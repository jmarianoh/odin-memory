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
  async #request(url, init, timeoutMs) {
    const headers = { ...init.headers };
    if (this.token !== '') headers.Authorization = `Bearer ${this.token}`;
    let target = url;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const response = await this.fetch(target, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const next = new URL(response.headers.get('location'), target).href;
        if (this.token !== '' && !next.startsWith('https://')) throw new Error('cloud: bearer token redirect requires HTTPS');
        target = next;
        continue;
      }
      return response;
    }
    throw new Error('cloud: too many redirects');
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
