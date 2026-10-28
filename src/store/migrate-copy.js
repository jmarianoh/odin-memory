import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fsErrorText } from '../runtime/fs-error.js';
import { isValidInstanceId } from './instance-id.js';
import { SCHEMA_VERSION } from './schema.js';
import { DB_FILE_NAME, Store } from './store.js';
import { goTrim } from './text.js';

const SHM_FILE = `${DB_FILE_NAME}-shm`;

/** Ruta absoluta y limpia sin enlaces simbólicos ni componentes que no sean directorios. */
function canonicalPath(path) {
  if (!isAbsolute(path)) throw new Error('data and output directories must be absolute paths');
  const clean = normalize(path).replace(/(.)\/+$/, '$1');
  for (let q = clean; ; q = join(q, '..')) {
    let info = null;
    try {
      info = lstatSync(q);
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(fsErrorText(err, q), { cause: err });
    }
    if (info) {
      if (info.isSymbolicLink()) throw new Error(`symlink path component is not allowed: ${q}`);
      if (q !== clean && !info.isDirectory()) throw new Error(`non-directory path component: ${q}`);
    }
    if (join(q, '..') === q) break;
  }
  return clean;
}

/** `child` es `parent` o está dentro de él (por nombre). */
function within(parent, child) {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..');
}

/** Alguno de los ancestros existentes de `child` es el mismo directorio físico que `parent` (alias de mayúsculas, p. ej.). */
function physicallyWithin(parentInfo, child) {
  for (let path = child; ; path = join(path, '..')) {
    try {
      const ancestor = lstatSync(path);
      if (ancestor.ino === parentInfo.ino && ancestor.dev === parentInfo.dev) return true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (join(path, '..') === path) return false;
  }
}

function digestOf(path, info) {
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.ino !== info.ino || opened.dev !== info.dev) throw new Error(`source entry changed: ${path}`);
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1 << 20);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** Estado de cada entrada del directorio: tipo, permisos, tamaño, fecha, identidad y huella. */
function manifestOf(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path, { bigint: true });
      if (!info.isDirectory() && !info.isFile()) throw new Error(`unsafe source entry: ${path}`);
      const rel = relative(root, path);
      if (rel.endsWith('-journal')) throw new Error(`rollback journals are not supported: ${rel}`);
      out.set(rel, { info, digest: info.isFile() ? digestOf(path, info) : '' });
      if (info.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}

const sameEntry = (x, y) => x.digest === y.digest && x.info.mode === y.info.mode && x.info.size === y.info.size && x.info.mtimeNs === y.info.mtimeNs
  && x.info.ino === y.info.ino && x.info.dev === y.info.dev;
function manifestsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [path, x] of a) {
    const y = b.get(path);
    if (!y || !sameEntry(x, y)) return false;
  }
  return true;
}

/** Copia el directorio verificando la huella de cada archivo; omite `odin.db-shm`, que SQLite regenera. */
function copyDirectory(source, output, manifest) {
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(source, path);
      const entry = manifest.get(rel);
      if (!entry) throw new Error(`source gained entry: ${rel}`);
      const info = lstatSync(path, { bigint: true });
      if (info.ino !== entry.info.ino || info.dev !== entry.info.dev || info.mode !== entry.info.mode) throw new Error(`source changed: ${rel}`);
      const target = join(output, rel);
      if (info.isDirectory()) {
        mkdirSync(target, { mode: 0o700 });
        walk(path);
        continue;
      }
      if (rel === SHM_FILE) continue;
      const inFd = openSync(path, 'r');
      try {
        const opened = fstatSync(inFd, { bigint: true });
        if (opened.ino !== info.ino || opened.dev !== info.dev) throw new Error(`source changed: ${rel}`);
        const outFd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        const hash = createHash('sha256');
        try {
          const chunk = Buffer.alloc(1 << 20);
          for (;;) {
            const n = readSync(inFd, chunk, 0, chunk.length, null);
            if (n === 0) break;
            hash.update(chunk.subarray(0, n));
            let offset = 0;
            while (offset < n) offset += writeSync(outFd, chunk, offset, n - offset);
          }
          fsyncSync(outFd);
        } finally {
          closeSync(outFd);
        }
        if (hash.digest('hex') !== entry.digest) throw new Error(`source bytes changed: ${rel}`);
      } finally {
        closeSync(inFd);
      }
      chmodSync(target, Number(info.mode & 0o777n));
    }
  };
  walk(source);
}

function integrityCheck(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1) throw new Error('database integrity check returned no verdict');
  if (Object.values(rows[0])[0] !== 'ok') throw new Error('database integrity check failed');
}

/** Espacios fuera de comillas colapsados: los literales de valores por defecto y disparadores se conservan exactos. */
function sqlWhitespace(ddl) {
  let out = '';
  let quote = '';
  let space = false;
  for (let i = 0; i < ddl.length; i++) {
    const c = ddl[i];
    if (quote !== '') {
      out += c;
      if (c === quote) {
        if (ddl[i + 1] === quote) out += ddl[++i];
        else quote = '';
      }
      continue;
    }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      space = true;
      continue;
    }
    if (space && out.length > 0) out += ' ';
    space = false;
    out += c;
    if (c === "'" || c === '"' || c === '`') quote = c;
  }
  return out;
}

/** Las definiciones de columnas de una tabla se comparan como conjunto: ALTER las añade al final. */
function normalizeDdl(ddl) {
  if (!ddl.startsWith('CREATE TABLE ')) return ddl;
  const start = ddl.indexOf('(');
  if (start < 0 || !ddl.endsWith(')')) return ddl;
  const body = ddl.slice(start + 1, -1);
  const parts = [];
  let depth = 0;
  let quote = '';
  let last = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote !== '') {
      if (c === quote) {
        if (body[i + 1] === quote) i++;
        else quote = '';
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(last, i).trim());
      last = i + 1;
    }
  }
  parts.push(body.slice(last).trim());
  parts.sort();
  return `${ddl.slice(0, start + 1)}${parts.join(',')},)`;
}

function catalogOf(db) {
  const out = {};
  for (const r of db.prepare('SELECT name, type, tbl_name, ifnull(sql, \'\') AS sql FROM sqlite_schema').all()) {
    out[r.name] = { kind: r.type, table: r.tbl_name, sql: normalizeDdl(sqlWhitespace(r.sql)) };
  }
  return out;
}

/** El catálogo de una base recién creada por esta versión: la referencia de lo admisible. */
function currentCatalog() {
  const dir = mkdtempSync(join(tmpdir(), 'odin-catalog-'));
  try {
    const store = Store.open({ dataDir: join(dir, 'data'), log: () => {} });
    try {
      return catalogOf(store.db.raw ?? store.db);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Solo se admite el esquema y el catálogo exactos de esta versión; cualquier objeto desconocido falla. */
function validateCopy(db) {
  const version = Object.values(db.prepare('PRAGMA user_version').get())[0];
  if (version !== SCHEMA_VERSION) throw new Error(`unsupported database schema version: ${version}`);
  integrityCheck(db);
  const actual = catalogOf(db);
  const current = currentCatalog();
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(current).sort())) {
    throw new Error("unsupported database catalog; use a core supporting this store's exact shape");
  }
}

/**
 * Copia por completo un almacén detenido a un directorio nuevo y migra solo la
 * copia. Nunca abre el origen con SQLite. El operador debe haber detenido todo
 * cliente y conservar el control exclusivo de ambos directorios mientras dura la
 * copia y cualquier promoción posterior. Si falla, un directorio de salida recién
 * creado se conserva (nunca se borra) y no debe usarse.
 * @param {string} source
 * @param {string} output
 * @param {boolean} confirmed
 * @param {{ afterCopy?: () => void, afterValidate?: () => void, afterMigrate?: () => void }} [hooks] ganchos de prueba: se llaman tras copiar, tras validar y tras migrar la copia
 * @returns {{ source_dir: string, output_dir: string, instance_id: string, migration_completed: boolean }}
 */
export function migrateCopy(source, output, confirmed, hooks = {}) {
  if (!confirmed) throw new Error('--confirm-quiescent is required; stop every source client first');
  source = canonicalPath(source);
  output = canonicalPath(output);
  if (within(source, output) || within(output, source)) throw new Error('source and output must be disjoint directories');
  let exists = true;
  try {
    lstatSync(output);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    exists = false;
  }
  if (exists) throw new Error('output directory must not exist');
  let info;
  try {
    info = lstatSync(source);
  } catch (err) {
    throw new Error(fsErrorText(err, source), { cause: err });
  }
  if (!info.isDirectory()) throw new Error('source must be a directory');
  // La contención léxica no ve alias del sistema de archivos: se compara la identidad física.
  if (physicallyWithin(info, output)) throw new Error('source and output must be disjoint directories');
  const before = manifestOf(source);
  if (!before.has(DB_FILE_NAME)) throw new Error(`source has no ${DB_FILE_NAME}`);
  let identity;
  try {
    identity = goTrim(readFileSync(join(source, '.instance-id'), 'utf8'));
  } catch (err) {
    throw new Error(`source instance identity: ${fsErrorText(err, join(source, '.instance-id'))}`, { cause: err });
  }
  if (!isValidInstanceId(identity)) throw new Error('source instance identity is invalid');

  mkdirSync(output, { mode: 0o700 });
  try {
    copyDirectory(source, output, before);
    hooks.afterCopy?.();
    const header = Buffer.alloc(16);
    const fd = openSync(join(output, DB_FILE_NAME), 'r');
    try {
      readSync(fd, header, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    if (header.toString('latin1') !== 'SQLite format 3\0') throw new Error('invalid database header');
    // Solo la copia se abre con SQLite; sin `immutable`, SQLite lee el WAL copiado y reconstruye el SHM en el destino.
    const db = new DatabaseSync(join(output, DB_FILE_NAME), { readOnly: true });
    try {
      validateCopy(db);
    } finally {
      db.close();
    }
    hooks.afterValidate?.();
    if (!manifestsEqual(before, manifestOf(source))) throw new Error('source changed during copy');
    const store = Store.open({ dataDir: output, log: () => {} });
    let matches;
    try {
      integrityCheck(store.db.raw ?? store.db);
      matches = store.instanceId === identity;
    } finally {
      store.close();
    }
    if (!matches) throw new Error('destination instance identity changed');
    hooks.afterMigrate?.();
    if (!manifestsEqual(before, manifestOf(source))) throw new Error('source changed during migration');
  } catch (err) {
    const text = err.syscall && err.path ? fsErrorText(err, err.path) : err.message;
    throw new Error(`${text}; incomplete output retained at ${output}; do not use or promote it`, { cause: err });
  }
  return { source_dir: source, output_dir: output, instance_id: identity, migration_completed: true };
}
