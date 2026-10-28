import { randomBytes } from 'node:crypto';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { goTrim } from '../store/text.js';

/** Vigencia de un token de recuperación de proyecto ambiguo. */
export const AMBIGUOUS_PROJECT_RECOVERY_TTL_SECONDS = 300;

/**
 * Ruta del hijo git (único) cuyo nombre en minúsculas coincide con `choice` dentro
 * de `parent`, resuelta y absoluta; `''` si no hay exactamente uno.
 */
export function resolveAmbiguousChoicePath(parent, choice) {
  parent = goTrim(parent ?? '');
  if (parent === '' || goTrim(choice ?? '') === '') return '';
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return '';
  }
  let matched = '';
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (goTrim(entry.name.toLowerCase()) !== choice) continue;
    const child = join(parent, entry.name);
    try {
      statSync(join(child, '.git'));
    } catch {
      continue;
    }
    let real;
    try {
      real = resolve(realpathSync(child));
    } catch {
      return '';
    }
    if (matched !== '') return '';
    matched = real;
  }
  return matched;
}

/** Contexto de recuperación: ruta real, candidatas y si es válido (≥ 2 candidatas distintas). */
function recoveryContext(projects, contextPath) {
  let path;
  try {
    path = resolve(realpathSync(contextPath));
  } catch {
    return { path: '', paths: [], valid: false };
  }
  const names = [...projects].sort();
  const paths = [];
  for (const [i, name] of names.entries()) {
    if (name === '' || (i > 0 && names[i - 1] === name)) return { path: '', paths: [], valid: false };
    const candidate = resolveAmbiguousChoicePath(path, name);
    if (candidate === '') return { path: '', paths: [], valid: false };
    paths.push(candidate);
  }
  return { path, paths, valid: paths.length > 1 };
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Actividad de las sesiones de un proceso MCP: recuentos de llamadas y guardados
 * (para recordar al agente que guarde), prompt actual y tokens de recuperación
 * de proyecto ambiguo. Es memoria de proceso: no se persiste.
 */
export class SessionActivity {
  /**
   * @param {number} nudgeAfterMs tiempo sin guardados tras el cual se avisa (por defecto 10 min)
   * @param {() => number} [now] reloj en ms (pruebas)
   */
  constructor(nudgeAfterMs = 600_000, now = () => Date.now()) {
    this.nudgeAfter = nudgeAfterMs;
    this.now = now;
    /** @type {Map<string, any>} */ this.sessions = new Map();
    /** @type {Map<string, number>} */ this.projectLastSaveAt = new Map();
  }

  #state(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { lastSaveAt: 0, toolCallCount: 0, saveCount: 0, startedAt: this.now(), currentPrompt: null, recoveryTokens: new Map() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  recordToolCall(sessionId) {
    this.#state(sessionId).toolCallCount++;
  }

  clearSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  recordSave(sessionId) {
    const s = this.#state(sessionId);
    s.saveCount++;
    s.lastSaveAt = this.now();
  }

  recordSaveForProject(sessionId, project) {
    this.recordSave(sessionId);
    this.recordProjectSave(project);
  }

  recordProjectSave(project) {
    project = goTrim(project ?? '');
    if (project === '') return;
    const now = this.now();
    this.#expireProjectFreshness(now);
    this.projectLastSaveAt.set(project, now);
  }

  recordPrompt(sessionId, project, content) {
    this.#state(sessionId).currentPrompt = { project, content };
  }

  /** @returns {string|null} el prompt vigente de la sesión para ese proyecto */
  currentPrompt(sessionId, project) {
    const p = this.sessions.get(sessionId)?.currentPrompt;
    return p && p.project === project && p.content !== '' ? p.content : null;
  }

  /**
   * Aviso opcional para el final de una respuesta si hace tiempo que no se guarda.
   * Solo salta pasado el plazo desde el inicio de la sesión y desde el último
   * guardado, y si hubo actividad (algún guardado o más de 5 llamadas).
   */
  nudgeIfNeeded(sessionId, project = '') {
    project = goTrim(project);
    const now = this.now();
    if (project !== '') this.#expireProjectFreshness(now);
    const s = this.sessions.get(sessionId);
    if (!s) return '';
    if (now - s.startedAt < this.nudgeAfter) return '';
    if (s.saveCount === 0 && s.toolCallCount <= 5) return '';
    const reference = s.lastSaveAt === 0 ? s.startedAt : s.lastSaveAt;
    const elapsed = now - reference;
    if (elapsed < this.nudgeAfter) return '';
    if (project !== '' && this.projectLastSaveAt.has(project)) return '';
    return `\n\n⚠️ No mem_save calls for this project in ${Math.trunc(elapsed / 60_000)} minutes. Did you make any decisions, fix bugs, or discover something worth persisting?`;
  }

  #expireProjectFreshness(now) {
    for (const [project, savedAt] of this.projectLastSaveAt) {
      if (now >= savedAt + this.nudgeAfter) this.projectLastSaveAt.delete(project);
    }
  }

  activityScore(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return '';
    let score = `Session activity: ${s.toolCallCount} ${s.toolCallCount === 1 ? 'tool call' : 'tool calls'}, ${s.saveCount} ${s.saveCount === 1 ? 'save' : 'saves'}`;
    if (s.saveCount === 0 && s.toolCallCount > 5) score += ' — high activity with no saves, consider persisting important decisions';
    return score;
  }

  /**
   * Emite un token para resolver una ambigüedad de proyecto: vale para esta
   * sesión, estos candidatos y este directorio durante 5 minutos.
   * @returns {string} el token, o `''` si el contexto no permite uno
   */
  issueAmbiguousProjectRecoveryToken(sessionId, availableProjects, contextPath) {
    const s = this.#state(sessionId);
    const ctx = recoveryContext(availableProjects, contextPath);
    const token = randomBytes(16).toString('hex');
    if (!ctx.valid) return '';
    s.recoveryTokens.set(token, {
      availableProjects: [...availableProjects].sort(),
      contextPath: ctx.path,
      candidatePaths: ctx.paths,
      expiresAt: this.now() + AMBIGUOUS_PROJECT_RECOVERY_TTL_SECONDS * 1000,
      selectedProject: '',
    });
    return token;
  }

  /**
   * Comprueba un token de recuperación: debe existir, no haber caducado y
   * corresponder exactamente al mismo contexto; la primera elección válida lo
   * ata a ese proyecto (reutilizable solo para él).
   */
  validateAmbiguousProjectRecoveryToken(sessionId, token, selectedProject, availableProjects, contextPath) {
    if (!token || !selectedProject) return false;
    const s = this.sessions.get(sessionId);
    const recovery = s?.recoveryTokens.get(token);
    if (!recovery) return false;
    if (this.now() >= recovery.expiresAt) {
      s.recoveryTokens.delete(token);
      return false;
    }
    const projects = [...availableProjects].sort();
    const ctx = recoveryContext(availableProjects, contextPath);
    if (
      !ctx.valid || !projects.includes(selectedProject) || !sameList(recovery.availableProjects, projects) ||
      recovery.contextPath !== ctx.path || !sameList(recovery.candidatePaths, ctx.paths)
    ) {
      return false;
    }
    if (recovery.selectedProject === '') {
      recovery.selectedProject = selectedProject;
      return true;
    }
    return recovery.selectedProject === selectedProject;
  }
}
