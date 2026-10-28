import { TOOL_DEFINITIONS } from './tool-definitions.js';

/** Herramientas del perfil `agent`: las que ve el agente en su uso normal. */
export const PROFILE_AGENT = new Set([
  'mem_save', 'mem_search', 'mem_search_prompts', 'mem_context', 'mem_session_summary', 'mem_session_start', 'mem_session_end',
  'mem_consolidate', 'mem_get_observation', 'mem_suggest_topic_key', 'mem_capture_passive', 'mem_save_prompt', 'mem_update',
  'mem_current_project', 'mem_list_projects', 'mem_judge_many', 'mem_session_finalize', 'mem_judge', 'mem_compare', 'mem_doctor',
  'mem_review', 'mem_pin', 'mem_unpin',
]);

/** Herramientas del perfil `admin`: mantenimiento y curación, no para el agente. */
export const PROFILE_ADMIN = new Set(['mem_judge_many', 'mem_session_finalize', 'mem_delete', 'mem_stats', 'mem_timeline', 'mem_merge_projects']);

export const PROFILES = Object.freeze({ agent: PROFILE_AGENT, admin: PROFILE_ADMIN });

/**
 * Interpreta la selección de herramientas (`--tools=…`): perfiles y nombres
 * separados por comas. Vacío, `all` o una lista sin elementos significa todas.
 * @param {string} input
 * @returns {Set<string>|null} `null` = registrar todas
 */
export function resolveTools(input) {
  input = (input ?? '').trim();
  if (input === '' || input === 'all') return null;
  const result = new Set();
  for (let token of input.split(',')) {
    token = token.trim();
    if (token === '') continue;
    if (token === 'all') return null;
    if (Object.hasOwn(PROFILES, token)) for (const tool of PROFILES[token]) result.add(tool);
    else result.add(token);
  }
  return result.size === 0 ? null : result;
}

/** true si `name` está permitida por `allowlist` (`null` = todas). */
export const shouldRegister = (name, allowlist) => allowlist === null || allowlist === undefined || allowlist.has(name);

const CORE_TOOLS = [
  ['mem_save', 'mem_save — save verified durable conclusions, grouped by topic'],
  ['mem_search', 'mem_search — find past work, decisions, or context from previous sessions'],
  ['mem_context', 'mem_context — get recent history for useful recall or relevant recovery'],
  ['mem_session_summary', 'mem_session_summary — significant explicit closure or handoff; ordinary completion does not require it'],
  ['mem_get_observation', 'mem_get_observation — get full untruncated content of a search result by ID'],
  ['mem_save_prompt', 'mem_save_prompt — save user prompt for context'],
  ['mem_current_project', 'mem_current_project — detect current project from cwd (recommended first call)'],
  ['mem_judge', 'mem_judge — record a verdict on a pending memory conflict (judgment_required flow)'],
  ['mem_compare', 'mem_compare — persist a semantic verdict you have already judged externally'],
];

const DEFERRED_TOOLS = [
  'mem_update', 'mem_review', 'mem_pin', 'mem_unpin', 'mem_suggest_topic_key', 'mem_session_start', 'mem_session_end', 'mem_doctor',
  'mem_capture_passive', 'mem_stats', 'mem_delete', 'mem_timeline', 'mem_merge_projects', 'mem_judge_many', 'mem_session_finalize',
  'mem_consolidate',
];

const MEMORY_WRITING_TOOLS = [
  'mem_save', 'mem_update', 'mem_review', 'mem_delete', 'mem_save_prompt', 'mem_pin', 'mem_unpin', 'mem_session_summary',
  'mem_session_start', 'mem_session_end', 'mem_capture_passive', 'mem_merge_projects', 'mem_judge', 'mem_judge_many', 'mem_compare',
  'mem_session_finalize', 'mem_consolidate',
];

/**
 * Guía que el servidor entrega al agente al inicializarse. Solo menciona las
 * herramientas registradas.
 * @param {Set<string>|null} allowlist
 * @returns {string}
 */
export function buildServerInstructions(allowlist) {
  const active = (name) => shouldRegister(name, allowlist);
  let out = 'odin-memory provides persistent memory that survives across sessions and compactions.\n\n';
  const core = CORE_TOOLS.filter(([name]) => active(name)).map(([, desc]) => desc);
  if (core.length > 0) out += `CORE TOOLS (always available):\n${core.map((d) => `  ${d}\n`).join('')}\n`;
  const deferred = DEFERRED_TOOLS.filter(active);
  if (deferred.length > 0) out += `DEFERRED TOOLS (load them through your host's tool discovery when needed):\n  ${deferred.join(', ')}\n\n`;
  if (active('mem_save')) {
    out += 'PROACTIVE SAVE RULE: Persist verified durable knowledge costly to reconstruct; group related conclusions, not every event.\n\n';
  }
  if (MEMORY_WRITING_TOOLS.some(active)) {
    out +=
      '## DELIVERY GUARANTEE\n\n' +
      'Memory operations are internal bookkeeping, never the user-facing answer. Complete required memory work before composing the completed-task reply; send the complete answer as the final message of the turn with no later tool calls. If memory work fails or needs follow-up, still send the answer.\n\n';
  }
  if (active('mem_save') && (active('mem_judge') || active('mem_judge_many'))) {
    out += '## CONFLICT SURFACING\n\n';
    out += active('mem_judge_many')
      ? 'After mem_save: if judgment_required, prefer mem_judge_many (max 32) with candidates[].judgment_id; never reuse the top-level judgment_id.\n'
      : "After mem_save: if judgment_required, call mem_judge once per entry using that entry's judgment_id; never reuse the top-level judgment_id.\n";
    out +=
      'Ask conversationally when confidence < 0.7 OR (relation in\n' +
      '{supersedes, conflicts_with} AND type in {architecture, policy, decision}); else\n' +
      'resolve with related | compatible | scoped | not_conflict. Pass evidence from user reply.';
  }
  return out.trim();
}

/** Nombres de todas las herramientas definidas. */
export const ALL_TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map((t) => t.name));
