import { normalizeProject } from '../project/canonical.js';
import { goTrim } from '../store/text.js';

export const STATUS = Object.freeze({ ok: 'ok', warning: 'warning', blocked: 'blocked', error: 'error' });
export const SEVERITY = Object.freeze({ info: 'info', warning: 'warning', error: 'error', blocking: 'blocking' });

/** Error de un chequeo que no existe. */
export class InvalidCheckError extends Error {
  constructor(code) {
    super(`invalid diagnostic check: ${JSON.stringify(code)}`);
    this.name = 'InvalidCheckError';
    this.code = 'invalid_check';
  }
}

/** Nombre de proyecto normalizado y recortado (`''` si no es válido). */
export function normalizeProjectName(value) {
  try {
    return goTrim(normalizeProject(goTrim(value ?? '')).normalized);
  } catch {
    return '';
  }
}

/** Evidencia como mapa: claves en orden alfabético, como las serializa un mapa. */
export function mapEvidence(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

export function okResult(checkId, evidence) {
  return {
    check_id: checkId,
    result: STATUS.ok,
    severity: SEVERITY.info,
    reason_code: `${checkId}_ok`,
    message: 'No issues detected.',
    why: 'The evaluated store evidence matches expected operational invariants.',
    evidence,
    safe_next_step: 'No action required.',
    requires_confirmation: false,
  };
}

/** Resume los hallazgos de un chequeo en un resultado. */
export function resultFromFindings(checkId, okEvidence, findings) {
  if (findings.length === 0) return okResult(checkId, okEvidence);
  const result = {
    check_id: checkId,
    result: STATUS.warning,
    severity: SEVERITY.warning,
    reason_code: findings[0].reason_code,
    message: `${findings.length} finding(s) detected.`,
    why: findings[0].why,
    evidence: { finding_count: findings.length },
    safe_next_step: findings[0].safe_next_step,
    requires_confirmation: false,
    findings,
  };
  let actionable = false;
  for (const f of findings) {
    switch (f.severity) {
      case SEVERITY.blocking:
        result.result = STATUS.blocked;
        result.severity = SEVERITY.blocking;
        return result;
      case SEVERITY.error:
        actionable = true;
        if (result.result !== STATUS.blocked) {
          result.result = STATUS.error;
          result.severity = SEVERITY.error;
        }
        break;
      case SEVERITY.warning:
        actionable = true;
        break;
      default:
    }
  }
  if (!actionable) {
    result.result = STATUS.ok;
    result.severity = SEVERITY.info;
    result.message = 'No actionable issues detected.';
    result.safe_next_step = 'No action required.';
  }
  return result;
}

/** Rellena los campos que un chequeo dejó vacíos. */
export function completeResult(result, code) {
  const out = { ...result };
  out.check_id = goTrim(out.check_id ?? '') || code;
  if (!out.result) out.result = STATUS.ok;
  if (!out.severity) out.severity = SEVERITY.info;
  if (!out.reason_code) out.reason_code = `${out.check_id}_ok`;
  if (out.evidence === undefined || out.evidence === null) out.evidence = { evaluated: true };
  return out;
}

export function buildReport(project, checks) {
  const summary = { total: checks.length, ok: 0, warnings: 0, blocked: 0, errors: 0 };
  for (const check of checks) {
    if (check.result === STATUS.error) summary.errors += 1;
    else if (check.result === STATUS.blocked) summary.blocked += 1;
    else if (check.result === STATUS.warning) summary.warnings += 1;
    else summary.ok += 1;
  }
  let status = STATUS.ok;
  if (summary.errors > 0) status = STATUS.error;
  else if (summary.blocked > 0) status = STATUS.blocked;
  else if (summary.warnings > 0) status = STATUS.warning;
  const report = { status };
  if (project) report.project = project;
  report.summary = summary;
  report.checks = checks;
  return report;
}

/** Informe de un fallo del propio diagnóstico. */
export function errorReport(project, err) {
  const code = err instanceof InvalidCheckError ? 'invalid_check' : 'diagnostic_error';
  return buildReport(project, [{
    check_id: code,
    result: STATUS.error,
    severity: SEVERITY.error,
    reason_code: code,
    message: err.message,
    why: 'Doctor could not run the requested diagnostic safely.',
    evidence: { error: err.message },
    safe_next_step: 'Run `odin doctor` without --check to list registered diagnostics.',
    requires_confirmation: false,
  }]);
}
