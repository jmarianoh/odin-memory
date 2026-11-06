/** Versión del esquema (`PRAGMA user_version`). */
export const SCHEMA_VERSION = 1;

/** Destino de sincronización por defecto. */
export const DEFAULT_SYNC_TARGET_KEY = 'cloud';
/** Destino reservado de la bandeja de entrada de Cloud. */
export const SYNC_INBOX_TARGET_KEY = 'cloud:inbox';

export const SYNC_LIFECYCLE_IDLE = 'idle';
export const SYNC_LIFECYCLE_PENDING = 'pending';
export const SYNC_LIFECYCLE_RUNNING = 'running';
export const SYNC_LIFECYCLE_HEALTHY = 'healthy';
export const SYNC_LIFECYCLE_DEGRADED = 'degraded';
export const SYNC_LIFECYCLE_INBOX = 'inbox';

/** Columnas de observations_fts, en orden. */
export const OBSERVATIONS_FTS_COLUMNS = ['title', 'content', 'tool_name', 'type', 'project', 'topic_key'];
/** Columnas de prompts_fts, en orden. */
export const PROMPTS_FTS_COLUMNS = ['content', 'project'];

export const OBSERVATIONS_FTS_DEFINITION = `
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title,
  content,
  tool_name,
  type,
  project,
  topic_key,
  tokenize='trigram remove_diacritics 1',
  content='observations',
  content_rowid='id'
);
`;

export const PROMPTS_FTS_DEFINITION = `
CREATE VIRTUAL TABLE prompts_fts USING fts5(
  content,
  project,
  tokenize='trigram remove_diacritics 1',
  content='user_prompts',
  content_rowid='id'
);
`;

// Las sentencias DELETE ordinarias (en lugar del comando especial 'delete' de FTS5)
// son deliberadas: con el tokenizador trigram ese comando no es seguro.
export const OBSERVATIONS_FTS_TRIGGERS = `
CREATE TRIGGER obs_fts_insert AFTER INSERT ON observations
WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO observations_fts(rowid, title, content, tool_name, type, project, topic_key)
  VALUES (new.id, new.title, new.content, new.tool_name, new.type, new.project, new.topic_key);
END;

CREATE TRIGGER obs_fts_delete BEFORE DELETE ON observations
WHEN old.deleted_at IS NULL BEGIN
  DELETE FROM observations_fts WHERE rowid = old.id;
END;

CREATE TRIGGER obs_fts_update BEFORE UPDATE ON observations
WHEN old.deleted_at IS NULL BEGIN
  DELETE FROM observations_fts WHERE rowid = old.id;
END;

CREATE TRIGGER obs_fts_update_insert AFTER UPDATE ON observations
WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO observations_fts(rowid, title, content, tool_name, type, project, topic_key)
  VALUES (new.id, new.title, new.content, new.tool_name, new.type, new.project, new.topic_key);
END;
`;

export const PROMPTS_FTS_TRIGGERS = `
CREATE TRIGGER prompt_fts_insert AFTER INSERT ON user_prompts BEGIN
  INSERT INTO prompts_fts(rowid, content, project)
  VALUES (new.id, new.content, new.project);
END;

CREATE TRIGGER prompt_fts_delete BEFORE DELETE ON user_prompts BEGIN
  DELETE FROM prompts_fts WHERE rowid = old.id;
END;

CREATE TRIGGER prompt_fts_update BEFORE UPDATE ON user_prompts BEGIN
  DELETE FROM prompts_fts WHERE rowid = old.id;
END;

CREATE TRIGGER prompt_fts_update_insert AFTER UPDATE ON user_prompts BEGIN
  INSERT INTO prompts_fts(rowid, content, project)
  VALUES (new.id, new.content, new.project);
END;
`;

/**
 * Tablas e índices (sin FTS). Todo es idempotente (`IF NOT EXISTS`). El orden de
 * las columnas es parte del contrato: coincide con el esquema de referencia.
 */
export const TABLES_AND_INDEXES = `
CREATE TABLE IF NOT EXISTS project_aliases (
  kind TEXT NOT NULL CHECK (kind IN ('key', 'cwd')),
  alias_key TEXT NOT NULL,
  project TEXT NOT NULL,
  PRIMARY KEY (kind, alias_key)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  ownership_mode TEXT,
  directory  TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT,
  summary    TEXT,
  runtime_lease_expires_at TEXT,
  local_creation_project TEXT
);

CREATE TABLE IF NOT EXISTS session_finalizations (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary_id INTEGER NOT NULL,
  summary_sync_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id    TEXT,
  session_id TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  tool_name  TEXT,
  project    TEXT,
  scope      TEXT    NOT NULL DEFAULT 'project',
  topic_key  TEXT,
  normalized_hash TEXT,
  revision_count INTEGER NOT NULL DEFAULT 1,
  duplicate_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  pinned     BOOLEAN NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, review_after TEXT, superseded_by_sync_id TEXT, expires_at TEXT, embedding BLOB, embedding_model TEXT, embedding_created_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS observation_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  title          TEXT,
  content        TEXT NOT NULL,
  version        INTEGER NOT NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(observation_id, version)
);

CREATE TABLE IF NOT EXISTS observation_save_operations (
  operation_id     TEXT    NOT NULL PRIMARY KEY,
  fingerprint      TEXT    NOT NULL,
  observation_id   INTEGER,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS user_prompts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id    TEXT,
  source_inbox_id TEXT,
  local_creation_session_id TEXT,
  local_creation_inbox_id TEXT,
  local_creation_project TEXT,
  session_id TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  project    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS memory_relations (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id                   TEXT    NOT NULL UNIQUE,
  source_id                 TEXT,
  target_id                 TEXT,
  relation                  TEXT    NOT NULL DEFAULT 'pending',
  reason                    TEXT,
  evidence                  TEXT,
  confidence                REAL,
  judgment_status           TEXT    NOT NULL DEFAULT 'pending',
  marked_by_actor           TEXT,
  marked_by_kind            TEXT,
  marked_by_model           TEXT,
  session_id                TEXT,
  superseded_at             TEXT,
  superseded_by_relation_id INTEGER REFERENCES memory_relations(id) ON DELETE SET NULL,
  created_at                TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS capture_project_provenance (
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source TEXT NOT NULL,
  directory TEXT NOT NULL DEFAULT '',
  raw_project TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (entity_kind, entity_id)
);

CREATE TABLE IF NOT EXISTS review_clear_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  sync_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_tombstones (
  sync_id    TEXT PRIMARY KEY,
  source_inbox_id TEXT,
  local_creation_session_id TEXT,
  local_creation_inbox_id TEXT,
  local_creation_project TEXT,
  session_id TEXT,
  project    TEXT,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_source_confirmations (
  remote_target TEXT NOT NULL CHECK(length(trim(remote_target)) > 0),
  sync_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_inbox_id TEXT NOT NULL,
  prompt_project TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('live','deleted')),
  asserted_owner_project TEXT NOT NULL,
  remote_attestation_id INTEGER NOT NULL CHECK(remote_attestation_id > 0),
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (remote_target, sync_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  target_key           TEXT PRIMARY KEY,
  lifecycle            TEXT NOT NULL DEFAULT 'idle',
  last_enqueued_seq    INTEGER NOT NULL DEFAULT 0,
  last_acked_seq       INTEGER NOT NULL DEFAULT 0,
  last_pulled_seq      INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  backoff_until        TEXT,
  lease_owner          TEXT,
  lease_until          TEXT,
  last_error           TEXT,
  last_success_at      TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
, reason_code TEXT, reason_message TEXT);

CREATE TABLE IF NOT EXISTS sync_mutations (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  target_key  TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_key  TEXT NOT NULL,
  op          TEXT NOT NULL,
  payload     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'local',
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  acked_at    TEXT,
  disposition TEXT NOT NULL DEFAULT 'pending',
  disposition_reason TEXT,
  disposition_evidence TEXT,
  disposition_at TEXT, project TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (target_key) REFERENCES sync_state(target_key)
);

CREATE TABLE IF NOT EXISTS sync_chunks (
  target_key  TEXT NOT NULL DEFAULT 'local',
  chunk_id    TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (target_key, chunk_id)
);

CREATE TABLE IF NOT EXISTS sync_enrolled_projects (
  project     TEXT PRIMARY KEY,
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_delete_tombstones (
  entity      TEXT NOT NULL,
  entity_key  TEXT NOT NULL,
  session_id  TEXT,
  project     TEXT NOT NULL DEFAULT '',
  deleted_at        TEXT NOT NULL DEFAULT (datetime('now')),
  hard_delete       BOOLEAN NOT NULL DEFAULT 1,
  active                   BOOLEAN NOT NULL DEFAULT 1,
  last_mutation_seq        INTEGER NOT NULL DEFAULT 0,
  last_remote_mutation_seq INTEGER, superseded_by_sync_id TEXT,
  PRIMARY KEY (entity, entity_key)
);

CREATE TABLE IF NOT EXISTS sync_delete_tombstone_remote_floors (
  target_key        TEXT NOT NULL,
  entity            TEXT NOT NULL,
  entity_key        TEXT NOT NULL,
  last_mutation_seq INTEGER NOT NULL,
  PRIMARY KEY (target_key, entity, entity_key)
);

CREATE TABLE IF NOT EXISTS sync_apply_deferred (
  sync_id           TEXT    PRIMARY KEY,
  entity            TEXT    NOT NULL,
  payload           TEXT    NOT NULL,
  target_key        TEXT    NOT NULL DEFAULT '',
  remote_seq        INTEGER NOT NULL DEFAULT 0,
  entity_key        TEXT    NOT NULL DEFAULT '',
  op                TEXT    NOT NULL DEFAULT '',
  reason_code       TEXT    NOT NULL DEFAULT '',
  project           TEXT    NOT NULL DEFAULT '',
  scope_class       TEXT    NOT NULL DEFAULT 'legacy_unscoped',
  apply_status      TEXT    NOT NULL DEFAULT 'deferred',
  retry_count       INTEGER NOT NULL DEFAULT 0,
  payload_sync_id   TEXT    NOT NULL DEFAULT '',
  last_error        TEXT,
  last_attempted_at TEXT,
  first_seen_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cloud_upgrade_state (
  project            TEXT PRIMARY KEY,
  stage              TEXT NOT NULL DEFAULT 'planned',
  repair_class       TEXT NOT NULL DEFAULT 'none',
  snapshot_json      TEXT NOT NULL DEFAULT '{}',
  last_error_code    TEXT,
  last_error_message TEXT,
  findings_json      TEXT,
  applied_actions    TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_obs_session  ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_type     ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_project  ON observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_created  ON observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_scope ON observations(scope);
CREATE INDEX IF NOT EXISTS idx_obs_sync_id ON observations(sync_id);
CREATE INDEX IF NOT EXISTS idx_obs_project_lower ON observations(LOWER(project));
CREATE INDEX IF NOT EXISTS idx_sessions_project_lower ON sessions(LOWER(project));
CREATE INDEX IF NOT EXISTS idx_prompts_project_lower ON user_prompts(LOWER(project));
CREATE INDEX IF NOT EXISTS idx_obs_topic ON observations(topic_key, project, scope, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_deleted ON observations(deleted_at);
CREATE INDEX IF NOT EXISTS idx_obs_dedupe ON observations(normalized_hash, project, scope, type, title, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_save_op_created
  ON observation_save_operations(created_at);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON user_prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_prompts_project ON user_prompts(project);
CREATE INDEX IF NOT EXISTS idx_prompts_created ON user_prompts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompts_sync_id ON user_prompts(sync_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_source_inbox ON user_prompts(session_id, source_inbox_id) WHERE source_inbox_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memrel_source    ON memory_relations(source_id, judgment_status);
CREATE INDEX IF NOT EXISTS idx_memrel_target    ON memory_relations(target_id, judgment_status);
CREATE INDEX IF NOT EXISTS idx_memrel_status_created
  ON memory_relations(judgment_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memrel_supersede ON memory_relations(superseded_by_relation_id);
CREATE INDEX IF NOT EXISTS idx_prompt_tombstones_inbox ON prompt_tombstones(session_id, source_inbox_id) WHERE source_inbox_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prompt_tombstones_project ON prompt_tombstones(project, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_mutations_target_seq ON sync_mutations(target_key, seq);
CREATE INDEX IF NOT EXISTS idx_sync_mutations_pending ON sync_mutations(target_key, acked_at, seq);
CREATE INDEX IF NOT EXISTS idx_sync_mutations_project ON sync_mutations(project);
CREATE INDEX IF NOT EXISTS idx_sync_mutations_lookup ON sync_mutations(target_key, entity, entity_key, source);
CREATE INDEX IF NOT EXISTS idx_sync_mutations_transport ON sync_mutations(target_key, disposition, acked_at, seq);
CREATE INDEX IF NOT EXISTS idx_sync_delete_tombstones_project ON sync_delete_tombstones(project, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_sad_payload_sync
  ON sync_apply_deferred(payload_sync_id, entity);
CREATE INDEX IF NOT EXISTS idx_sad_scope_status_seen
  ON sync_apply_deferred(target_key, project, apply_status, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_sad_status_seen
  ON sync_apply_deferred(apply_status, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_cloud_upgrade_state_stage ON cloud_upgrade_state(stage);
`;
