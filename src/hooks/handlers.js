import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve as resolveProject } from '../project/resolution.js';
import { runtimeWorktreeDirectory } from '../project/worktree.js';
import { captureDetector } from '../server/project.js';
import {
  SESSION_OWNERSHIP_PROJECT_OWNED, SESSION_OWNERSHIP_SHARED, addPrompt, endRuntimeSession, endSession, formatCompactionContext, formatContext, getSession,
  passiveCapture, registerSessionWithProvenance,
} from '../store/index.js';
import { goTrim } from '../store/text.js';
import { Syncer } from '../sync/index.js';
import { CONFIG_DIR } from '../project/detect.js';
import { contextOutput } from './input.js';

const CONTEXT_OPTIONS = { compact: true, pinned: 20, max_bytes: 16384, observations: 0, prompts: 0, sessions: 0, older_history: false };
const MARKER_TTL_MS = 24 * 60 * 60 * 1000;

export const SESSION_START_HEADER = '## Odin persistent memory — session context\n\nThe Odin memory tools are available. Follow the Odin memory protocol from your instructions.';

export const COMPACTION_INSTRUCTION = [
  'CRITICAL INSTRUCTION POST-COMPACTION — follow these steps IN ORDER:',
  '',
  'FIRST ACTION REQUIRED:',
  '1. IMMEDIATELY call mem_session_summary with the compacted summary content — this persists what was done before compaction.',
  '2. Then call mem_context to recover any additional context from previous sessions.',
  '3. Only THEN continue working.',
  '',
  'Do not skip step 1. Without it, everything done before compaction is lost from memory.',
].join('\n');

/** Proyecto del directorio, o `null` si no se puede determinar (ambiguo, no válido…). */
function projectOf(store, cwd, env, inspectOnly) {
  if (goTrim(cwd) === '') return null;
  try {
    const res = resolveProject({ mode: 'current', directory: goTrim(cwd), detect: captureDetector(store, inspectOnly), env });
    return res.project ? res : null;
  } catch {
    return null;
  }
}

/**
 * Registra (o reanuda) la sesión del anfitrión. Una sesión raíz ya terminada y compartida
 * conserva su modo para que su continuación siga siendo resoluble.
 */
function registerSession(store, sessionId, res, cwd) {
  let mode = SESSION_OWNERSHIP_PROJECT_OWNED;
  const existing = getSession(store, sessionId);
  if (existing && existing.ended_at != null && existing.ownership_mode === SESSION_OWNERSHIP_SHARED) mode = SESSION_OWNERSHIP_SHARED;
  return registerSessionWithProvenance(store, {
    id: sessionId, project: res.project, directory: runtimeWorktreeDirectory(cwd), mode, resume: true, provenance: null,
  });
}

/** Importa los chunks de Git compartidos si la carpeta existe; cualquier fallo se ignora. */
async function autoImport(store, cwd, project, env) {
  if (env.ODIN_HOOK_AUTO_IMPORT === '0') return;
  const dir = join(cwd, CONFIG_DIR);
  if (!existsSync(join(dir, 'manifest.json'))) return;
  try {
    await Syncer.local(store, dir, project, { log: () => {} }).import();
  } catch {
    // la importación es de mejor esfuerzo
  }
}

/** `sessionStart`: registra la sesión, importa lo compartido e inyecta el contexto. */
export async function sessionStart({ store, input, env }) {
  const res = projectOf(store, input.cwd, env, false);
  let context = '';
  if (res && input.sessionId !== '') {
    try {
      registerSession(store, input.sessionId, res, input.cwd);
    } catch {
      // sin sesión registrada el agente puede usar las herramientas igualmente
    }
    await autoImport(store, goTrim(input.cwd), res.project, env);
    try {
      context = formatContext(store, res.project, '', CONTEXT_OPTIONS);
    } catch {
      context = '';
    }
  }
  const text = context === '' ? SESSION_START_HEADER : `${SESSION_START_HEADER}\n\n${context}`;
  return contextOutput(input, 'SessionStart', text);
}

/** `userPromptSubmitted`: guarda el prompt original en la sesión del proyecto del directorio. */
export function userPromptSubmitted({ store, input, env }) {
  const content = goTrim(input.prompt);
  if (content === '' || input.sessionId === '') return null;
  const res = projectOf(store, input.cwd, env, true);
  if (!res) return null;
  try {
    if (!getSession(store, input.sessionId)) registerSession(store, input.sessionId, res, input.cwd);
    addPrompt(store, {
      session_id: input.sessionId, content: input.prompt, project: res.project, project_provenance: { source: res.source, directory: goTrim(input.cwd) },
    });
  } catch {
    // un prompt que no se guarda nunca bloquea al agente
  }
  return null;
}

// ─── Compactación ────────────────────────────────────────────────────────────

const markerPath = (dataDir, sessionId) => join(dataDir, 'hook-state', `compact-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`);

/** Pendiente de recuperar contexto tras una compactación (`true` si hay marca vigente). */
export function hasCompactionMarker(dataDir, sessionId) {
  try {
    return Date.now() - statSync(markerPath(dataDir, sessionId)).mtimeMs < MARKER_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * `preCompact`: el anfitrión no procesa su salida, así que deja una marca; el siguiente
 * `postToolUse` de la sesión entrega la instrucción de recuperación.
 */
export function preCompact({ input, dataDir }) {
  if (input.sessionId === '') return null;
  try {
    const path = markerPath(dataDir, input.sessionId);
    mkdirSync(join(dataDir, 'hook-state'), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ session_id: input.sessionId, cwd: input.cwd, trigger: input.trigger, at: new Date().toISOString() }), { mode: 0o600 });
  } catch {
    // sin marca no hay recordatorio, pero nada se rompe
  }
  return null;
}

/** `postToolUse`: si hubo una compactación, entrega una vez la instrucción de recuperación y el contexto. */
export function postToolUse({ store, input, env, dataDir }) {
  if (input.sessionId === '' || !hasCompactionMarker(dataDir, input.sessionId)) return null;
  try {
    rmSync(markerPath(dataDir, input.sessionId), { force: true });
  } catch {
    return null;
  }
  let recovered = '';
  try {
    recovered = formatCompactionContext(store, input.sessionId);
  } catch {
    const res = projectOf(store, input.cwd, env, true);
    if (res) recovered = formatContext(store, res.project, '', CONTEXT_OPTIONS);
  }
  return contextOutput(input, 'PostToolUse', recovered === '' ? COMPACTION_INSTRUCTION : `${COMPACTION_INSTRUCTION}\n\n${recovered}`);
}

/** `subagentStop`: pasa la respuesta del subagente por la captura pasiva. */
export function subagentStop({ store, input, env }) {
  const content = input.response;
  if (goTrim(content) === '' || input.sessionId === '') return null;
  const res = projectOf(store, input.cwd, env, true);
  if (!res) return null;
  try {
    passiveCapture(store, { session_id: input.sessionId, content, project: res.project, source: 'subagent-stop' });
  } catch {
    // la captura pasiva es una red de seguridad
  }
  return null;
}

/** `sessionEnd`: cierra la sesión; una raíz ya terminada se cierra por su ámbito de ejecución. */
export function sessionEnd({ store, input }) {
  if (input.sessionId === '') return null;
  try {
    const session = getSession(store, input.sessionId);
    if (session && session.ended_at != null && goTrim(session.project) !== '' && goTrim(session.directory) !== '') {
      endRuntimeSession(store, session.id, session.project, session.directory, session.ownership_mode || SESSION_OWNERSHIP_SHARED, '');
    } else if (session) {
      endSession(store, input.sessionId, '');
    }
  } catch {
    // cerrar es de mejor esfuerzo
  }
  return null;
}

export const HANDLERS = Object.freeze({
  'copilot-session-start': sessionStart,
  'copilot-user-prompt-submit': userPromptSubmitted,
  'copilot-pre-compact': preCompact,
  'copilot-post-tool-use': postToolUse,
  'copilot-subagent-stop': subagentStop,
  'copilot-session-end': sessionEnd,
});
