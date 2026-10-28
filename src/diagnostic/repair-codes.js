import { CHECK } from './checks.js';

/** Chequeos con una reparación implementada. */
export const REPAIRABLE_CODES = Object.freeze([
  CHECK.sessionProjectDirectoryMismatch,
  CHECK.manualSessionNameProjectMismatch,
  CHECK.invalidSessionIdentity,
  CHECK.orphanedObservationSession,
  CHECK.orphanedPendingRelations,
  CHECK.syncMutationRequiredFields,
  CHECK.syncTargetClosedSpace,
]);

export const isRepairableCode = (code) => REPAIRABLE_CODES.includes(String(code ?? '').trim());
