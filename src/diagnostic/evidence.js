import { statSync } from 'node:fs';
import {
  SOURCE_DIR_BASENAME, SOURCE_GIT_REMOTE, SOURCE_GIT_ROOT, detectProjectFull, observeGitRoot,
} from '../project/detect.js';
import { deriveRoutingCandidate } from '../project/routing-candidate.js';
import { listDiagnosticSessions } from '../store/diagnostic.js';
import { resolveProjectAlias } from '../store/projects.js';
import { goTrim } from '../store/text.js';
import { normalizeProjectName } from './core.js';

/** Evidencia de Git que basta para fijar el proyecto de un directorio. */
const isTrustedDirectoryEvidence = (source) => goTrim(source ?? '') === SOURCE_GIT_REMOTE || goTrim(source ?? '') === SOURCE_GIT_ROOT;

export const isAcceptedDirectoryAuthoritySource = (source) => [SOURCE_GIT_REMOTE, SOURCE_GIT_ROOT, SOURCE_DIR_BASENAME].includes(goTrim(source ?? ''));

/**
 * Proyecto que le corresponde a un directorio. `scope.detectProject` lo sustituye en las pruebas.
 * @returns {{ project: string, source: string, path?: string }|null}
 */
export function detectSessionDirectoryProject(scope, cache, directory) {
  if (goTrim(directory) === '') return null;
  if (cache.has(directory)) {
    const cached = cache.get(directory);
    return cached.project !== '' ? cached : null;
  }
  if (scope.detectProject) {
    const detected = scope.detectProject(directory);
    if (!detected || !isAcceptedDirectoryAuthoritySource(detected.source)) return null;
    cache.set(directory, detected);
    return detected.project !== '' ? detected : null;
  }
  try {
    statSync(directory);
  } catch {
    return null;
  }
  const result = detectProjectFull(directory, { inspectOnly: true });
  if (result.error) return null;
  if (!isAcceptedDirectoryAuthoritySource(result.source)) return null;
  const detected = { project: normalizeProjectName(result.project), source: result.source, path: result.path };
  cache.set(directory, detected);
  return detected.project !== '' ? detected : null;
}

/**
 * Alias locales como evidencia y veto, nunca como autoridad. Usa el mismo candidato
 * (solo la raíz) que `alias resolve`.
 */
export function sessionProjectAliases(scope, directory) {
  if (goTrim(directory ?? '') === '') return { project: '', key_alias: null, cwd_alias: null, conflict: false };
  let candidate;
  try {
    candidate = deriveRoutingCandidate({ git_root: observeGitRoot(directory), directory });
  } catch (err) {
    if (err.code !== 'invalid_project_name') throw err;
    // Una raíz del sistema de archivos legítima puede no ser una clave válida: sin alias de clave, pero el cwd exacto aún cuenta.
    candidate = { ...err.candidate, key: '' };
  }
  return resolveProjectAlias(scope.store, candidate.key, candidate.directory);
}

export const SESSION_PROJECT_AUTHORITY = Object.freeze({ none: '', trustedDirectory: 'trusted_directory', manualName: 'manual_name' });

/**
 * Jerarquía de evidencia compartida entre los hallazgos y el plan de reparación. Git de confianza
 * puede establecer un traslado; el nombre del directorio solo puede corroborar o vetar.
 */
export function decideSessionProjectAuthority(persistedProject, manualTarget, knownManualTarget, directory) {
  const decision = {
    persistedProject: normalizeProjectName(persistedProject),
    directoryProject: normalizeProjectName(directory?.project ?? ''),
    directorySource: goTrim(directory?.source ?? ''),
    directoryPath: directory?.path ?? '',
    knownManualTarget,
    directoryBasenameCorroboratesPersisted: false,
    authority: SESSION_PROJECT_AUTHORITY.none,
    repairTarget: '',
    repairEvidenceSource: '',
    repairEvidencePath: '',
  };
  const manual = normalizeProjectName(manualTarget);
  if (decision.persistedProject === '') return decision;
  if (isTrustedDirectoryEvidence(decision.directorySource) && decision.directoryProject !== '') {
    if (decision.directoryProject !== decision.persistedProject) {
      decision.authority = SESSION_PROJECT_AUTHORITY.trustedDirectory;
      decision.repairTarget = decision.directoryProject;
      decision.repairEvidenceSource = decision.directorySource;
      decision.repairEvidencePath = decision.directoryPath;
    }
    return decision;
  }
  if (decision.directorySource === SOURCE_DIR_BASENAME) {
    decision.directoryBasenameCorroboratesPersisted = decision.directoryProject === decision.persistedProject;
    return decision;
  }
  if (knownManualTarget && manual !== '' && manual !== decision.persistedProject) {
    decision.authority = SESSION_PROJECT_AUTHORITY.manualName;
    decision.repairTarget = manual;
  }
  return decision;
}

export const shouldReportDirectoryMismatch = (d) => d.authority === SESSION_PROJECT_AUTHORITY.trustedDirectory;
export const shouldReportManualNameMismatch = (d) => d.authority === SESSION_PROJECT_AUTHORITY.manualName;

/** `manual-save-<proyecto>` → proyecto normalizado, o `''`. */
export function manualSessionNameTarget(name) {
  if (!String(name ?? '').startsWith('manual-save-')) return '';
  return normalizeProjectName(name.slice('manual-save-'.length));
}

/** Solo se reconoce el destino de un nombre manual si hay una sesión local de ese proyecto. */
export function knownManualSessionTarget(name, knownProjects) {
  const target = manualSessionNameTarget(name);
  return [target, target !== '' && knownProjects.has(target)];
}

export function knownSessionProjects(scope) {
  const known = new Set();
  for (const session of listDiagnosticSessions(scope.store, '')) {
    const project = normalizeProjectName(session.project);
    if (project !== '') known.add(project);
  }
  return known;
}
