import { posix } from 'node:path';
import { goTrim } from '../../store/text.js';
import { escapeHtml } from './html.js';

/** Formato, paginación y saneamiento de rutas del panel. */

export const DEFAULT_PAGE_SIZE = 10;
export const MIN_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;
export const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_HOME = '/dashboard/';

// ─── Escapes de URL ─────────────────────────────────────────────────────────

const UNRESERVED = /[A-Za-z0-9\-_.~]/;
const hex = (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;

function escapeWith(text, keep, spaceAsPlus) {
  let out = '';
  for (const byte of Buffer.from(String(text), 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (byte < 0x80 && (UNRESERVED.test(ch) || keep.includes(ch))) out += ch;
    else if (byte === 0x20 && spaceAsPlus) out += '+';
    else out += hex(byte);
  }
  return out;
}

/** Un segmento de ruta: deja `$&+=:@` y escapa `/`, `;`, `,` y `?`. */
export const pathEscape = (text) => escapeWith(text, '$&+=:@', false);

/** Un valor de consulta: espacio como `+`, todo lo demás escapado salvo los no reservados. */
export const queryEscape = (text) => escapeWith(text, '', true);

/** Consulta ordenada por clave, como la emite un mapa de valores. @param {Record<string,string|string[]>|[string,string][]} values */
export function encodeQuery(values) {
  const pairs = Array.isArray(values) ? values : Object.entries(values).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]));
  const grouped = new Map();
  for (const [key, value] of pairs) {
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }
  return [...grouped.keys()].sort().flatMap((key) => grouped.get(key).map((v) => `${queryEscape(key)}=${queryEscape(v)}`)).join('&');
}

/** Reemplaza una clave de una consulta cruda y devuelve la consulta ordenada. */
export function preserveQuery(rawQuery, key, value) {
  const params = new URLSearchParams(rawQuery);
  params.set(key, value);
  return encodeQuery([...params.entries()]);
}

export function safeQuery(urlPath, rawQuery) {
  if (goTrim(rawQuery ?? '') === '') return urlPath;
  const encoded = encodeQuery([...new URLSearchParams(rawQuery).entries()]);
  return encoded === '' ? urlPath : `${urlPath}?${encoded}`;
}

// ─── Paginación ─────────────────────────────────────────────────────────────

export class Pagination {
  constructor(page = 1, pageSize = DEFAULT_PAGE_SIZE, totalItems = 0, totalPages = 1) {
    Object.assign(this, { page, pageSize, totalItems, totalPages });
  }

  get offset() {
    return (this.page - 1) * this.pageSize;
  }

  get hasPrev() {
    return this.page > 1;
  }

  get hasNext() {
    return this.page < this.totalPages;
  }

  get show() {
    return this.totalPages > 1;
  }

  get start() {
    return this.totalItems === 0 ? 0 : this.offset + 1;
  }

  get end() {
    return Math.min(this.page * this.pageSize, this.totalItems);
  }

  /** Números de página; -1 es una elipsis. */
  numbers() {
    if (this.totalPages <= 7) return Array.from({ length: this.totalPages }, (_, i) => i + 1);
    const pages = [1];
    if (this.page > 3) pages.push(-1);
    for (let i = this.page - 1; i <= this.page + 1; i++) if (i > 1 && i < this.totalPages) pages.push(i);
    if (this.page < this.totalPages - 2) pages.push(-1);
    pages.push(this.totalPages);
    return pages;
  }
}

const atoi = (value) => {
  const n = /^[+-]?\d+$/.test(goTrim(value ?? '')) ? Number(goTrim(value)) : 0;
  return Number.isSafeInteger(n) ? n : 0;
};

/** Página y tamaño pedidos, sin ajustar al total todavía. */
export function parsePaginationRaw(query) {
  let pageSize = atoi(query.get('pageSize'));
  if (pageSize < MIN_PAGE_SIZE) pageSize = DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;
  return { page: Math.max(atoi(query.get('page')), 1), pageSize };
}

/** Paginación ajustada al total real; `refetch` si la página pedida quedaba fuera. */
export function reclampPagination(page, pageSize, totalItems) {
  const totalPages = Math.max(Math.ceil(totalItems / pageSize), 1);
  const clamped = Math.min(page, totalPages);
  return { pg: new Pagination(clamped, pageSize, totalItems, totalPages), refetch: clamped !== page };
}

// ─── Texto ──────────────────────────────────────────────────────────────────

const TIMESTAMP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');

/** `02 Jan 2006 15:04` en hora local; vacío = `-`; ilegible = el texto tal cual. */
export function formatTimestamp(ts) {
  const text = goTrim(ts ?? '');
  if (text === '') return '-';
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(text)) return text;
  return `${two(date.getDate())} ${TIMESTAMP_MONTHS[date.getMonth()]} ${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export const formatTimestampOrNever = (ts) => (ts ? formatTimestamp(ts) : 'Never');

export function truncate(text, max) {
  const runes = Array.from(text ?? '');
  return runes.length <= max ? text : `${runes.slice(0, max).join('')}...`;
}

export const emptyDash = (text) => (goTrim(text ?? '') === '' ? '-' : goTrim(text));
const normalizeWhitespace = (text) => text.split(/\s+/).filter(Boolean).join(' ');
const normalizeParagraph = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');

const FIELD = /\*\*(What|Why|Where|Learned)\*\*:\s*/;
const FIELD_G = new RegExp(FIELD.source, 'g');
const HEADING = /^##\s+([^\n#]+?)\s*$/m;
const HEADING_G = /^##\s+([^\n#]+?)\s*$/gm;
const NO_CONTENT = '<p class="muted">No content captured.</p>';

function paragraphBlocks(rawText) {
  const blocks = goTrim(rawText).split('\n\n').map((b) => goTrim(b)).filter((b) => b !== '');
  return blocks.length === 0 ? NO_CONTENT : blocks.map((b) => `<p>${escapeHtml(normalizeParagraph(b))}</p>`).join('');
}

function headingSections(rawText) {
  const matches = [...rawText.matchAll(HEADING_G)];
  if (matches.length === 0) return paragraphBlocks(rawText);
  let out = '<div class="structured-content">';
  matches.forEach((m, i) => {
    const label = goTrim(m[1]);
    const end = i + 1 < matches.length ? matches[i + 1].index : rawText.length;
    const value = goTrim(rawText.slice(m.index + m[0].length, end));
    if (value === '') return;
    out += `<section class="structured-block"><h4>${escapeHtml(label)}</h4>${paragraphBlocks(value)}</section>`;
  });
  return `${out}</div>`;
}

function fieldSections(rawText) {
  const labels = [...rawText.matchAll(FIELD_G)];
  const parts = rawText.split(FIELD_G).filter((_, i) => i % 2 === 0);
  let out = '<div class="structured-content">';
  labels.forEach((m, i) => {
    const value = goTrim(parts[i + 1] ?? '');
    if (value === '') return;
    out += `<section class="structured-block"><h4>${escapeHtml(m[1])}</h4>${paragraphBlocks(value)}</section>`;
  });
  return `${out}</div>`;
}

/** Contenido de una memoria como secciones (`**What**:` / `## Título`) o párrafos; HTML ya escapado. */
export function renderStructuredContent(rawText) {
  const text = goTrim(rawText ?? '');
  if (text === '') return NO_CONTENT;
  if (FIELD.test(text)) return fieldSections(text);
  return HEADING.test(text) ? headingSections(text) : paragraphBlocks(text);
}

/** Vista previa en una línea del contenido estructurado. */
export function inlinePreview(rawText, max) {
  let text = goTrim(rawText ?? '');
  if (text === '') return 'No content captured.';
  if (FIELD.test(text)) {
    const labels = [...text.matchAll(FIELD_G)];
    const parts = text.split(FIELD_G).filter((_, i) => i % 2 === 0);
    text = labels.map((m, i) => [m[1], goTrim(parts[i + 1] ?? '')]).filter(([, v]) => v !== '').map(([l, v]) => `${l}: ${normalizeWhitespace(v)}`).join(' • ');
  } else if (HEADING.test(text)) {
    const matches = [...text.matchAll(HEADING_G)];
    text = matches.map((m, i) => {
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      return [goTrim(m[1]), goTrim(text.slice(m.index + m[0].length, end))];
    }).filter(([, v]) => v !== '').map(([l, v]) => `${l}: ${normalizeWhitespace(v)}`).join(' • ');
  }
  return truncate(normalizeWhitespace(text), max);
}

export function typeBadgeVariant(type) {
  if (type === 'decision' || type === 'architecture') return 'success';
  if (type === 'bugfix') return 'danger';
  if (type === 'discovery' || type === 'learning') return 'warning';
  return 'muted';
}

// ─── Redirecciones ──────────────────────────────────────────────────────────

/** Ruta interna segura a la que volver tras el acceso; vacía si no es del panel. */
export function sanitizeNext(rawNext) {
  const text = goTrim(rawNext ?? '');
  if (text === '' || !text.startsWith('/') || text.startsWith('//')) return '';
  let parsed;
  try {
    parsed = new URL(text, 'http://dashboard.invalid');
  } catch {
    return '';
  }
  if (parsed.origin !== 'http://dashboard.invalid') return '';
  let decoded;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return '';
  }
  let cleaned = posix.normalize(decoded);
  if (cleaned.length > 1 && cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1);
  if (cleaned !== '/dashboard' && !cleaned.startsWith('/dashboard/')) return '';
  const path = cleaned.split('/').map((segment) => pathEscape(segment)).join('/');
  const query = encodeQuery([...parsed.searchParams.entries()]);
  return query === '' ? path : `${path}?${query}`;
}

export function loginPathWithNext(next) {
  const safe = sanitizeNext(next);
  return safe === '' ? '/dashboard/login' : `/dashboard/login?${encodeQuery({ next: safe })}`;
}

export function postLoginPath(next) {
  const safe = sanitizeNext(next);
  return safe === '' ? DEFAULT_HOME : safe;
}
