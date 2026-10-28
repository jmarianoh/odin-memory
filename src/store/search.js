import { normalizeProject } from '../project/canonical.js';
import { StoreError, storeError } from './errors.js';
import { getSession } from './sessions.js';
import {
  escapeLike, hasShortFtsTerm, normalizeScope, sanitizeFts, sanitizeFtsCandidates, searchTerms,
} from './text.js';

// Ponderaciones de la clasificación FTS: título 5, contenido 1, topic_key 3.
const TITLE_WEIGHT = 5.0;
const CONTENT_WEIGHT = 1.0;
const TOPIC_KEY_WEIGHT = 3.0;
// Refuerzos multiplicativos acotados que solo afectan al orden.
const PINNED_BOOST = 0.1;
const RECENCY_BOOST = 0.06;
const RECENCY_HALF_SCORE_DAYS = 30.0;
const STABILITY_BOOST = 0.04;
const STABILITY_DIMINISHING_SCALE = 4.0;

const DEFAULT_LIMIT = 10;
/** Clasificación asignada a las coincidencias directas por topic_key. */
const DIRECT_MATCH_RANK = -1000;
const PREVIEW_CHARS = 300;

const FULL_COLUMNS = `o.id, ifnull(o.sync_id, '') AS sync_id, o.session_id, o.type, o.title, o.content, o.tool_name, o.project,
  o.scope, o.topic_key, o.revision_count, o.duplicate_count, o.last_seen_at, o.review_after, o.pinned, o.created_at, o.updated_at, o.deleted_at, o.superseded_by_sync_id`;
const PREVIEW_COLUMNS = `o.id, ifnull(o.sync_id, '') AS sync_id, o.type, o.title,
  substr(o.content, 1, ${PREVIEW_CHARS}) AS preview, length(o.content) > ${PREVIEW_CHARS} AS truncated,
  o.project, o.topic_key, o.scope, o.review_after, o.pinned, o.created_at`;

const toResult = (row) => ({ ...row, pinned: Boolean(row.pinned), ...(row.truncated !== undefined && { truncated: Boolean(row.truncated) }) });

/**
 * @typedef {object} SearchOptions
 * @property {string} [type]
 * @property {string} [project] se normaliza; filtro sin distinguir mayúsculas
 * @property {string} [scope]
 * @property {number} [limit] por defecto 10, tope `maxSearchResults`
 * @property {'all'|'any'} [match_mode] `all` (por defecto) exige todos los términos; `any`, alguno
 */

function prepare(store, opts) {
  const mode = opts.match_mode ?? '';
  if (mode !== '' && mode !== 'all' && mode !== 'any') {
    throw new StoreError('invalid_match_mode', `invalid match_mode ${JSON.stringify(mode)}: must be "all" or "any"`);
  }
  let limit = opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  if (limit > store.settings.maxSearchResults) limit = store.settings.maxSearchResults;
  return {
    mode,
    limit,
    filters: {
      type: opts.type ?? '',
      project: normalizeProject(opts.project ?? '').normalized,
      scope: opts.scope ?? '',
    },
  };
}

/** Añade los filtros comunes y devuelve el SQL con sus argumentos. */
function withFilters(sql, args, filters) {
  if (filters.type !== '') {
    sql += ' AND o.type = ?';
    args.push(filters.type);
  }
  if (filters.project !== '') {
    sql += ' AND LOWER(o.project) = ?';
    args.push(filters.project);
  }
  if (filters.scope !== '') {
    sql += ' AND o.scope = ?';
    args.push(normalizeScope(filters.scope));
  }
  return sql;
}

function ftsQuery(columns, ftsExpression, filters, limit) {
  const rawRank = `bm25(observations_fts, ${TITLE_WEIGHT.toFixed(1)}, ${CONTENT_WEIGHT.toFixed(1)}, 0.0, 0.0, 0.0, ${TOPIC_KEY_WEIGHT.toFixed(1)})`;
  const compositeRank = `
    ${rawRank} * (
      1.0 +
      CASE WHEN o.pinned THEN ${PINNED_BOOST.toFixed(2)} ELSE 0.0 END +
      ${RECENCY_BOOST.toFixed(2)} * (1.0 / (1.0 + MAX(0.0, julianday('now') - COALESCE(julianday(o.last_seen_at), julianday(o.updated_at), julianday(o.created_at), julianday('now'))) / ${RECENCY_HALF_SCORE_DAYS.toFixed(1)})) +
      ${STABILITY_BOOST.toFixed(2)} * ((MAX(0, COALESCE(o.revision_count, 0)) + MAX(0, COALESCE(o.duplicate_count, 0))) / (MAX(0, COALESCE(o.revision_count, 0)) + MAX(0, COALESCE(o.duplicate_count, 0)) + ${STABILITY_DIMINISHING_SCALE.toFixed(1)}))
    )`;
  const args = [ftsExpression];
  let sql = `SELECT ${columns}, ${rawRank} AS rank
    FROM observations_fts fts
    CROSS JOIN observations o ON o.id = fts.rowid
    WHERE observations_fts MATCH ? AND o.deleted_at IS NULL`;
  sql = withFilters(sql, args, filters);
  sql += ` ORDER BY ${compositeRank} ASC, COALESCE(NULLIF(o.sync_id, ''), printf('%020d', o.id)) ASC, o.id ASC LIMIT ?`;
  args.push(limit);
  return { sql, args };
}

function likeQuery(columns, query, mode, filters, limit) {
  const args = [];
  const groups = searchTerms(query).map((term) => {
    const pattern = `%${escapeLike(term)}%`;
    for (let i = 0; i < 6; i++) args.push(pattern);
    return "(o.title LIKE ? ESCAPE '\\' OR o.content LIKE ? ESCAPE '\\' OR o.tool_name LIKE ? ESCAPE '\\' OR o.type LIKE ? ESCAPE '\\' OR o.project LIKE ? ESCAPE '\\' OR o.topic_key LIKE ? ESCAPE '\\')";
  });
  let sql = `SELECT ${columns}, 0.0 AS rank FROM observations o WHERE o.deleted_at IS NULL AND (${groups.join(mode === 'any' ? ' OR ' : ' AND ')})`;
  sql = withFilters(sql, args, filters);
  sql += ' ORDER BY datetime(o.updated_at) DESC, o.id DESC LIMIT ?';
  args.push(limit);
  return { sql, args };
}

function directTopicQuery(columns, query, filters, limit) {
  const args = [query];
  let sql = `SELECT ${columns} FROM observations o WHERE o.topic_key = ? AND o.deleted_at IS NULL`;
  if (filters.type !== '') {
    sql += ' AND o.type = ?';
    args.push(filters.type);
  }
  if (filters.project !== '') {
    sql += ' AND LOWER(o.project) = ?';
    args.push(filters.project);
  }
  if (filters.scope !== '') {
    sql += ' AND o.scope = ?';
    args.push(normalizeScope(filters.scope));
  }
  sql += ' ORDER BY o.updated_at DESC LIMIT ?';
  args.push(limit);
  return { sql, args };
}

function runSearch(store, query, opts, columns, { allowAnyEncoding }) {
  const { mode, limit, filters } = prepare(store, opts);
  const results = [];
  const seen = new Set();

  if (query.includes('/')) {
    const { sql, args } = directTopicQuery(columns, query, filters, limit);
    try {
      for (const row of store.db.all(sql, ...args)) {
        results.push({ ...toResult(row), rank: DIRECT_MATCH_RANK });
        seen.add(Number(row.id));
      }
    } catch {
      // una coincidencia directa fallida no impide la búsqueda de texto
    }
  }

  let q;
  if (hasShortFtsTerm(query)) {
    q = likeQuery(columns, query, mode, filters, limit);
  } else {
    const expression = mode === 'any' && allowAnyEncoding ? sanitizeFtsCandidates(query) : sanitizeFts(query);
    q = ftsQuery(columns, expression, filters, limit);
  }
  let rows;
  try {
    rows = store.db.all(q.sql, ...q.args);
  } catch (err) {
    throw new StoreError('search_failed', `search: ${err.message}`);
  }
  for (const row of rows) {
    if (!seen.has(Number(row.id))) results.push(toResult(row));
  }
  return results.length > limit ? results.slice(0, limit) : results;
}

/**
 * Busca observaciones.
 *
 * 1. Si la consulta contiene `/`, primero devuelve las observaciones cuyo
 *    `topic_key` coincide exactamente, con clasificación -1000.
 * 2. Si algún término tiene menos de 3 caracteres, busca con LIKE (ordena por
 *    `updated_at` descendente, clasificación 0).
 * 3. Si no, usa FTS5 trigram: cada palabra entrecomillada, unidas por AND
 *    (`all`) o por OR (`any`), ordenadas por `bm25` ponderado con refuerzos por
 *    fijado, recencia y estabilidad. `rank` es el `bm25` sin reforzar.
 * Las coincidencias directas no se repiten y el total se recorta a `limit`.
 *
 * @param {import('./store.js').Store} store
 * @param {string} query
 * @param {SearchOptions} [opts]
 */
export function searchObservations(store, query, opts = {}) {
  return runSearch(store, query, opts, FULL_COLUMNS, { allowAnyEncoding: true });
}

/**
 * Igual que `searchObservations`, pero devuelve solo una vista previa (300
 * caracteres) sin hidratar el contenido completo.
 * @param {import('./store.js').Store} store
 * @param {string} query
 * @param {SearchOptions} [opts]
 */
export function searchObservationPreviews(store, query, opts = {}) {
  return runSearch(store, query, opts, PREVIEW_COLUMNS, { allowAnyEncoding: true });
}

const TIMELINE_COLUMNS =
  'id, session_id, type, title, content, tool_name, project, scope, topic_key, revision_count, duplicate_count, last_seen_at, created_at, updated_at, deleted_at, superseded_by_sync_id';

/**
 * Observaciones vecinas a una dada, dentro de la misma sesión y por id.
 * @param {import('./store.js').Store} store
 * @param {number} observationId
 * @param {number} [before] por defecto 5
 * @param {number} [after] por defecto 5
 * @returns {{ focus: object, before: object[], after: object[], session_info: object|null, total_in_range: number }}
 */
export function timeline(store, observationId, before = 5, after = 5) {
  before = before > 0 ? before : 5;
  after = after > 0 ? after : 5;
  const focusRow = store.db.get(
    `SELECT id, ifnull(sync_id, '') AS sync_id, session_id, type, title, content, tool_name, project,
       scope, topic_key, revision_count, duplicate_count, last_seen_at, review_after, pinned, created_at, updated_at, deleted_at, superseded_by_sync_id
     FROM observations WHERE id = ? AND deleted_at IS NULL`,
    observationId,
  );
  if (!focusRow) throw storeError('observation_not_found', `timeline: observation #${observationId}`);
  const focus = { ...focusRow, pinned: Boolean(focusRow.pinned) };
  const entry = (row) => ({ ...row, is_focus: false });
  const beforeRows = store.db
    .all(
      `SELECT ${TIMELINE_COLUMNS} FROM observations WHERE session_id = ? AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`,
      focus.session_id, observationId, before,
    )
    .reverse()
    .map(entry);
  const afterRows = store.db
    .all(
      `SELECT ${TIMELINE_COLUMNS} FROM observations WHERE session_id = ? AND id > ? AND deleted_at IS NULL ORDER BY id ASC LIMIT ?`,
      focus.session_id, observationId, after,
    )
    .map(entry);
  const total = store.db.get('SELECT COUNT(*) AS n FROM observations WHERE session_id = ? AND deleted_at IS NULL', focus.session_id).n;
  return {
    focus,
    before: beforeRows,
    after: afterRows,
    session_info: getSession(store, focus.session_id),
    total_in_range: Number(total),
  };
}
