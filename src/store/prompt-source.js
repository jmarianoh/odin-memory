import { goTrim } from './text.js';

/** Origen observado de un prompt y su confirmación local tras una atestación remota. */

export class PromptSourceConfirmationError extends Error {
  constructor() {
    super('prompt source confirmation rejected');
    this.name = 'PromptSourceConfirmationError';
  }
}

const OBSERVED_SQL = `SELECT ifnull(session_id,'') AS session_id, ifnull(source_inbox_id,'') AS source_inbox_id, ifnull(project,'') AS project, ifnull(sync_id,'') AS sync_id, 'live' AS kind
  FROM user_prompts WHERE sync_id = ?
  UNION ALL
  SELECT ifnull(session_id,''), ifnull(source_inbox_id,''), ifnull(project,''), ifnull(sync_id,''), 'deleted'
  FROM prompt_tombstones WHERE sync_id = ? LIMIT 2`;

const toPreview = (row) => ({ sessionId: row.session_id, sourceInboxId: row.source_inbox_id, project: row.project, syncId: row.sync_id, kind: row.kind });
const complete = (p) => [p.sessionId, p.sourceInboxId, p.project, p.syncId].every((v) => goTrim(v ?? '') !== '');

/**
 * Lo que el almacén observa de un `sync_id` exacto (prompt vivo o lápida). Dato observado, no prueba de dueño.
 * @returns {{ sessionId: string, sourceInboxId: string, project: string, syncId: string, kind: 'live'|'deleted' }|null} `null` si es ambiguo, incompleto o no existe
 */
export function previewPromptSource(store, syncId) {
  if (goTrim(syncId ?? '') === '') return null;
  const rows = store.db.all(OBSERVED_SQL, syncId, syncId);
  if (rows.length !== 1) return null;
  const preview = toPreview(rows[0]);
  return complete(preview) ? preview : null;
}

const samePreview = (a, b) => a.sessionId === b.sessionId && a.sourceInboxId === b.sourceInboxId && a.project === b.project && a.syncId === b.syncId && a.kind === b.kind;

/**
 * Guarda la afirmación humana de dueño solo tras el éxito remoto. Revalida la observación y la contrasta con la sesión viva.
 * @throws {PromptSourceConfirmationError}
 */
export function confirmPromptSourceAttestation(store, remoteTarget, preview, assertedOwner, remoteAttestationId) {
  const bad = () => new PromptSourceConfirmationError();
  if (goTrim(remoteTarget ?? '') === '' || goTrim(assertedOwner ?? '') === '' || !(remoteAttestationId > 0) || !complete(preview ?? {}) || (preview.kind !== 'live' && preview.kind !== 'deleted')) throw bad();
  store.db.writeTransaction((db) => {
    const rows = db.all(OBSERVED_SQL, preview.syncId, preview.syncId);
    if (rows.length !== 1) throw bad();
    const current = toPreview(rows[0]);
    if (!samePreview(current, preview) || !complete(current)) throw bad();
    const session = db.get('SELECT project FROM sessions WHERE id = ?', preview.sessionId);
    if (session && goTrim(session.project ?? '') !== '' && session.project !== assertedOwner) throw bad();
    const existing = db.get(
      'SELECT session_id, source_inbox_id, prompt_project, sync_id, kind, asserted_owner_project, remote_attestation_id FROM prompt_source_confirmations WHERE remote_target = ? AND sync_id = ?',
      remoteTarget, preview.syncId,
    );
    if (!existing) {
      db.run(
        'INSERT INTO prompt_source_confirmations (remote_target, sync_id, session_id, source_inbox_id, prompt_project, kind, asserted_owner_project, remote_attestation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        remoteTarget, preview.syncId, preview.sessionId, preview.sourceInboxId, preview.project, preview.kind, assertedOwner, remoteAttestationId,
      );
      return;
    }
    if (existing.session_id !== preview.sessionId || existing.source_inbox_id !== preview.sourceInboxId || existing.prompt_project !== preview.project || existing.sync_id !== preview.syncId || existing.asserted_owner_project !== assertedOwner) throw bad();
    if (remoteAttestationId <= existing.remote_attestation_id) {
      if (remoteAttestationId === existing.remote_attestation_id && existing.kind === preview.kind) return;
      throw bad();
    }
    if (existing.kind !== 'live' && existing.kind !== 'deleted') throw bad();
    db.run('UPDATE prompt_source_confirmations SET kind = ?, remote_attestation_id = ? WHERE remote_target = ? AND sync_id = ?', preview.kind, remoteAttestationId, remoteTarget, preview.syncId);
  });
}
