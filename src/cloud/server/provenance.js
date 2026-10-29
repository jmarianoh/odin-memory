import { normalizeProject } from '../../project/canonical.js';
import { BodyTooLargeError, sendText } from '../../server/http.js';
import { goTrim } from '../../store/text.js';
import { readBuffer, sendMap } from './respond.js';
import { normalizeProjectGrant } from './identity.js';
import { KIND } from './tokens.js';

/**
 * Procedencia de los prompts con buzón de origen: quién es dueño de una sesión, qué pares (sesión, buzón) se
 * enlazan con qué prompt y la atestación humana de ese origen. Todo en tablas propias, independientes del
 * índice de sesiones que sale de los chunks.
 */

export class ProvenanceError extends Error {
  constructor(message, code) {
    super(`cloudstore: ${message}`);
    this.name = 'ProvenanceError';
    this.code = code;
  }
}
const ErrConflict = (message) => new ProvenanceError(message, 'session_authority_conflict');
const ErrClaimConflict = (message) => new ProvenanceError(message, 'prompt_pair_claim_conflict');
const ErrAuthorityNotFound = (id) => new ProvenanceError(`session authority not found: ${JSON.stringify(id)}`, 'session_authority_not_found');
const ErrUnbound = () => new ProvenanceError('prompt source attestation requires exact session authority and prompt pair claim', 'attestation_unbound');

export const PROVENANCE_DDL = [
  `CREATE TABLE IF NOT EXISTS cloud_session_authority (
    session_id TEXT PRIMARY KEY,
    owner_project TEXT NOT NULL,
    registered_by TEXT NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_prompt_pair_claims (
    session_id TEXT NOT NULL REFERENCES cloud_session_authority(session_id),
    source_inbox_id TEXT NOT NULL,
    sync_id TEXT NOT NULL UNIQUE,
    prompt_project TEXT NOT NULL,
    claimed_by TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, source_inbox_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_prompt_source_attestations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    source_inbox_id TEXT NOT NULL,
    sync_id TEXT NOT NULL,
    owner_project TEXT NOT NULL,
    prompt_project TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    attested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

export const provenanceMethods = {
  /** Registra al dueño de una sesión; repetir el mismo dueño es inocuo y otro dueño es un conflicto. */
  async registerSessionAuthority(sessionId, project, actor) {
    const [id, owner, by] = [goTrim(sessionId ?? ''), goTrim(project ?? ''), goTrim(actor ?? '')];
    if (id === '' || owner === '' || by === '') throw new ProvenanceError('session id, project and actor are required');
    let rows = await this.db.query('INSERT INTO cloud_session_authority (session_id, owner_project, registered_by) VALUES ($1, $2, $3) ON CONFLICT (session_id) DO NOTHING RETURNING owner_project', [id, owner, by]);
    if (rows.length === 0) rows = await this.db.query('SELECT owner_project FROM cloud_session_authority WHERE session_id = $1', [id]);
    if (rows[0].owner_project !== owner) throw ErrConflict(`session authority conflict: session ${JSON.stringify(id)} is owned by another project`);
  },

  /** El dueño registrado de la sesión, o `null`. */
  async getSessionAuthority(sessionId) {
    const id = goTrim(sessionId ?? '');
    if (id === '') throw new ProvenanceError('session id is required');
    const rows = await this.db.query('SELECT session_id, owner_project, registered_by, registered_at FROM cloud_session_authority WHERE session_id = $1', [id]);
    return rows[0] ?? null;
  },

  async getPromptPairClaim(sessionId, sourceInboxId) {
    const [id, inbox] = [goTrim(sessionId ?? ''), goTrim(sourceInboxId ?? '')];
    if (id === '' || inbox === '') throw new ProvenanceError('session id and inbox id are required');
    const rows = await this.db.query('SELECT session_id, source_inbox_id, sync_id, prompt_project, claimed_by, claimed_at FROM cloud_prompt_pair_claims WHERE session_id = $1 AND source_inbox_id = $2', [id, inbox]);
    return rows[0] ?? null;
  },

  /** Enlaza un par (sesión, buzón) con un prompt; repetir el mismo enlace es inocuo. */
  async claimPromptPair(sessionId, sourceInboxId, syncId, promptProject, actor) {
    const [id, inbox, sync, project, by] = [sessionId, sourceInboxId, syncId, promptProject, actor].map((v) => goTrim(v ?? ''));
    if ([id, inbox, sync, project, by].includes('')) throw new ProvenanceError('session id, inbox id, sync id, prompt project and actor are required');
    const inserted = await this.db.query(
      `INSERT INTO cloud_prompt_pair_claims (session_id, source_inbox_id, sync_id, prompt_project, claimed_by)
       SELECT session_id, $2, $3, $4, $5 FROM cloud_session_authority WHERE session_id = $1 ON CONFLICT DO NOTHING RETURNING sync_id`,
      [id, inbox, sync, project, by],
    );
    if (inserted.length > 0) return;
    const existing = await this.getPromptPairClaim(id, inbox);
    if (existing) {
      if (existing.sync_id === sync && existing.prompt_project === project) return;
      throw ErrClaimConflict('prompt pair claim conflict: pair already bound');
    }
    const [{ registered }] = await this.db.query('SELECT EXISTS (SELECT 1 FROM cloud_session_authority WHERE session_id = $1) AS registered', [id]);
    if (!registered) throw ErrAuthorityNotFound(id);
    throw ErrClaimConflict('prompt pair claim conflict: sync id already bound');
  },

  async verifyPromptSourceAttestation(id, sessionId, sourceInboxId, syncId, ownerProject, promptProject) {
    if (!(id > 0) || [sessionId, sourceInboxId, syncId, ownerProject, promptProject].some((v) => v === '')) return false;
    const rows = await this.db.query(
      `SELECT 1 AS found FROM cloud_prompt_source_attestations WHERE id = $1 AND session_id = $2 AND source_inbox_id = $3 AND sync_id = $4 AND owner_project = $5 AND prompt_project = $6`,
      [id, sessionId, sourceInboxId, syncId, ownerProject, promptProject],
    );
    return rows.length === 1;
  },

  /** Anota la afirmación humana de origen; exige el dueño registrado y el enlace exactos. */
  async attestPromptSource(sessionId, sourceInboxId, syncId, ownerProject, promptProject, actorId) {
    const values = [sessionId, sourceInboxId, syncId, ownerProject, promptProject, actorId].map((v) => goTrim(v ?? ''));
    if (values.includes('')) throw new ProvenanceError('all attestation fields are required');
    const rows = await this.db.query(
      `INSERT INTO cloud_prompt_source_attestations (session_id, source_inbox_id, sync_id, owner_project, prompt_project, actor_id)
       SELECT a.session_id, c.source_inbox_id, c.sync_id, a.owner_project, c.prompt_project, $6
       FROM cloud_session_authority a JOIN cloud_prompt_pair_claims c ON c.session_id = a.session_id
       WHERE a.session_id = $1 AND c.source_inbox_id = $2 AND c.sync_id = $3 AND a.owner_project = $4 AND c.prompt_project = $5
       RETURNING id::text AS id`,
      values,
    );
    if (rows.length === 0) throw ErrUnbound();
    return { id: Number(rows[0].id) };
  },
};

/** Un cuerpo JSON de un solo valor, con solo los campos indicados. @throws {Error} con `large` si superó el tope */
async function strictBody(req, limit, fields) {
  let text;
  try {
    text = (await readBuffer(req, limit)).toString('utf8');
  } catch (err) {
    throw Object.assign(new Error('too large'), { large: err instanceof BodyTooLargeError });
  }
  const bad = () => Object.assign(new Error('invalid'), { large: false });
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw bad();
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw bad();
  for (const [key, value] of Object.entries(doc)) {
    const spec = fields[key];
    if (spec === undefined || (value !== null && typeof value !== spec)) throw bad();
  }
  return Object.fromEntries(Object.keys(fields).map((k) => [k, doc[k] ?? (fields[k] === 'number' ? 0 : '')]));
}

const usable = (principal) => principal !== null && goTrim(principal.id ?? '') !== '';
const canonical = (name) => goTrim(normalizeProject(goTrim(name)).normalized);

/** ¿Tiene este principal un permiso vigente sobre el proyecto? */
async function granted(server, principal, project) {
  if (!/^\d+$/.test(principal.id)) return false;
  const name = normalizeProjectGrant(project);
  if (name === '') return false;
  try {
    return (await server.store.listProjectGrants(principal.id)).some((g) => g.project === name);
  } catch {
    return false;
  }
}

const AUTH_UNAVAILABLE = (res) => sendText(res, 401, 'authentication unavailable');

/** Rutas de autoridad de sesión, reclamos de pares de prompts y atestación de origen. */
export function installProvenanceRoutes(server) {
  const add = (pattern, handler) => server.router.add(pattern, { handler, auth: true });
  const authMode = () => server.token !== '';
  const body = async (req, res, fields, label) => {
    try {
      return await strictBody(req, server.maxPushBodyBytes, fields);
    } catch (err) {
      if (err.large) sendText(res, 413, `${label} request too large`);
      else sendText(res, 400, `invalid ${label} request`);
      return null;
    }
  };
  const authorityUnavailable = (res) => sendMap(res, 404, { error: 'session authority unavailable', error_code: 'session_authority_unavailable' });

  add('POST /sync/session-authorities', async ({ req, res, principal }) => {
    const p = await body(req, res, { session_id: 'string', project: 'string' }, 'session authority');
    if (p === null) return;
    const sessionId = goTrim(p.session_id);
    let project = goTrim(p.project);
    if (sessionId === '' || project === '') return sendText(res, 400, 'session_id and project are required');
    project = canonical(project);
    if (project === '') return sendText(res, 400, 'project is required');
    if (!usable(principal) && !authMode()) return AUTH_UNAVAILABLE(res);
    if (!(await server.authorizeProject(res, project, principal))) return undefined;
    const actor = usable(principal) ? goTrim(principal.id) : 'legacy:authenticated';
    try {
      await server.store.registerSessionAuthority(sessionId, project, actor);
    } catch (err) {
      return err.code === 'session_authority_conflict' ? sendText(res, 409, 'session authority conflict') : sendText(res, 500, 'session authority storage unavailable');
    }
    return sendMap(res, 200, { status: 'ok' });
  });

  add('POST /sync/prompt-pair-claims', async ({ req, res, principal }) => {
    if (!authMode() || !usable(principal)) return AUTH_UNAVAILABLE(res);
    const p = await body(req, res, { session_id: 'string', source_inbox_id: 'string', sync_id: 'string', owner_project: 'string', project: 'string' }, 'prompt pair claim');
    if (p === null) return;
    const [sessionId, inboxId, syncId] = [p.session_id, p.source_inbox_id, p.sync_id].map(goTrim);
    if ([sessionId, inboxId, syncId, goTrim(p.owner_project), goTrim(p.project)].includes('')) return sendText(res, 400, 'session_id, source_inbox_id, sync_id, owner_project and project are required');
    const [owner, project] = [canonical(p.owner_project), canonical(p.project)];
    if (owner === '' || project === '') return sendText(res, 400, 'owner_project and project are required');
    if (!(await server.authorizeProject(res, owner, principal)) || !(await server.authorizeProject(res, project, principal))) return undefined;
    let authority;
    try {
      authority = await server.store.getSessionAuthority(sessionId);
    } catch {
      return sendText(res, 500, 'session authority storage unavailable');
    }
    if (authority === null || authority.owner_project !== owner) return authorityUnavailable(res);
    try {
      await server.store.claimPromptPair(sessionId, inboxId, syncId, project, goTrim(principal.id));
    } catch (err) {
      if (err.code === 'prompt_pair_claim_conflict') return sendText(res, 409, 'prompt pair claim conflict');
      if (err.code === 'session_authority_not_found') return authorityUnavailable(res);
      return sendText(res, 500, 'prompt pair claim storage unavailable');
    }
    return sendMap(res, 200, { status: 'ok' });
  });

  add('POST /sync/prompt-source-attestations', async ({ req, res, principal }) => {
    if (!authMode() || !usable(principal)) return sendText(res, 401, 'human authentication required');
    if (principal.kind !== KIND.human) return sendText(res, 403, 'human principal required');
    const p = await body(req, res, { session_id: 'string', source_inbox_id: 'string', sync_id: 'string', owner_project: 'string', prompt_project: 'string' }, 'attestation');
    if (p === null) return;
    const [session, inbox, syncId] = [p.session_id, p.source_inbox_id, p.sync_id].map(goTrim);
    if ([session, inbox, syncId, goTrim(p.owner_project), goTrim(p.prompt_project)].includes('')) return sendText(res, 400, 'all attestation fields are required');
    const [owner, prompt] = [canonical(p.owner_project), canonical(p.prompt_project)];
    if (owner === '' || prompt === '') return sendText(res, 400, 'projects are required');
    if (!(await granted(server, principal, owner))) return sendText(res, 403, 'owner project forbidden');
    if (!(await granted(server, principal, prompt))) return sendText(res, 403, 'prompt project forbidden');
    const actor = goTrim(principal.id);
    try {
      await server.store.registerSessionAuthority(session, owner, actor);
    } catch (err) {
      return err.code === 'session_authority_conflict' ? sendText(res, 409, 'session authority conflict') : sendText(res, 500, 'registration storage unavailable');
    }
    try {
      await server.store.claimPromptPair(session, inbox, syncId, prompt, actor);
    } catch (err) {
      if (err.code === 'prompt_pair_claim_conflict') return sendText(res, 409, 'prompt pair conflict');
      if (err.code === 'session_authority_not_found') return authorityUnavailable(res);
      return sendText(res, 500, 'claim storage unavailable');
    }
    try {
      const record = await server.store.attestPromptSource(session, inbox, syncId, owner, prompt, actor);
      return sendMap(res, 200, { status: 'ok', attestation_id: record.id });
    } catch (err) {
      return err.code === 'attestation_unbound' ? sendText(res, 409, 'attestation binding conflict') : sendText(res, 500, 'attestation storage unavailable');
    }
  });

  add('POST /sync/prompt-source-attestations/verify', async ({ req, res, principal }) => {
    if (!authMode() || !usable(principal)) return sendText(res, 401, 'authentication required');
    const p = await body(req, res, { audit_id: 'number', session_id: 'string', source_inbox_id: 'string', sync_id: 'string', owner_project: 'string', prompt_project: 'string' }, 'verification');
    if (p === null) return;
    if (!(p.audit_id > 0) || [p.session_id, p.source_inbox_id, p.sync_id, p.owner_project, p.prompt_project].some((v) => goTrim(v) === '')) return sendText(res, 400, 'audit id and all verification fields are required');
    const [owner, prompt] = [canonical(p.owner_project), canonical(p.prompt_project)];
    if (owner === '' || prompt === '') return sendText(res, 400, 'projects are required');
    if (!(await granted(server, principal, owner))) return sendText(res, 403, 'owner project forbidden');
    if (!(await granted(server, principal, prompt))) return sendText(res, 403, 'prompt project forbidden');
    let found;
    try {
      found = await server.store.verifyPromptSourceAttestation(p.audit_id, p.session_id, p.source_inbox_id, p.sync_id, owner, prompt);
    } catch {
      return sendText(res, 500, 'verification storage unavailable');
    }
    if (!found) return sendText(res, 409, 'attestation binding conflict');
    return sendMap(res, 200, { status: 'ok', attestation_id: p.audit_id });
  });
}
