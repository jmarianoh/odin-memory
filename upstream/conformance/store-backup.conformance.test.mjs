// Contraste diferencial de la copia de seguridad directa: exportar, importar y borrar sesiones.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Store, deletePrompt, deleteSession, exportData, exportProject, exportToJsonValue, importData, parseExportData, toGoJson } from '../../src/store/index.js';
import { resolveBinary, startMcpCommand } from './engram-mcp.mjs';

const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const SERVER = fileURLToPath(new URL('./odin-mcp-server.mjs', import.meta.url));

let base;
let repo;
let seedRef;
let seedOdin;
const closers = [];

/** Ejecuta la referencia con un directorio de datos propio. */
function engram(dataDir, args, { cwd = repo, input } = {}) {
  try {
    return { code: 0, stdout: execFileSync(binary.bin, args, { cwd, env: { ...process.env, ENGRAM_DATA_DIR: dataDir, ENGRAM_NO_UPDATE_CHECK: '1' }, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

before(async () => {
  if (!binary) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'conformance-backup-')));
  repo = join(base, 'repo-backup');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  seedRef = join(base, 'ref-seed');
  seedOdin = join(base, 'odin-seed');
  const ref = startMcpCommand(binary.bin, ['mcp', '--tools=all'], { cwd: repo, dataDir: seedRef, env: { ENGRAM_DATA_DIR: seedRef, ENGRAM_NO_UPDATE_CHECK: '1' } });
  const odin = startMcpCommand(process.execPath, ['--no-warnings', SERVER], { cwd: repo, dataDir: seedOdin, env: { ODIN_DATA_DIR: seedOdin } });
  closers.push(() => ref.close(), () => odin.close());
  await Promise.all([ref.initialize(), odin.initialize()]);
  const both = async (tool, args) => {
    const [a, b] = await Promise.all([ref.call(tool, args), odin.call(tool, args)]);
    assert.equal(b.isError, a.isError, `${tool}: ${a.text} / ${b.text}`);
    assert.equal(a.isError, false, `${tool}: ${a.text}`);
    return { ref: a, odin: b };
  };
  await both('mem_session_start', { id: 'sesion-1' });
  await both('mem_session_start', { id: 'sesion-2' });
  const saves = [
    { title: 'Decisión de caché', content: 'usamos Redis como caché distribuida', type: 'decision', session_id: 'sesion-1' },
    { title: 'Decisión de caché con Redis', content: 'Redis guarda las sesiones de usuario', type: 'decision', session_id: 'sesion-1' },
    { title: 'Tema versionado', content: 'primera versión', type: 'manual', topic_key: 'notas/versionado', session_id: 'sesion-1' },
    { title: 'Tema versionado', content: 'segunda versión', type: 'manual', topic_key: 'notas/versionado', session_id: 'sesion-1' },
    { title: 'Preferencia', content: 'tabulaciones de dos espacios', type: 'preference', scope: 'personal', session_id: 'sesion-2' },
    { title: 'Para borrar', content: 'se borrará suavemente', type: 'manual', session_id: 'sesion-2' },
    { title: 'Para borrar duro', content: 'se borrará de forma permanente', type: 'manual', session_id: 'sesion-2' },
    { title: 'Marcado <html> & más', content: 'contenido con <etiquetas> & ampersand', type: 'manual', session_id: 'sesion-1' },
    { title: 'Caché de Redis y sesiones de usuario', content: 'otra nota sobre Redis y sesiones', type: 'decision', session_id: 'sesion-1' },
  ];
  const results = [];
  for (const s of saves) results.push(await both('mem_save', s));
  await both('mem_save_prompt', { content: 'primer prompt', session_id: 'sesion-1' });
  await both('mem_save_prompt', { content: 'segundo prompt', session_id: 'sesion-2' });
  await both('mem_pin', { id: 1 });
  const candidate = (side) => results[1][side].json.candidates[0].judgment_id;
  const judged = await Promise.all([
    ref.call('mem_judge', { judgment_id: candidate('ref'), relation: 'supersedes', reason: 'más reciente', confidence: 0.9 }),
    odin.call('mem_judge', { judgment_id: candidate('odin'), relation: 'supersedes', reason: 'más reciente', confidence: 0.9 }),
  ]);
  assert.ok(judged.every((r) => !r.isError), judged.map((r) => r.text).join(' / '));
  await both('mem_delete', { id: 5, expected_project: 'repo-backup' });
  await both('mem_delete', { id: 6, expected_project: 'repo-backup', hard_delete: true });
  await both('mem_session_end', { id: 'sesion-2', summary: 'cerrada' });
  ref.close();
  odin.close();
  // Un prompt borrado deja una lápida (por la CLI de la referencia y por la API de odin).
  assert.equal(engram(seedRef, ['delete', 'prompt', '2']).code, 0);
  const seeded = Store.open({ dataDir: seedOdin, log: () => {} });
  deletePrompt(seeded, 2);
  seeded.close();
  // Fechas deterministas en ambas bases.
  for (const path of [join(seedRef, 'engram.db'), join(seedOdin, 'odin.db')]) {
    const db = new DatabaseSync(path, { timeout: 5000 });
    db.exec(`UPDATE observations SET created_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), updated_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes'), last_seen_at = datetime('2026-03-01 10:00:00', '+' || id || ' minutes')`);
    db.exec("UPDATE user_prompts SET created_at = datetime('2026-03-03 10:00:00', '+' || id || ' minutes')");
    db.exec("UPDATE sessions SET started_at = '2026-03-01 09:00:00', ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE '2026-03-01 11:00:00' END");
    db.exec("UPDATE prompt_tombstones SET deleted_at = '2026-03-05 10:00:00'");
    db.exec("UPDATE sessions SET project = 'otro' WHERE id = 'sesion-2'"); // segundo proyecto
    db.exec("UPDATE observations SET project = 'otro' WHERE session_id = 'sesion-2'");
    db.exec("UPDATE user_prompts SET project = 'otro' WHERE session_id = 'sesion-2'");
    db.exec("UPDATE observations SET project = NULL WHERE title = 'Preferencia'"); // sin proyecto propio: manda el de la sesión
    db.exec("UPDATE observations SET project = '' WHERE title LIKE 'Marcado%'"); // proyecto vacío
    db.exec("UPDATE prompt_tombstones SET project = 'repo-backup'"); // dueño distinto del de su sesión
    db.exec(`INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, created_at, updated_at)
      SELECT 'rel-cross0000000001', (SELECT sync_id FROM observations WHERE title = 'Decisión de caché'), (SELECT sync_id FROM observations WHERE title = 'Preferencia'), 'related', 'judged', '2026-03-04 10:00:00', '2026-03-04 10:00:00'`);
    db.exec(`UPDATE memory_relations SET superseded_by_relation_id = (SELECT id FROM memory_relations WHERE sync_id = 'rel-cross0000000001'), superseded_at = '2026-03-05 10:00:00' WHERE id = (SELECT MIN(id) FROM memory_relations WHERE judgment_status = 'judged' AND sync_id != 'rel-cross0000000001')`);
    db.exec("UPDATE memory_relations SET created_at = datetime('2026-03-04 10:00:00', '+' || id || ' minutes'), updated_at = datetime('2026-03-04 10:00:00', '+' || id || ' minutes')");
    db.close();
  }
});
after(() => {
  for (const close of closers) close();
  if (base) rmSync(base, { recursive: true, force: true });
  binary?.cleanup();
});

/** Enmascara lo aleatorio para comparar exportaciones. */
function normalize(value) {
  if (typeof value === 'string') {
    return value
      .replace(/obs-[0-9a-f]{16}/g, 'obs-X').replace(/rel-[0-9a-f]{16}/g, 'rel-X').replace(/prompt-[0-9a-f]{16}/g, 'prompt-X')
      .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, 'T');
  }
  if (value === 'engram') return 'odin';
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  return value;
}

const rows = (path, sql) => {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare(sql).all().map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const openOdin = (dir) => Store.open({ dataDir: dir, log: () => {} });
const odinExportJson = (store, project = '') => JSON.parse(toGoJson(exportToJsonValue(project ? exportProject(store, project) : exportData(store)), 2));
function refExportJson(dir, extra = []) {
  const file = join(dir, 'out.json');
  const r = engram(dir, ['export', file, ...extra]);
  assert.equal(r.code, 0, r.stderr);
  return { json: JSON.parse(readFileSync(file, 'utf8')), text: readFileSync(file, 'utf8'), stdout: r.stdout };
}

test('exportar: misma estructura, mismas claves y mismo orden que la referencia', { skip }, () => {
  const ref = refExportJson(seedRef, ['--all']);
  const store = openOdin(seedOdin);
  try {
    const mine = odinExportJson(store);
    assert.deepEqual(normalize(mine), normalize(ref.json));
    // el orden de las claves también es parte del formato
    assert.deepEqual(Object.keys(mine), Object.keys(ref.json));
    for (const section of ['sessions', 'observations', 'prompts']) {
      if (ref.json[section]) assert.deepEqual(Object.keys(mine[section][0]), Object.keys(ref.json[section][0]), section);
    }
    // el texto sangrado es idéntico salvo identificadores y fechas
    const mineText = toGoJson(exportToJsonValue(exportData(store)), 2);
    const mask = (t) => normalize(t).replace(/"exported_at": "T"/, '"exported_at": "T"');
    assert.equal(mask(mineText), mask(ref.text));
  } finally {
    store.close();
  }
});

test('exportar un proyecto y un proyecto sin datos', { skip }, () => {
  const store = openOdin(seedOdin);
  try {
    for (const name of ['repo-backup', 'otro']) {
      const ref = refExportJson(seedRef, ['--project', name]);
      assert.deepEqual(normalize(odinExportJson(store, name)), normalize(ref.json), name);
    }
    assert.throws(() => exportProject(store, '  '), /project is required/);
    assert.deepEqual(normalize(odinExportJson(store, 'no-existe')), normalize({
      version: '0.2.0', exported_at: 'T', sessions: null, observations: null, prompts: null,
    }));
  } finally {
    store.close();
  }
});

test('importar: la copia de la referencia produce el mismo estado en ambos', { skip }, () => {
  const source = refExportJson(seedRef, ['--all']);
  // referencia
  const refDir = join(base, 'ref-import');
  const file = join(base, 'a.json');
  writeFileSync(file, source.text);
  const imported = engram(refDir, ['import', file]);
  assert.equal(imported.code, 0, imported.stderr);
  // odin
  const odinDir = join(base, 'odin-import');
  const store = openOdin(odinDir);
  try {
    const result = importData(store, parseExportData(source.text));
    const printed = `Imported from ${file}\n  Sessions:     ${result.sessions_imported}\n  Observations: ${result.observations_imported} imported, ${result.observations_updated} updated, ${result.observations_skipped_stale} skipped stale\n  Prompts:      ${result.prompts_imported}\n`;
    assert.equal(printed, imported.stdout);
    const after = refExportJson(refDir, ['--all']);
    assert.deepEqual(normalize(odinExportJson(store)), normalize(after.json));

    // reimportar la misma copia no cambia nada: todo se omite como antiguo o repetido
    const again = importData(store, parseExportData(source.text));
    const refAgain = engram(refDir, ['import', file]);
    assert.equal(
      `Imported from ${file}\n  Sessions:     ${again.sessions_imported}\n  Observations: ${again.observations_imported} imported, ${again.observations_updated} updated, ${again.observations_skipped_stale} skipped stale\n  Prompts:      ${again.prompts_imported}\n`,
      refAgain.stdout,
    );
  } finally {
    store.close();
  }
});

test('importar: observaciones más nuevas, más antiguas y sin fecha comparable', { skip }, () => {
  const source = JSON.parse(refExportJson(seedRef, ['--all']).text);
  const variants = JSON.parse(JSON.stringify(source));
  variants.observations[0].title = 'Título actualizado';
  variants.observations[0].updated_at = '2030-01-01 00:00:00';
  variants.observations[1].title = 'Título anterior';
  variants.observations[1].updated_at = '2001-01-01 00:00:00';
  variants.observations[2].title = 'Sin fecha';
  variants.observations[2].updated_at = 'no es fecha';
  variants.observations[3].revision_count = 0;
  variants.observations[3].duplicate_count = 0;
  variants.observations[3].updated_at = '2030-06-01T12:00:00Z';
  variants.observations[3].created_at = 'tampoco';
  variants.observations.push({
    id: 99, sync_id: '', session_id: 'sesion-1', type: 'manual', title: 'Nueva sin sync_id', content: 'se asigna un identificador', scope: 'project',
    revision_count: 0, duplicate_count: 0, created_at: '2026-04-01 00:00:00', updated_at: '2026-04-01 00:00:00', pinned: true,
  });
  const refDir = join(base, 'ref-variants');
  const odinDir = join(base, 'odin-variants');
  const seedFile = join(base, 'seed.json');
  writeFileSync(seedFile, JSON.stringify(source));
  const variantFile = join(base, 'variants.json');
  writeFileSync(variantFile, JSON.stringify(variants));
  assert.equal(engram(refDir, ['import', seedFile]).code, 0);
  const refResult = engram(refDir, ['import', variantFile]);
  assert.equal(refResult.code, 0, refResult.stderr);
  const store = openOdin(odinDir);
  try {
    importData(store, parseExportData(JSON.stringify(source)));
    const result = importData(store, parseExportData(JSON.stringify(variants)));
    assert.equal(
      `Imported from ${variantFile}\n  Sessions:     ${result.sessions_imported}\n  Observations: ${result.observations_imported} imported, ${result.observations_updated} updated, ${result.observations_skipped_stale} skipped stale\n  Prompts:      ${result.prompts_imported}\n`,
      refResult.stdout,
    );
    const ref = refExportJson(refDir, ['--all']);
    assert.deepEqual(normalize(odinExportJson(store)), normalize(ref.json));
  } finally {
    store.close();
  }
});

test('importar: versiones, sesiones, relaciones y lápidas inválidas', { skip }, () => {
  const source = JSON.parse(refExportJson(seedRef, ['--all']).text);
  const cases = {
    'versión no admitida': { ...source, version: '9.9.9' },
    'versión antigua': { ...source, version: '0.1.0' },
    'sin versión': { ...source, version: '' },
    'modo de propiedad inválido': { ...source, sessions: source.sessions.map((s) => ({ ...s, ownership_mode: 'raro' })) },
    'identificador de sesión vacío': { ...source, sessions: [{ ...source.sessions[0], id: '' }] },
    'relación con extremo ausente': { ...source, relations: [{ ...source.relations?.[0], sync_id: 'rel-0000000000000001', source_id: 'obs-nada', target_id: source.observations[0].sync_id, judgment_status: 'judged', relation: 'related', created_at: 'x', updated_at: 'x' }] },
    'relación huérfana': { ...source, relations: [{ sync_id: 'rel-0000000000000002', source_id: 'obs-nada', target_id: 'obs-tampoco', relation: 'related', judgment_status: ' Orphaned ', created_at: 'x', updated_at: 'x' }] },
    'relación sin sync_id': { ...source, relations: [{ sync_id: ' ', source_id: 'a', target_id: 'b', relation: 'related', judgment_status: 'judged', created_at: 'x', updated_at: 'x' }] },
    'lápida sin sync_id': { ...source, prompt_tombstones: [{ sync_id: '', session_id: 's', deleted_at: '2026-01-01 00:00:00' }] },
    'lápida con inbox sin sesión': { ...source, prompt_tombstones: [{ sync_id: 'prompt-1', session_id: ' ', source_inbox_id: 'i', deleted_at: '2026-01-01 00:00:00' }] },
    'lápida nueva': { ...source, prompt_tombstones: [{ sync_id: 'prompt-aaaaaaaaaaaaaaaa', session_id: 'sesion-1', project: 'repo-backup', deleted_at: '2030-01-01 00:00:00' }] },
    'prompt con identidad de bandeja': { ...source, prompts: [{ id: 50, sync_id: 'prompt-bbbbbbbbbbbbbbbb', session_id: 'sesion-1', content: 'con bandeja', project: 'repo-backup', created_at: '2026-05-01 00:00:00', source_inbox_id: 'inbox-1' }] },
  };
  for (const [label, payload] of Object.entries(cases)) {
    const refDir = join(base, `ref-case-${label.replace(/\W+/g, '-')}`);
    const odinDir = join(base, `odin-case-${label.replace(/\W+/g, '-')}`);
    const file = join(base, `case-${label.replace(/\W+/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(payload));
    const ref = engram(refDir, ['import', file]);
    const store = openOdin(odinDir);
    try {
      let mineOk = true;
      let message = '';
      try {
        importData(store, parseExportData(JSON.stringify(payload)));
      } catch (err) {
        mineOk = false;
        message = err.message;
      }
      assert.equal(mineOk, ref.code === 0, `${label}: referencia ${ref.code} ${ref.stderr ?? ''} / odin ${message}`);
      if (!mineOk) {
        const expected = (ref.stderr ?? '').replace(/^engram: /, '').trim();
        assert.equal(message.replace(/^[^:]+: /, '').slice(0, 20), expected.replace(/^[^:]+: /, '').slice(0, 20), `${label}: mensaje`);
      } else {
        const refOut = refExportJson(refDir, ['--all']);
        assert.deepEqual(normalize(odinExportJson(store)), normalize(refOut.json), label);
      }
    } finally {
      store.close();
    }
  }
});

test('borrar sesiones', { skip }, () => {
  const refDir = join(base, 'ref-delete');
  const odinDir = join(base, 'odin-delete');
  const source = refExportJson(seedRef, ['--all']);
  const seedFile = join(base, 'delete-seed.json');
  writeFileSync(seedFile, source.text);
  assert.equal(engram(refDir, ['import', seedFile]).code, 0);
  const store = openOdin(odinDir);
  try {
    importData(store, parseExportData(source.text));
    // una sesión sin observaciones pero con prompt
    const extra = JSON.parse(source.text);
    extra.sessions.push({ id: 'vacia', project: 'repo-backup', directory: '/d', started_at: '2026-03-01 08:00:00' });
    extra.prompts.push({ id: 90, sync_id: 'prompt-cccccccccccccccc', session_id: 'vacia', content: 'prompt de la sesión vacía', project: '', created_at: '2026-03-02 00:00:00' });
    const extraFile = join(base, 'delete-extra.json');
    writeFileSync(extraFile, JSON.stringify(extra));
    assert.equal(engram(refDir, ['import', extraFile]).code, 0);
    importData(store, parseExportData(JSON.stringify(extra)));

    for (const id of ['sesion-1', 'no-existe', 'vacia', 'vacia']) {
      const ref = engram(refDir, ['delete', 'session', id]);
      let message = 'ok';
      try {
        deleteSession(store, id);
      } catch (err) {
        message = err.message;
      }
      if (ref.code === 0) assert.equal(message, 'ok', id);
      else {
        assert.notEqual(message, 'ok', id);
        assert.equal(message, (ref.stderr ?? '').replace(/^engram: /, '').trim(), id);
      }
    }
    const tombstones = 'SELECT entity, entity_key, project, hard_delete, active FROM sync_delete_tombstones ORDER BY entity, entity_key';
    assert.deepEqual(normalize(rows(join(odinDir, 'odin.db'), tombstones)), normalize(rows(join(refDir, 'engram.db'), tombstones)));
    assert.ok(rows(join(odinDir, 'odin.db'), tombstones).some((t) => t.entity === 'session'));
    const refOut = refExportJson(refDir, ['--all']);
    assert.deepEqual(normalize(odinExportJson(store)), normalize(refOut.json));
  } finally {
    store.close();
  }
});

// ─── Importaciones en varios pasos ───────────────────────────────────────────

/** Aplica la misma secuencia de importaciones y SQL a ambos y compara cada paso y el resultado final. */
function scenario(label, steps) {
  const slug = label.replace(/\W+/g, '-');
  const refDir = join(base, `ref-sc-${slug}`);
  const odinDir = join(base, `odin-sc-${slug}`);
  const store = openOdin(odinDir);
  try {
    for (const [i, step] of steps.entries()) {
      if (step.sql) {
        for (const path of [join(refDir, 'engram.db'), join(odinDir, 'odin.db')]) {
          const db = new DatabaseSync(path, { timeout: 5000 });
          db.exec(step.sql);
          db.close();
        }
        continue;
      }
      const file = join(base, `sc-${slug}-${i}.json`);
      writeFileSync(file, JSON.stringify(step.payload));
      const ref = engram(refDir, ['import', file]);
      let mine;
      try {
        const r = importData(store, parseExportData(JSON.stringify(step.payload)));
        mine = { code: 0, stdout: `Imported from ${file}\n  Sessions:     ${r.sessions_imported}\n  Observations: ${r.observations_imported} imported, ${r.observations_updated} updated, ${r.observations_skipped_stale} skipped stale\n  Prompts:      ${r.prompts_imported}\n` };
      } catch (err) {
        mine = { code: 1, message: err.message };
      }
      assert.equal(mine.code, ref.code === 0 ? 0 : 1, `${label} paso ${i}: referencia ${ref.stderr ?? ''} / odin ${mine.message ?? ''}`);
      if (ref.code === 0) assert.equal(mine.stdout, ref.stdout, `${label} paso ${i}`);
      else assert.equal(mine.message, (ref.stderr ?? '').replace(/^engram: /, '').trim(), `${label} paso ${i}: mensaje`);
    }
    const refOut = refExportJson(refDir, ['--all']);
    assert.deepEqual(normalize(odinExportJson(store)), normalize(refOut.json), `${label}: estado final`);
  } finally {
    store.close();
  }
}

test('importar en varios pasos: relaciones, lápidas, bandejas y fechas', { skip }, () => {
  const source = refExportJson(seedRef, ['--all']).json;
  const clone = () => structuredClone(source);
  const tombstone = source.prompt_tombstones[0];
  const firstPrompt = source.prompts[0];
  const secondProject = source.sessions.find((s) => s.project !== 'repo-backup');
  assert.ok(tombstone && firstPrompt && secondProject && source.relations.some((r) => r.superseded_by_relation_sync_id), 'la siembra debe cubrir estos casos');

  const withoutLinks = clone();
  for (const r of withoutLinks.relations) delete r.superseded_by_relation_sync_id;
  scenario('relación sustituida al insertarse', [{ payload: withoutLinks }, { payload: clone() }]);

  const foreignSession = clone();
  foreignSession.prompt_tombstones = [{ ...tombstone, session_id: 'otra-sesion' }];
  scenario('lápida con otra sesión', [{ payload: clone() }, { payload: foreignSession }]);

  const foreignInbox = clone();
  foreignInbox.prompt_tombstones = [{ ...tombstone, source_inbox_id: 'in-x', session_id: tombstone.session_id }];
  scenario('lápida con otra bandeja', [{ payload: clone() }, { payload: foreignInbox }]);

  const foreignOwner = clone();
  foreignOwner.prompt_tombstones = [{ sync_id: firstPrompt.sync_id, session_id: firstPrompt.session_id, project: secondProject.project, deleted_at: '2099-01-01 00:00:00' }];
  scenario('lápida de otro dueño', [{ payload: clone() }, { payload: foreignOwner }]);

  const sameOwner = clone();
  sameOwner.prompt_tombstones = [{ sync_id: firstPrompt.sync_id, session_id: firstPrompt.session_id, project: firstPrompt.project, deleted_at: '2099-01-01 00:00:00' }];
  scenario('lápida del mismo dueño borra el prompt', [{ payload: clone() }, { payload: sameOwner }]);

  const stale = { ...clone(), prompt_tombstones: [], prompts: [{ id: 70, sync_id: tombstone.sync_id, session_id: tombstone.session_id, content: 'viejo', project: tombstone.project, created_at: '2020-01-01 00:00:00' }] };
  const revived = { ...clone(), prompt_tombstones: [], prompts: [{ id: 71, sync_id: tombstone.sync_id, session_id: tombstone.session_id, content: 'nuevo', project: tombstone.project, created_at: '2040-01-01 00:00:00' }] };
  const undated = { ...clone(), prompt_tombstones: [], prompts: [{ id: 72, sync_id: tombstone.sync_id, session_id: tombstone.session_id, content: 'sin fecha', project: tombstone.project, created_at: 'ayer' }] };
  scenario('prompt anterior a la lápida', [{ payload: clone() }, { payload: stale }]);
  scenario('prompt sin fecha comparable', [{ payload: clone() }, { payload: undated }]);
  scenario('prompt posterior a la lápida', [{ payload: clone() }, { payload: stale }, { payload: revived }]);

  const inboxTombstone = { ...clone(), prompts: [], prompt_tombstones: [{ sync_id: 'prompt-dddddddddddddddd', session_id: 'sesion-1', source_inbox_id: 'in-1', deleted_at: '2026-01-01 00:00:00' }] };
  const inboxPrompt = { ...clone(), prompt_tombstones: [], prompts: [{ id: 80, sync_id: 'prompt-eeeeeeeeeeeeeeee', session_id: 'sesion-1', content: 'con bandeja borrada', project: 'repo-backup', created_at: '2030-01-01 00:00:00', source_inbox_id: 'in-1' }] };
  scenario('bandeja borrada', [{ payload: inboxTombstone }, { payload: inboxPrompt }]);
  const revivedByInbox = { ...clone(), prompt_tombstones: [], prompts: [{ id: 81, sync_id: tombstone.sync_id, session_id: tombstone.session_id, content: 'con bandeja', project: tombstone.project, created_at: '2040-01-01 00:00:00', source_inbox_id: 'in-2' }] };
  scenario('prompt con bandeja tras lápida', [{ payload: clone() }, { payload: revivedByInbox }]);

  const conflicting = { ...clone(), prompt_tombstones: [], prompts: [{ ...firstPrompt, session_id: 'sesion-2', source_inbox_id: 'in-9', project: secondProject.project }] };
  scenario('bandeja en otra sesión', [{ payload: clone() }, { payload: conflicting }]);
  const sisterSession = { ...clone(), prompt_tombstones: [], sessions: [...source.sessions, { id: 'hermana', project: 'repo-backup', directory: '/d', started_at: '2026-03-01 07:00:00' }], prompts: [{ ...firstPrompt, session_id: 'hermana', source_inbox_id: 'in-9' }] };
  scenario('bandeja en otra sesión del mismo proyecto', [{ payload: clone() }, { payload: sisterSession }]);
  const differentProject = { ...clone(), prompt_tombstones: [], prompts: [{ ...firstPrompt, source_inbox_id: 'in-9', project: secondProject.project }] };
  scenario('bandeja con otro proyecto', [{ payload: clone() }, { payload: differentProject }]);
  const adopting = { ...clone(), prompt_tombstones: [], prompts: [{ ...firstPrompt, source_inbox_id: 'in-adopt' }] };
  scenario('bandeja adoptada', [{ payload: clone() }, { payload: adopting }]);
  const otherInbox = { ...clone(), prompt_tombstones: [], prompts: [{ ...firstPrompt, source_inbox_id: 'in-otra' }] };
  scenario('bandeja ya establecida', [{ payload: clone() }, { payload: adopting }, { payload: otherInbox }]);

  const newer = clone();
  newer.observations[0].title = 'Más nuevo';
  newer.observations[0].updated_at = '2099-01-01 00:00:00';
  delete newer.observations[0].superseded_by_sync_id;
  scenario('enlace de sustitución conservado', [
    { payload: clone() },
    { sql: "UPDATE observations SET superseded_by_sync_id = 'obs-enlace0000000001' WHERE id = 1" },
    { payload: newer },
  ]);
  const tombstoneLink = clone();
  tombstoneLink.observations[0].title = 'Con enlace de lápida';
  tombstoneLink.observations[0].updated_at = '2099-01-01 00:00:00';
  scenario('enlace de lápida de sincronización', [
    { payload: clone() },
    { sql: "INSERT INTO sync_delete_tombstones (entity, entity_key, project, deleted_at, hard_delete, active, superseded_by_sync_id) SELECT 'observation', sync_id, 'repo-backup', '2026-03-01 00:00:00', 0, 0, 'obs-lapida00000000001' FROM observations WHERE id = 1" },
    { payload: tombstoneLink },
  ]);

  const zones = clone();
  zones.observations[0].title = 'Con zona';
  zones.observations[0].updated_at = '2026-03-01T13:00:00+02:00'; // 11:00 UTC: anterior a la local
  zones.observations[1].title = 'Solo fecha';
  zones.observations[1].updated_at = '2030-01-01';
  zones.observations[2].title = 'Con zona negativa';
  zones.observations[2].updated_at = '2030-01-01T00:00:00-05:00';
  zones.observations[3].title = 'Con fracción';
  zones.observations[3].updated_at = '2030-01-01T00:00:00.123456789012Z';
  scenario('fechas con zona', [
    { payload: clone() },
    { sql: "UPDATE observations SET updated_at = '2026-03-01 11:30:00' WHERE id = 1" },
    { payload: zones },
  ]);

  const owned = clone();
  owned.sessions.push({ id: 'propia', project: 'repo-backup', ownership_mode: 'project_owned', directory: '/d', started_at: '2026-03-01 07:00:00' });
  owned.sessions.push({ id: 'compartida', project: 'repo-backup', ownership_mode: 'shared', directory: '', started_at: '2026-03-01 07:00:00' });
  owned.sessions.push({ id: 'sin-modo', project: 'repo-backup', directory: '/d', started_at: '2026-03-01 07:00:00' });
  scenario('modos de propiedad', [{ payload: owned }]);
});
