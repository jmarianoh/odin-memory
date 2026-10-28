import { goTrim } from '../store/text.js';

/**
 * Normaliza la carga de un hook de Copilot. Acepta los dos formatos: camelCase
 * (`sessionId`, `prompt`, …) y el de VS Code/PascalCase (`session_id`, `hook_event_name`, …).
 * @param {string} text
 * @returns {{ ok: boolean, style: 'camel'|'pascal', eventName: string, sessionId: string, cwd: string, prompt: string, source: string, reason: string, trigger: string, response: string, raw: object }}
 */
export function parseHookInput(text) {
  const empty = { ok: false, style: 'camel', eventName: '', sessionId: '', cwd: '', prompt: '', source: '', reason: '', trigger: '', response: '', raw: {} };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const pick = (...names) => {
    for (const name of names) if (typeof raw[name] === 'string') return raw[name];
    return '';
  };
  const eventName = typeof raw.hook_event_name === 'string' ? raw.hook_event_name : '';
  return {
    ok: true,
    style: eventName !== '' || 'session_id' in raw ? 'pascal' : 'camel',
    eventName,
    sessionId: goTrim(pick('sessionId', 'session_id')),
    cwd: pick('cwd'),
    prompt: pick('prompt'),
    source: pick('source'),
    reason: pick('reason'),
    trigger: pick('trigger'),
    response: pick('response', 'last_assistant_message'),
    raw,
  };
}

/** Salida de un hook que aporta contexto, en el formato del que lo llamó. */
export function contextOutput(input, hookEventName, additionalContext) {
  if (input.style === 'pascal') return { hookSpecificOutput: { hookEventName, additionalContext } };
  return { additionalContext };
}
