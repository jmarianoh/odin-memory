import { goTrim } from '../store/text.js';
import {
  canonicalizeForProject, chunkId as hashChunkId, compressedContentType, decodeCompressed, encodeCompressed, isCompressedContentType,
} from './codec.js';
import { MAX_DECODED_BYTES } from './constants.js';
import { ChunkNotFoundError } from '../sync/transport.js';

export const ORDINARY_TIMEOUT_MS = 30_000;
export const WRITE_CHUNK_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;

/** Respuesta de error de la nube con su clasificación. */
export class HttpStatusError extends Error {
  constructor({ operation, statusCode, errorClass = '', errorCode = '', body = '' }) {
    super(`cloud: ${operation}: status ${statusCode}: ${goTrim(body)}`);
    this.name = 'HttpStatusError';
    this.operation = operation;
    this.statusCode = statusCode;
    this.errorClass = errorClass;
    this.errorCode = errorCode;
    this.body = body;
  }

  get isAuthFailure() {
    return this.statusCode === 401;
  }

  get isPolicyFailure() {
    return this.statusCode === 403;
  }

  get isRepairable() {
    return goTrim(this.errorClass).toLowerCase() === 'repairable';
  }
}

/** Construye el error con el sobre `{error_class, error_code, error}` si el cuerpo lo trae. */
export function statusError(operation, statusCode, body) {
  let message = goTrim(body);
  let errorClass = '';
  let errorCode = '';
  try {
    const payload = JSON.parse(body);
    if (payload && typeof payload === 'object') {
      errorClass = goTrim(String(payload.error_class ?? ''));
      errorCode = goTrim(String(payload.error_code ?? ''));
      if (goTrim(String(payload.error ?? '')) !== '') message = goTrim(String(payload.error));
    }
  } catch {
    // el cuerpo no es JSON: se usa tal cual
  }
  return new HttpStatusError({ operation, statusCode, errorClass, errorCode, body: message });
}

/**
 * URL base `http` o `https` con host, sin consulta ni fragmento y sin `/` final.
 * @throws {Error}
 */
export function validateBaseUrl(raw) {
  const trimmed = goTrim(raw ?? '');
  if (trimmed === '') throw new Error('cloud: remote url is required');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new Error(`cloud: invalid remote url: ${err.message}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('cloud: invalid remote url: scheme must be http or https');
  if (parsed.host === '') throw new Error('cloud: invalid remote url: host is required');
  if (trimmed.includes('?')) throw new Error('cloud: invalid remote url: query is not allowed');
  if (trimmed.includes('#')) throw new Error('cloud: invalid remote url: fragment is not allowed');
  return parsed.href.replace(/\/+$/, '');
}

/** Un token solo viaja por HTTPS. */
export function validateBearerBaseUrl(baseUrl, token) {
  const normalized = validateBaseUrl(baseUrl);
  const bearer = goTrim(token ?? '');
  if (bearer !== '' && !normalized.startsWith('https://')) throw new Error('cloud: bearer token requires an HTTPS remote URL');
  return { baseUrl: normalized, token: bearer };
}

/** Una petición con el token (si hay); con token, una redirección solo se sigue hacia HTTPS. */
async function sendRequest(fetchFn, token, url, init, timeoutMs) {
  const headers = { ...init.headers };
  if (token !== '') headers.Authorization = `Bearer ${token}`;
  let target = url;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const response = await fetchFn(target, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const next = new URL(response.headers.get('location'), target).href;
      if (token !== '' && !next.startsWith('https://')) throw new Error('cloud: bearer token redirect requires HTTPS');
      target = next;
      continue;
    }
    return response;
  }
  throw new Error('cloud: too many redirects');
}

/**
 * Transporte de chunks contra el servidor de la nube de un proyecto. Cumple el contrato del
 * sincronizador (`readManifest`, `writeManifest`, `writeChunk`, `readChunk`) con E/S asíncrona.
 */
export class RemoteTransport {
  /**
   * @param {string} baseUrl
   * @param {string} token
   * @param {string} project
   * @param {{ fetch?: typeof fetch }} [options]
   */
  constructor(baseUrl, token, project, { fetch: fetchFn = globalThis.fetch } = {}) {
    const checked = validateBearerBaseUrl(baseUrl, token);
    this.baseUrl = checked.baseUrl;
    this.token = checked.token;
    this.project = project;
    this.fetch = fetchFn;
  }

  #url(parts, query = {}) {
    const url = new URL(`${this.baseUrl}/${parts.map((p) => encodeURIComponent(p)).join('/')}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url.href;
  }

  /** Una petición; con token, una redirección solo se sigue hacia HTTPS. */
  #request(url, init, timeoutMs) {
    return sendRequest(this.fetch, this.token, url, init, timeoutMs);
  }

  async readManifest() {
    let response;
    try {
      response = await this.#request(this.#url(['sync', 'pull'], { project: this.project }), { method: 'GET' }, ORDINARY_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`cloud: fetch manifest: ${err.message}`, { cause: err });
    }
    if (response.status !== 200) throw statusError('fetch manifest', response.status, await response.text());
    try {
      const manifest = await response.json();
      return { version: manifest.version, chunks: manifest.chunks ?? [] };
    } catch (err) {
      throw new Error(`cloud: parse manifest: ${err.message}`, { cause: err });
    }
  }

  /** El manifiesto lo lleva el servidor. */
  async writeManifest() {}

  async writeChunk(chunkId, json, entry = {}) {
    let canonical;
    try {
      canonical = canonicalizeForProject(json, this.project);
    } catch (err) {
      throw new Error(`cloud: canonicalize push chunk: ${err.message}`, { cause: err });
    }
    const id = hashChunkId(canonical);
    const body = encodeCompressed(Buffer.from(JSON.stringify({
      chunk_id: id,
      created_by: entry.created_by ?? '',
      client_created_at: goTrim(entry.created_at ?? ''),
      project: this.project,
      data: JSON.parse(canonical),
    })));
    let response;
    try {
      response = await this.#request(this.#url(['sync', 'push']), { method: 'POST', headers: { 'Content-Type': compressedContentType() }, body }, WRITE_CHUNK_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`cloud: push chunk ${chunkId}: ${err.message}`, { cause: err });
    }
    if (response.status !== 200) throw statusError(`push chunk ${chunkId}`, response.status, await response.text());
  }

  async readChunk(chunkId) {
    let response;
    try {
      response = await this.#request(this.#url(['sync', 'pull', chunkId], { project: this.project }), { method: 'GET', headers: { Accept: compressedContentType() } }, ORDINARY_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`cloud: pull chunk ${chunkId}: ${err.message}`, { cause: err });
    }
    if (response.status === 404) throw new ChunkNotFoundError(chunkId);
    if (response.status !== 200) throw statusError(`pull chunk ${chunkId}`, response.status, await response.text());
    let data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) throw new Error('cloud: empty chunk payload');
    if (isCompressedContentType(response.headers.get('content-type'))) {
      try {
        data = decodeCompressed(data, MAX_DECODED_BYTES);
      } catch (err) {
        throw new Error(`cloud: decode compressed chunk ${chunkId}: ${err.message}`, { cause: err });
      }
    }
    return data.toString('utf8');
  }
}

/**
 * Transporte de mutaciones sueltas: empuja lotes al diario de la nube y lee por cursor. Un 404 se clasifica como
 * `server_unsupported` (el servidor aún no trae las rutas).
 */
export class MutationTransport {
  /**
   * @param {string} baseUrl
   * @param {string} token
   * @param {{ fetch?: typeof fetch, log?: (message: string) => void }} [options]
   */
  constructor(baseUrl, token, { fetch: fetchFn = globalThis.fetch, log = () => {} } = {}) {
    const checked = validateBearerBaseUrl(baseUrl, token);
    this.baseUrl = checked.baseUrl;
    this.token = checked.token;
    this.fetch = fetchFn;
    this.log = log;
  }

  #failure(operation, status, body) {
    const err = statusError(operation, status, body);
    if (status === 404) {
      err.errorCode = 'server_unsupported';
      this.log('[autosync] cloud mutation endpoint returned 404 (server_unsupported); deploy the new server first before enabling ODIN_CLOUD_AUTOSYNC=1');
    }
    return err;
  }

  /**
   * @param {{ project: string, entity: string, entity_key: string, op: string, payload: string }[]} entries carga como texto JSON
   * @returns {Promise<number[]>} los `seq` aceptados por el servidor
   */
  async pushMutations(entries) {
    let body;
    try {
      body = JSON.stringify({ entries: entries.map((e) => ({ project: e.project, entity: e.entity, entity_key: e.entity_key, op: e.op, payload: JSON.parse(e.payload) })) });
    } catch (err) {
      throw new Error(`cloud: marshal mutation push: ${err.message}`, { cause: err });
    }
    let response;
    try {
      response = await sendRequest(this.fetch, this.token, `${this.baseUrl}/sync/mutations/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, ORDINARY_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`cloud: mutation push: ${err.message}`, { cause: err });
    }
    if (response.status !== 200) throw this.#failure('mutation push', response.status, await response.text());
    try {
      const result = await response.json();
      return result.accepted_seqs ?? [];
    } catch (err) {
      throw new Error(`cloud: decode mutation push response: ${err.message}`, { cause: err });
    }
  }

  /** @returns {Promise<{ mutations: object[], has_more: boolean, latest_seq: number }>} */
  async pullMutations(sinceSeq, limit) {
    let response;
    try {
      response = await sendRequest(this.fetch, this.token, `${this.baseUrl}/sync/mutations/pull?since_seq=${sinceSeq}&limit=${limit}`, { method: 'GET' }, ORDINARY_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`cloud: mutation pull: ${err.message}`, { cause: err });
    }
    if (response.status !== 200) throw this.#failure('mutation pull', response.status, await response.text());
    try {
      const result = await response.json();
      return { mutations: result.mutations ?? [], has_more: result.has_more === true, latest_seq: Number(result.latest_seq ?? 0) };
    } catch (err) {
      throw new Error(`cloud: decode mutation pull response: ${err.message}`, { cause: err });
    }
  }

  /** POST de un mensaje de procedencia; devuelve el cuerpo ya analizado. */
  async #provenance(operation, path, payload) {
    let response;
    try {
      response = await sendRequest(this.fetch, this.token, `${this.baseUrl}/sync/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, ORDINARY_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`cloud: ${operation}: ${err.message}`, { cause: err });
    }
    if (response.status !== 200) throw statusError(operation, response.status, await response.text());
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (body?.status !== 'ok') throw new Error(`cloud: invalid ${operation} response`);
    return body;
  }

  /** Registra a un proyecto como dueño de una sesión. */
  async registerSessionAuthority(sessionId, ownerProject) {
    await this.#provenance('register session authority', 'session-authorities', { session_id: sessionId, project: ownerProject });
  }

  /** Enlaza un buzón de origen con la identidad de sincronización de un prompt. */
  async claimPromptPair(sessionId, sourceInboxId, syncId, ownerProject, promptProject) {
    await this.#provenance('claim prompt pair', 'prompt-pair-claims', {
      session_id: sessionId, source_inbox_id: sourceInboxId, sync_id: syncId, owner_project: ownerProject, project: promptProject,
    });
  }

  /** Pide al servidor la atestación humana del origen de un prompt; devuelve su identificador. */
  async attestPromptSource(sessionId, sourceInboxId, syncId, ownerProject, promptProject) {
    const operation = 'attest prompt source';
    if ([sessionId, sourceInboxId, syncId, ownerProject, promptProject].some((v) => goTrim(v ?? '') === '')) throw new Error(`cloud: ${operation}: all fields are required`);
    const body = await this.#provenance(operation, 'prompt-source-attestations', {
      session_id: sessionId, source_inbox_id: sourceInboxId, sync_id: syncId, owner_project: ownerProject, prompt_project: promptProject,
    });
    if (!Number.isInteger(body.attestation_id) || body.attestation_id <= 0) throw new Error(`cloud: invalid ${operation} response`);
    return body.attestation_id;
  }
}
