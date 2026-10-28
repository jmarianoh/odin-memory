import { createHash, randomBytes } from 'node:crypto';

// Espacio según Go (`unicode.IsSpace`): ASCII, U+0085, U+00A0 y categorías Zs/Zl/Zp.
// No incluye U+FEFF, que `\s` de JavaScript sí trata como espacio.
const GO_SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const GO_SPACE_RUNS = new RegExp(`[${GO_SPACE}]+`);
const GO_SPACE_EDGES = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, 'g');

/** Conjunto de caracteres que `goTrim` recorta, para `trim(X, Y)` de SQLite. */
export const SQL_WHITESPACE_TRIM_SET =
  '\t\n\v\f\r \u0085  ' +
  Array.from({ length: 0x200a - 0x2000 + 1 }, (_, i) => String.fromCharCode(0x2000 + i)).join('') +
  '    　';

/** `strings.TrimSpace` de Go. */
export function goTrim(s) {
  return s.replace(GO_SPACE_EDGES, '');
}

/** `strings.Fields` de Go: separa por espacios Unicode y descarta vacíos. */
export function goFields(s) {
  return s.split(GO_SPACE_RUNS).filter((w) => w !== '');
}

/** @param {string} id true si el identificador de sesión está vacío o solo tiene espacios. */
export function isBlankSessionId(id) {
  return goTrim(id) === '';
}

/** Marcador que se añade al contenido truncado. */
export const TRUNCATION_MARKER = '... [truncated]';

/** Quita el contenido entre `<private>…</private>` (sin distinguir mayúsculas, multilínea). */
export function stripPrivateTags(s) {
  return goTrim(s.replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]'));
}

/** Longitud en bytes UTF-8. */
export function byteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Trunca a `max` bytes UTF-8 sin partir un carácter y añade el marcador.
 * @param {string} content
 * @param {number} max
 */
export function truncateContent(content, max) {
  if (byteLength(content) <= max) return content;
  const buf = Buffer.from(content, 'utf8');
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + TRUNCATION_MARKER;
}

/** Corta una cadena a `max` bytes UTF-8 sin partir un carácter. */
export function cutBytes(s, max) {
  if (byteLength(s) <= max) return s;
  const buf = Buffer.from(s, 'utf8');
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** SHA-256 hexadecimal del contenido en minúsculas con espacios colapsados. */
export function hashNormalized(content) {
  const normalized = goFields(content).join(' ').toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** `personal`, `global` o `project` (por defecto). */
export function normalizeScope(scope) {
  const v = goTrim(scope ?? '').toLowerCase();
  return v === 'personal' || v === 'global' ? v : 'project';
}

/** topic_key: minúsculas, espacios a guiones, máximo 120 bytes. */
export function normalizeTopicKey(topic) {
  const v = goTrim(topic ?? '').toLowerCase();
  if (v === '') return '';
  return cutBytes(goFields(v).join('-'), 120);
}

/** Segmento de topic_key: solo `a-z0-9` separados por guiones, máximo 100. */
export function normalizeTopicSegment(s) {
  const v = goTrim(s ?? '').toLowerCase();
  if (v === '') return '';
  const joined = goFields(v.replace(/[^a-z0-9]+/g, ' ')).join('-');
  return joined.length > 100 ? joined.slice(0, 100) : joined;
}

const hasAny = (text, words) => words.some((w) => text.includes(w));

function inferTopicFamily(type, title, content) {
  const t = goTrim(type ?? '').toLowerCase();
  switch (t) {
    case 'architecture': case 'design': case 'adr': case 'refactor': return 'architecture';
    case 'bug': case 'bugfix': case 'fix': case 'incident': case 'hotfix': return 'bug';
    case 'decision': return 'decision';
    case 'pattern': case 'convention': case 'guideline': return 'pattern';
    case 'config': case 'setup': case 'infra': case 'infrastructure': case 'ci': return 'config';
    case 'discovery': case 'investigation': case 'root_cause': case 'root-cause': return 'discovery';
    case 'learning': case 'learn': return 'learning';
    case 'session_summary': return 'session';
    default:
  }
  const text = `${title} ${content}`.toLowerCase();
  if (hasAny(text, ['bug', 'fix', 'panic', 'error', 'crash', 'regression', 'incident', 'hotfix'])) return 'bug';
  if (hasAny(text, ['architecture', 'design', 'adr', 'boundary', 'hexagonal', 'refactor'])) return 'architecture';
  if (hasAny(text, ['decision', 'tradeoff', 'chose', 'choose', 'decide'])) return 'decision';
  if (hasAny(text, ['pattern', 'convention', 'naming', 'guideline'])) return 'pattern';
  if (hasAny(text, ['config', 'setup', 'environment', 'env', 'docker', 'pipeline'])) return 'config';
  if (hasAny(text, ['discovery', 'investigate', 'investigation', 'found', 'root cause'])) return 'discovery';
  if (hasAny(text, ['learned', 'learning'])) return 'learning';
  if (t !== '' && t !== 'manual') return normalizeTopicSegment(t);
  return 'topic';
}

/** Distingue sugerencias cuyo origen tiene caracteres no ASCII que el segmento pierde. */
function appendUnicodeTopicIdentity(segment, source, maxLen) {
  for (const ch of source) {
    if (ch.codePointAt(0) <= 0x7f) continue;
    const digest = createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 12);
    const suffix = `-u-${digest}`;
    const limit = Math.min(maxLen, 100);
    const kept = segment.length > limit - suffix.length ? segment.slice(0, limit - suffix.length) : segment;
    return kept + suffix;
  }
  return segment;
}

/**
 * Sugiere un topic_key estable `familia/segmento` a partir de tipo, título y contenido.
 * @param {string} type
 * @param {string} title
 * @param {string} content
 */
export function suggestTopicKey(type, title, content) {
  const family = inferTopicFamily(type, title, content);
  let segmentSource = stripPrivateTags(title ?? '');
  let segment = normalizeTopicSegment(segmentSource);
  if (segment === '') {
    segmentSource = goFields(stripPrivateTags(content ?? '')).slice(0, 8).join(' ');
    segment = normalizeTopicSegment(segmentSource);
  }
  if (segment === '') segment = 'general';
  if (segment.startsWith(`${family}-`)) segment = segment.slice(family.length + 1);
  if (segment === '' || segment === family) segment = 'general';
  segment = appendUnicodeTopicIdentity(segment, segmentSource, 120 - family.length - 1);
  return `${family}/${segment}`;
}

/**
 * Entrecomilla cada palabra para que FTS5 no interprete caracteres especiales:
 * `fix auth bug` → `"fix" "auth" "bug"`.
 * @param {string} query
 */
export function sanitizeFts(query) {
  return goFields(query)
    .map((w) => `"${w.replace(/^"+|"+$/g, '').replaceAll('"', '""')}"`)
    .join(' ');
}

/** Términos de búsqueda: palabras sin comillas en los extremos, sin vacías. */
export function searchTerms(query) {
  return goFields(query)
    .map((w) => w.replace(/^"+|"+$/g, ''))
    .filter((w) => w !== '');
}

/** true si algún término tiene menos de 3 caracteres (el índice trigram no lo cubre). */
export function hasShortFtsTerm(query) {
  return searchTerms(query).some((t) => [...t].length < 3);
}

/** Escapa `\`, `%` y `_` para un LIKE con `ESCAPE '\'`. */
export function escapeLike(term) {
  return term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * Términos entrecomillados para un OR de candidatos. A diferencia de `sanitizeFts`,
 * un par de comillas consecutivas dentro de una palabra se convierte en un solo `""`.
 */
export function candidateTerms(title) {
  const quoted = [];
  for (const raw of goFields(title ?? '')) {
    const w = raw.replace(/^"+|"+$/g, '');
    if (w === '') continue;
    let escaped = '';
    for (let i = 0; i < w.length; i++) {
      if (w[i] === '"') {
        escaped += '""';
        if (i + 1 < w.length && w[i + 1] === '"') i++;
        continue;
      }
      escaped += w[i];
    }
    quoted.push(`"${escaped}"`);
  }
  return quoted;
}

/** Consulta FTS que acepta cualquiera de los términos: `"a" OR "b"`. */
export function sanitizeFtsCandidates(title) {
  return candidateTerms(title).join(' OR ');
}

/** Recorta a `max` caracteres (puntos de código) y añade `...` si hubo recorte. */
export function truncate(s, max) {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max).join('')}...`;
}

/** "" → null, para columnas opcionales. */
export function nullableString(v) {
  return v === undefined || v === null || v === '' ? null : v;
}

/** Prefijo + 8 bytes aleatorios en hexadecimal, p. ej. `obs-1a2b3c4d5e6f7a8b`. */
export function newSyncId(prefix) {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}
