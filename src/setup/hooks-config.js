export const HOOKS_FILE_NAME = 'odin-memory.json';

/** Evento de Copilot → (acción de `odin hook`, plazo en segundos). */
export const HOOK_EVENTS = Object.freeze([
  ['sessionStart', 'copilot-session-start', 15],
  ['userPromptSubmitted', 'copilot-user-prompt-submit', 5],
  ['preCompact', 'copilot-pre-compact', 5],
  ['postToolUse', 'copilot-post-tool-use', 5],
  ['subagentStop', 'copilot-subagent-stop', 10],
  ['sessionEnd', 'copilot-session-end', 5],
]);

const posixQuote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/**
 * Configuración de hooks de Copilot: cada evento ejecuta `odin hook copilot-<evento>`.
 * @param {{ command: string, args: string[] }} invocation
 */
export function hooksConfig(invocation) {
  const argv = (action) => [invocation.command, ...invocation.args, 'hook', action];
  const hooks = {};
  for (const [event, action, timeoutSec] of HOOK_EVENTS) {
    const words = argv(action);
    const bash = words.map(posixQuote).join(' ');
    const powershell = invocation.command === 'odin' ? words.join(' ') : `& ${words.map((w) => `"${w.replaceAll('"', '`"')}"`).join(' ')}`;
    hooks[event] = [{ type: 'command', bash, powershell, command: bash, timeoutSec }];
  }
  return { version: 1, hooks };
}
