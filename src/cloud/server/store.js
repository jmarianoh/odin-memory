import { decodeMutationPayload, normalizeJson, summarizeChunk } from '../codec.js';
import { goTrim } from '../../store/text.js';
import { isUniqueViolation } from './db.js';

/** Un chunk con ese identificador ya existe con otra carga. */
export class ChunkConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChunkConflictError';
  }
}

export class ChunkNotFoundInCloud extends Error {
  constructor(chunkId) {
    super(`cloudstore: chunk not found: ${JSON.stringify(chunkId)}`);
    this.name = 'ChunkNotFoundInCloud';
  }
}

export const AUDIT_ACTION_CHUNK_PUSH = 'chunk_push';
export const AUDIT_OUTCOME_REJECTED_PROJECT_PAUSED = 'rejected_project_paused';

const DDL = [
  `CREATE TABLE IF NOT EXISTS cloud_chunks (
    project_name TEXT NOT NULL DEFAULT 'default',
    chunk_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    client_created_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload JSONB NOT NULL,
    sessions_count INTEGER NOT NULL DEFAULT 0,
    observations_count INTEGER NOT NULL DEFAULT 0,
    prompts_count INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS cloud_chunks_project_chunk_uidx ON cloud_chunks (project_name, chunk_id)',
  `CREATE TABLE IF NOT EXISTS cloud_project_sessions (
    project_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_name, session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_project_controls (
    project       TEXT PRIMARY KEY,
    sync_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    paused_reason TEXT,
    updated_by    TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_cloud_project_controls_enabled ON cloud_project_controls(sync_enabled)',
  `CREATE TABLE IF NOT EXISTS cloud_mutations (
    seq        BIGSERIAL PRIMARY KEY,
    project    TEXT NOT NULL,
    entity     TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    op         TEXT NOT NULL,
    payload    JSONB NOT NULL DEFAULT '{}',
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_cloud_mutations_project ON cloud_mutations(project)',
  'CREATE INDEX IF NOT EXISTS idx_cloud_mutations_seq ON cloud_mutations(seq)',
  `CREATE TABLE IF NOT EXISTS cloud_sync_audit_log (
    id           SERIAL PRIMARY KEY,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    contributor  TEXT NOT NULL,
    project      TEXT NOT NULL,
    action       TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    entry_count  INT NOT NULL DEFAULT 0,
    reason_code  TEXT,
    metadata     JSONB
  )`,
  'CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON cloud_sync_audit_log (occurred_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_audit_log_contributor_project ON cloud_sync_audit_log (contributor, project)',
  'CREATE INDEX IF NOT EXISTS idx_audit_log_outcome ON cloud_sync_audit_log (outcome)',
];

/** Identificadores de las sesiones que un chunk declara (filas y mutaciones de sesión). */
export function collectSessionIds(chunk) {
  const ids = new Set();
  for (const s of chunk.sessions ?? []) if (goTrim(s?.id ?? '') !== '') ids.add(s.id);
  for (const m of chunk.mutations ?? []) {
    if (m?.entity !== 'session' || m?.op !== 'upsert') continue;
    let id = '';
    try {
      id = decodeMutationPayload(m.payload).id;
    } catch {
      continue;
    }
    if (typeof id !== 'string' || goTrim(id) === '') id = m.entity_key;
    if (typeof id === 'string' && goTrim(id) !== '') ids.add(id);
  }
  return ids;
}

const rfc3339 = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Almacén de la nube sobre Postgres: chunks por proyecto, controles y auditoría. */
export class CloudStore {
  /** @param {import('./db.js').Database} db */
  constructor(db) {
    this.db = db;
  }

  async migrate() {
    for (const statement of DDL) await this.db.query(statement);
  }

  close() {
    return this.db.close();
  }

  /** Manifiesto v2 de los chunks del proyecto, por orden de llegada. */
  async readManifest(project) {
    const rows = await this.db.query(
      `SELECT chunk_id, created_by, COALESCE(client_created_at, created_at) AS manifest_created_at, sessions_count, observations_count, prompts_count
       FROM cloud_chunks WHERE project_name = $1 ORDER BY created_at ASC, chunk_id ASC`,
      [project],
    );
    return {
      version: 2,
      chunks: rows.map((r) => ({
        id: r.chunk_id,
        created_by: r.created_by,
        created_at: rfc3339(r.manifest_created_at),
        sessions: r.sessions_count,
        memories: r.observations_count,
        prompts: r.prompts_count,
      })),
    };
  }

  /** La carga del chunk tal como la devuelve Postgres (`jsonb::text`). */
  async readChunk(project, chunkId) {
    const rows = await this.db.query('SELECT payload::text AS payload FROM cloud_chunks WHERE project_name = $1 AND chunk_id = $2', [project, goTrim(chunkId)]);
    if (rows.length === 0) throw new ChunkNotFoundInCloud(chunkId);
    return rows[0].payload;
  }

  /** Sesiones que el servidor ya conoce del proyecto. */
  async knownSessionIds(project) {
    const rows = await this.db.query('SELECT session_id FROM cloud_project_sessions WHERE project_name = $1', [project]);
    return new Set(rows.map((r) => r.session_id).filter((id) => goTrim(id) !== ''));
  }

  /**
   * Guarda un chunk. Repetir el mismo chunk es inocuo; el mismo identificador con otra carga es un conflicto.
   * @param {string} payload JSON canónico
   * @param {string} clientCreatedAt RFC 3339 o vacío
   * @throws {ChunkConflictError}
   */
  async writeChunk(project, chunkId, createdBy, clientCreatedAt, payload) {
    const chunk = JSON.parse(payload);
    const sessionIds = collectSessionIds(chunk);
    const existing = await this.db.query('SELECT payload::text AS payload FROM cloud_chunks WHERE project_name = $1 AND chunk_id = $2', [project, chunkId]);
    if (existing.length > 0) {
      this.#assertSamePayload(chunkId, payload, existing[0].payload);
      await this.#indexSessions(this.db, project, sessionIds);
      return;
    }
    const counts = summarizeChunk(payload);
    const originCreatedAt = goTrim(clientCreatedAt) === '' ? null : new Date(clientCreatedAt);
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO cloud_chunks (project_name, chunk_id, created_by, client_created_at, payload, sessions_count, observations_count, prompts_count)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [project, goTrim(chunkId), goTrim(createdBy), originCreatedAt, payload, counts.sessions, counts.observations, counts.prompts],
        );
        await this.#indexSessions(tx, project, sessionIds);
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Otra petición lo insertó entre la lectura y la escritura.
      const again = await this.db.query('SELECT payload::text AS payload FROM cloud_chunks WHERE project_name = $1 AND chunk_id = $2', [project, chunkId]);
      if (again.length === 0) throw new ChunkConflictError(`existing chunk ${JSON.stringify(chunkId)} was concurrently inserted`);
      this.#assertSamePayload(chunkId, payload, again[0].payload);
    }
  }

  #assertSamePayload(chunkId, incoming, existing) {
    if (normalizeJson(incoming) !== normalizeJson(existing)) throw new ChunkConflictError(`existing chunk ${JSON.stringify(chunkId)} has different payload`);
  }

  async #indexSessions(runner, project, sessionIds) {
    for (const id of sessionIds) {
      await runner.query('INSERT INTO cloud_project_sessions (project_name, session_id) VALUES ($1, $2) ON CONFLICT (project_name, session_id) DO NOTHING', [project, id]);
    }
  }

  /** Sin fila de control, la sincronización está activa. */
  async isProjectSyncEnabled(project) {
    const rows = await this.db.query('SELECT sync_enabled FROM cloud_project_controls WHERE project = $1', [goTrim(project)]);
    return rows.length === 0 ? true : rows[0].sync_enabled;
  }

  async setProjectSyncEnabled(project, enabled, updatedBy = '', reason = '') {
    await this.db.query(
      `INSERT INTO cloud_project_controls (project, sync_enabled, paused_reason, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (project) DO UPDATE SET sync_enabled = EXCLUDED.sync_enabled, paused_reason = EXCLUDED.paused_reason, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [goTrim(project), enabled, enabled ? null : goTrim(reason) || null, goTrim(updatedBy) || null],
    );
  }

  async insertAuditEntry({ contributor, project, action, outcome, entryCount = 0, reasonCode = '', metadata = null }) {
    const reason = goTrim(reasonCode);
    const hasMetadata = metadata !== null && Object.keys(metadata).length > 0;
    await this.db.query(
      `INSERT INTO cloud_sync_audit_log (contributor, project, action, outcome, entry_count, reason_code, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [contributor, project, action, outcome, entryCount, reason === '' ? null : reason, hasMetadata ? JSON.stringify(metadata) : null],
    );
  }
}
