import { goTrim } from '../../store/text.js';
import { REASON, UPGRADE_ERROR_CLASS, UPGRADE_ERROR_CODE } from '../constants.js';
import { actionable, readBuffer, sendMap } from './respond.js';
import { sendJson } from '../../server/http.js';
import { PRINCIPAL_SOURCE, ROLE, generateManagedToken } from './tokens.js';

const REPAIRABLE = UPGRADE_ERROR_CLASS.repairable;
const BLOCKED = UPGRADE_ERROR_CLASS.blocked;
const INVALID = UPGRADE_ERROR_CODE.payloadInvalid;
const INTERNAL = UPGRADE_ERROR_CODE.internal;

const badRequest = (res, message) => actionable(res, 400, REPAIRABLE, INVALID, message);
const internal = (res, message) => actionable(res, 500, BLOCKED, INTERNAL, message);

/** Solo una persona administradora autenticada con un token gestionado puede usar `/admin`. */
export const isManagedAdmin = (principal) => principal !== null && principal.role === ROLE.admin && principal.source === PRINCIPAL_SOURCE.managedToken;

function requireManagedAdmin(res, principal) {
  if (isManagedAdmin(principal)) return true;
  actionable(res, 403, UPGRADE_ERROR_CLASS.policy, REASON.policyForbidden, 'forbidden: managed admin principal is required');
  return false;
}

/**
 * Cuerpo JSON con los campos admitidos y de tipo cadena; uno desconocido o de otro tipo es un error y un cuerpo
 * vacío se admite.
 * @throws {Error}
 */
export async function decodeJsonBody(req, fields) {
  const text = (await readBuffer(req, 1 << 20)).toString('utf8');
  const empty = () => Object.fromEntries(fields.map((f) => [f, '']));
  if (goTrim(text) === '') return empty();
  const doc = JSON.parse(text);
  if (doc === null) return empty();
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`json: cannot unmarshal ${Array.isArray(doc) ? 'array' : typeof doc} into Go value of type struct`);
  for (const [key, value] of Object.entries(doc)) {
    if (!fields.includes(key)) throw new Error(`json: unknown field ${JSON.stringify(key)}`);
    if (value !== null && typeof value !== 'string') throw new Error(`json: cannot unmarshal ${typeof value} into Go struct field ${key} of type string`);
  }
  return Object.fromEntries(fields.map((f) => [f, doc[f] ?? '']));
}

const tokenMetadata = (t) => {
  const out = { id: t.id, principal_id: t.principalId, token_prefix: t.tokenPrefix, name: t.name, created_by_principal_id: t.createdByPrincipalId, created_at: t.createdAt };
  if (t.lastUsedAt) out.last_used_at = t.lastUsedAt;
  if (t.revokedAt) out.revoked_at = t.revokedAt;
  if (t.revokedByPrincipalId !== '') out.revoked_by_principal_id = t.revokedByPrincipalId;
  if (t.revocationReason !== '') out.revocation_reason = t.revocationReason;
  return out;
};

const auditEvent = (actor, action, targetPrincipalId, project, metadata) => ({
  actorPrincipalId: goTrim(actor.id), actorSource: actor.source, targetPrincipalId: goTrim(targetPrincipalId), project: goTrim(project), action, outcome: 'success', metadata,
});

const disabledMessage = (id) => `managed user ${JSON.stringify(id)} is disabled; enable the user before creating a managed token`;

/**
 * Escribe la auditoría de una acción de administración; si falla responde el error y devuelve `false`.
 */
async function audit(server, res, actor, ...args) {
  try {
    await server.store.insertAuthAuditEvent(auditEvent(actor, ...args));
    return true;
  } catch (err) {
    internal(res, `record auth audit: ${err.message}`);
    return false;
  }
}

/** Registra las rutas JSON de administración de personas, tokens y permisos. */
export function installAdminRoutes(server) {
  const add = (pattern, handler) => server.router.add(pattern, { handler, auth: true });
  const store = () => server.store;

  add('GET /admin/users', async ({ res, principal }) => {
    if (!requireManagedAdmin(res, principal)) return;
    try {
      sendJson(res, 200, await store().listHumanUsers());
    } catch (err) {
      internal(res, `list users: ${err.message}`);
    }
  });

  add('POST /admin/users', async ({ req, res, principal }) => {
    if (!requireManagedAdmin(res, principal)) return;
    let body;
    try {
      body = await decodeJsonBody(req, ['username', 'email', 'display_name', 'role']);
    } catch (err) {
      return badRequest(res, `invalid user payload: ${err.message}`);
    }
    const role = goTrim(body.role) || ROLE.member;
    let user;
    try {
      user = await store().createHumanUser({ username: body.username, email: body.email, displayName: body.display_name, role });
    } catch (err) {
      return badRequest(res, `create user: ${err.message}`);
    }
    if (!(await audit(server, res, principal, 'user.create', user.principal_id, '', { kind: 'human', role, username: goTrim(body.username) }))) return undefined;
    return sendJson(res, 201, user);
  });

  const setEnabled = (enabled, action) => async ({ res, params, principal }) => {
    if (!requireManagedAdmin(res, principal)) return;
    const id = goTrim(params.principalID ?? '');
    if (id === '') return badRequest(res, 'principal id is required');
    try {
      await store().setHumanUserEnabled(id, enabled);
    } catch (err) {
      return badRequest(res, `set user enabled: ${err.message}`);
    }
    if (!(await audit(server, res, principal, action, id, '', { enabled }))) return undefined;
    return sendMap(res, 200, { status: 'ok', principal_id: id, enabled });
  };
  add('POST /admin/users/{principalID}/enable', setEnabled(true, 'user.enable'));
  add('POST /admin/users/{principalID}/disable', setEnabled(false, 'user.disable'));

  add('GET /admin/users/{principalID}/tokens', async ({ res, params, principal }) => {
    if (!requireManagedAdmin(res, principal)) return;
    const id = goTrim(params.principalID ?? '');
    if (id === '') return badRequest(res, 'principal id is required');
    try {
      return sendJson(res, 200, (await store().listPrincipalTokens(id)).map(tokenMetadata));
    } catch (err) {
      return internal(res, `list tokens: ${err.message}`);
    }
  });

  add('POST /admin/users/{principalID}/tokens', async ({ req, res, params, principal }) => {
    if (!requireManagedAdmin(res, principal)) return;
    if (server.hasher === null) return internal(res, 'managed token hasher is not configured');
    const id = goTrim(params.principalID ?? '');
    if (id === '') return badRequest(res, 'principal id is required');
    let body;
    try {
      body = await decodeJsonBody(req, ['name']);
    } catch (err) {
      return badRequest(res, `invalid token payload: ${err.message}`);
    }
    let users;
    try {
      users = await store().listHumanUsers();
    } catch (err) {
      return internal(res, `list users: ${err.message}`);
    }
    const user = users.find((u) => u.principal_id === id);
    if (!user) return actionable(res, 404, REPAIRABLE, INVALID, 'managed user not found');
    if (!user.enabled) return actionable(res, 409, UPGRADE_ERROR_CLASS.policy, REASON.policyForbidden, disabledMessage(id));
    const managed = generateManagedToken('live');
    let created;
    try {
      created = await store().createPrincipalTokenWithAudit(
        { principalId: id, tokenPrefix: managed.prefix, tokenHash: server.hasher.hash(managed.raw), name: body.name, createdByPrincipalId: principal.id },
        auditEvent(principal, 'token.create', id, '', { token_prefix: managed.prefix, name: goTrim(body.name) }),
      );
    } catch (err) {
      if (err.code === 'principal_disabled') return actionable(res, 409, UPGRADE_ERROR_CLASS.policy, REASON.policyForbidden, disabledMessage(id));
      if (err.code === 'principal_not_found') return actionable(res, 404, REPAIRABLE, INVALID, 'managed user not found');
      if (err.code === 'audit_insert_failed') return internal(res, `record auth audit: ${err.message}`);
      return badRequest(res, `create token: ${err.message}`);
    }
    return sendMap(res, 201, { raw_token: managed.raw, token: tokenMetadata(created) });
  });

  add('POST /admin/tokens/{tokenID}/revoke', async ({ req, res, params, principal }) => {
    if (!requireManagedAdmin(res, principal)) return;
    const tokenId = goTrim(params.tokenID ?? '');
    if (tokenId === '') return badRequest(res, 'token id is required');
    let body;
    try {
      body = await decodeJsonBody(req, ['reason']);
    } catch (err) {
      return badRequest(res, `invalid revoke payload: ${err.message}`);
    }
    try {
      await store().revokePrincipalToken(tokenId, principal.id, body.reason);
    } catch (err) {
      return badRequest(res, `revoke token: ${err.message}`);
    }
    if (!(await audit(server, res, principal, 'token.revoke', '', '', { id: tokenId, reason: goTrim(body.reason) }))) return undefined;
    return sendMap(res, 200, { status: 'ok', token_id: tokenId });
  });

  add('GET /admin/users/{principalID}/grants', async ({ res, params, principal }) => {
    if (!requireManagedAdmin(res, principal)) return;
    const id = goTrim(params.principalID ?? '');
    if (id === '') return badRequest(res, 'principal id is required');
    try {
      return sendJson(res, 200, await store().listProjectGrants(id));
    } catch (err) {
      return internal(res, `list grants: ${err.message}`);
    }
  });

  add('POST /admin/users/{principalID}/grants', async ({ req, res, params, principal }) => {
    if (!requireManagedAdmin(res, principal)) return;
    const id = goTrim(params.principalID ?? '');
    if (id === '') return badRequest(res, 'principal id is required');
    let body;
    try {
      body = await decodeJsonBody(req, ['project']);
    } catch (err) {
      return badRequest(res, `invalid grant payload: ${err.message}`);
    }
    const project = goTrim(body.project);
    if (project === '') return badRequest(res, 'project is required');
    let grant;
    try {
      grant = await store().createProjectGrant({ principalId: id, project, grantedByPrincipalId: principal.id });
    } catch (err) {
      return badRequest(res, `create grant: ${err.message}`);
    }
    if (!(await audit(server, res, principal, 'grant.create', id, project, { project }))) return undefined;
    return sendJson(res, 201, grant);
  });

  add('POST /admin/users/{principalID}/grants/{project}/revoke', async ({ res, params, principal }) => {
    if (!requireManagedAdmin(res, principal)) return;
    const id = goTrim(params.principalID ?? '');
    const project = goTrim(params.project ?? '');
    if (id === '' || project === '') return badRequest(res, 'principal id and project are required');
    try {
      await store().revokeProjectGrant(id, project);
    } catch (err) {
      return badRequest(res, `revoke grant: ${err.message}`);
    }
    if (!(await audit(server, res, principal, 'grant.revoke', id, project, { project }))) return undefined;
    return sendMap(res, 200, { status: 'ok', principal_id: id, project });
  });
}
