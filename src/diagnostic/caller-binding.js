import { RESOLUTION_EXPLICIT, resolve } from '../project/resolution.js';
import { getSession } from '../store/sessions.js';
import { goTrim } from '../store/text.js';

const COLLECT = 'Collect caller context without registering a session.';
const INSPECT = 'Inspect the runtime binding; diagnosis does not repair it.';
const RESUME = 'Resume through a host that can persist effective identity; do not reopen the ended session.';

/** Proyecto canónico de un nombre, o `null` si no es válido. */
function canonicalProject(name) {
  try {
    return resolve({ mode: RESOLUTION_EXPLICIT, explicit: name }).project;
  } catch {
    return null;
  }
}

/**
 * Evalúa el vínculo entre la sesión de ejecución y la efectiva. Lee solo las identidades dadas:
 * nunca elige una continuación, registra sesiones, renueva concesiones ni predice que una
 * escritura vaya a tener éxito. La evidencia del anfitrión no autoriza reanudar ni escribir.
 * @param {{ getSession: (id: string) => object|null }|null} reader
 * @param {{ project?: string, runtime_session_id?: string, effective_session_id?: string, host_context?: { append_entry_available: boolean|null, branch_available: boolean|null }|null }} input
 * @returns {{ status: string, root_state: string, effective_state: string, reason_code: string, safe_next_step: string, write_success_guaranteed: boolean }}
 */
export function assessCallerBinding(reader, input) {
  const out = { status: '', root_state: 'unknown', effective_state: 'unknown', reason_code: '', safe_next_step: '', write_success_guaranteed: false };
  const result = (status, reason, next) => Object.assign(out, { status, reason_code: reason, safe_next_step: next });
  const runtimeId = input.runtime_session_id ?? '';
  const effectiveId = input.effective_session_id ?? '';
  if (goTrim(runtimeId) === '' || goTrim(effectiveId) === '' || goTrim(input.project ?? '') === '') {
    return result('unknown', 'caller_context_missing', COLLECT);
  }
  const project = canonicalProject(input.project);
  if (project === null) return result('unknown', 'caller_context_missing', COLLECT);
  const unavailable = () => result('unknown', 'caller_binding_unavailable', 'Verify support and availability of the caller diagnostic.');
  if (!reader) return unavailable();

  let root;
  try {
    root = reader.getSession(runtimeId);
  } catch {
    return unavailable();
  }
  if (root === null || root === undefined) {
    out.root_state = 'missing';
    return result('unknown', 'session_not_registered', 'Use the normal runtime registration path; diagnosis does not register sessions.');
  }
  const state = (row) => (row.ended_at != null ? 'ended' : 'active');
  out.root_state = state(root);
  let effective = root;
  if (effectiveId !== runtimeId) {
    try {
      effective = reader.getSession(effectiveId);
    } catch {
      return unavailable();
    }
    if (effective === null || effective === undefined) {
      out.effective_state = 'missing';
      return result('unknown', 'effective_session_missing', INSPECT);
    }
  }
  out.effective_state = state(effective);
  for (const row of [root, effective]) {
    const persisted = canonicalProject(row.project ?? '');
    if (persisted === null || persisted !== project) return result('blocked', 'session_project_conflict', INSPECT);
  }
  if (effectiveId !== runtimeId) {
    const prefix = `${runtimeId}:resume:`;
    const suffix = effectiveId.startsWith(prefix) ? effectiveId.slice(prefix.length) : '';
    // El sufijo es un entero decimal canónico (sin signo ni ceros a la izquierda) y al menos 2.
    const canonical = /^[0-9]+$/.test(suffix) && String(BigInt(suffix)) === suffix && BigInt(suffix) >= 2n;
    if (!effectiveId.startsWith(prefix) || !canonical) return result('blocked', 'effective_mapping_invalid', INSPECT);
  }
  const host = input.host_context;
  if (!host || host.append_entry_available == null || host.branch_available == null) return result('unknown', 'host_context_missing', COLLECT);
  if (out.effective_state === 'active') return result('ok', 'binding_observed', 'No action required; a later write is not guaranteed.');
  if (!host.append_entry_available || !host.branch_available) return result('blocked', 'ended_session_without_persistence', RESUME);
  return result('warning', 'resume_required', RESUME);
}

/** Lector de sesiones sobre un almacén. */
export const storeSessionReader = (store) => ({ getSession: (id) => getSession(store, id) });
