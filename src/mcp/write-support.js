import { normalizeProject } from '../project/canonical.js';
import { defaultSessionId, writeProjectErrorResult } from './envelope.js';
import { resolveSaveWriteProjectWithProcessOverride } from './write-projects.js';
import { goTrim } from '../store/text.js';

const text = (value) => (typeof value === 'string' ? value : '');

/**
 * Validador del token de recuperación de una ambigüedad de proyecto: `provided`
 * indica si el agente envió un token y `valid` si es correcto para esta elección.
 */
export function recoveryTokenValidator(ctx, args) {
  const sessionId = text(args.session_id);
  const token = text(args.recovery_token);
  const recoverySessionId = goTrim(sessionId) === '' ? defaultSessionId('') : sessionId;
  return {
    recoverySessionId,
    validate: (res, choice) => {
      if (goTrim(token) === '') return { provided: false, valid: false };
      return {
        provided: true,
        valid: ctx.activity.validateAmbiguousProjectRecoveryToken(recoverySessionId, token, goTrim(choice), res.available_projects ?? [], res.path ?? ''),
      };
    },
  };
}

/**
 * Resuelve el proyecto de una escritura conservando la evidencia cruda de la
 * detección aparte del nombre normalizado que se persiste. El llamador valida
 * antes su contenido y opciones.
 * @returns {{ error: object } | { res: object, project: string, warning: string }}
 */
export function prepareWriteProject(ctx, args) {
  const { recoverySessionId, validate } = recoveryTokenValidator(ctx, args);
  const { res, err } = resolveSaveWriteProjectWithProcessOverride(
    ctx, text(args.project), Object.hasOwn(args, 'project'), text(args.project_choice_reason), text(args.session_id), validate,
  );
  if (err) return { error: writeProjectErrorResult(ctx.activity, recoverySessionId, res, err) };
  const { normalized, warning } = normalizeProject(res.project ?? '');
  return { res, project: normalized, warning };
}

export { text as stringArg };
