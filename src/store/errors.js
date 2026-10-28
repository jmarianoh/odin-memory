/** El archivo de base de datos fue reemplazado mientras el proceso estaba en marcha. */
export class DatabaseGenerationChangedError extends Error {
  constructor() {
    super('Database generation changed; restart odin');
    this.name = 'DatabaseGenerationChangedError';
    this.code = 'database_generation_changed';
  }
}

/** El directorio de datos está en un sistema de archivos remoto (WAL inseguro). */
export class NetworkFilesystemError extends Error {
  /**
   * @param {string} dataDir
   * @param {string} filesystem
   */
  constructor(dataDir, filesystem) {
    super(
      `odin-memory: data directory "${dataDir}" is on ${filesystem}; persistent SQLite WAL is unsafe on network filesystems — set ODIN_DATA_DIR to a local directory`,
    );
    this.name = 'NetworkFilesystemError';
    this.code = 'network_filesystem';
    this.dataDir = dataDir;
    this.filesystem = filesystem;
  }
}

/** Error de uso del store con código estable. */
export class StoreError extends Error {
  /**
   * @param {string} code identificador estable en snake_case
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** Mensajes base de los errores de uso del store, indexados por `code`. */
const MESSAGES = {
  session_not_found: 'session not found',
  session_id_required: 'session id is required',
  session_already_ended: 'session has already ended',
  observation_not_found: 'observation not found',
  prompt_not_found: 'prompt not found',
  project_required: 'project identity is required',
  invalid_session_ownership_mode: 'invalid session ownership mode',
  session_ownership_mismatch: 'session ownership does not match write project',
  project_ownership_ambiguous: 'session project ownership is ambiguous',
  expected_project_required: 'expected_project must be a valid non-empty project name',
  observation_project_mismatch: 'expected_project does not match observation owner',
  observation_project_immutable: 'observation project cannot be reassigned',
  observation_title_required: 'observation title is required',
  observation_content_required: 'observation content is required',
  observation_operation_conflict: 'observation operation id conflicts with a different payload',
  observation_operation_expired: 'observation operation id is outside the replay horizon',
  observation_find_replace_pair_required: 'find and replace must be provided together',
  observation_find_replace_content_conflict: 'find and replace cannot be combined with content',
  observation_find_replace_input_too_large: 'find and replace inputs exceed maximum observation length',
  observation_find_replace_result_too_large: 'replacement result exceeds maximum observation length',
  observation_find_replace_legacy_content_large: 'cannot partially replace oversized legacy observation',
  prompt_content_required: 'prompt content is required',
  prompt_inbox_deleted: 'prompt inbox identity was deleted',
  pulled_prompt_identity_invalid: 'pulled prompt identity is invalid',
  invalid_match_mode: 'invalid match_mode',
  search_failed: 'search',
  cross_project_relation: 'relation rejected: source and target observations are in different projects',
  invalid_project_name: 'invalid project name',
  project_not_found: 'project not found',
  project_name_required: 'project name must not be empty',
  project_prune_blocked: 'project still has observations',
  invalid_project_merge: 'invalid project merge',
  consolidate_need_two_sources: 'consolidate needs at least two source observations',
  consolidate_duplicate_id: 'consolidate source list contains duplicate ids',
  consolidate_missing_observation: 'consolidate source missing or already deleted',
  consolidate_cross_project: 'consolidate sources span multiple projects',
  consolidate_provenance_cycle: 'consolidate provenance cycle detected',
  consolidate_fingerprint_mismatch: 'consolidate sources changed since plan; re-plan required',
  invalid_project_alias: 'invalid project alias',
  passive_capture_failed: 'passive capture save',
  relation_not_found: 'relation not found',
  invalid_relation_verb: 'invalid relation verb',
  invalid_confidence: 'invalid confidence',
  relation_endpoint_required: 'relation endpoint is required',
  sync_journal_unavailable: 'sync journal is not available for enrolled projects yet',
};

/**
 * Crea un StoreError con el mensaje base del código y, opcionalmente, un detalle
 * (`<mensaje base>: <detalle>`).
 * @param {keyof typeof MESSAGES} code
 * @param {string} [detail]
 * @returns {StoreError}
 */
export function storeError(code, detail) {
  const base = MESSAGES[code];
  return new StoreError(code, detail ? `${base}: ${detail}` : base);
}

/** La sesión pertenece a otro proyecto y no admite la escritura solicitada. */
export class SessionProjectConflictError extends StoreError {
  /**
   * @param {string} sessionId
   * @param {string} ownerProject
   * @param {string} requestedProject
   */
  constructor(sessionId, ownerProject, requestedProject) {
    super(
      'session_ownership_mismatch',
      `${MESSAGES.session_ownership_mismatch}: session ${JSON.stringify(sessionId)} belongs to ${JSON.stringify(ownerProject)}, not ${JSON.stringify(requestedProject)}`,
    );
    this.name = 'SessionProjectConflictError';
    this.sessionId = sessionId;
    this.ownerProject = ownerProject;
    this.requestedProject = requestedProject;
  }
}
