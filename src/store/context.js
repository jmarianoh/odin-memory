import { normalizeProject } from '../project/canonical.js';
import { formatLocal } from '../timeutil/index.js';
import { storeError } from './errors.js';
import {
  compactionObservations, pinnedObservations, recentUnpinnedObservations,
} from './observations.js';
import { compactionPrompts, recentPrompts } from './prompts.js';
import { getSession, recentSessions } from './sessions.js';
import { byteLength, goFields, normalizeScope, truncate } from './text.js';

const CONTEXT_TRUNCATION_MARKER = '\n[truncated]\n';
const OLDER_HISTORY_HEADER = '### Older History\nSamples are titles, not summaries; use mem_get_observation with an ID to drill in.\n';
const OLDER_HISTORY_OMITTED = '- [older groups omitted]\n';
const DAY_MS = 86_400_000;

// ─── Historial antiguo ────────────────────────────────────────────────────────

const utc = (year, month, day = 1) => new Date(Date.UTC(year, month, day));
const ymd = (d) => d.toISOString().slice(0, 10);
const rfc3339 = (d) => `${d.toISOString().slice(0, 19)}Z`;

/**
 * Periodos en que se agrupa el historial anterior a las observaciones recientes,
 * del más reciente al más antiguo: semanas (lunes a domingo) del mes en curso,
 * meses del trimestre en curso, trimestres del año en curso; lo anterior se
 * agrupa por año fuera de esta función.
 * @param {Date} now
 * @returns {{ label: string, start: Date, end: Date, samples: number, monthly: boolean }[]}
 */
export function historyPeriods(now) {
  const year = now.getUTCFullYear();
  const month = utc(year, now.getUTCMonth());
  const next = utc(year, now.getUTCMonth() + 1);
  const periods = [];
  for (let start = month; start < next;) {
    let days = (8 - start.getUTCDay()) % 7; // días hasta el lunes siguiente
    if (days === 0) days = 7;
    let end = new Date(start.getTime() + days * DAY_MS);
    if (end > next) end = next;
    const current = now >= start && now < end;
    periods.push({ label: `${ymd(start)}–${ymd(new Date(end.getTime() - DAY_MS))}`, start, end, samples: current ? 3 : 1, monthly: false });
    start = end;
  }
  const quarter = utc(year, Math.floor(now.getUTCMonth() / 3) * 3 + 0);
  for (let start = quarter; start < month; start = utc(start.getUTCFullYear(), start.getUTCMonth() + 1)) {
    periods.push({ label: start.toISOString().slice(0, 7), start, end: utc(start.getUTCFullYear(), start.getUTCMonth() + 1), samples: 0, monthly: true });
  }
  for (let start = utc(year, 0); start < quarter; start = utc(year, start.getUTCMonth() + 3)) {
    periods.push({ label: `${year} Q${Math.floor(start.getUTCMonth() / 3) + 1}`, start, end: utc(year, start.getUTCMonth() + 3), samples: 0, monthly: false });
  }
  return periods.sort((a, b) => b.start - a.start);
}

const historyLine = (s) => goFields(s).join(' ');

/**
 * Observaciones recientes más un resumen agrupado de las anteriores.
 * @returns {{ recent: object[], groups: { label: string, count: number, types: string[], samples: string[] }[] }}
 */
function contextHistory(store, project, scope, limit, now) {
  const { db } = store;
  project = normalizeProject(project).normalized;
  let filter = 'deleted_at IS NULL AND pinned = 0';
  const args = [];
  if (project !== '') {
    filter += ' AND LOWER(project) = ?';
    args.push(project);
  }
  if (scope !== '') {
    filter += ' AND scope = ?';
    args.push(normalizeScope(scope));
  }
  if (limit <= 0) limit = store.settings.maxContextResults;

  return db.readTransaction(() => {
    const recent = recentUnpinnedObservations(store, project, scope, limit);
    const recentArgs = [...args, limit];
    const base = `WITH recent AS (SELECT id FROM observations WHERE ${filter} ORDER BY datetime(created_at) DESC,id DESC LIMIT ?), old AS (SELECT id,type,title,created_at FROM observations WHERE ${filter} AND id NOT IN (SELECT id FROM recent)) `;
    const baseArgs = [...recentArgs, ...args];
    const periods = historyPeriods(now);

    let expr = 'CASE WHEN datetime(created_at) < datetime(?) THEN strftime(\'%Y\',created_at)';
    const aggregateArgs = [...baseArgs, rfc3339(utc(now.getUTCFullYear(), 0))];
    for (const p of periods) {
      expr += ' WHEN datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?) THEN ?';
      aggregateArgs.push(rfc3339(p.start), rfc3339(p.end), p.label);
    }
    expr += ' END';
    const rows = db.all(`${base}SELECT ${expr} AS period,type,count(*) AS cnt FROM old GROUP BY period,type HAVING period IS NOT NULL ORDER BY period DESC,type`, ...aggregateArgs);
    const groups = new Map();
    for (const row of rows) {
      const g = groups.get(row.period) ?? { label: row.period, count: 0, types: [], samples: [] };
      g.count += Number(row.cnt);
      g.types.push(`${historyLine(row.type)}: ${row.cnt}`);
      groups.set(row.period, g);
    }

    const result = [];
    for (const p of periods) {
      const g = groups.get(p.label);
      if (!g) continue;
      if (!p.monthly) g.types = [];
      if (p.samples > 0) {
        const samples = db.all(
          `${base}SELECT id,title FROM old WHERE datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?) ORDER BY datetime(created_at) DESC,id DESC LIMIT ?`,
          ...baseArgs, rfc3339(p.start), rfc3339(p.end), p.samples,
        );
        for (const s of samples) g.samples.push(`  - Sample #${s.id}: ${historyLine(s.title)}\n`);
      }
      result.push(g);
      groups.delete(p.label);
    }
    for (const year of [...groups.keys()].sort().reverse()) {
      const g = groups.get(year);
      g.types = [];
      result.push(g);
    }
    return { recent, groups: result };
  });
}

/**
 * Texto del historial antiguo dentro de un presupuesto de bytes; vacío si no
 * cabe ni la cabecera.
 * @param {{ label: string, count: number, types: string[], samples: string[] }[]} groups
 * @param {number} budget
 */
export function renderContextHistory(groups, budget) {
  if (groups.length === 0 || budget <= byteLength(OLDER_HISTORY_HEADER)) return '';
  const lines = [];
  for (const g of groups) {
    let line = `- ${g.label}: ${g.count} observations`;
    if (g.types.length > 0) line += ` (${g.types.join(', ')})`;
    lines.push(`${line}\n`, ...g.samples);
  }
  const complete = `${OLDER_HISTORY_HEADER}${lines.join('')}\n`;
  if (byteLength(complete) <= budget) return complete;
  let out = OLDER_HISTORY_HEADER;
  let useful = false;
  for (const [i, line] of lines.entries()) {
    const reserve = 1 + (i < lines.length - 1 ? byteLength(OLDER_HISTORY_OMITTED) : 0);
    if (byteLength(out) + byteLength(line) + reserve > budget) {
      if (useful && byteLength(out) + byteLength(OLDER_HISTORY_OMITTED) + 1 <= budget) out += OLDER_HISTORY_OMITTED;
      break;
    }
    out += line;
    useful = true;
  }
  return useful ? `${out}\n` : '';
}

// ─── Contexto ─────────────────────────────────────────────────────────────────

/** Prefijo de `s` de a lo sumo `maxBytes` bytes UTF-8, sin partir caracteres. */
function utf8Prefix(s, maxBytes) {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(s, 'utf8');
  if (maxBytes >= buf.length) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Recorta el contexto a `maxBytes` (0 o negativo = sin límite) dejando un marcador. */
export function limitContextBytes(context, maxBytes) {
  if (maxBytes <= 0 || byteLength(context) <= maxBytes) return context;
  const marker = byteLength(CONTEXT_TRUNCATION_MARKER);
  if (maxBytes < marker) return utf8Prefix(context, maxBytes);
  return utf8Prefix(context, maxBytes - marker) + CONTEXT_TRUNCATION_MARKER;
}

const bullet = (obs, compact) =>
  compact ? `- [${obs.type}] **${obs.title}**\n` : `- [${obs.type}] **${obs.title}**: ${truncate(obs.content, 300)}\n`;

/**
 * @typedef {object} ContextOptions
 * @property {boolean} [older_history] añade un resumen agrupado de lo anterior
 * @property {number} [max_bytes] tope del texto (0 = sin límite)
 * @property {number} [observations] 0 = por defecto, negativo = omitir
 * @property {number} [prompts] 0 = 10, negativo = omitir
 * @property {number} [sessions] 0 = 5, negativo = omitir
 * @property {number} [pinned] 0 = todas, negativo = omitir
 * @property {boolean} [compact] solo tipo y título de cada observación
 * @property {() => Date} [now] reloj del historial (pruebas)
 */

/**
 * Texto de contexto de sesiones anteriores: sesiones recientes, prompts,
 * observaciones fijadas y observaciones recientes (y, opcionalmente, historial
 * agrupado). Devuelve cadena vacía si no hay nada que contar.
 * @param {import('./store.js').Store} store
 * @param {string} [project]
 * @param {string} [scope]
 * @param {ContextOptions} [opts]
 * @returns {string}
 */
export function formatContext(store, project = '', scope = '', opts = {}) {
  const sessionsLimit = opts.sessions ?? 0;
  const pinnedLimit = opts.pinned ?? 0;
  const obsLimit = opts.observations ?? 0;
  const promptsLimit = opts.prompts ?? 0;

  const sessions = sessionsLimit >= 0 ? recentSessions(store, project, sessionsLimit === 0 ? 5 : sessionsLimit) : [];
  const pinned = pinnedLimit >= 0 ? pinnedObservations(store, project, scope, pinnedLimit) : [];
  let observations = [];
  let olderGroups = [];
  if (opts.older_history) {
    const now = (opts.now ?? store.settings.now ?? (() => new Date()))();
    ({ recent: observations, groups: olderGroups } = contextHistory(store, project, scope, obsLimit, now));
    if (obsLimit < 0) observations = [];
  } else if (obsLimit >= 0) {
    observations = recentUnpinnedObservations(store, project, scope, obsLimit === 0 ? store.settings.maxContextResults : obsLimit);
  }
  const prompts = promptsLimit >= 0 ? recentPrompts(store, project, promptsLimit === 0 ? 10 : promptsLimit) : [];
  if (!sessions.length && !pinned.length && !observations.length && !prompts.length && !olderGroups.length) return '';

  let out = '## Memory from Previous Sessions\n\n';
  if (sessions.length) {
    out += '### Recent Sessions\n';
    for (const s of sessions) {
      const summary = s.summary != null ? `: ${truncate(s.summary, 200)}` : '';
      out += `- **${s.project}** (${formatLocal(s.started_at)})${summary} [${s.observation_count} observations]\n`;
    }
    out += '\n';
  }
  if (prompts.length) {
    out += '### Recent User Prompts\n';
    for (const p of prompts) out += `- ${formatLocal(p.created_at)}: ${truncate(p.content, 200)}\n`;
    out += '\n';
  }
  if (pinned.length) {
    out += '### Pinned\n';
    for (const o of pinned) out += bullet(o, opts.compact);
    out += '\n';
  }
  if (observations.length) {
    out += '### Recent Observations\n';
    for (const o of observations) out += bullet(o, opts.compact);
    out += '\n';
  }
  const maxBytes = opts.max_bytes ?? 0;
  if (opts.older_history) {
    let budget = 2048;
    if (maxBytes > 0) budget = Math.min(budget, Math.floor(maxBytes / 4));
    const older = renderContextHistory(olderGroups, budget);
    if (older !== '') {
      const remainder = maxBytes <= 0 ? 0 : maxBytes - byteLength(older);
      return limitContextBytes(out, remainder) + older;
    }
  }
  return limitContextBytes(out, maxBytes);
}

/**
 * Contexto de una sesión para recuperarla tras compactar la conversación.
 * @param {import('./store.js').Store} store
 * @param {string} sessionId
 * @throws {StoreError} `session_not_found`
 */
export function formatCompactionContext(store, sessionId) {
  const session = getSession(store, sessionId);
  if (!session) throw storeError('session_not_found');
  const project = normalizeProject(session.project).normalized;
  const count = Number(
    store.db.get('SELECT COUNT(*) AS n FROM observations WHERE session_id = ? AND LOWER(project) = ? AND deleted_at IS NULL', session.id, project).n,
  );
  const pinned = compactionObservations(store, session.id, project, true, 0);
  const observations = compactionObservations(store, session.id, project, false, store.settings.maxContextResults);
  const prompts = compactionPrompts(store, session.id, project, 10);

  const summary = session.summary != null ? `: ${truncate(session.summary, 200)}` : '';
  let out = `## Memory from This Session\n\n### Session\n- **${session.id}** (${formatLocal(session.started_at)})${summary} [${count} observations]\n\n`;
  if (prompts.length) {
    out += '### Recent User Prompts\n';
    for (const p of prompts) out += `- ${formatLocal(p.created_at)}: ${truncate(p.content, 200)}\n`;
    out += '\n';
  }
  const line = (o) => `- [${o.type}] **${o.title}**: ${truncate(o.content, 300)}\n`;
  if (pinned.length) out += `### Pinned\n${pinned.map(line).join('')}\n`;
  if (observations.length) out += `### Recent Observations\n${observations.map(line).join('')}\n`;
  return out;
}
