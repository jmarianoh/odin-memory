import { normalizeProject } from '../../project/canonical.js';
import { formatContext, limitContextBytes, stats } from '../../store/index.js';
import { goTrim, byteLength } from '../../store/text.js';
import { strArg, boolArg } from '../args.js';
import { defaultSessionId, readProjectErrorResult, respondWithProject } from '../envelope.js';
import { resolveReadProject } from '../projects.js';

export const MEM_CONTEXT_DEFAULT_MAX_BYTES = 16_384;
export const MEM_CONTEXT_MAX_BYTES_CEILING = 65_536;
export const MEM_CONTEXT_MAX_PINNED = 20;
export const MEM_CONTEXT_MAX_STATS_PROJECTS = 8;

/** `max_bytes` de la herramienta: entero positivo, con tope; si no, el valor por defecto. */
export function memContextMaxBytes(raw) {
  if (typeof raw !== 'number' || !(raw > 0) || raw !== Math.trunc(raw)) return MEM_CONTEXT_DEFAULT_MAX_BYTES;
  return Math.min(raw, MEM_CONTEXT_MAX_BYTES_CEILING);
}

/** Lista de proyectos para el pie de estadísticas. */
export function formatContextProjects(names) {
  if (names.length === 0) return 'none';
  if (names.length <= MEM_CONTEXT_MAX_STATS_PROJECTS) return names.join(', ');
  return `${names.slice(0, MEM_CONTEXT_MAX_STATS_PROJECTS).join(', ')}, +${names.length - MEM_CONTEXT_MAX_STATS_PROJECTS} more`;
}

/** Recorta el resultado total al presupuesto, con el marcador de truncado. */
export const clampMemContextResult = (result, maxBytes) => limitContextBytes(result, maxBytes);

export function contextTool(ctx) {
  return (args) => {
    const { store, activity } = ctx;
    const projectOverride = strArg(args, 'project');
    const scope = strArg(args, 'scope');
    const { res, err } = resolveReadProject(ctx, projectOverride);
    if (err) return readProjectErrorResult(activity, res, err);
    const project = normalizeProject(res.project ?? '').normalized;
    const detected = { ...res, project };
    const contextProject = scope === 'personal' && goTrim(projectOverride) === '' ? '' : project;
    const sessionId = defaultSessionId(project);
    activity.recordToolCall(sessionId);
    const maxBytes = memContextMaxBytes(args.max_bytes);
    const global = stats(store);
    let suffix = `\n---\nMemory stats: ${global.total_sessions} sessions, ${global.total_observations} observations across projects: ${formatContextProjects(global.projects)}`;
    suffix += activity.nudgeIfNeeded(sessionId, project);
    const budget = Math.max(1, maxBytes - byteLength(suffix));
    const context = formatContext(store, contextProject, scope, {
      max_bytes: budget, pinned: MEM_CONTEXT_MAX_PINNED, compact: boolArg(args, 'compact', false), older_history: boolArg(args, 'older_history', false),
    });
    if (context === '') return respondWithProject(detected, clampMemContextResult('No previous session memories found.', maxBytes));
    return respondWithProject(detected, clampMemContextResult(context + suffix, maxBytes));
  };
}
