import { normalizeProject } from '../project/canonical.js';
import {
  DEFAULT_SYNC_TARGET_KEY,
  OBSERVATIONS_FTS_COLUMNS,
  OBSERVATIONS_FTS_DEFINITION,
  OBSERVATIONS_FTS_TRIGGERS,
  PROMPTS_FTS_COLUMNS,
  PROMPTS_FTS_DEFINITION,
  PROMPTS_FTS_TRIGGERS,
  SCHEMA_VERSION,
  SYNC_INBOX_TARGET_KEY,
  SYNC_LIFECYCLE_IDLE,
  SYNC_LIFECYCLE_INBOX,
  TABLES_AND_INDEXES,
} from './schema.js';

/**
 * Columnas añadidas después del esquema inicial, en orden. Cada entrada se aplica
 * con `addColumnIfNotExists`. Vacía mientras `SCHEMA_VERSION` siga en 1.
 * @type {{ table: string, column: string, definition: string }[]}
 */
export const COLUMN_MIGRATIONS = [];

/** Espera máxima (ms) por el bloqueo de escritura durante la migración. */
const MIGRATION_BUSY_TIMEOUT_MS = 60_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Quita espacios y pasa a minúsculas para comparar DDL sin importar el formato. */
function normalizeSql(sql) {
  return sql.replace(/\s+/g, '').toLowerCase();
}

/**
 * Añade una columna si la tabla aún no la tiene.
 * @param {import('./db.js').Database} db
 * @param {string} table
 * @param {string} column
 * @param {string} definition tipo y restricciones, p. ej. `TEXT NOT NULL DEFAULT ''`
 */
export function addColumnIfNotExists(db, table, column, definition) {
  const exists = db.all(`PRAGMA table_info(${table})`).some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Indica si una tabla FTS5 externa tiene las columnas, el tokenizador y el
 * contenido esperados.
 * @param {import('./db.js').Database} db
 * @param {string} table
 * @param {string[]} expectedColumns
 * @param {string} contentTable
 */
function ftsTableMatches(db, table, expectedColumns, contentTable) {
  const row = db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table);
  if (!row) return false;
  const columns = db
    .all('SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid', table)
    .map((c) => c.name);
  if (columns.length !== expectedColumns.length || columns.some((c, i) => c !== expectedColumns[i])) return false;
  const ddl = normalizeSql(row.sql);
  return (
    ddl.includes(`createvirtualtable${table}usingfts5(`) &&
    ddl.includes("tokenize='trigram'") &&
    ddl.includes(`content='${contentTable}'`) &&
    ddl.includes("content_rowid='id'")
  );
}

/**
 * Indica si cada trigger existe y contiene los fragmentos esperados.
 * @param {import('./db.js').Database} db
 * @param {Record<string, string[]>} expected nombre → fragmentos normalizados
 */
function ftsTriggersMatch(db, expected) {
  for (const [name, fragments] of Object.entries(expected)) {
    const row = db.get("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", name);
    if (!row) return false;
    const ddl = normalizeSql(row.sql);
    if (!fragments.every((f) => ddl.includes(f))) return false;
  }
  return true;
}

/**
 * Crea o reconstruye las tablas FTS y sus triggers cuando faltan o difieren de la
 * definición esperada, repoblándolas desde las tablas de contenido.
 * @param {import('./db.js').Database} db
 */
export function migrateFts(db) {
  const observationsRebuild =
    !ftsTableMatches(db, 'observations_fts', OBSERVATIONS_FTS_COLUMNS, 'observations') ||
    !ftsTriggersMatch(db, {
      obs_fts_insert: ['afterinsertonobservations', 'whennew.deleted_atisnull'],
      obs_fts_delete: ['beforedeleteonobservations', 'whenold.deleted_atisnull', 'deletefromobservations_ftswhererowid=old.id'],
      obs_fts_update: ['beforeupdateonobservations', 'whenold.deleted_atisnull', 'deletefromobservations_ftswhererowid=old.id'],
      obs_fts_update_insert: ['afterupdateonobservations', 'whennew.deleted_atisnull'],
    });
  const promptsRebuild =
    !ftsTableMatches(db, 'prompts_fts', PROMPTS_FTS_COLUMNS, 'user_prompts') ||
    !ftsTriggersMatch(db, {
      prompt_fts_insert: ['afterinsertonuser_prompts'],
      prompt_fts_delete: ['beforedeleteonuser_prompts', 'deletefromprompts_ftswhererowid=old.id'],
      prompt_fts_update: ['beforeupdateonuser_prompts', 'deletefromprompts_ftswhererowid=old.id'],
      prompt_fts_update_insert: ['afterupdateonuser_prompts'],
    });

  if (observationsRebuild) {
    db.exec(`
      DROP TRIGGER IF EXISTS obs_fts_insert;
      DROP TRIGGER IF EXISTS obs_fts_update_insert;
      DROP TRIGGER IF EXISTS obs_fts_update;
      DROP TRIGGER IF EXISTS obs_fts_delete;
      DROP TABLE IF EXISTS observations_fts;
      ${OBSERVATIONS_FTS_DEFINITION}
      ${OBSERVATIONS_FTS_TRIGGERS}
      INSERT INTO observations_fts(rowid, title, content, tool_name, type, project, topic_key)
      SELECT id, title, content, tool_name, type, project, topic_key
      FROM observations
      WHERE deleted_at IS NULL;
    `);
  }
  if (promptsRebuild) {
    db.exec(`
      DROP TRIGGER IF EXISTS prompt_fts_insert;
      DROP TRIGGER IF EXISTS prompt_fts_update_insert;
      DROP TRIGGER IF EXISTS prompt_fts_update;
      DROP TRIGGER IF EXISTS prompt_fts_delete;
      DROP TABLE IF EXISTS prompts_fts;
      ${PROMPTS_FTS_DEFINITION}
      ${PROMPTS_FTS_TRIGGERS}
      INSERT INTO prompts_fts(rowid, content, project)
      SELECT id, content, project FROM user_prompts;
    `);
  }
}

/**
 * Lleva el esquema al estado actual. Es idempotente y se ejecuta en cada
 * apertura. Debe llamarse dentro de una transacción.
 * @param {import('./db.js').Database} db
 */
export function migrate(db) {
  db.exec(TABLES_AND_INDEXES);
  for (const { table, column, definition } of COLUMN_MIGRATIONS) {
    addColumnIfNotExists(db, table, column, definition);
  }
  backfillLegacySessionOwnershipModes(db);
  migrateFts(db);
  db.run(
    "INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, ?, datetime('now'))",
    DEFAULT_SYNC_TARGET_KEY,
    SYNC_LIFECYCLE_IDLE,
  );
  // El destino reservado de la bandeja de entrada tiene siempre una fila fija.
  db.run(
    "INSERT OR IGNORE INTO sync_state (target_key, lifecycle, updated_at) VALUES (?, ?, datetime('now'))",
    SYNC_INBOX_TARGET_KEY,
    SYNC_LIFECYCLE_INBOX,
  );
  db.run(
    `UPDATE sync_state
     SET lifecycle = ?, last_enqueued_seq = 0, last_acked_seq = 0, last_pulled_seq = 0
     WHERE target_key = ?
       AND (lifecycle <> ? OR last_enqueued_seq <> 0 OR last_acked_seq <> 0 OR last_pulled_seq <> 0)`,
    SYNC_LIFECYCLE_INBOX,
    SYNC_INBOX_TARGET_KEY,
    SYNC_LIFECYCLE_INBOX,
  );
}

const MANUAL_SESSION_ID_PREFIX = 'manual-save-';

/** ¿El ID `manual-save-<x>` nombra al proyecto? Ambos lados se canonicalizan. */
export function manualSaveOwnerProject(id, project) {
  if (!id.startsWith(MANUAL_SESSION_ID_PREFIX)) return false;
  const canonicalProject = normalizeProject(project).normalized;
  if (canonicalProject === '') return false;
  return normalizeProject(id.slice(MANUAL_SESSION_ID_PREFIX.length)).normalized === canonicalProject;
}

/**
 * Clasifica las filas anteriores a la columna de propiedad. Solo una identidad persistida que
 * demuestre un dueño de guardado manual determinista queda como `project_owned`; nunca se
 * infiere la propiedad solo por el ID. Ambas fases son idempotentes (dependen de un modo NULL).
 * @param {import('./db.js').Database} db
 */
export function backfillLegacySessionOwnershipModes(db) {
  db.run(
    `UPDATE sessions SET ownership_mode = 'shared'
     WHERE ownership_mode IS NULL AND id NOT LIKE 'manual-save-%' AND ifnull(trim(project), '') <> ''`,
  );
  const rows = db.all("SELECT id, ifnull(project, '') AS project FROM sessions WHERE ownership_mode IS NULL AND ifnull(trim(project), '') <> ''");
  for (const row of rows) {
    if (manualSaveOwnerProject(row.id, row.project)) db.run("UPDATE sessions SET ownership_mode = 'project_owned' WHERE id = ? AND ownership_mode IS NULL", row.id);
  }
}

/** @param {import('./db.js').Database} db */
export function readUserVersion(db) {
  return Number(db.get('PRAGMA user_version').user_version);
}

/**
 * Migra al arrancar. Nunca escribe en una base con un esquema más nuevo que el
 * de este programa. La transacción `BEGIN IMMEDIATE` actúa de exclusión mutua
 * entre procesos: SQLite libera el bloqueo si el proceso muere.
 * @param {import('./db.js').Database} db
 * @param {import('./generation.js').DatabaseGeneration} generation
 * @param {(message: string) => void} log
 * @returns {{ futureSchema: boolean }}
 */
export function runStartupMigrations(db, generation, log) {
  return generation.withStartupChecks(() => {
    const futureWarning = (v) =>
      log(`[store] database schema version ${v} is newer than this program's ${SCHEMA_VERSION} — skipping migrations (upgrade odin to manage this database)`);
    if (readUserVersion(db) > SCHEMA_VERSION) {
      futureWarning(readUserVersion(db));
      return { futureSchema: true };
    }
    db.raw.exec(`PRAGMA busy_timeout = ${MIGRATION_BUSY_TIMEOUT_MS}`);
    try {
      return db.writeTransaction(() => {
        // Otro proceso pudo migrar mientras esperábamos el bloqueo.
        const current = readUserVersion(db);
        if (current > SCHEMA_VERSION) {
          futureWarning(current);
          return { futureSchema: true };
        }
        migrate(db);
        if (current < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        return { futureSchema: false };
      });
    } finally {
      db.raw.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    }
  });
}
