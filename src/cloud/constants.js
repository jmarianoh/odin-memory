import { DEFAULT_SYNC_TARGET_KEY, SYNC_INBOX_TARGET_KEY } from '../store/sync-state.js';

export const TARGET_KEY_CLOUD = DEFAULT_SYNC_TARGET_KEY;
export const TARGET_KEY_CLOUD_INBOX = SYNC_INBOX_TARGET_KEY;

export const REASON = Object.freeze({
  blockedUnenrolled: 'blocked_unenrolled',
  nonEnrolledPendingMutations: 'non_enrolled_pending_mutations',
  paused: 'paused',
  authRequired: 'auth_required',
  policyForbidden: 'policy_forbidden',
  transportFailed: 'transport_failed',
  cloudConfigError: 'cloud_config_error',
});

export const UPGRADE_ERROR_CLASS = Object.freeze({ repairable: 'repairable', blocked: 'blocked', policy: 'policy' });
export const UPGRADE_ERROR_CODE = Object.freeze({
  projectRequired: 'upgrade_blocked_project_required',
  payloadInvalid: 'upgrade_repairable_payload_invalid',
  payloadTooLarge: 'upgrade_repairable_payload_too_large',
  chunkConflict: 'upgrade_repairable_chunk_conflict',
  internal: 'upgrade_blocked_internal',
});

/** Tipo de contenido del sobre comprimido de los chunks. */
export const COMPRESSED_MEDIA_TYPE = 'application/vnd.odin.sync+gzip';
export const ENVELOPE_VERSION = '1';
/** Tope de bytes descomprimidos de un chunk (8 MiB). */
export const MAX_DECODED_BYTES = 8 * 1024 * 1024;
