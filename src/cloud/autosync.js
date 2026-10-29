import { normalizeProject } from '../project/canonical.js';
import { countDeferredAndDead } from '../store/conflicts.js';
import {
  ackSyncMutationSeqs, acquireSyncLease, applyCloudMutation, countPendingNonEnrolledSyncMutations, ensureEnrolledProjectSyncMutations, listDeferredProjectsForTarget,
  listPendingSyncMutationsAfterSeq, localPromptCreationIdentity, localSessionProvenance, maxPendingSyncMutationSeq, releaseSyncLease,
} from '../store/index.js';
import { replayDeferredForScope } from '../store/sync-apply.js';
import { DEFAULT_SYNC_TARGET_KEY } from '../store/schema.js';
import { getSyncState, markSyncBlocked, markSyncBlockedAfterSuccess, markSyncFailure, markSyncHealthy } from '../store/sync-state.js';
import { goTrim } from '../store/text.js';
import { REASON } from './constants.js';
import { appendGuidance, projectFromTargetKey } from './guidance.js';

export const PHASE = Object.freeze({
  idle: 'idle', pushing: 'pushing', pulling: 'pulling', pushFailed: 'push_failed', pullFailed: 'pull_failed', backoff: 'backoff', healthy: 'healthy', disabled: 'disabled',
});

export const DEFAULT_CONFIG = Object.freeze({
  targetKey: DEFAULT_SYNC_TARGET_KEY,
  leaseInterval: 60_000,
  debounce: 500,
  pollInterval: 30_000,
  pushBatchSize: 100,
  pullBatchSize: 100,
  maxConsecutiveFailures: 10,
  baseBackoff: 1_000,
  maxBackoff: 5 * 60_000,
});

/** Quedan pendientes de proyectos sin inscribir: la salida está bloqueada, pero la lectura puede seguir. */
class NonEnrolledPendingError extends Error {
  constructor(counts) {
    super(`pending cloud sync mutations are blocked because project(s) are not enrolled: ${counts.map((c) => `${c.project}=${c.count}`).join(', ')}. Run \`odin cloud enroll <project>\` for each intended project or review enrollment.`);
    this.name = 'NonEnrolledPendingError';
  }
}

/** Un prompt no pasó la comprobación local de origen: no sale, pero no impide empujar ni leer el resto. */
class PromptPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromptPreflightError';
  }
}

/** Fallo de empujar el lote de un proyecto. */
class ProjectTransportFailure extends Error {
  constructor(project, cause) {
    super(`transport push project ${JSON.stringify(project)}: ${cause.message}`, { cause });
    this.name = 'ProjectTransportFailure';
    this.project = project;
  }
}

/** Varios fallos de un mismo paso (`errors.Join`). */
class JoinedError extends Error {
  constructor(errors) {
    super(errors.map((e) => e.message).join('\n'));
    this.name = 'JoinedError';
    this.errors = errors;
  }
}

/** Solo los bloqueos locales conocidos permiten seguir leyendo de la nube aunque la salida no pueda. */
function safeOutboundBlock(err) {
  if (!err) return false;
  if (err instanceof NonEnrolledPendingError || err instanceof PromptPreflightError) return true;
  if (err instanceof JoinedError) return err.errors.length > 0 && err.errors.every(safeOutboundBlock);
  return err.cause ? safeOutboundBlock(err.cause) : false;
}

/** Primer error del árbol que clasifica por estado HTTP. */
function findStatusError(err) {
  if (!err) return null;
  if (err.isAuthFailure !== undefined || err.isPolicyFailure !== undefined) return err;
  if (err instanceof JoinedError) {
    for (const child of err.errors) {
      const found = findStatusError(child);
      if (found) return found;
    }
    return null;
  }
  return findStatusError(err.cause);
}

/** `auth_required` (401), `policy_forbidden` (403) o `transport_failed`. */
export function classifyTransportError(err) {
  const status = findStatusError(err);
  if (status?.isAuthFailure === true) return REASON.authRequired;
  if (status?.isPolicyFailure === true) return REASON.policyForbidden;
  return REASON.transportFailed;
}

function projectForPolicyFailure(err) {
  if (!err) return '';
  if (err instanceof ProjectTransportFailure && err.cause?.isPolicyFailure === true) return err.project;
  if (err instanceof JoinedError) {
    for (const child of err.errors) {
      const project = projectForPolicyFailure(child);
      if (project !== '') return project;
    }
    return '';
  }
  return projectForPolicyFailure(err.cause);
}

function projectFromError(err) {
  const match = /project "([^"]+)"/.exec(err?.message ?? '');
  return match ? goTrim(normalizeProject(match[1]).normalized) : '';
}

function failureMessage(targetKey, message, err) {
  const project = projectForPolicyFailure(err) || projectFromError(err) || projectFromTargetKey(targetKey);
  return appendGuidance(message, project, err);
}


/**
 * Sincronización en segundo plano entre el almacén local y la nube, por mutaciones. Vive en procesos largos
 * (`odin serve`, `odin mcp`): toma un arriendo guardado en SQLite para que solo un trabajador lo haga, empuja el
 * diario pendiente por proyecto, lee las mutaciones remotas por cursor y las aplica, con espera y reintentos
 * crecientes (con variación aleatoria) si algo falla.
 */
export class AutosyncManager {
  /**
   * @param {import('../store/store.js').Store} store
   * @param {{ pushMutations: Function, pullMutations: Function }} transport
   * @param {Partial<typeof DEFAULT_CONFIG> & { leaseOwner?: string, log?: (m: string) => void, random?: () => number, now?: () => number }} [config]
   */
  constructor(store, transport, config = {}) {
    this.store = store;
    this.transport = transport;
    this.cfg = { ...DEFAULT_CONFIG, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) };
    for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) if (typeof fallback === 'number' && !(this.cfg[key] > 0)) this.cfg[key] = fallback;
    if (goTrim(this.cfg.targetKey ?? '') === '') this.cfg.targetKey = DEFAULT_SYNC_TARGET_KEY;
    this.leaseOwner = config.leaseOwner ?? `autosync-${process.pid}-${Date.now()}`;
    this.log = config.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.random = config.random ?? Math.random;
    this.nowMs = config.now ?? Date.now;
    this.state = { phase: PHASE.idle, lastError: '', consecutiveFailures: 0, backoffUntil: null, lastSyncAt: null, reasonCode: '', reasonMessage: '' };
    this.disabled = false;
    this.running = false;
    this.cycling = null;
    this.debounceTimer = null;
    this.pollTimer = null;
    this.repaired = false;
  }

  /** Avisa de que el estado local cambió: agrupa avisos seguidos en un solo ciclo. */
  notifyDirty() {
    if (!this.running) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.#safeCycle(), this.cfg.debounce);
    this.debounceTimer.unref?.();
  }

  /** Instantánea del estado, con los recuentos de relaciones diferidas y muertas. */
  status() {
    const snapshot = { ...this.state, deferredCount: 0, deadCount: 0 };
    try {
      const counts = countDeferredAndDead(this.store, this.cfg.targetKey, '');
      snapshot.deferredCount = counts.deferred;
      snapshot.deadCount = counts.dead;
    } catch {
      // el recuento es de mejor esfuerzo
    }
    return snapshot;
  }

  /** Empieza a sincronizar; llamarlo de nuevo no hace nada. */
  start() {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => this.#safeCycle(), this.cfg.pollInterval);
    this.pollTimer.unref?.();
  }

  /** Para los temporizadores, espera al ciclo en curso y suelta el arriendo. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.debounceTimer);
    clearInterval(this.pollTimer);
    try {
      await this.cycling;
    } catch {
      // un ciclo fallido ya dejó constancia en el estado
    }
    this.#releaseLease();
  }

  /** Detiene los ciclos sin soltar el arriendo, para que nadie más sincronice durante una migración. */
  stopForUpgrade(project) {
    const name = goTrim(normalizeProject(project ?? '').normalized);
    if (name === '') throw new Error('autosync stop requires project');
    this.disabled = true;
    Object.assign(this.state, { phase: PHASE.disabled, reasonCode: REASON.paused, reasonMessage: `autosync paused for cloud upgrade rollback on project ${JSON.stringify(name)}` });
  }

  resumeAfterUpgrade(project) {
    const name = goTrim(normalizeProject(project ?? '').normalized);
    if (name === '') throw new Error('autosync resume requires project');
    if (!this.disabled) return;
    this.disabled = false;
    Object.assign(this.state, { phase: PHASE.idle, reasonCode: '', reasonMessage: '' });
    this.notifyDirty();
  }

  /** Un ciclo ahora mismo (las pruebas y `start` lo usan). */
  runOnce() {
    return this.#safeCycle();
  }

  #safeCycle() {
    if (this.cycling) return this.cycling;
    this.cycling = this.#cycle()
      .catch((err) => {
        this.log(`[autosync] PANIC in cycle: ${err?.stack ?? err}`);
        this.#setStatus(PHASE.backoff, 'internal_error', `panic: ${err?.message ?? err}`);
        this.state.consecutiveFailures += 1;
        let wait = this.cfg.baseBackoff;
        try {
          wait = this.computeBackoff(this.state.consecutiveFailures);
        } catch {
          // si ni el cálculo funciona, se espera la base
        }
        this.state.backoffUntil = new Date(this.nowMs() + wait);
      })
      .finally(() => {
        this.cycling = null;
      });
    return this.cycling;
  }

  async #cycle() {
    if (this.disabled) return;
    const { consecutiveFailures: failures, backoffUntil } = this.state;
    if (failures >= this.cfg.maxConsecutiveFailures && backoffUntil && this.nowMs() < backoffUntil.getTime()) {
      this.#setPhase(PHASE.backoff);
      return;
    }
    if (backoffUntil && this.nowMs() < backoffUntil.getTime()) return;

    let acquired = false;
    try {
      acquired = acquireSyncLease(this.store, this.cfg.targetKey, this.leaseOwner, this.cfg.leaseInterval, new Date(this.nowMs()));
    } catch {
      return;
    }
    if (!acquired) return;

    try {
      await this.#push();
    } catch (err) {
      if (!safeOutboundBlock(err)) {
        this.#recordFailure(failureMessage(this.cfg.targetKey, `push: ${err.message}`, err), classifyTransportError(err));
        return;
      }
      const message = err.message;
      const reason = err instanceof NonEnrolledPendingError || (err instanceof JoinedError && err.errors.every((e) => e instanceof NonEnrolledPendingError))
        ? REASON.nonEnrolledPendingMutations : 'prompt_provenance_blocked';
      this.#recordBlocked(message, reason);
      try {
        await this.#pull(true);
      } catch (pullErr) {
        this.#recordFailure(failureMessage(this.cfg.targetKey, `pull: ${pullErr.message}`, pullErr), classifyTransportError(pullErr));
        return;
      }
      try {
        markSyncBlockedAfterSuccess(this.store, this.cfg.targetKey, reason, message);
        this.#recordBlockedAfterSuccess(message, reason);
      } catch (persistErr) {
        this.#recordFailure(failureMessage(this.cfg.targetKey, `persist blocked state after successful pull: ${persistErr.message}`, persistErr), classifyTransportError(persistErr));
      }
      return;
    }

    try {
      await this.#pull(false);
    } catch (err) {
      this.#recordFailure(failureMessage(this.cfg.targetKey, `pull: ${err.message}`, err), classifyTransportError(err));
      return;
    }
    this.#recordSuccess();
  }

  // ─── Empujar ───────────────────────────────────────────────────────────────

  async #push() {
    this.#setPhase(PHASE.pushing);
    if (!this.repaired) {
      try {
        ensureEnrolledProjectSyncMutations(this.store);
      } catch (err) {
        throw new Error(`repair enrolled sync journal: ${err.message}`, { cause: err });
      }
      this.repaired = true;
    }
    const highWater = maxPendingSyncMutationSeq(this.store, this.cfg.targetKey);
    const failures = [];
    let afterSeq = 0;
    let seen = false;
    for (;;) {
      const pending = listPendingSyncMutationsAfterSeq(this.store, this.cfg.targetKey, afterSeq, this.cfg.pushBatchSize);
      const page = [];
      for (const mutation of pending) {
        if (mutation.seq > highWater) break;
        page.push(mutation);
        afterSeq = mutation.seq;
      }
      if (page.length === 0) break;
      seen = true;
      failures.push(...await this.#pushPage(page));
      if (pending.length < this.cfg.pushBatchSize || afterSeq >= highWater) break;
    }
    if (!seen) {
      const counts = countPendingNonEnrolledSyncMutations(this.store, this.cfg.targetKey);
      if (counts.length > 0) throw new NonEnrolledPendingError(counts);
      return;
    }
    if (failures.length > 0) throw new JoinedError(failures);
  }

  /** Empuja un tramo del diario agrupado por proyecto; devuelve los fallos sin abortar los demás proyectos. */
  async #pushPage(pending) {
    const groups = new Map();
    const failures = [];
    for (const mutation of pending) {
      const project = mutation.project;
      if (goTrim(project) !== project || project === '') {
        failures.push(new Error(`pending mutation seq ${mutation.seq} (${mutation.entity}/${mutation.entity_key}) has an empty or padded project and was not sent; repair local project metadata or inspect \`odin doctor --check sync_mutation_required_fields\``));
        continue;
      }
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project).push(mutation);
    }
    for (const [project, batch] of groups) {
      const entries = [];
      const seqs = [];
      for (const mutation of batch) {
        if (mutation.entity === 'prompt') {
          const identity = promptIdentity(mutation, project);
          if (typeof identity === 'string') {
            failures.push(new Error(`prompt seq ${mutation.seq}: ${identity}`));
            continue;
          }
          if (identity.inbox !== '') {
            try {
              await this.#preflightPrompt(mutation, identity);
            } catch (err) {
              failures.push(err instanceof PromptPreflightError ? new PromptPreflightError(`prompt seq ${mutation.seq}: ${err.message}`) : new Error(`prompt seq ${mutation.seq}: ${err.message}`, { cause: err }));
              continue;
            }
          }
        }
        entries.push({ project: mutation.project, entity: mutation.entity, entity_key: mutation.entity_key, op: mutation.op, payload: mutation.payload });
        seqs.push(mutation.seq);
      }
      if (entries.length === 0) continue;
      let accepted;
      try {
        accepted = await this.transport.pushMutations(entries);
      } catch (err) {
        failures.push(new ProjectTransportFailure(project, err));
        continue;
      }
      if (!Array.isArray(accepted)) {
        failures.push(new Error(`transport push project ${JSON.stringify(project)}: missing accepted seqs for ${entries.length} mutations`));
        continue;
      }
      if (accepted.length !== entries.length) {
        failures.push(new Error(`transport push project ${JSON.stringify(project)}: cloud accepted ${accepted.length} of ${entries.length} mutations; refusing to ack local seqs`));
        continue;
      }
      try {
        ackSyncMutationSeqs(this.store, this.cfg.targetKey, seqs);
      } catch (err) {
        failures.push(new Error(`ack project ${JSON.stringify(project)}: ${err.message}`, { cause: err }));
        return failures;
      }
    }
    return failures;
  }

  /**
   * Un prompt con buzón de origen solo sale si el almacén conserva su origen local intacto: se registra al dueño
   * de la sesión ante la nube y se enlaza el par (sesión, buzón) con el prompt.
   */
  async #preflightPrompt(mutation, { syncId, session, inbox, project }) {
    if (typeof this.transport.registerSessionAuthority !== 'function' || typeof this.transport.claimPromptPair !== 'function') throw new Error('remote prompt authority unavailable');
    let creation;
    let owner;
    try {
      creation = localPromptCreationIdentity(this.store, syncId);
      owner = localSessionProvenance(this.store, session);
    } catch (err) {
      throw new Error(`read local prompt origin: ${err.message}`, { cause: err });
    }
    if (!creation.eligible || creation.session !== session || creation.inbox !== inbox || creation.project !== project) throw new PromptPreflightError('unverified keyed prompt origin');
    if (!owner.eligible || owner.owner === '') throw new PromptPreflightError('unverified local session owner');
    try {
      await this.transport.registerSessionAuthority(session, owner.owner);
    } catch (err) {
      throw new Error(`register session authority: ${err.message}`, { cause: err });
    }
    try {
      await this.transport.claimPromptPair(session, inbox, syncId, owner.owner, project);
    } catch (err) {
      throw new Error(`claim prompt pair: ${err.message}`, { cause: err });
    }
  }

  // ─── Leer ──────────────────────────────────────────────────────────────────

  async #pull(preserveSyncState) {
    this.#setPhase(PHASE.pulling);
    const state = getSyncState(this.store, this.cfg.targetKey);
    let sinceSeq = Number(state.last_pulled_seq ?? 0);
    const touched = new Set();
    for (;;) {
      const response = await this.transport.pullMutations(sinceSeq, this.cfg.pullBatchSize).catch((err) => {
        throw new Error(`transport pull: ${err.message}`, { cause: err });
      });
      for (const remote of response.mutations) {
        const mutation = {
          seq: remote.seq, target_key: this.cfg.targetKey, project: remote.project, entity: remote.entity, entity_key: remote.entity_key, op: remote.op,
          payload: JSON.stringify(remote.payload), occurred_at: remote.occurred_at,
        };
        try {
          applyCloudMutation(this.store, this.cfg.targetKey, mutation, { preserveSyncState });
        } catch (err) {
          throw new Error(`apply pulled mutation seq=${remote.seq}: ${err.message}`, { cause: err });
        }
        const project = goTrim(remote.project ?? '');
        if (project !== '') touched.add(project);
        if (remote.seq > sinceSeq) sinceSeq = remote.seq;
      }
      if (!response.has_more) break;
    }
    try {
      for (const project of listDeferredProjectsForTarget(this.store, this.cfg.targetKey)) if (goTrim(project) !== '') touched.add(goTrim(project));
    } catch (err) {
      this.log(`[autosync] list deferred projects target=${JSON.stringify(this.cfg.targetKey)} error: ${err.message}`);
    }
    for (const project of [...touched].sort()) {
      try {
        const result = replayDeferredForScope(this.store, this.cfg.targetKey, project);
        if (result.retried > 0) this.log(`[autosync] replayDeferred project=${JSON.stringify(project)} retried=${result.retried} succeeded=${result.succeeded} failed=${result.failed} dead=${result.dead}`);
      } catch (err) {
        this.log(`[autosync] replayDeferred project=${JSON.stringify(project)} error: ${err.message}`);
      }
    }
  }

  // ─── Estado ────────────────────────────────────────────────────────────────

  /** Mientras una migración tiene pausado el trabajador, su estado manda. */
  #setStatus(phase, reasonCode, reasonMessage) {
    if (this.disabled) return;
    Object.assign(this.state, { phase, reasonCode, reasonMessage });
  }

  #setPhase(phase) {
    this.#setStatus(phase, this.state.reasonCode, this.state.reasonMessage);
  }

  #recordFailure(message, reasonCode) {
    const failures = this.state.consecutiveFailures + 1;
    this.state.consecutiveFailures = failures;
    this.state.lastError = message;
    const backoffUntil = new Date(this.nowMs() + this.computeBackoff(failures));
    this.state.backoffUntil = backoffUntil;
    this.#setStatus(this.state.phase === PHASE.pushing ? PHASE.pushFailed : PHASE.pullFailed, reasonCode, message);
    try {
      markSyncFailure(this.store, this.cfg.targetKey, message, backoffUntil, reasonCode);
    } catch {
      // el estado local es de mejor esfuerzo
    }
  }

  #recordBlocked(message, reasonCode) {
    this.#setStatus(PHASE.pushFailed, reasonCode, message);
    this.state.lastError = message;
    this.state.backoffUntil = null;
    try {
      markSyncBlocked(this.store, this.cfg.targetKey, reasonCode, message);
    } catch {
      // el estado local es de mejor esfuerzo
    }
  }

  #recordBlockedAfterSuccess(message, reasonCode) {
    this.#setStatus(PHASE.pushFailed, reasonCode, message);
    Object.assign(this.state, { consecutiveFailures: 0, lastError: message, backoffUntil: null, lastSyncAt: new Date(this.nowMs()) });
  }

  #recordSuccess() {
    this.#setStatus(PHASE.healthy, '', '');
    Object.assign(this.state, { consecutiveFailures: 0, lastError: '', backoffUntil: null, lastSyncAt: new Date(this.nowMs()) });
    try {
      markSyncHealthy(this.store, this.cfg.targetKey);
    } catch {
      // el estado local es de mejor esfuerzo
    }
  }

  /** Espera exponencial con variación de ±25 %, entre la mitad de la base y el tope. */
  computeBackoff(failures) {
    const { baseBackoff, maxBackoff } = this.cfg;
    if (failures <= 0) return baseBackoff;
    let base = Math.min(baseBackoff, maxBackoff);
    for (let i = 1; i < failures && base < maxBackoff; i++) base = base > maxBackoff / 2 ? maxBackoff : base * 2;
    const jitter = Math.floor(this.random() * (Math.floor(base / 2) + 1)) - Math.floor(base / 4);
    const result = jitter > 0 && base > maxBackoff - jitter ? maxBackoff : base + jitter;
    return Math.max(result, Math.floor(baseBackoff / 2));
  }

  #releaseLease() {
    try {
      releaseSyncLease(this.store, this.cfg.targetKey, this.leaseOwner);
    } catch {
      // soltar el arriendo es de mejor esfuerzo
    }
  }
}

/** Identidad de un prompt del diario, o el motivo por el que no es válida. */
function promptIdentity(mutation, project) {
  let identity;
  try {
    identity = JSON.parse(mutation.payload);
  } catch (err) {
    return `invalid identity: ${err.message}`;
  }
  const text = (v) => (typeof v === 'string' ? v : '');
  if (text(identity?.sync_id) === '' || identity.sync_id !== mutation.entity_key || text(identity.project) !== project || text(identity.session_id) === '') return 'invalid journal identity';
  return { syncId: identity.sync_id, session: identity.session_id, inbox: text(identity.source_inbox_id), project: identity.project };
}
