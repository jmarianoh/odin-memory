import { replayDeferred, rescueNullProjectOwnership } from '../../store/index.js';
import { normalizeProject } from '../../project/canonical.js';
import { goTrim } from '../../store/text.js';
import { DecodeError, decodeBody } from '../decode.js';
import { BodyTooLargeError, HttpError, sendJson } from '../http.js';

/** Reintenta las relaciones diferidas; avisa de escritura si alguna se aplicó. */
export function replayDeferredRoute(ctx) {
  let result;
  try {
    result = replayDeferred(ctx.store);
  } catch (err) {
    throw new HttpError(500, err.message);
  }
  sendJson(ctx.res, 200, { retried: result.retried, succeeded: result.succeeded, failed: result.failed, dead: result.dead });
}

const RESCUE_BODY_LIMIT = 8 << 10;

/**
 * Rescata la propiedad de registros históricos sin proyecto. Siempre exige un token
 * configurado (`requireConfiguredAuth`). Cuerpo de hasta 8 KiB.
 */
export async function rescueOwnershipRoute(ctx) {
  let body;
  try {
    body = decodeBody(await ctx.body(RESCUE_BODY_LIMIT), { target_project: 'string', confirmed: 'bool', observation_ids: 'int[]', session_ids: 'string[]', prompt_ids: 'int[]' });
  } catch (err) {
    if (err instanceof DecodeError || err instanceof BodyTooLargeError) throw new HttpError(400, 'invalid JSON');
    throw err;
  }
  const target = normalizeProject(body.target_project ?? '').normalized;
  if (goTrim(target) === '') throw new HttpError(400, 'target_project is required');
  if (body.confirmed !== true) throw new HttpError(400, 'confirmed must be true');
  let result;
  try {
    result = rescueNullProjectOwnership(ctx.store, {
      target_project: target, observation_ids: body.observation_ids ?? [], session_ids: body.session_ids ?? [], prompt_ids: body.prompt_ids ?? [],
    });
  } catch (err) {
    if (err.code === 'project_required' || err.code === 'project_rescue_invalid_request') {
      throw new HttpError(400, 'invalid ownership rescue request: provide a target project and at least one positive record ID or non-blank session ID');
    }
    process.stderr.write(`[odin] project ownership rescue failed: ${err.message}\n`);
    throw new HttpError(500, 'project ownership rescue is temporarily unavailable');
  }
  if (result.rescued_sessions + result.rescued_observations + result.rescued_prompts > 0 || result.journaled) ctx.notifyWrite();
  sendJson(ctx.res, 200, {
    status: result.complete ? 'rescued' : 'partially_rescued',
    complete: result.complete,
    blocked: result.blocked,
    target_project: target,
    rescued_observations: result.rescued_observations,
    rescued_sessions: result.rescued_sessions,
    rescued_prompts: result.rescued_prompts,
    conflicting_records: result.conflicting_records,
    skipped_records: result.skipped_records,
    journaled_local: result.journaled,
    reconciliation_status: 'local journal pending autosync',
  });
}
