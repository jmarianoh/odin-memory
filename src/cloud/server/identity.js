import { normalizeProject } from '../../project/canonical.js';
import { goTrim } from '../../store/text.js';

/**
 * Identidades gestionadas del servidor: personas, tokens, permisos por proyecto y auditoría de autenticación.
 * Se añaden a `CloudStore`; todas las funciones usan `this.db`.
 */

export class IdentityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}
const fail = (message, code) => new IdentityError(`cloudstore: ${message}`, code);

export const ErrLastActiveAdmin = () => fail('cannot remove last active admin', 'last_active_admin');
export const ErrAdminAlreadyExists = () => fail('a managed admin already exists', 'admin_already_exists');
export const ErrPrincipalNotFound = () => fail('principal not found', 'principal_not_found');
export const ErrPrincipalDisabled = () => fail('principal is disabled', 'principal_disabled');
export const ErrTokenNotFound = () => fail('principal token not found', 'token_not_found');
export const ErrTokenRevoked = () => fail('principal token is revoked', 'token_revoked');
export const ErrRecoveryIneligible = (why) => fail(`stranded admin token recovery is not eligible: ${why}`, 'recovery_ineligible');
export const ErrAuditInsertFailed = () => fail('auth audit insert failed', 'audit_insert_failed');

const GUARD = "SELECT pg_advisory_xact_lock(hashtext('odin_cloud_active_admin_guard'))";
const ROLES = new Set(['admin', 'member']);

/** Nombre de proyecto de un permiso: canónico y limitado a `a-z 0-9 . _ -`. */
export function normalizeProjectGrant(project) {
  const normalized = goTrim(normalizeProject(project ?? '').normalized);
  if (normalized === '') return '';
  return normalized.replace(/[^a-z0-9._]+/g, '-').replace(/^-+|-+$/g, '');
}

const SENSITIVE = ['token', 'authorization', 'cookie', 'secret', 'hash', 'password', 'bearer'];
const sensitiveKey = (key) => {
  const k = goTrim(key).toLowerCase();
  return k !== 'token_prefix' && SENSITIVE.some((fragment) => k.includes(fragment));
};
const exempt = (key, value) => goTrim(key).toLowerCase() === 'issued_token' && typeof value === 'boolean';

/** Los metadatos de la auditoría nunca llevan secretos. */
function rejectSensitive(value) {
  if (Array.isArray(value)) return value.forEach(rejectSensitive);
  if (value === null || typeof value !== 'object') return undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (!exempt(key, entry) && sensitiveKey(key)) throw fail(`sensitive auth audit metadata is not allowed: ${key}`, 'sensitive_audit_metadata');
    rejectSensitive(entry);
  }
  return undefined;
}

/** Columna de fecha como texto RFC 3339 en UTC con microsegundos; `fmtTs` le quita los ceros finales como el formato de referencia. */
const ts = (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const fmtTs = (text) => (text == null ? null : text.replace(/(\.\d*?)0+Z$/, '$1Z').replace(/\.Z$/, 'Z'));

const nullable = (value) => (goTrim(value ?? '') === '' ? null : goTrim(value));

async function insertAudit(runner, event) {
  const actorSource = goTrim(event.actorSource ?? '');
  if (actorSource === '') throw fail('actor source is required');
  const action = goTrim(event.action ?? '');
  if (action === '') throw fail('action is required');
  const outcome = goTrim(event.outcome ?? '');
  if (outcome === '') throw fail('outcome is required');
  const metadata = event.metadata && Object.keys(event.metadata).length > 0 ? event.metadata : null;
  if (metadata) rejectSensitive(metadata);
  await runner.query(
    `INSERT INTO cloud_auth_audit_log (actor_principal_id, actor_source, target_principal_id, project, action, outcome, reason_code, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [nullable(event.actorPrincipalId), actorSource, nullable(event.targetPrincipalId), nullable(event.project), action, outcome, nullable(event.reasonCode), metadata ? JSON.stringify(metadata) : null],
  );
}

const human = (row) => ({
  principal_id: row.principal_id, username: row.username, email: row.email ?? '', display_name: row.display_name, role: row.role, enabled: row.enabled, created_at: fmtTs(row.created_at),
});

const TOKEN_COLUMNS = `t.id::text AS id, t.principal_id::text AS principal_id, t.token_prefix, t.name, COALESCE(t.created_by_principal_id::text, '') AS created_by_principal_id,
  ${ts('t.created_at')} AS created_at, ${ts('t.last_used_at')} AS last_used_at, ${ts('t.revoked_at')} AS revoked_at, COALESCE(t.revoked_by_principal_id::text, '') AS revoked_by_principal_id, COALESCE(t.revocation_reason, '') AS revocation_reason`;
const token = (row) => ({
  id: row.id, principalId: row.principal_id, tokenPrefix: row.token_prefix, name: row.name, createdByPrincipalId: row.created_by_principal_id, createdAt: row.created_at,
  lastUsedAt: row.last_used_at, revokedAt: row.revoked_at, revokedByPrincipalId: row.revoked_by_principal_id, revocationReason: row.revocation_reason,
});

export const identityMethods = {
  async createHumanUser({ username, email = '', displayName = '', role }) {
    const name = goTrim(username ?? '');
    if (name === '') throw fail('username is required');
    const r = goTrim(role ?? '');
    if (!ROLES.has(r)) throw fail('invalid principal role', 'invalid_role');
    const display = goTrim(displayName ?? '') || name;
    return this.db.transaction(async (tx) => {
      if (r === 'admin') await tx.query(GUARD);
      const [principal] = await tx.query(
        "INSERT INTO cloud_principals (kind, display_name, role, enabled) VALUES ('human', $1, $2, TRUE) RETURNING id::text AS id, display_name, role, enabled",
        [display, r],
      );
      const [row] = await tx.query(
        'INSERT INTO cloud_human_users (principal_id, username, email) VALUES ($1, $2, $3) RETURNING principal_id::text AS principal_id, username, COALESCE(email, \'\') AS email, ' + ts('created_at') + ' AS created_at',
        [principal.id, name, nullable(email)],
      );
      return human({ ...row, display_name: principal.display_name, role: principal.role, enabled: principal.enabled });
    });
  },

  /** Crea el primer administrador de forma atómica; falla si ya hay uno activo. */
  async createFirstAdminHumanUser({ username, email = '', displayName = '' }) {
    const name = goTrim(username ?? '');
    if (name === '') throw fail('username is required');
    const display = goTrim(displayName ?? '') || name;
    return this.db.transaction(async (tx) => {
      await tx.query(GUARD);
      const [{ exists }] = await tx.query("SELECT EXISTS (SELECT 1 FROM cloud_principals WHERE role = 'admin' AND enabled = TRUE) AS exists");
      if (exists) throw ErrAdminAlreadyExists();
      const [principal] = await tx.query(
        "INSERT INTO cloud_principals (kind, display_name, role, enabled) VALUES ('human', $1, 'admin', TRUE) RETURNING id::text AS id, display_name, role, enabled",
        [display],
      );
      const [row] = await tx.query(
        'INSERT INTO cloud_human_users (principal_id, username, email) VALUES ($1, $2, $3) RETURNING principal_id::text AS principal_id, username, COALESCE(email, \'\') AS email, ' + ts('created_at') + ' AS created_at',
        [principal.id, name, nullable(email)],
      );
      return human({ ...row, display_name: principal.display_name, role: principal.role, enabled: principal.enabled });
    });
  },

  /** El principal con ese id, para revalidar una sesión; `principal_not_found` si no existe. */
  async getPrincipal(id) {
    const key = goTrim(id ?? '');
    if (!/^\d+$/.test(key)) throw ErrPrincipalNotFound();
    const rows = await this.db.query('SELECT id::text AS id, kind, display_name, role, enabled FROM cloud_principals WHERE id = $1', [key]);
    if (rows.length === 0) throw ErrPrincipalNotFound();
    const r = rows[0];
    return { id: r.id, kind: r.kind, displayName: r.display_name, role: r.role, enabled: r.enabled };
  },

  async listHumanUsers() {
    const rows = await this.db.query(
      `SELECT h.principal_id::text AS principal_id, h.username, COALESCE(h.email, '') AS email, p.display_name, p.role, p.enabled, ${ts('h.created_at')} AS created_at
       FROM cloud_human_users h JOIN cloud_principals p ON p.id = h.principal_id ORDER BY h.username ASC`,
    );
    return rows.map(human);
  },

  /** Habilita o deshabilita a una persona; nunca deja a la nube sin administrador activo. */
  async setHumanUserEnabled(principalId, enabled) {
    const id = goTrim(principalId ?? '');
    await this.db.transaction(async (tx) => {
      const rows = await tx.query("SELECT role, enabled FROM cloud_principals WHERE id::text = $1 AND kind = 'human' FOR UPDATE", [id]);
      if (rows.length === 0) throw fail('human user not found', 'not_found');
      await tx.query(GUARD);
      const { role, enabled: current } = rows[0];
      if (role === 'admin' && current && !enabled) {
        const [{ n }] = await tx.query("SELECT COUNT(*)::int AS n FROM cloud_principals WHERE role = 'admin' AND enabled = TRUE");
        if (n <= 1) throw ErrLastActiveAdmin();
      }
      await tx.query("UPDATE cloud_principals SET enabled = $2, updated_at = NOW() WHERE id::text = $1 AND kind = 'human'", [id, enabled]);
    });
  },

  /** Emite un token y deja constancia en la auditoría en la misma transacción. */
  async createPrincipalTokenWithAudit({ principalId, tokenPrefix, tokenHash, name = '', createdByPrincipalId = '' }, audit) {
    const id = goTrim(principalId ?? '');
    if (id === '') throw fail('principal id is required');
    if (goTrim(tokenPrefix ?? '') === '') throw fail('token prefix is required');
    if (goTrim(tokenHash ?? '') === '') throw fail('token hash is required');
    return this.db.transaction(async (tx) => {
      const target = await tx.query('SELECT enabled FROM cloud_principals WHERE id::text = $1 FOR UPDATE', [id]);
      if (target.length === 0) throw ErrPrincipalNotFound();
      if (!target[0].enabled) throw ErrPrincipalDisabled();
      await tx.query(GUARD);
      const [row] = await tx.query(
        `INSERT INTO cloud_principal_tokens (principal_id, token_prefix, token_hash, name, created_by_principal_id) VALUES ($1, $2, $3, $4, $5)
         RETURNING id::text AS id, principal_id::text AS principal_id, token_prefix, name, COALESCE(created_by_principal_id::text, '') AS created_by_principal_id, ${ts('created_at')} AS created_at,
           ${ts('last_used_at')} AS last_used_at, ${ts('revoked_at')} AS revoked_at, COALESCE(revoked_by_principal_id::text, '') AS revoked_by_principal_id, COALESCE(revocation_reason, '') AS revocation_reason`,
        [id, goTrim(tokenPrefix), goTrim(tokenHash), goTrim(name ?? ''), nullable(createdByPrincipalId)],
      );
      if (audit) {
        try {
          await insertAudit(tx, audit);
        } catch (cause) {
          throw Object.assign(ErrAuditInsertFailed(), { cause, message: `${ErrAuditInsertFailed().message}: ${cause.message}` });
        }
      }
      return token(row);
    });
  },

  /**
   * Emite un token a la única persona administradora habilitada que se quedó sin él. Solo si no existe ningún
   * token en el despliegue; con `revokeExisting`, también sustituye a un único token activo y sin usar.
   */
  async recoverStrandedAdminTokenWithAudit({ tokenPrefix, tokenHash, name = '', revokeExisting = false }, audit) {
    if (goTrim(tokenPrefix ?? '') === '') throw fail('token prefix is required');
    if (goTrim(tokenHash ?? '') === '') throw fail('token hash is required');
    const lockAdmins = (tx) => tx.query(
      "SELECT p.id::text AS id FROM cloud_principals p JOIN cloud_human_users h ON h.principal_id = p.id WHERE p.kind = 'human' AND p.role = 'admin' AND p.enabled = TRUE ORDER BY p.id FOR UPDATE OF p",
    );
    return this.db.transaction(async (tx) => {
      await lockAdmins(tx);
      await tx.query(GUARD);
      const admins = await lockAdmins(tx);
      if (admins.length !== 1) throw ErrRecoveryIneligible(`requires exactly one enabled managed human admin, found ${admins.length}`);
      const principalId = admins[0].id;
      const [{ n: tokens }] = await tx.query('SELECT COUNT(*)::int AS n FROM cloud_principal_tokens');
      if (tokens !== 0) {
        if (!revokeExisting) throw ErrRecoveryIneligible(`requires zero principal tokens, found ${tokens}`);
        const active = await tx.query(
          `SELECT id::text AS id, principal_id::text AS principal_id, last_used_at, (SELECT COUNT(*)::int FROM cloud_principal_tokens WHERE revoked_at IS NULL) AS active
           FROM cloud_principal_tokens WHERE revoked_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE`,
        );
        if (active.length === 0) throw ErrRecoveryIneligible('replacement requires exactly one active principal token, found 0');
        if (active[0].active !== 1) throw ErrRecoveryIneligible(`replacement requires exactly one active principal token, found ${active[0].active}`);
        if (active[0].principal_id !== principalId || active[0].last_used_at !== null) {
          throw ErrRecoveryIneligible('replacement requires one unused active token owned by the sole enabled managed human admin');
        }
        await tx.query(
          "UPDATE cloud_principal_tokens SET revoked_at = NOW(), revoked_by_principal_id = $2, revocation_reason = 'stranded_admin_token_replaced' WHERE id::text = $1 AND revoked_at IS NULL",
          [active[0].id, principalId],
        );
      }
      const [row] = await tx.query(
        `INSERT INTO cloud_principal_tokens (principal_id, token_prefix, token_hash, name, created_by_principal_id) VALUES ($1, $2, $3, $4, $1)
         RETURNING id::text AS id, principal_id::text AS principal_id, token_prefix, name, COALESCE(created_by_principal_id::text, '') AS created_by_principal_id, ${ts('created_at')} AS created_at,
           ${ts('last_used_at')} AS last_used_at, ${ts('revoked_at')} AS revoked_at, COALESCE(revoked_by_principal_id::text, '') AS revoked_by_principal_id, COALESCE(revocation_reason, '') AS revocation_reason`,
        [principalId, goTrim(tokenPrefix), goTrim(tokenHash), goTrim(name ?? '')],
      );
      try {
        await insertAudit(tx, {
          ...audit, actorPrincipalId: '', actorSource: 'bootstrap_cli', targetPrincipalId: principalId, project: '', action: 'bootstrap.cli', outcome: 'success', reasonCode: 'stranded_admin_token_recovered',
        });
      } catch (cause) {
        throw Object.assign(ErrAuditInsertFailed(), { cause, message: `${ErrAuditInsertFailed().message}: ${cause.message}` });
      }
      return token(row);
    });
  },

  async listPrincipalTokens(principalId) {
    const rows = await this.db.query(`SELECT ${TOKEN_COLUMNS} FROM cloud_principal_tokens t WHERE t.principal_id::text = $1 ORDER BY t.created_at ASC, t.id ASC`, [goTrim(principalId ?? '')]);
    return rows.map(token);
  },

  /** El token y su titular a partir del resumen del token. */
  async findPrincipalTokenByHash(tokenHash) {
    const hash = goTrim(tokenHash ?? '');
    if (hash === '') throw fail('token hash is required');
    const rows = await this.db.query(
      `SELECT ${TOKEN_COLUMNS}, p.id::text AS p_id, p.kind, p.display_name, p.role, p.enabled
       FROM cloud_principal_tokens t JOIN cloud_principals p ON p.id = t.principal_id WHERE t.token_hash = $1`,
      [hash],
    );
    if (rows.length === 0) throw ErrTokenNotFound();
    const row = rows[0];
    return { token: token(row), principal: { id: row.p_id, kind: row.kind, displayName: row.display_name, role: row.role, enabled: row.enabled } };
  },

  /** Anota el uso de un token; falla si su titular está deshabilitado o el token revocado. */
  async markPrincipalTokenUsed(tokenId) {
    const id = goTrim(tokenId ?? '');
    await this.db.transaction(async (tx) => {
      const found = await tx.query('SELECT principal_id::text AS principal_id FROM cloud_principal_tokens WHERE id::text = $1', [id]);
      if (found.length === 0) throw ErrTokenNotFound();
      const owner = await tx.query('SELECT enabled FROM cloud_principals WHERE id::text = $1 FOR NO KEY UPDATE', [found[0].principal_id]);
      if (owner.length === 0) throw ErrPrincipalNotFound();
      if (!owner[0].enabled) throw ErrPrincipalDisabled();
      const locked = await tx.query('SELECT revoked_at FROM cloud_principal_tokens WHERE id::text = $1 FOR UPDATE', [id]);
      if (locked[0].revoked_at) throw ErrTokenRevoked();
      await tx.query('UPDATE cloud_principal_tokens SET last_used_at = GREATEST(last_used_at, clock_timestamp()) WHERE id::text = $1', [id]);
    });
  },

  async revokePrincipalToken(tokenId, revokedByPrincipalId, reason) {
    const rows = await this.db.query(
      `UPDATE cloud_principal_tokens SET revoked_at = COALESCE(revoked_at, NOW()), revoked_by_principal_id = $2, revocation_reason = $3 WHERE id::text = $1 RETURNING id`,
      [goTrim(tokenId ?? ''), nullable(revokedByPrincipalId), nullable(reason)],
    );
    if (rows.length === 0) throw fail('principal token not found', 'not_found');
  },

  async createProjectGrant({ principalId, project, grantedByPrincipalId = '' }) {
    const id = goTrim(principalId ?? '');
    if (id === '') throw fail('principal id is required');
    const name = normalizeProjectGrant(project);
    if (name === '') throw fail('project is required');
    const [row] = await this.db.query(
      `INSERT INTO cloud_project_grants (principal_id, project, granted_by_principal_id) VALUES ($1, $2, $3)
       ON CONFLICT (principal_id, project) DO UPDATE SET project = EXCLUDED.project
       RETURNING principal_id::text AS principal_id, project, COALESCE(granted_by_principal_id::text, '') AS granted_by_principal_id, ${ts('created_at')} AS created_at`,
      [id, name, nullable(grantedByPrincipalId)],
    );
    return { ...row, created_at: fmtTs(row.created_at) };
  },

  async listProjectGrants(principalId) {
    const id = goTrim(principalId ?? '');
    if (!/^\d+$/.test(id)) throw fail(`parse principal id: invalid syntax: ${JSON.stringify(id)}`);
    const rows = await this.db.query(
      `SELECT principal_id::text AS principal_id, project, COALESCE(granted_by_principal_id::text, '') AS granted_by_principal_id, ${ts('created_at')} AS created_at FROM cloud_project_grants WHERE principal_id = $1 ORDER BY project ASC`,
      [id],
    );
    return rows.map((row) => ({ ...row, created_at: fmtTs(row.created_at) }));
  },

  async revokeProjectGrant(principalId, project) {
    const id = goTrim(principalId ?? '');
    if (!/^\d+$/.test(id)) throw fail(`parse principal id: invalid syntax: ${JSON.stringify(id)}`);
    await this.db.query('DELETE FROM cloud_project_grants WHERE principal_id = $1 AND project = $2', [id, normalizeProjectGrant(project)]);
  },

  async hasActiveAdmin() {
    const [{ exists }] = await this.db.query("SELECT EXISTS (SELECT 1 FROM cloud_principals WHERE role = 'admin' AND enabled = TRUE) AS exists");
    return exists;
  },

  async insertAuthAuditEvent(event) {
    await insertAudit(this.db, event);
  },

  async listAuthAuditEvents({ limit = 100 } = {}) {
    const size = limit <= 0 || limit > 500 ? 100 : limit;
    const rows = await this.db.query(
      `SELECT id::text AS id, occurred_at, COALESCE(actor_principal_id::text, '') AS actor_principal_id, actor_source, COALESCE(target_principal_id::text, '') AS target_principal_id,
         COALESCE(project, '') AS project, action, outcome, COALESCE(reason_code, '') AS reason_code, metadata
       FROM cloud_auth_audit_log ORDER BY occurred_at DESC, id DESC LIMIT $1`,
      [size],
    );
    return rows.map((r) => ({
      id: r.id, occurredAt: r.occurred_at, actorPrincipalId: r.actor_principal_id, actorSource: r.actor_source, targetPrincipalId: r.target_principal_id, project: r.project,
      action: r.action, outcome: r.outcome, reasonCode: r.reason_code, metadata: r.metadata ?? {},
    }));
  },
};
