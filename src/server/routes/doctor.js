import { InvalidCheckError, Runner, assessCallerBinding, errorReport, storeSessionReader } from '../../diagnostic/index.js';
import { DecodeError, firstJsonValue } from '../decode.js';
import { BodyTooLargeError, HttpError, sendJson } from '../http.js';
import { inspectDetector, projectOrThrow } from '../project.js';
import { goTrim } from '../../store/text.js';

/** Diagnóstico de solo lectura: siempre `200` con el informe, incluso si el propio diagnóstico falla. */
export function doctorRoute(ctx) {
  const res = projectOrThrow(ctx, { detect: inspectDetector(ctx.store) });
  const project = res.project ?? '';
  const check = goTrim(ctx.query.get('check') ?? '');
  const scope = { store: ctx.store, project };
  let report;
  try {
    const runner = new Runner();
    report = check !== '' ? runner.runOne(scope, check) : runner.runAll(scope);
  } catch (err) {
    report = errorReport(project, err instanceof InvalidCheckError ? err : err);
  }
  sendJson(ctx.res, 200, report);
}

const CALLER_BODY_LIMIT = 16 << 10;
const INVALID = 'invalid caller-binding request';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Campos de un objeto, sin distinguir mayúsculas y rechazando los desconocidos (`DisallowUnknownFields`). */
function strictFields(value, spec) {
  const out = {};
  const byLower = new Map(Object.keys(spec).map((name) => [name.toLowerCase(), name]));
  for (const [key, raw] of Object.entries(value)) {
    const name = byLower.get(key.toLowerCase());
    if (name === undefined) throw new DecodeError(`json: unknown field ${JSON.stringify(key)}`);
    if (raw === null) continue;
    if (typeof raw !== spec[name]) throw new DecodeError(`json: cannot unmarshal into field ${name}`);
    out[name] = raw;
  }
  return out;
}

/**
 * Evidencia del anfitrión sobre una sesión: POST de solo lectura para que las identidades no
 * viajen en la URL. Cuerpo de hasta 16 KiB con un único objeto y campos conocidos.
 */
export async function callerBindingRoute(ctx) {
  let input;
  try {
    const text = await ctx.body(CALLER_BODY_LIMIT);
    const { value, rest } = firstJsonValue(text);
    if (!isObject(value) || /[^ \t\n\r]/.test(rest)) throw new DecodeError(INVALID);
    input = strictFields(value, { project: 'string', runtime_session_id: 'string', effective_session_id: 'string', host_context: 'object' });
    if (input.host_context !== undefined) {
      if (!isObject(input.host_context)) throw new DecodeError(INVALID);
      input.host_context = strictFields(input.host_context, { append_entry_available: 'boolean', branch_available: 'boolean' });
      for (const key of ['append_entry_available', 'branch_available']) input.host_context[key] ??= null;
    }
  } catch (err) {
    if (err instanceof DecodeError || err instanceof BodyTooLargeError) throw new HttpError(400, INVALID);
    throw err;
  }
  sendJson(ctx.res, 200, assessCallerBinding(storeSessionReader(ctx.store), input));
}
