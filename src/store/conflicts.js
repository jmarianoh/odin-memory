import { normalizeProject } from '../project/canonical.js';
import { StoreError } from './errors.js';
import { RELATION, VALID_RELATION_VERBS, findCandidates, isValidConfidence, judgeBySemantic } from './relations.js';
import { candidateTerms, goTrim, newSyncId } from './text.js';

/** Observaciones inspeccionadas como máximo por página de escaneo. */
export const DEFAULT_SCAN_LIMIT = 100;
/** Candidatos por observación en un escaneo. */
const SCAN_CANDIDATE_LIMIT = 10;
/** Tamaño de los lotes de `IN (…)`, muy por debajo del límite de variables de SQLite. */
const CHUNK = 500;

const ACTIONABLE_STATS_PREDICATE = ` AND NOT coalesce((r.judgment_status = 'pending' AND
 (SELECT coalesce(nullif(o.project,''), s.project, '') FROM observations o
  LEFT JOIN sessions s ON s.id = o.session_id WHERE o.sync_id = r.source_id) != '' AND
 (SELECT coalesce(nullif(o.project,''), s.project, '') FROM observations o
  LEFT JOIN sessions s ON s.id = o.session_id WHERE o.sync_id = r.target_id) != '' AND
 (SELECT coalesce(nullif(o.project,''), s.project, '') FROM observations o
  LEFT JOIN sessions s ON s.id = o.session_id WHERE o.sync_id = r.source_id) !=
 (SELECT coalesce(nullif(o.project,''), s.project, '') FROM observations o
  LEFT JOIN sessions s ON s.id = o.session_id WHERE o.sync_id = r.target_id)), 0)`;

// ─── Diferidos ───────────────────────────────────────────────────────────────

/**
 * Cuenta las filas diferidas y las muertas de la cola de aplicación de la
 * sincronización, opcionalmente de un destino y/o un proyecto.
 * @param {import('./store.js').Store} store
 * @param {string} [targetKey]
 * @param {string} [project]
 * @returns {{ deferred: number, dead: number }}
 */
export function countDeferredAndDead(store, targetKey = '', project = '') {
  const target = goTrim(targetKey);
  const name = normalizeProject(goTrim(project)).normalized;
  let sql = "SELECT apply_status, count(*) AS n FROM sync_apply_deferred WHERE apply_status IN ('deferred', 'dead')";
  const args = [];
  if (target !== '') {
    sql += " AND target_key = ? AND scope_class != 'legacy_unscoped'";
    args.push(target.toLowerCase());
  }
  if (name !== '') {
    sql += " AND project = ? AND scope_class = 'scoped'";
    args.push(name);
  }
  sql += ' GROUP BY apply_status';
  const out = { deferred: 0, dead: 0 };
  for (const row of store.db.all(sql, ...args)) {
    if (row.apply_status === 'deferred') out.deferred = Number(row.n);
    else if (row.apply_status === 'dead') out.dead = Number(row.n);
  }
  return out;
}

const DEFERRED_COLUMNS = `sync_id, entity, payload, target_key, project, scope_class, remote_seq, entity_key, op, reason_code, apply_status, retry_count,
  last_error, last_attempted_at, first_seen_at`;

/** Fila de `sync_apply_deferred` con la carga decodificada (`payload_valid` indica si era JSON). */
function toDeferredRow(row) {
  const out = { sync_id: row.sync_id, entity: row.entity, target_key: row.target_key, project: row.project, scope_class: row.scope_class };
  if (Number(row.remote_seq) !== 0) out.remote_seq = Number(row.remote_seq);
  if (row.entity_key) out.entity_key = row.entity_key;
  if (row.op) out.op = row.op;
  if (row.reason_code) out.reason_code = row.reason_code;
  let decoded;
  try {
    decoded = JSON.parse(row.payload);
  } catch {
    decoded = undefined;
  }
  const isObject = decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded);
  if (isObject && Object.keys(decoded).length > 0) out.payload = decoded;
  out.payload_raw = row.payload;
  out.payload_valid = isObject || decoded === null;
  out.apply_status = row.apply_status;
  out.retry_count = Number(row.retry_count);
  if (row.last_error != null) out.last_error = row.last_error;
  if (row.last_attempted_at != null) out.last_attempted_at = row.last_attempted_at;
  out.first_seen_at = row.first_seen_at;
  return out;
}

/**
 * Filas diferidas, de la más antigua a la más reciente.
 * @param {import('./store.js').Store} store
 * @param {{ status?: string, limit?: number, offset?: number }} [opts]
 */
export function listDeferred(store, opts = {}) {
  let sql = `SELECT ${DEFERRED_COLUMNS} FROM sync_apply_deferred WHERE 1=1`;
  const args = [];
  if (opts.status) {
    sql += ' AND apply_status = ?';
    args.push(opts.status);
  }
  sql += ' ORDER BY first_seen_at';
  if (opts.limit > 0) {
    sql += ' LIMIT ?';
    args.push(opts.limit);
  }
  if (opts.offset > 0) {
    sql += ' OFFSET ?';
    args.push(opts.offset);
  }
  return store.db.all(sql, ...args).map(toDeferredRow);
}

/**
 * Una fila diferida por `sync_id`.
 * @throws {StoreError} `deferred_not_found`
 */
export function getDeferred(store, syncId) {
  const row = store.db.get(`SELECT ${DEFERRED_COLUMNS} FROM sync_apply_deferred WHERE sync_id = ?`, syncId);
  if (!row) throw new StoreError('deferred_not_found', `GetDeferred: deferred row ${JSON.stringify(syncId)} not found`);
  return toDeferredRow(row);
}

// ─── Estadísticas ────────────────────────────────────────────────────────────

/**
 * Recuentos de relaciones de un proyecto (o de todos) por verbo y por estado de
 * juicio, más las colas de diferidos y muertos. Conserva la evidencia juzgada pero
 * omite los pares pendientes entre proyectos distintos.
 * @param {import('./store.js').Store} store
 * @param {string} [project]
 * @returns {{ project: string, by_relation: Record<string, number>, by_judgment_status: Record<string, number>, deferred: number, dead: number }}
 */
export function getActionableRelationStats(store, project = '') {
  let sql = `SELECT r.relation, r.judgment_status, count(*) AS cnt
    FROM memory_relations r
    LEFT JOIN observations src ON src.sync_id = r.source_id AND src.deleted_at IS NULL
    LEFT JOIN observations tgt ON tgt.sync_id = r.target_id AND tgt.deleted_at IS NULL
    WHERE 1=1${ACTIONABLE_STATS_PREDICATE}`;
  const args = [];
  if (project !== '') {
    sql += " AND (ifnull(src.project,'') = ? OR ifnull(tgt.project,'') = ?)";
    args.push(project, project);
  }
  sql += " AND r.relation != 'not_conflict' GROUP BY r.relation, r.judgment_status";
  const byRelation = {};
  const byStatus = {};
  for (const row of store.db.all(sql, ...args)) {
    byRelation[row.relation] = (byRelation[row.relation] ?? 0) + Number(row.cnt);
    byStatus[row.judgment_status] = (byStatus[row.judgment_status] ?? 0) + Number(row.cnt);
  }
  const { deferred, dead } = countDeferredAndDead(store, '', project);
  return { project, by_relation: byRelation, by_judgment_status: byStatus, deferred, dead };
}

// ─── Escaneo ─────────────────────────────────────────────────────────────────

const pairKey = (a, b) => (a > b ? `${b}\0${a}` : `${a}\0${b}`);
const chunks = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

/**
 * Candidatos de toda una página con lotes a nivel de página: una consulta FTS por
 * término distinto, los metadatos de lo encontrado de una vez y las exclusiones por
 * juicios previos. La puntuación es el número de términos distintos del título de la
 * fuente que coinciden con el candidato (mayor primero; a igualdad, el id menor).
 * @returns {Map<number, object[]>}
 */
function scanCandidateBatch(store, sources, candidateLimit) {
  const result = new Map();
  if (sources.length === 0) return result;
  const { db } = store;

  const termRowids = new Map();
  for (const src of sources) {
    for (const term of candidateTerms(src.title)) {
      if (termRowids.has(term)) continue;
      termRowids.set(term, db.all('SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?', term).map((r) => Number(r.rowid)));
    }
  }

  const union = [...new Set([...termRowids.values()].flat())].sort((a, b) => a - b);
  const meta = new Map();
  for (const ids of chunks(union, CHUNK)) {
    const rows = db.all(
      `SELECT o.id, ifnull(o.sync_id,'') AS sync_id, o.title, o.type, o.topic_key, o.scope, ifnull(o.project,'') AS project
       FROM observations o WHERE o.deleted_at IS NULL AND o.id IN (${placeholders(ids.length)})`,
      ...ids,
    );
    for (const r of rows) meta.set(Number(r.id), r);
  }

  const judged = new Set();
  for (const ids of chunks([...new Set(sources.map((s) => s.sync_id))], CHUNK)) {
    const marks = placeholders(ids.length);
    const rows = db.all(
      `SELECT ifnull(source_id,'') AS a, ifnull(target_id,'') AS b FROM memory_relations
       WHERE judgment_status = 'judged' AND (source_id IN (${marks}) OR target_id IN (${marks}))`,
      ...ids, ...ids,
    );
    for (const r of rows) judged.add(pairKey(r.a, r.b));
  }

  for (const src of sources) {
    const scored = new Map();
    for (const term of new Set(candidateTerms(src.title))) {
      for (const id of termRowids.get(term) ?? []) {
        const m = meta.get(id);
        if (!m || id === src.id || m.project !== src.project || m.scope !== src.scope || judged.has(pairKey(src.sync_id, m.sync_id))) continue;
        scored.set(id, (scored.get(id) ?? 0) + 1);
      }
    }
    const order = [...scored.keys()].sort((a, b) => scored.get(b) - scored.get(a) || a - b).slice(0, candidateLimit);
    result.set(src.id, order.map((id) => {
      const m = meta.get(id);
      return { id: Number(m.id), sync_id: m.sync_id, title: m.title, type: m.type, topic_key: m.topic_key, score: scored.get(id) };
    }));
  }
  return result;
}

/**
 * Recorre una página de observaciones (por id) y busca pares candidatos a
 * contradicción. Con `apply` registra cada par nuevo como relación pendiente (hasta
 * `max_insert`); con `semantic` pide un veredicto al ejecutor para cada par.
 *
 * @param {import('./store.js').Store} store
 * @param {object} opts
 * @param {string} [opts.project] proyecto exacto (ignorado con `allProjects`)
 * @param {Date} [opts.since] solo observaciones creadas desde esta fecha
 * @param {number} [opts.limit] 1..100 (por defecto 100)
 * @param {number} [opts.cursor] último id de la página anterior
 * @param {boolean} [opts.apply]
 * @param {number} [opts.max_insert] por defecto 100
 * @param {boolean} [opts.semantic]
 * @param {number} [opts.concurrency] por defecto 5
 * @param {number} [opts.timeout_per_call_ms] por defecto 60000
 * @param {number} [opts.max_semantic] por defecto 100
 * @param {{ compare: (prompt: string, signal: AbortSignal) => Promise<{ relation: string, confidence: number, reasoning?: string, model?: string }> }} [opts.runner]
 * @param {(a: object, b: object) => string} [opts.build_prompt]
 * @param {boolean} [allProjects]
 * @returns {Promise<object>}
 */
export async function scanProject(store, opts, allProjects = false) {
  const limit = opts.limit === undefined || opts.limit === 0 ? DEFAULT_SCAN_LIMIT : opts.limit;
  if (limit < 0 || limit > DEFAULT_SCAN_LIMIT) throw new StoreError('invalid_scan_limit', `ScanProject: limit must be between 1 and ${DEFAULT_SCAN_LIMIT}`);
  const cursor = opts.cursor ?? 0;
  if (cursor < 0) throw new StoreError('invalid_scan_cursor', 'ScanProject: cursor must be non-negative');
  if (opts.semantic) {
    if (!opts.runner) throw new StoreError('semantic_runner_required', 'semantic scan requires a non-nil Runner');
    if (!opts.build_prompt) throw new StoreError('semantic_prompt_builder_required', 'semantic scan requires a non-nil BuildPrompt function');
  }
  const maxInsert = opts.max_insert > 0 ? opts.max_insert : 100;
  const maxSemantic = opts.max_semantic > 0 ? opts.max_semantic : 100;
  const concurrency = opts.concurrency > 0 ? opts.concurrency : 5;
  const timeoutMs = opts.timeout_per_call_ms > 0 ? opts.timeout_per_call_ms : 60_000;
  const project = opts.project ?? '';
  const apply = opts.apply === true;
  const { db } = store;

  const result = {
    project, inspected: 0, ranked_queries: 0, candidates_found: 0, already_related: 0, inserted: 0, capped: false, dry_run: !apply,
    semantic_judged: 0, semantic_skipped: 0, semantic_errors: 0,
  };

  let sql = "SELECT id, ifnull(sync_id,'') AS sync_id, scope, title, ifnull(project,'') AS project FROM observations WHERE deleted_at IS NULL";
  const args = [];
  if (!allProjects) {
    sql += " AND ifnull(project,'') = ?";
    args.push(project);
  }
  if (opts.since) {
    sql += ' AND created_at >= ?';
    args.push(new Date(opts.since).toISOString().slice(0, 19).concat('Z'));
  }
  sql += ' AND id > ? ORDER BY id LIMIT ?';
  args.push(cursor, limit + 1);
  let observations = db.all(sql, ...args).map((r) => ({ ...r, id: Number(r.id) }));
  const hasMore = observations.length > limit;
  if (hasMore) observations = observations.slice(0, limit);

  let batched = null;
  try {
    batched = scanCandidateBatch(store, observations, SCAN_CANDIDATE_LIMIT);
  } catch (err) {
    (store.config.log ?? (() => {}))(`[store] ScanProject: batched candidates failed, falling back to per-source ranking: ${err.message}`);
  }

  const snippet = (syncId) => {
    const r = db.get("SELECT id, title, type, ifnull(content,'') AS content FROM observations WHERE sync_id = ?", syncId);
    return { id: r ? Number(r.id) : 0, sync_id: syncId, title: r?.title ?? '', type: r?.type ?? '', content: r?.content ?? '' };
  };
  const semanticPairs = [];
  const semanticKeys = new Set();

  scan: for (const obs of observations) {
    result.inspected++;
    result.ranked_queries++;
    let candidates;
    if (batched) {
      candidates = batched.get(obs.id) ?? [];
    } else {
      try {
        ({ candidates } = findCandidates(store, obs.id, { project: allProjects ? '' : project, scope: obs.scope, limit: SCAN_CANDIDATE_LIMIT, skip_insert: true }));
      } catch (err) {
        (store.config.log ?? (() => {}))(`[store] ScanProject: FindCandidates obs=${obs.sync_id}: ${err.message}`);
        continue;
      }
    }
    result.candidates_found += candidates.length;

    if (opts.semantic) {
      const source = snippet(obs.sync_id);
      for (const c of candidates) {
        const key = pairKey(obs.sync_id, c.sync_id);
        if (semanticKeys.has(key)) continue;
        if (semanticPairs.length === maxSemantic) {
          result.capped = true;
          break scan;
        }
        semanticPairs.push({ source, candidate: snippet(c.sync_id) });
        semanticKeys.add(key);
      }
      continue;
    }

    if (!apply) continue;
    if (result.inserted >= maxInsert && candidates.length > 0) {
      result.capped = true;
      break scan;
    }
    for (const [index, c] of candidates.entries()) {
      const exists = db.get(
        'SELECT 1 AS found FROM memory_relations WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?) LIMIT 1',
        obs.sync_id, c.sync_id, c.sync_id, obs.sync_id,
      );
      if (exists) {
        result.already_related++;
        continue;
      }
      try {
        db.run(
          "INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, created_at, updated_at) VALUES (?, ?, ?, 'pending', 'pending', datetime('now'), datetime('now'))",
          newSyncId('rel'), obs.sync_id, c.sync_id,
        );
      } catch (err) {
        (store.config.log ?? (() => {}))(`[store] ScanProject: insert relation obs=${obs.sync_id} cand=${c.sync_id}: ${err.message}`);
        continue;
      }
      result.inserted++;
      if (result.inserted === maxInsert && index + 1 < candidates.length) {
        result.capped = true;
        break scan;
      }
    }
  }

  if (!result.capped && hasMore && observations.length > 0) result.next_cursor = observations.at(-1).id;
  if (opts.semantic && semanticPairs.length > 0) {
    const counts = await judgeSemanticPairs(store, opts, semanticPairs, concurrency, timeoutMs);
    result.semantic_judged += counts.judged;
    result.semantic_skipped += counts.skipped;
    result.semantic_errors += counts.errors;
  }
  return result;
}

/** Escaneo de todos los proyectos. */
export const scanAllProjects = (store, opts) => scanProject(store, opts, true);

/** Pide un veredicto por par con un grupo acotado de llamadas concurrentes y lo contabiliza. */
async function judgeSemanticPairs(store, opts, pairs, concurrency, timeoutMs) {
  const counts = { judged: 0, skipped: 0, errors: 0 };
  const log = store.config.log ?? (() => {});
  let next = 0;
  const worker = async () => {
    while (next < pairs.length) {
      const pair = pairs[next++];
      const names = `(${pair.source.sync_id},${pair.candidate.sync_id})`;
      try {
        const prompt = opts.build_prompt(pair.source, pair.candidate);
        const verdict = await opts.runner.compare(prompt, AbortSignal.timeout(timeoutMs));
        if (!opts.apply && verdict.relation === RELATION.not_conflict && isValidConfidence(verdict.confidence)) {
          counts.skipped++;
          continue;
        }
        if (!opts.apply && pair.source.sync_id !== '' && pair.candidate.sync_id !== '' && VALID_RELATION_VERBS.includes(verdict.relation) && isValidConfidence(verdict.confidence)) {
          counts.judged++;
          continue;
        }
        judgeBySemantic(store, {
          source_id: pair.source.sync_id, target_id: pair.candidate.sync_id, relation: verdict.relation, confidence: verdict.confidence,
          reasoning: verdict.reasoning, model: verdict.model,
        });
        counts.judged++;
      } catch (err) {
        log(`[store] ScanProject: semantic pair=${names} error: ${err.message}`);
        counts.errors++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, worker));
  return counts;
}

// ─── Retención de filas muertas ──────────────────────────────────────────────

/** Antigüedad máxima (días) y tope por ámbito de las filas muertas de la cola de aplicación. */
export const DEFAULT_DEAD_ROW_MAX_AGE_DAYS = 30;
export const DEFAULT_DEAD_ROW_MAX_PER_SCOPE = 1000;
/** Errores de relación que dejan una fila muerta potencialmente recuperable (nunca se poda). */
export const RELATION_FK_MISSING_ERROR = 'relation FK precondition not met: referenced observation missing';
export const RELATION_PROJECT_MISMATCH_ERROR = 'relation FK precondition not met: referenced observation effective project mismatch';

const AGE_BUCKET_ORDER = { '0-6d': 0, '7-29d': 1, '30d+': 2, unknown: 3 };
const DELETE_CHUNK = 500;

const PRUNE_CANDIDATES_SQL = `
  SELECT sync_id, target_key, project, entity, reason_code,
    first_seen_at < datetime('now', ?) AS expired,
    ifnull(CAST(julianday('now') - julianday(first_seen_at) AS INTEGER), -1) AS age_days
  FROM (
    SELECT sync_id, target_key, project, entity, reason_code, first_seen_at,
      ROW_NUMBER() OVER (PARTITION BY target_key, project ORDER BY first_seen_at DESC, sync_id DESC) AS scope_rank
    FROM sync_apply_deferred
    WHERE apply_status = 'dead'
      AND NOT (
        scope_class = 'scoped' AND project <> ''
        AND entity = 'relation' AND retry_count = 5
        AND last_error IN (?, ?)
        AND sync_id = payload_sync_id AND entity_key = payload_sync_id
        AND op = 'upsert'
      )
  )
  WHERE first_seen_at < datetime('now', ?) OR scope_rank > ?`;

function ageBucket(days) {
  if (days < 0) return 'unknown';
  if (days < 7) return '0-6d';
  if (days < 30) return '7-29d';
  return '30d+';
}

function selectPruneCandidates(db, opts) {
  const modifier = `-${opts.max_age_days} days`;
  return db.all(PRUNE_CANDIDATES_SQL, modifier, RELATION_FK_MISSING_ERROR, RELATION_PROJECT_MISMATCH_ERROR, modifier, opts.max_per_scope).map((r) => ({
    sync_id: r.sync_id, target_key: r.target_key, project: r.project, entity: r.entity, reason_code: r.reason_code, expired: Number(r.expired) === 1, age_days: Number(r.age_days),
  }));
}

function summarizePrune(candidates, applied) {
  const scopes = new Map();
  const reasons = new Map();
  for (const c of candidates) {
    const sk = `${c.target_key}\0${c.project}`;
    const scope = scopes.get(sk) ?? { target_key: c.target_key, project: c.project, by_age: 0, by_cap: 0 };
    scopes.set(sk, scope);
    if (c.expired) scope.by_age++;
    else scope.by_cap++;
    const bucket = ageBucket(c.age_days);
    const rk = `${c.entity}\0${c.reason_code}\0${bucket}`;
    const reason = reasons.get(rk) ?? { entity: c.entity, reason_code: c.reason_code, age_bucket: bucket, count: 0 };
    reasons.set(rk, reason);
    reason.count++;
  }
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    applied,
    total: candidates.length,
    scopes: [...scopes.values()].sort((a, b) => byText(a.target_key, b.target_key) || byText(a.project, b.project)),
    reasons: [...reasons.values()].sort((a, b) => byText(a.entity, b.entity) || byText(a.reason_code, b.reason_code) || AGE_BUCKET_ORDER[a.age_bucket] - AGE_BUCKET_ORDER[b.age_bucket]),
  };
}

/**
 * Acota el crecimiento de las filas muertas de `sync_apply_deferred`: poda las
 * anteriores a `max_age_days` y las que exceden `max_per_scope` por ámbito (destino
 * y proyecto), conservando las más recientes. Las filas diferidas y las relaciones
 * muertas potencialmente recuperables no se tocan. Sin `apply` solo informa.
 * @param {import('./store.js').Store} store
 * @param {{ max_age_days: number, max_per_scope: number, apply?: boolean }} opts
 */
export function pruneDeadRows(store, opts) {
  if (!(opts.max_age_days > 0)) throw new StoreError('invalid_prune_limit', 'prune dead rows: max age days must be positive');
  if (!(opts.max_per_scope > 0)) throw new StoreError('invalid_prune_limit', 'prune dead rows: max per scope must be positive');
  if (!opts.apply) return summarizePrune(selectPruneCandidates(store.db, opts), false);
  const candidates = store.db.writeTransaction((db) => {
    const found = selectPruneCandidates(db, opts);
    for (const chunk of chunks(found, DELETE_CHUNK)) {
      // La guarda de estado deja fuera una fila que se rearmó como diferida.
      db.run(`DELETE FROM sync_apply_deferred WHERE apply_status = 'dead' AND sync_id IN (${placeholders(chunk.length)})`, ...chunk.map((c) => c.sync_id));
    }
    return found;
  });
  return summarizePrune(candidates, true);
}
