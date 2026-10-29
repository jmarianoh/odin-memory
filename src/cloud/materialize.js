import { chunkId as hashChunkId, MUTATION_FIELDS, canonicalJson, canonicalizeForProject, decodeFields, decodeMutationPayload, encodeFields, jsonKind, normalizeJson } from './codec.js';
import { goTrim } from '../store/text.js';

/**
 * Pasa los chunks de la nube a mutaciones: cada chunk guardado deja en el diario del servidor
 * (`cloud_mutations`) las mutaciones que contiene, y cada lote de mutaciones empujado deja un chunk
 * equivalente en `cloud_chunks`. Así las dos vías de sincronización ven los mismos datos.
 */

const SESSION_ROW = [
  ['id', 'string'], ['project', 'string'], ['ownership_mode', 'string', true], ['directory', 'string'], ['started_at', 'string'],
  ['ended_at', 'ptr', true], ['summary', 'ptr', true],
];
const OBSERVATION_ROW = [
  ['id', 'int'], ['sync_id', 'string'], ['session_id', 'string'], ['type', 'string'], ['title', 'string'], ['content', 'string'],
  ['tool_name', 'ptr', true], ['project', 'ptr', true], ['scope', 'string'], ['topic_key', 'ptr', true], ['revision_count', 'int'],
  ['duplicate_count', 'int'], ['last_seen_at', 'ptr', true], ['review_after', 'ptr', true], ['superseded_by_sync_id', 'ptr', true],
  ['created_at', 'string'], ['updated_at', 'string'], ['deleted_at', 'ptr', true],
];
const PROMPT_ROW = [
  ['source_inbox_id', 'string', true], ['id', 'int'], ['sync_id', 'string'], ['session_id', 'string'], ['content', 'string'],
  ['project', 'string', true], ['created_at', 'string'],
];
const ROWS = {
  sessions: { fields: SESSION_ROW, struct: 'Session' },
  observations: { fields: OBSERVATION_ROW, struct: 'Observation' },
  prompts: { fields: PROMPT_ROW, struct: 'Prompt' },
  mutations: { fields: MUTATION_FIELDS, struct: 'SyncMutation' },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const GO_ROW = { sessions: 'store.Session', observations: 'store.Observation', prompts: 'store.Prompt', mutations: 'store.SyncMutation' };

export const SYNC_ENTITY = Object.freeze({ session: 'session', observation: 'observation', prompt: 'prompt', relation: 'relation' });

/** Clave de entidad: la de una sesión se respeta byte a byte; las demás se recortan. */
export const mutationEntityKey = (entity, key) => (goTrim(entity) === 'session' ? key : goTrim(key ?? ''));

/** ¿La entidad viaja en los chunks? */
export const isChunkMaterializableEntity = (entity) => ['session', 'observation', 'prompt', 'relation'].includes(goTrim(entity ?? ''));

/**
 * Decodifica un chunk con los campos tipados de cada fila (lo que descarta o rechaza el decodificador
 * tipado de la referencia).
 * @param {string|Buffer} payload JSON del chunk
 * @returns {{ sessions: object[], observations: object[], prompts: object[], mutations: object[] }}
 * @throws {Error}
 */
export function parseTypedChunk(payload) {
  const doc = JSON.parse(String(payload));
  if (!isObject(doc)) throw new Error(`json: cannot unmarshal ${jsonKind(doc)} into Go value of type sync.ChunkData`);
  const out = {};
  for (const [key, { fields, struct }] of Object.entries(ROWS)) {
    const value = doc[key];
    if (value === undefined || value === null) {
      out[key] = [];
      continue;
    }
    if (!Array.isArray(value)) throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go struct field ChunkData.${key} of type []${GO_ROW[key]}`);
    out[key] = value.map((row) => {
      if (row === null) return {};
      if (!isObject(row)) throw new Error(`json: cannot unmarshal ${jsonKind(row)} into Go struct field ChunkData.${key} of type ${GO_ROW[key]}`);
      try {
        return decodeFields(row, fields, struct);
      } catch (err) {
        throw new Error(err.message.replace(/Go struct field (\w+)\.(\w+)/, `Go struct field $1.${key}.$2`));
      }
    });
  }
  for (const [i, session] of (doc.sessions ?? []).entries()) {
    if (isObject(session) && session.ownership_mode === 'project_owned' && 'directory' in session && typeof session.directory !== 'string') {
      throw new Error(`sessions[${i}]: pulled session directory is invalid: directory must be a string`);
    }
  }
  return out;
}

/** La fila con los campos de su estructura y los vacíos con `omit` fuera. */
const rowJson = (row, fields) => encodeFields(row, fields);

/** Carga de una mutación de relación: todos los campos obligatorios son cadenas no vacías. */
export function validateRelationPayload(payloadText) {
  let fields;
  try {
    fields = JSON.parse(payloadText);
  } catch {
    return { field: 'sync_id', ok: false };
  }
  if (!isObject(fields)) return { field: 'sync_id', ok: false };
  for (const field of ['sync_id', 'source_id', 'target_id', 'relation', 'judgment_status', 'marked_by_actor', 'marked_by_kind']) {
    if (!(field in fields)) return { field, ok: false };
    if (typeof fields[field] !== 'string' || goTrim(fields[field]) === '') return { field, ok: false };
  }
  return { field: '', ok: true };
}

/** Sesión que describe una mutación; sin id en la carga toma la clave de entidad. */
export function sessionFromMutation(entry) {
  let obj;
  try {
    obj = decodeMutationPayload(entry.payload);
  } catch (err) {
    throw new Error(err.message);
  }
  const session = decodeFields(obj, SESSION_ROW, 'Session');
  if (goTrim(text(session.id)) === '') session.id = entry.entity_key;
  return session;
}

function decodeRaw(entry, fields, struct) {
  let value;
  try {
    value = JSON.parse(entry.payload);
  } catch (err) {
    throw new Error(err.message);
  }
  if (!isObject(value)) throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go value of type store.${struct}`);
  return decodeFields(value, fields, struct);
}

/** Rechaza altas mal formadas y bajas de sesión cuya identidad no coincide con la clave. */
function validateMaterializedPayload(entry) {
  if (entry.op === 'upsert' && goTrim(entry.payload) === 'null') throw new Error('payload must be a JSON object');
  let identity;
  let field;
  switch (entry.entity) {
    case 'session':
      identity = sessionFromMutation(entry).id;
      field = 'id';
      break;
    case 'observation':
      identity = text(decodeRaw(entry, OBSERVATION_ROW, 'Observation').sync_id);
      field = 'sync_id';
      break;
    case 'prompt':
      identity = text(decodeRaw(entry, PROMPT_ROW, 'Prompt').sync_id);
      field = 'sync_id';
      break;
    default:
      return;
  }
  if (entry.entity !== 'session') identity = goTrim(identity);
  if (identity !== '' && identity !== entry.entity_key) throw new Error(`payload.${field} ${JSON.stringify(identity)} does not match entity_key ${JSON.stringify(entry.entity_key)}`);
}

/**
 * Normaliza una mutación de chunk antes de materializarla.
 * @param {string} project
 * @param {{ entity?: string, entity_key?: string, op?: string, payload?: string }} mutation
 * @returns {{ project: string, entity: string, entity_key: string, op: string, payload: string }|null} `null` si no se materializa
 * @throws {Error}
 */
export function materializeChunkMutation(project, mutation) {
  const entity = goTrim(text(mutation.entity));
  if (!isChunkMaterializableEntity(entity)) return null;
  let op = goTrim(text(mutation.op));
  if (op === '') op = 'upsert';
  if (entity !== 'relation' && op !== 'upsert' && op !== 'delete') return null;
  const entityKey = mutationEntityKey(entity, text(mutation.entity_key));
  if (goTrim(entityKey) === '') throw new Error(`entity_key is required for ${entity}`);
  let payload = goTrim(text(mutation.payload));
  if (payload === '') payload = '{}';
  if (entity === 'relation') {
    const { field, ok } = validateRelationPayload(payload);
    if (!ok) throw new Error(`payload.${field} is required for relation`);
  }
  const entry = { project: goTrim(project), entity, entity_key: entityKey, op, payload };
  if (op === 'upsert' || (entity === 'session' && op === 'delete')) {
    try {
      validateMaterializedPayload(entry);
    } catch (err) {
      throw new Error(`invalid ${entity} ${op} payload: ${err.message}`);
    }
  }
  return entry;
}

/**
 * Mutaciones que deja en el diario un chunk subido entero: las altas tipadas de sus listas y las de su
 * lista de mutaciones (sin repetir un alta ya presente en las listas; las bajas van después).
 * @param {string} project
 * @param {ReturnType<typeof parseTypedChunk>} chunk
 */
export function chunkMaterializedMutations(project, chunk) {
  const name = goTrim(project);
  const entries = [];
  const typed = new Set();
  const addTyped = (entry) => {
    entries.push(entry);
    typed.add(`${entry.entity}\0${entry.entity_key}`);
  };
  chunk.sessions.forEach((session, i) => {
    if (goTrim(text(session.id)) === '') throw new Error(`cloudstore: materialize chunk: sessions[${i}].id is required`);
    addTyped({ project: name, entity: 'session', entity_key: session.id, op: 'upsert', payload: rowJson(session, SESSION_ROW) });
  });
  chunk.observations.forEach((o, i) => {
    const key = goTrim(text(o.sync_id));
    if (key === '') throw new Error(`cloudstore: materialize chunk: observations[${i}].sync_id is required`);
    addTyped({ project: name, entity: 'observation', entity_key: key, op: 'upsert', payload: rowJson(o, OBSERVATION_ROW) });
  });
  chunk.prompts.forEach((p, i) => {
    const key = goTrim(text(p.sync_id));
    if (key === '') throw new Error(`cloudstore: materialize chunk: prompts[${i}].sync_id is required`);
    addTyped({ project: name, entity: 'prompt', entity_key: key, op: 'upsert', payload: rowJson(p, PROMPT_ROW) });
  });
  chunk.mutations.forEach((mutation, i) => {
    let entry;
    try {
      entry = materializeChunkMutation(name, mutation);
    } catch (err) {
      throw new Error(`cloudstore: materialize chunk: mutations[${i}].${err.message}`);
    }
    if (entry === null) return;
    if (entry.op === 'upsert' && typed.has(`${entry.entity}\0${entry.entity_key}`)) return;
    entries.push(entry);
  });
  return entries;
}

/**
 * Un chunk por proyecto con las mutaciones de un lote, más las filas tipadas de sus altas.
 * @param {{ project: string, entity: string, entity_key: string, op: string, payload: string, created_by?: string }[]} batch
 * @returns {{ project: string, id: string, created_by: string, payload: string, counts: { sessions: number, observations: number, prompts: number } }[]}
 */
export function mutationBatchChunks(batch) {
  const groups = new Map();
  batch.forEach((entry, i) => {
    const project = goTrim(entry.project);
    if (project === '') throw new Error(`cloudstore: materialize mutation batch: entries[${i}].project is required`);
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(entry);
  });
  const chunks = [];
  for (const [project, entries] of groups) {
    const built = batchChunk(entries);
    if (built === null) continue;
    chunks.push({ project, id: hashChunkId(built.payload), created_by: goTrim(entries[0].created_by ?? ''), payload: built.payload, counts: built.counts });
  }
  return chunks;
}

function batchChunk(batch) {
  const project = goTrim(batch[0].project);
  const chunk = { sessions: [], observations: [], prompts: [], mutations: [] };
  batch.forEach((entry, i) => {
    let materialized;
    try {
      materialized = materializeChunkMutation(goTrim(entry.project), { entity: entry.entity, entity_key: entry.entity_key, op: entry.op, payload: entry.payload });
    } catch (err) {
      throw new Error(`cloudstore: materialize mutation batch entry ${i}: ${err.message}`);
    }
    if (materialized === null) return;
    chunk.mutations.push({ project: materialized.project, entity: materialized.entity, entity_key: materialized.entity_key, op: materialized.op, payload: materialized.payload });
    if (materialized.op !== 'upsert') return;
    const label = (what) => `cloudstore: materialize mutation batch ${what} ${JSON.stringify(materialized.entity_key)}`;
    if (materialized.entity === 'session') {
      try {
        chunk.sessions.push(sessionFromMutation(materialized));
      } catch (err) {
        throw new Error(`${label('session')}: ${err.message}`);
      }
    } else if (materialized.entity === 'observation') {
      const o = decodeOrFail(materialized, OBSERVATION_ROW, 'Observation', label('observation'));
      if (goTrim(text(o.sync_id)) === '') o.sync_id = materialized.entity_key;
      chunk.observations.push(o);
    } else if (materialized.entity === 'prompt') {
      const p = decodeOrFail(materialized, PROMPT_ROW, 'Prompt', label('prompt'));
      if (goTrim(text(p.sync_id)) === '') p.sync_id = materialized.entity_key;
      chunk.prompts.push(p);
    }
  });
  if (chunk.mutations.length === 0) return null;
  const doc = {
    sessions: chunk.sessions.map((s) => JSON.parse(rowJson(s, SESSION_ROW))),
    observations: chunk.observations.map((o) => JSON.parse(rowJson(o, OBSERVATION_ROW))),
    prompts: chunk.prompts.map((p) => JSON.parse(rowJson(p, PROMPT_ROW))),
    mutations: chunk.mutations.map((m) => JSON.parse(rowJson({ ...m, disposition: '' }, MUTATION_FIELDS))),
  };
  let payload;
  try {
    payload = canonicalizeForProject(JSON.stringify(doc), project);
  } catch (err) {
    throw new Error(`cloudstore: canonicalize materialized mutation batch chunk: ${err.message}`);
  }
  return { payload, counts: { sessions: chunk.sessions.length, observations: chunk.observations.length, prompts: chunk.prompts.length } };
}

function decodeOrFail(entry, fields, struct, label) {
  try {
    return decodeRaw(entry, fields, struct);
  } catch (err) {
    throw new Error(`${label}: ${err.message}`);
  }
}

/** Firma de una mutación de chunk: proyecto, entidad, clave, operación y carga por valor. */
export function mutationSignature(mutation) {
  const payloadText = goTrim(text(mutation.payload));
  let normalized = normalizeJson(payloadText);
  try {
    JSON.parse(normalized);
  } catch {
    throw new Error('payload is not valid JSON');
  }
  normalized = canonicalJson(JSON.parse(normalized));
  return [goTrim(text(mutation.project)), goTrim(text(mutation.entity)), mutationEntityKey(mutation.entity, text(mutation.entity_key)), goTrim(text(mutation.op)), normalized].join('\0');
}

/** Firma de una fila del diario del servidor, pasada antes por la canonicalización de chunks. */
export function entrySignature(entry) {
  const project = goTrim(entry.project);
  if (project === '') throw new Error('project is required');
  const payload = entry.payload === '' || entry.payload === undefined ? '{}' : entry.payload;
  const doc = { sessions: null, observations: null, prompts: null, mutations: [JSON.parse(rowJson({
    project, entity: goTrim(entry.entity), entity_key: mutationEntityKey(entry.entity, entry.entity_key), op: goTrim(entry.op), payload, disposition: '',
  }, MUTATION_FIELDS))] };
  const canonical = JSON.parse(canonicalizeForProject(JSON.stringify(doc), project));
  if (canonical.mutations.length !== 1) throw new Error(`expected one canonical mutation, got ${canonical.mutations.length}`);
  return mutationSignature(canonical.mutations[0]);
}
