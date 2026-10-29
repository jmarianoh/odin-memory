import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { toGoJson } from '../store/backup.js';
import { goTrim } from '../store/text.js';
import { COMPRESSED_MEDIA_TYPE, ENVELOPE_VERSION, MAX_DECODED_BYTES } from './constants.js';

/** Los 8 primeros hexadecimales del SHA-256 de la carga. */
export const chunkId = (payload) => createHash('sha256').update(payload).digest('hex').slice(0, 8);

export const compressedContentType = () => `${COMPRESSED_MEDIA_TYPE}; version=${ENVELOPE_VERSION}`;

export class PayloadTooLargeError extends Error {
  constructor() {
    super('compressed payload exceeds decoded size limit');
    this.name = 'PayloadTooLargeError';
  }
}

export class UnsupportedEnvelopeVersionError extends Error {
  constructor() {
    super('unsupported compressed envelope version');
    this.name = 'UnsupportedEnvelopeVersionError';
  }
}

/** Parámetros `clave=valor` de un tipo de contenido. */
function mediaType(value) {
  const [type, ...rest] = String(value).split(';');
  const params = {};
  for (const part of rest) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    params[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim().replace(/^"|"$/g, '');
  }
  return { type: type.trim().toLowerCase(), params };
}

/**
 * ¿El tipo de contenido es el sobre comprimido? Sin tipo, no. Con el tipo pero otra versión, error.
 * @throws {UnsupportedEnvelopeVersionError}
 */
export function isCompressedContentType(contentType) {
  if (goTrim(contentType ?? '') === '') return false;
  const { type, params } = mediaType(contentType);
  if (type !== COMPRESSED_MEDIA_TYPE) return false;
  if (params.version !== ENVELOPE_VERSION) throw new UnsupportedEnvelopeVersionError();
  return true;
}

/** ¿Acepta el cliente el sobre comprimido (con `q` > 0 si lo indica)? */
export function acceptsCompressed(accept) {
  for (const raw of String(accept ?? '').split(',')) {
    const { type, params } = mediaType(raw);
    if (type !== COMPRESSED_MEDIA_TYPE || params.version !== ENVELOPE_VERSION) continue;
    if ('q' in params) {
      const q = Number(params.q);
      if (!Number.isFinite(q) || q < 0 || q > 1 || q === 0) continue;
    }
    return true;
  }
  return false;
}

export const hasGzipMagic = (buf) => buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;

export const encodeCompressed = (payload) => gzipSync(payload);

/** @throws {PayloadTooLargeError} si lo descomprimido supera `maxBytes` */
export function decodeCompressed(payload, maxBytes = MAX_DECODED_BYTES) {
  if (maxBytes <= 0) throw new Error('decoded size limit must be positive');
  let decoded;
  try {
    decoded = gunzipSync(payload, { maxOutputLength: maxBytes + 1 });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw new PayloadTooLargeError();
    throw new Error(`decode compressed payload: ${err.message}`, { cause: err });
  }
  if (decoded.length > maxBytes) throw new PayloadTooLargeError();
  return decoded;
}

// ─── Canonicalización de un chunk para un proyecto ───────────────────────────

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SUPPORTED = { session: ['upsert', 'delete'], observation: ['upsert', 'delete'], prompt: ['upsert', 'delete'], relation: ['upsert'] };

/** Carga de una mutación: objeto, o una cadena JSON (también anidada). */
export function decodeMutationPayload(payload) {
  const text = goTrim(payload ?? '');
  if (text === '') throw new Error('empty payload');
  const first = JSON.parse(text);
  const value = typeof first === 'string' ? JSON.parse(first) : first;
  if (!isObject(value)) throw new Error('payload must be a JSON object');
  return value;
}

/** Copia con las claves de cada objeto en orden alfabético, como las emite un mapa. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}

/** JSON compacto con las claves ordenadas y `<`, `>`, `&` escapados: la forma canónica de un chunk. */
export const canonicalJson = (value) => toGoJson(sortKeys(value));

const text = (v) => (typeof v === 'string' ? v : '');
const need = (cond, message) => {
  if (!cond) throw new Error(message);
};

// ─── Cargas de mutación con forma de estructura ──────────────────────────────

/**
 * Campos de cada carga, en el orden en que se emiten. Tipos: `string` (ausente o nulo = vacío), `ptr` (cadena
 * opcional), `float` (número opcional), `bool`, `int` y `raw` (JSON tal cual). Con `omit` el campo vacío no sale.
 */
const SESSION_FIELDS = [
  ['id', 'string'], ['project', 'string'], ['ownership_mode', 'string', true], ['directory', 'string', true], ['started_at', 'string', true],
  ['ended_at', 'ptr', true], ['summary', 'ptr', true], ['deleted', 'bool', true], ['deleted_at', 'ptr', true], ['hard_delete', 'bool', true],
];
const OBSERVATION_FIELDS = [
  ['superseded_by_sync_id', 'ptr', true], ['sync_id', 'string'], ['session_id', 'string'], ['type', 'string'], ['title', 'string'], ['content', 'string'],
  ['tool_name', 'ptr', true], ['project', 'ptr', true], ['scope', 'string'], ['topic_key', 'ptr', true], ['revision_count', 'int', true],
  ['duplicate_count', 'int', true], ['last_seen_at', 'ptr', true], ['review_after', 'raw', true], ['created_at', 'string', true], ['updated_at', 'string', true],
  ['deleted', 'bool', true], ['deleted_at', 'ptr', true], ['hard_delete', 'bool', true],
];
const PROMPT_FIELDS = [
  ['sync_id', 'string'], ['session_id', 'string'], ['content', 'string'], ['project', 'ptr', true], ['created_at', 'string', true],
  ['deleted', 'bool', true], ['deleted_at', 'ptr', true], ['hard_delete', 'bool', true],
];
const RELATION_FIELDS = [
  ['sync_id', 'string'], ['source_id', 'string'], ['target_id', 'string'], ['relation', 'string'], ['reason', 'ptr', true], ['evidence', 'ptr', true],
  ['confidence', 'float', true], ['judgment_status', 'string'], ['marked_by_actor', 'ptr', true], ['marked_by_kind', 'ptr', true],
  ['marked_by_model', 'ptr', true], ['session_id', 'ptr', true], ['project', 'string'], ['created_at', 'string', true], ['updated_at', 'string', true],
];
const MUTATION_FIELDS = [
  ['seq', 'int'], ['target_key', 'string'], ['entity', 'string'], ['entity_key', 'string'], ['op', 'string'], ['payload', 'string'], ['source', 'string'],
  ['project', 'string'], ['occurred_at', 'string'], ['acked_at', 'ptr', true], ['disposition', 'string'], ['disposition_reason', 'string', true],
  ['disposition_evidence', 'string', true], ['disposition_at', 'ptr', true],
];

const jsonKind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
const GO_TYPE = { string: 'string', ptr: 'string', bool: 'bool', int: 'int', float: 'float64' };

/** Valor de la clave, con la coincidencia exacta primero y luego sin distinguir mayúsculas, como el decodificador. */
function lookup(obj, name) {
  if (Object.hasOwn(obj, name)) return { found: true, value: obj[name] };
  const lower = name.toLowerCase();
  let hit;
  for (const key of Object.keys(obj)) if (key.toLowerCase() === lower) hit = key;
  return hit === undefined ? { found: false } : { found: true, value: obj[hit] };
}

/** Proyecta un objeto JSON sobre los campos de una estructura, validando los tipos. */
function decodeFields(obj, fields, structName) {
  const out = {};
  for (const [name, kind] of fields) {
    const { found, value } = lookup(obj, name);
    if (!found) continue;
    if (kind === 'raw') {
      out[name] = value;
      continue;
    }
    if (value === null) continue;
    const ok = kind === 'string' || kind === 'ptr' ? typeof value === 'string'
      : kind === 'bool' ? typeof value === 'boolean'
        : kind === 'int' ? Number.isInteger(value)
          : typeof value === 'number';
    if (!ok) throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go struct field ${structName}.${name} of type ${GO_TYPE[kind]}`);
    out[name] = value;
  }
  return out;
}

/** JSON de la estructura: campos en orden, los vacíos con `omit` fuera y `<`, `>`, `&` escapados. */
function encodeFields(values, fields) {
  const parts = [];
  for (const [name, kind, omit] of fields) {
    const has = Object.hasOwn(values, name) && values[name] !== undefined;
    let value;
    if (kind === 'string') value = has ? values[name] : '';
    else if (kind === 'bool') value = has ? values[name] : false;
    else if (kind === 'int') value = has ? values[name] : 0;
    else value = has ? values[name] : null;
    if (omit) {
      if (kind === 'string' && value === '') continue;
      if (kind === 'bool' && value === false) continue;
      if (kind === 'int' && value === 0) continue;
      if ((kind === 'ptr' || kind === 'float') && value === null) continue;
      if (kind === 'raw' && !has) continue;
    }
    parts.push(`${JSON.stringify(name)}:${canonicalJson(value)}`);
  }
  return `{${parts.join(',')}}`;
}

const trimmed = (values, name) => goTrim(text(values[name]));

/** Valida y normaliza la carga de una mutación para el proyecto; devuelve la carga y la clave que le corresponde. */
function normalizeMutationPayload(entity, op, payloadText, project) {
  let obj;
  try {
    obj = decodeMutationPayload(payloadText);
  } catch (err) {
    throw new Error(`decode mutation payload: ${err.message}`);
  }
  const decode = (fields, name) => {
    try {
      return decodeFields(obj, fields, name);
    } catch (err) {
      throw new Error(`decode mutation payload: ${err.message}`);
    }
  };
  switch (entity) {
    case 'session': {
      const body = decode(SESSION_FIELDS, 'mutationSessionPayload');
      if (Object.hasOwn(body, 'directory')) body.directory = goTrim(body.directory);
      need(goTrim(text(body.id)) !== '', 'session payload id is required');
      if (op === 'upsert') {
        if (body.ownership_mode === 'project_owned') need(!('directory' in obj) || typeof obj.directory === 'string', 'pulled session directory is invalid: directory must be a string');
        else need(goTrim(text(body.directory)) !== '', 'session payload directory is required for upsert');
      }
      if (op === 'delete') {
        delete body.directory;
        delete body.started_at;
        delete body.ended_at;
        delete body.summary;
        if (Object.hasOwn(body, 'deleted_at')) body.deleted_at = goTrim(body.deleted_at) === '' ? undefined : goTrim(body.deleted_at);
      }
      body.project = project;
      return { payload: encodeFields(body, SESSION_FIELDS), key: body.id };
    }
    case 'observation': {
      const body = decode(OBSERVATION_FIELDS, 'mutationObservationPayload');
      body.sync_id = trimmed(body, 'sync_id');
      need(body.sync_id !== '', 'observation payload sync_id is required');
      if (op === 'upsert') {
        need(goTrim(text(body.session_id)) !== '', 'observation payload session_id is required for upsert');
        for (const field of ['type', 'title', 'content', 'scope']) {
          body[field] = trimmed(body, field);
          need(body[field] !== '', `observation payload ${field} is required for upsert`);
        }
      }
      body.project = project;
      return { payload: encodeFields(body, OBSERVATION_FIELDS), key: body.sync_id };
    }
    case 'prompt': {
      const body = decode(PROMPT_FIELDS, 'mutationPromptPayload');
      body.sync_id = trimmed(body, 'sync_id');
      need(body.sync_id !== '', 'prompt payload sync_id is required');
      if (op === 'upsert') {
        need(goTrim(text(body.session_id)) !== '', 'prompt payload session_id is required for upsert');
        body.content = trimmed(body, 'content');
        need(body.content !== '', 'prompt payload content is required for upsert');
      }
      body.project = project;
      return { payload: encodeFields(body, PROMPT_FIELDS), key: body.sync_id };
    }
    default: {
      const body = decode(RELATION_FIELDS, 'mutationRelationPayload');
      for (const field of ['sync_id', 'source_id', 'target_id', 'relation', 'judgment_status']) body[field] = trimmed(body, field);
      for (const field of ['marked_by_actor', 'marked_by_kind']) if (Object.hasOwn(body, field)) body[field] = trimmed(body, field);
      for (const field of ['sync_id', 'source_id', 'target_id', 'relation', 'judgment_status']) need(body[field] !== '', `relation payload ${field} is required for upsert`);
      for (const field of ['marked_by_actor', 'marked_by_kind']) need((body[field] ?? '') !== '', `relation payload ${field} is required for upsert`);
      body.project = project;
      return { payload: encodeFields(body, RELATION_FIELDS), key: body.sync_id };
    }
  }
}

function normalizeChunkMutation(raw, project) {
  let mutation;
  try {
    mutation = decodeFields(raw, MUTATION_FIELDS, 'SyncMutation');
  } catch (err) {
    throw new Error(`decode mutation: ${err.message}`);
  }
  mutation.entity = goTrim(text(mutation.entity));
  if (mutation.entity !== 'session') mutation.entity_key = goTrim(text(mutation.entity_key));
  mutation.op = goTrim(text(mutation.op));
  const ops = SUPPORTED[mutation.entity];
  if (!ops?.includes(mutation.op)) throw new Error(`unsupported mutation ${JSON.stringify(mutation.entity)}/${JSON.stringify(mutation.op)}`);
  const payloadText = goTrim(text(mutation.payload));
  need(payloadText !== '', 'payload is required');
  const { payload, key } = normalizeMutationPayload(mutation.entity, mutation.op, payloadText, project);
  if (text(mutation.entity_key) === '') mutation.entity_key = key;
  if (mutation.entity_key !== key) throw new Error(`entity_key ${JSON.stringify(mutation.entity_key)} does not match payload key ${JSON.stringify(key)}`);
  mutation.project = project;
  mutation.payload = payload;
  return JSON.parse(encodeFields(mutation, MUTATION_FIELDS));
}

/** Identificadores de las sesiones que declaran las mutaciones de sesión (clave y carga). */
function sessionMutationKeys(mutations) {
  const keys = new Set();
  for (const m of mutations) {
    if (!isObject(m) || goTrim(text(m.entity)) !== 'session' || !['upsert', 'delete'].includes(goTrim(text(m.op)))) continue;
    if (goTrim(text(m.entity_key)) !== '') keys.add(m.entity_key);
    const payload = goTrim(text(m.payload));
    if (payload === '') continue;
    try {
      const id = decodeFields(decodeMutationPayload(payload), SESSION_FIELDS, 'mutationSessionPayload').id;
      if (goTrim(text(id)) !== '') keys.add(id);
    } catch {
      // una carga ilegible se rechaza al normalizar la mutación
    }
  }
  return keys;
}

/** Sesiones a las que se refieren las observaciones, los prompts y las altas de observaciones y prompts por mutación. */
function requiredSessionKeys(doc, mutations) {
  const keys = new Set();
  for (const key of ['observations', 'prompts']) {
    for (const row of Array.isArray(doc[key]) ? doc[key] : []) if (isObject(row) && goTrim(text(row.session_id)) !== '') keys.add(row.session_id);
  }
  for (const m of mutations) {
    if (!isObject(m) || goTrim(text(m.op)) !== 'upsert') continue;
    const entity = goTrim(text(m.entity));
    const payload = goTrim(text(m.payload));
    if (payload === '' || (entity !== 'observation' && entity !== 'prompt')) continue;
    try {
      const fields = entity === 'observation' ? OBSERVATION_FIELDS : PROMPT_FIELDS;
      const id = decodeFields(decodeMutationPayload(payload), fields, 'mutationPayload').session_id;
      if (goTrim(text(id)) !== '') keys.add(id);
    } catch {
      // una carga ilegible se rechaza al normalizar la mutación
    }
  }
  return keys;
}

/**
 * Deja el chunk con un único proyecto: el de la inscripción. Las filas de sesiones, observaciones y
 * prompts toman ese proyecto (con una lista de mutaciones, una sesión solo si alguna mutación la
 * trae o algo la necesita) y cada mutación se valida y se normaliza.
 * @param {Buffer|string} payload JSON del chunk
 * @param {string} project
 * @returns {string} JSON canónico
 * @throws {Error} con el motivo si el chunk no es válido
 */
export function canonicalizeForProject(payload, project) {
  let doc;
  try {
    doc = JSON.parse(String(payload));
  } catch (err) {
    throw new Error(`decode chunk data: ${err.message}`);
  }
  if (!isObject(doc)) throw new Error('decode chunk data: chunk must be a JSON object');
  const hasMutationList = 'mutations' in doc;
  const rawMutations = hasMutationList ? (doc.mutations ?? []) : [];
  if (hasMutationList && !Array.isArray(rawMutations)) throw new Error('mutations must be an array');
  const ownedBySession = hasMutationList ? sessionMutationKeys(rawMutations) : new Set();
  const required = hasMutationList ? requiredSessionKeys(doc, rawMutations) : new Set();

  for (const key of ['sessions', 'observations', 'prompts']) {
    if (!(key in doc)) continue;
    if (doc[key] === null) {
      doc[key] = [];
      continue;
    }
    if (!Array.isArray(doc[key])) throw new Error(`${key} must be an array`);
    doc[key] = doc[key].map((row, i) => {
      if (!isObject(row)) throw new Error(`${key}[${i}] must be an object`);
      if (key === 'sessions') {
        if (row.ownership_mode === 'project_owned') need(!('directory' in row) || typeof row.directory === 'string', `sessions[${i}]: pulled session directory is invalid: directory must be a string`);
        const id = text(row.id);
        if (!hasMutationList || goTrim(id) === '' || ownedBySession.has(id) || required.has(id)) return { ...row, project };
        return row;
      }
      return { ...row, project };
    });
  }
  if (hasMutationList) {
    doc.mutations = rawMutations.map((row, i) => {
      if (!isObject(row)) throw new Error(`mutations[${i}] must be an object`);
      try {
        return normalizeChunkMutation(row, project);
      } catch (err) {
        throw new Error(`mutations[${i}]: ${err.message}`);
      }
    });
  }
  return canonicalJson(doc);
}

/** Comparación de cargas por valor: igual JSON, sin importar espacios ni el orden de las claves. */
export function normalizeJson(payload) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  try {
    return JSON.stringify(sort(JSON.parse(String(payload))));
  } catch {
    return String(payload);
  }
}

/** Recuento de sesiones, observaciones y prompts de un chunk. */
export function summarizeChunk(payload) {
  try {
    const doc = JSON.parse(String(payload));
    const count = (k) => (Array.isArray(doc?.[k]) ? doc[k].length : 0);
    return { sessions: count('sessions'), observations: count('observations'), prompts: count('prompts') };
  } catch {
    return { sessions: 0, observations: 0, prompts: 0 };
  }
}

/**
 * Comprueba que cada sesión a la que se refiere el chunk está en el chunk o ya la conoce el servidor.
 * @param {object} chunk el chunk analizado (con `sessions`, `observations`, `prompts` y `mutations`)
 * @param {Set<string>} known sesiones que el servidor ya tiene del proyecto
 * @throws {Error} con la fila y el motivo
 */
export function validateChunkSessionReferences(chunk, known) {
  const inChunk = new Set();
  (chunk.sessions ?? []).forEach((s, i) => {
    if (goTrim(text(s?.id)) === '') throw new Error(`sessions[${i}].id is required`);
    inChunk.add(s.id);
  });
  const payloadOf = (m, i) => {
    try {
      return decodeMutationPayload(m.payload);
    } catch (err) {
      throw new Error(`mutations[${i}] invalid payload: ${err.message}`);
    }
  };
  (chunk.mutations ?? []).forEach((m, i) => {
    if (m.entity !== 'session' || m.op !== 'upsert') return;
    let id = text(payloadOf(m, i).id);
    if (goTrim(id) === '') id = text(m.entity_key);
    if (goTrim(id) === '') throw new Error(`mutations[${i}].payload.id is required for session upsert`);
    inChunk.add(id);
  });
  const has = (id) => inChunk.has(id) || known.has(id);
  const check = (what, i, id) => {
    const session = text(id);
    if (goTrim(session) === '') throw new Error(`${what}[${i}].session_id is required`);
    if (!has(session)) throw new Error(`${what}[${i}] references missing session_id ${JSON.stringify(session)}`);
  };
  (chunk.observations ?? []).forEach((o, i) => check('observations', i, o.session_id));
  (chunk.prompts ?? []).forEach((p, i) => check('prompts', i, p.session_id));
  (chunk.mutations ?? []).forEach((m, i) => {
    if (m.entity !== 'observation' && m.entity !== 'prompt') return;
    const session = text(payloadOf(m, i).session_id);
    if (m.op !== 'upsert') return;
    if (goTrim(session) === '') throw new Error(`mutations[${i}].payload.session_id is required for upsert`);
    if (!has(session)) throw new Error(`mutations[${i}] references missing session_id ${JSON.stringify(session)}`);
  });
}
