import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { canonicalizeProjectName, normalizeProject } from '../../project/canonical.js';
import { goTrim } from '../../store/text.js';
import { BodyTooLargeError, sendJson, sendText } from '../../server/http.js';
import { Router } from '../../server/router.js';
import {
  PayloadTooLargeError, UnsupportedEnvelopeVersionError, acceptsCompressed, canonicalizeForProject, chunkId as hashChunkId, compressedContentType,
  decodeCompressed, hasGzipMagic, isCompressedContentType, validateChunkSessionReferences,
} from '../codec.js';
import { MAX_DECODED_BYTES, REASON, UPGRADE_ERROR_CLASS, UPGRADE_ERROR_CODE } from '../constants.js';
import { parseTypedChunk, validateRelationPayload } from '../materialize.js';
import { canonicalMutationEntry } from './mutations.js';
import { DEFAULT_MAX_PUSH_BODY_BYTES } from './config.js';
import { AUDIT_ACTION_CHUNK_PUSH, AUDIT_ACTION_MUTATION_PUSH, AUDIT_OUTCOME_REJECTED_PROJECT_PAUSED, ChunkConflictError, ChunkNotFoundInCloud, MutationBatchEntryError } from './store.js';
import { validateChunkRows } from './validate.js';

const SERVICE_NAME = 'odin-cloud';
const digest = (value) => createHash('sha256').update(goTrim(value)).digest();

/** ¿`presented` es el secreto esperado? Compara resúmenes en tiempo constante. */
function tokenEquals(presented, expected) {
  if (goTrim(presented) === '' || goTrim(expected) === '') return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Lista de proyectos permitidos; `*` los admite todos. */
export class ProjectAllowlist {
  /** @param {string[]} projects */
  constructor(projects) {
    this.all = false;
    this.allowed = new Set();
    for (const project of projects) {
      if (goTrim(project) === '*') {
        this.all = true;
        this.allowed.clear();
        return;
      }
      const name = goTrim(normalizeProject(project).normalized);
      if (name !== '') this.allowed.add(name);
    }
  }

  /** Proyectos permitidos, ordenados; `null` si se admiten todos (sin filtro). */
  enrolled() {
    return this.all ? null : [...this.allowed].sort();
  }

  /** @returns {boolean} */
  allows(project) {
    const name = goTrim(normalizeProject(project).normalized);
    if (name === '') return false;
    return this.all || this.allowed.has(name);
  }
}

/** Respuesta JSON de un objeto libre: las claves salen por orden alfabético, como en un mapa. */
const sendMap = (res, status, fields) => sendJson(res, status, Object.fromEntries(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

const MAX_MUTATION_BATCH = 100;
const DEFAULT_PULL_LIMIT = 100;

const actionable = (res, status, errorClass, errorCode, message) => sendMap(res, status, { error_class: errorClass, error_code: errorCode, error: goTrim(message) });

/** Cuerpo completo con tope de bytes. */
function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      fn(value);
    };
    req.on('data', (part) => {
      size += part.length;
      if (size > limit) {
        parts.length = 0;
        finish(reject, new BodyTooLargeError());
        req.resume();
        return;
      }
      parts.push(part);
    });
    req.on('end', () => finish(resolve, Buffer.concat(parts)));
    req.on('error', (err) => finish(reject, err));
    req.on('aborted', () => finish(reject, new Error('unexpected EOF')));
  });
}

/**
 * Entradas de un lote de mutaciones. Cada carga se conserva como el texto JSON recibido.
 * @returns {{ entries: { project: string, entity: string, entity_key: string, op: string, payload: string }[], createdBy: string }}
 */
function parseMutationEnvelope(body) {
  const doc = JSON.parse(body);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('json: cannot unmarshal into Go value of type cloudserver.mutationPushEnvelope');
  if (doc.created_by !== undefined && doc.created_by !== null && typeof doc.created_by !== 'string') throw new Error('json: cannot unmarshal into Go struct field mutationPushEnvelope.created_by of type string');
  const createdBy = doc.created_by ?? '';
  const list = doc.entries;
  if (list === undefined || list === null) return { entries: [], createdBy };
  if (!Array.isArray(list)) throw new Error('json: cannot unmarshal into Go struct field mutationPushEnvelope.entries of type []cloudstore.MutationEntry');
  const entries = list.map((raw) => {
    const row = raw ?? {};
    if (typeof row !== 'object' || Array.isArray(row)) throw new Error('json: cannot unmarshal into Go struct field mutationPushEnvelope.entries of type cloudstore.MutationEntry');
    for (const key of ['project', 'entity', 'entity_key', 'op']) {
      if (row[key] !== undefined && row[key] !== null && typeof row[key] !== 'string') throw new Error(`json: cannot unmarshal into Go struct field MutationEntry.entries.${key} of type string`);
    }
    return {
      project: row.project ?? '', entity: row.entity ?? '', entity_key: row.entity_key ?? '', op: row.op ?? '',
      payload: row.payload === undefined ? '' : JSON.stringify(row.payload),
    };
  });
  return { entries, createdBy };
}

/** Sobre de una subida: campos de texto opcionales y la carga `data`. */
function parsePushRequest(text) {
  const doc = JSON.parse(text);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('json: cannot unmarshal into Go value of type cloudserver.chunkPushRequest');
  for (const key of ['chunk_id', 'created_by', 'client_created_at', 'project']) {
    if (doc[key] !== undefined && doc[key] !== null && typeof doc[key] !== 'string') throw new Error(`json: cannot unmarshal into Go struct field chunkPushRequest.${key} of type string`);
  }
  return doc;
}

/**
 * Servidor HTTP de la nube: `/health` y la sincronización por chunks (`/sync/pull`, `/sync/pull/{id}`, `/sync/push`).
 */
export class CloudServer {
  /**
   * @param {import('./store.js').CloudStore} store
   * @param {object} options
   * @param {string[]} options.allowedProjects `*` admite todos; vacía no admite ninguno
   * @param {string} [options.token] secreto de sincronización; vacío = sin autenticación
   * @param {string} [options.adminToken] secreto de administración; también autentica
   * @param {number} [options.port] 0 = puerto libre
   * @param {string} [options.host]
   * @param {number} [options.maxPushBodyBytes]
   * @param {(message: string) => void} [options.log]
   */
  constructor(store, options) {
    this.store = store;
    this.allowlist = new ProjectAllowlist(options.allowedProjects);
    this.token = goTrim(options.token ?? '');
    this.adminToken = goTrim(options.adminToken ?? '');
    this.port = options.port ?? 8080;
    this.host = goTrim(options.host ?? '') || '127.0.0.1';
    this.maxPushBodyBytes = options.maxPushBodyBytes > 0 ? options.maxPushBodyBytes : DEFAULT_MAX_PUSH_BODY_BYTES;
    this.log = options.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.router = new Router();
    this.router.add('GET /health', { handler: (c) => this.#health(c), auth: false });
    this.router.add('GET /sync/pull', { handler: (c) => this.#pullManifest(c), auth: true });
    this.router.add('GET /sync/pull/{chunkID}', { handler: (c) => this.#pullChunk(c), auth: true });
    this.router.add('POST /sync/push', { handler: (c) => this.#pushChunk(c), auth: true });
    this.router.add('POST /sync/mutations/push', { handler: (c) => this.#pushMutations(c), auth: true });
    this.router.add('GET /sync/mutations/pull', { handler: (c) => this.#pullMutations(c), auth: true });
    this.http = createServer((req, res) => {
      this.#serve(req, res).catch((err) => {
        this.log(`[odin-cloud] unexpected request error: ${err?.stack ?? err}`);
        if (res.headersSent) res.destroy();
        else sendText(res, 500, 'internal error');
      });
    });
    this.http.requestTimeout = 0;
  }

  /** @returns {Promise<import('node:net').AddressInfo>} */
  listen() {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, this.host, () => {
        this.http.off('error', reject);
        this.log(`[odin-cloud] listening on ${this.host}:${this.http.address().port}`);
        resolve(this.http.address());
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }

  /**
   * @returns {{ failure: string|null, principal: string }} el motivo del rechazo (o `null` si la petición
   * está autenticada) y el nombre con que se anotan sus escrituras
   */
  #authenticate(req) {
    if (this.token === '') return { failure: null, principal: '' };
    const header = goTrim(req.headers.authorization ?? '');
    if (header === '') return { failure: 'missing authorization header', principal: '' };
    const fields = header.split(/\s+/);
    if (fields.length !== 2 || fields[0].toLowerCase() !== 'bearer') return { failure: 'authorization must use Bearer token', principal: '' };
    if (tokenEquals(fields[1], this.token)) return { failure: null, principal: 'LEGACY_SYNC' };
    if (tokenEquals(fields[1], this.adminToken)) return { failure: null, principal: 'OPERATOR' };
    return { failure: 'unknown token', principal: '' };
  }

  async #serve(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const found = this.router.match(req.method ?? 'GET', url.pathname);
    if (found.kind === 'none') {
      req.resume();
      sendText(res, 404, '404 page not found');
      return;
    }
    if (found.kind === 'method') {
      req.resume();
      sendText(res, 405, 'Method Not Allowed', { Allow: found.allow.join(', ') });
      return;
    }
    const { handler, auth } = found.route.handler;
    let principal = '';
    if (auth) {
      const outcome = this.#authenticate(req);
      if (outcome.failure !== null) {
        req.resume();
        sendText(res, 401, `unauthorized: ${outcome.failure}`);
        return;
      }
      principal = outcome.principal;
    }
    await handler({ req, res, query: url.searchParams, params: found.params, principal });
  }

  #health({ res }) {
    sendMap(res, 200, { status: 'ok', service: SERVICE_NAME });
  }

  /** Proyecto canónico de la consulta; responde el error y devuelve `null` si falta. */
  #projectFromQuery({ res, query }) {
    const project = goTrim(normalizeProject(goTrim(query.get('project') ?? '')).normalized);
    if (project === '') {
      actionable(res, 400, UPGRADE_ERROR_CLASS.blocked, UPGRADE_ERROR_CODE.projectRequired, 'project is required');
      return null;
    }
    return project;
  }

  /** @returns {boolean} `false` si el proyecto no está permitido (ya respondido) */
  #authorizeProject(res, project) {
    if (this.allowlist.allows(project)) return true;
    this.log(`[odin-cloud] project authorization denied: project=${JSON.stringify(project)}`);
    actionable(res, 403, UPGRADE_ERROR_CLASS.policy, REASON.policyForbidden, `forbidden: project ${JSON.stringify(project)} is not allowed`);
    return false;
  }

  async #pullManifest(ctx) {
    const project = this.#projectFromQuery(ctx);
    if (project === null || !this.#authorizeProject(ctx.res, project)) return;
    let manifest;
    try {
      manifest = await this.store.readManifest(project);
    } catch (err) {
      sendText(ctx.res, 500, `read manifest: ${err.message}`);
      return;
    }
    sendJson(ctx.res, 200, manifest);
  }

  async #pullChunk(ctx) {
    const { req, res, params } = ctx;
    const project = this.#projectFromQuery(ctx);
    if (project === null || !this.#authorizeProject(res, project)) return;
    const chunkId = goTrim(params.chunkID ?? '');
    if (chunkId === '') {
      sendText(res, 400, 'chunkID is required');
      return;
    }
    let payload;
    try {
      payload = await this.store.readChunk(project, chunkId);
    } catch (err) {
      sendText(res, err instanceof ChunkNotFoundInCloud ? 404 : 500, `read chunk: ${err.message}`);
      return;
    }
    const body = Buffer.from(payload);
    const headers = { 'Cache-Control': 'no-store', Vary: 'Accept' };
    if (acceptsCompressed(req.headers.accept ?? '') && body.length <= MAX_DECODED_BYTES) {
      res.writeHead(200, { ...headers, 'Content-Type': compressedContentType() });
      res.end(gzipSync(body));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(body);
  }

  async #pushChunk({ req, res, query }) {
    const limit = this.maxPushBodyBytes;
    const invalid = (message) => actionable(res, 400, UPGRADE_ERROR_CLASS.repairable, UPGRADE_ERROR_CODE.payloadInvalid, message);
    const tooLarge = (message) => actionable(res, 413, UPGRADE_ERROR_CLASS.repairable, UPGRADE_ERROR_CODE.payloadTooLarge, message);
    const contentType = req.headers['content-type'] ?? '';
    let compressed;
    try {
      compressed = isCompressedContentType(contentType);
    } catch (err) {
      if (!(err instanceof UnsupportedEnvelopeVersionError)) throw err;
      req.resume();
      actionable(res, 415, UPGRADE_ERROR_CLASS.repairable, UPGRADE_ERROR_CODE.payloadInvalid, `unsupported push payload: ${err.message}`);
      return;
    }
    let request;
    try {
      const raw = await readBuffer(req, limit);
      let text;
      if (compressed || hasGzipMagic(raw)) {
        if (!compressed) this.log(`[odin-cloud] push body is a gzip stream but Content-Type is ${JSON.stringify(contentType)}; sniffing and decoding as compressed envelope`);
        text = decodeCompressed(raw, limit).toString('utf8');
      } else {
        text = raw.toString('utf8');
      }
      request = parsePushRequest(text);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return tooLarge(`push payload too large (max ${limit} bytes)`);
      if (err instanceof PayloadTooLargeError) return tooLarge(`decoded push payload too large (max ${limit} bytes)`);
      return invalid(`invalid push payload: ${err.message} (content-type: ${JSON.stringify(contentType)})`);
    }
    if (request.data === undefined) return invalid('data is required');
    let project = goTrim(request.project ?? '');
    if (project === '') project = goTrim(query.get('project') ?? '');
    project = goTrim(normalizeProject(project).normalized);
    if (project === '') return actionable(res, 400, UPGRADE_ERROR_CLASS.blocked, UPGRADE_ERROR_CODE.projectRequired, 'project is required');
    if (!this.#authorizeProject(res, project)) return;

    try {
      if (!(await this.store.isProjectSyncEnabled(project))) return await this.#rejectPaused(res, project, request);
    } catch (err) {
      return actionable(res, 500, UPGRADE_ERROR_CLASS.blocked, UPGRADE_ERROR_CODE.internal, `check project control: ${err.message}`);
    }

    let normalized;
    let chunk;
    try {
      normalized = canonicalizeForProject(JSON.stringify(request.data), project);
    } catch (err) {
      return invalid(`invalid push payload: ${err.message}`);
    }
    try {
      chunk = parseTypedChunk(normalized);
    } catch (err) {
      return invalid(`invalid push payload: chunk schema: ${err.message}`);
    }
    try {
      validateChunkRows(chunk);
    } catch (err) {
      return invalid(`invalid push payload: ${err.message}`);
    }
    let known;
    try {
      known = await this.store.knownSessionIds(project);
    } catch (err) {
      return actionable(res, 500, UPGRADE_ERROR_CLASS.blocked, UPGRADE_ERROR_CODE.internal, `validate push payload: ${err.message}`);
    }
    try {
      validateChunkSessionReferences(chunk, known);
    } catch (err) {
      return invalid(`invalid push payload: ${err.message}`);
    }
    const computed = hashChunkId(normalized);
    const provided = goTrim(request.chunk_id ?? '');
    if (provided !== '' && provided !== computed) {
      this.log(`[odin-cloud] chunk_id mismatch for project ${JSON.stringify(project)}: client=${JSON.stringify(provided)} server=${JSON.stringify(computed)}; accepting server-canonicalized payload`);
    }
    const clientCreatedAt = goTrim(request.client_created_at ?? '');
    if (clientCreatedAt !== '' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(clientCreatedAt)) return invalid('client_created_at must be RFC3339');
    try {
      await this.store.writeChunk(project, computed, request.created_by ?? '', clientCreatedAt, normalized);
    } catch (err) {
      if (err instanceof ChunkConflictError) return actionable(res, 409, UPGRADE_ERROR_CLASS.repairable, UPGRADE_ERROR_CODE.chunkConflict, `write chunk: ${err.message}`);
      return actionable(res, 500, UPGRADE_ERROR_CLASS.blocked, UPGRADE_ERROR_CODE.internal, `write chunk: ${err.message}`);
    }
    sendMap(res, 200, { status: 'ok', chunk_id: computed });
  }

  // ─── Mutaciones ──────────────────────────────────────────────────────────

  async #pushMutations({ req, res, principal }) {
    const limit = this.maxPushBodyBytes;
    let body;
    try {
      body = (await readBuffer(req, limit)).toString('utf8');
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        actionable(res, 413, UPGRADE_ERROR_CLASS.repairable, UPGRADE_ERROR_CODE.payloadTooLarge, `push payload too large (max ${limit} bytes)`);
        return;
      }
      sendText(res, 400, `invalid request body: ${err.message}`);
      return;
    }
    let entries;
    let envelopeCreatedBy;
    try {
      ({ entries, createdBy: envelopeCreatedBy } = parseMutationEnvelope(body));
    } catch (err) {
      sendText(res, 400, `invalid request body: ${err.message}`);
      return;
    }
    if (entries.length > MAX_MUTATION_BATCH) {
      sendText(res, 400, `batch too large: max ${MAX_MUTATION_BATCH} entries per request`);
      return;
    }
    if (entries.length === 0) {
      actionable(res, 400, UPGRADE_ERROR_CLASS.repairable, 'empty_batch', 'mutation batch must contain at least one entry');
      return;
    }
    for (const entry of entries) {
      if (goTrim(entry.project) === '') {
        actionable(res, 400, 'invalid_request', 'empty_project', 'mutation entries must specify a project');
        return;
      }
      entry.project = canonicalizeProjectName(entry.project);
    }
    const seen = new Set();
    for (const entry of entries) {
      if (seen.has(entry.project)) continue;
      seen.add(entry.project);
      if (!this.#authorizeProject(res, entry.project)) return;
    }
    const primary = entries[0].project;
    for (const entry of entries) {
      let enabled;
      try {
        enabled = await this.store.isProjectSyncEnabled(entry.project);
      } catch (err) {
        sendText(res, 500, `check project sync: ${err.message}`);
        return;
      }
      if (enabled) continue;
      await this.#audit({ contributor: goTrim(envelopeCreatedBy) || 'unknown', project: entry.project, action: AUDIT_ACTION_MUTATION_PUSH, entryCount: entries.length }, 'mutation push');
      sendMap(res, 409, {
        error_class: UPGRADE_ERROR_CLASS.policy, error_code: 'sync-paused', error: `sync is paused for project ${JSON.stringify(entry.project)}`,
        project: primary, project_source: 'request_body', project_path: '',
      });
      return;
    }
    const createdBy = principal === '' ? 'unknown' : principal;
    const invalidEntries = [];
    const normalized = [];
    entries.forEach((entry, index) => {
      const entity = goTrim(entry.entity);
      const bad = (field) => invalidEntries.push({ entity, field, index });
      if (entity === 'relation') {
        const { field, ok } = validateRelationPayload(entry.payload);
        if (!ok) return bad(field);
      }
      try {
        normalized.push({ ...canonicalMutationEntry(entry), created_by: createdBy });
      } catch {
        bad('payload');
      }
    });
    if (invalidEntries.length > 0) {
      sendMap(res, 400, {
        error_class: UPGRADE_ERROR_CLASS.repairable, error_code: UPGRADE_ERROR_CODE.payloadInvalid, error: 'invalid mutation payload', reason_code: 'validation_error', invalid: invalidEntries,
      });
      return;
    }
    let seqs;
    try {
      seqs = await this.store.insertMutationBatch(normalized);
    } catch (err) {
      if (err instanceof MutationBatchEntryError) {
        this.log(`cloudserver: mutation push rejected: batch_index=${err.batchIndex} entity=${JSON.stringify(err.entity.slice(0, 64))} entity_key=${JSON.stringify(err.entityKey.slice(0, 64))}`);
        sendText(res, 500, `insert mutations: batch_index=${err.batchIndex} entity=${JSON.stringify(err.entity.slice(0, 64))} entity_key=${JSON.stringify(err.entityKey.slice(0, 64))}`);
      } else {
        this.log('cloudserver: mutation push rejected');
        sendText(res, 500, 'insert mutations failed');
      }
      return;
    }
    sendMap(res, 200, { accepted_seqs: seqs, project: primary, project_source: 'request_body', project_path: '' });
  }

  async #pullMutations({ res, query }) {
    const sinceRaw = goTrim(query.get('since_seq') ?? '');
    let sinceSeq = 0;
    if (sinceRaw !== '' && /^[+-]?\d+$/.test(sinceRaw)) sinceSeq = Number(sinceRaw);
    const limitRaw = goTrim(query.get('limit') ?? '');
    let limit = DEFAULT_PULL_LIMIT;
    if (limitRaw !== '' && /^[+-]?\d+$/.test(limitRaw) && Number(limitRaw) > 0) limit = Math.min(Number(limitRaw), DEFAULT_PULL_LIMIT);
    const allowed = this.allowlist.enrolled();
    const primary = allowed !== null && allowed.length > 0 ? allowed[0] : '';
    let page;
    try {
      page = await this.store.listMutationsSince(sinceSeq, limit, allowed);
    } catch (err) {
      sendText(res, 500, `list mutations: ${err.message}`);
      return;
    }
    sendMap(res, 200, { mutations: page.mutations, has_more: page.has_more, latest_seq: page.latest_seq, project: primary, project_source: 'request_body', project_path: '' });
  }

  /** Anota una auditoría; un fallo solo se registra en el log. */
  async #audit(entry, what) {
    try {
      await this.store.insertAuditEntry({ ...entry, outcome: AUDIT_OUTCOME_REJECTED_PROJECT_PAUSED, reasonCode: 'sync-paused' });
    } catch (err) {
      this.log(`[odin-cloud] audit insert failed (${what}): ${err.message}`);
    }
  }

  async #rejectPaused(res, project, request) {
    const contributor = goTrim(request.created_by ?? '') || 'unknown';
    try {
      await this.store.insertAuditEntry({
        contributor, project, action: AUDIT_ACTION_CHUNK_PUSH, outcome: AUDIT_OUTCOME_REJECTED_PROJECT_PAUSED, reasonCode: 'sync-paused',
      });
    } catch (err) {
      this.log(`[odin-cloud] audit insert failed (chunk push): ${err.message}`);
    }
    sendMap(res, 409, {
      error_class: UPGRADE_ERROR_CLASS.policy,
      error_code: 'sync-paused',
      error: `sync is paused for project ${JSON.stringify(project)}`,
      project,
      project_source: 'request_body',
      project_path: '',
    });
  }
}
