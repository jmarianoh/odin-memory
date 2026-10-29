import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENV_CLOUD_SERVER, ENV_CLOUD_TOKEN, SOURCE, clearCloudConfig, effectiveToken, loadCloudConfig, resolveCloudRuntimeConfig, saveCloudConfig, validateServerUrl,
} from '../../cloud/config.js';
import { TARGET_KEY_CLOUD } from '../../cloud/constants.js';
import { normalizeProject } from '../../project/canonical.js';
import { enrollProject, unenrollProject } from '../../store/enrollment.js';
import { cloudSyncSummary, cloudTargetKeyForProject, getSyncState, isProjectEnrolled } from '../../store/sync-state.js';
import { goTrim } from '../../store/text.js';
import { CliExit, fatal, println } from '../runtime.js';
import { DEFAULT_PORT } from './serve.js';

const SUBCOMMANDS = 'status, enroll, unenroll, config, serve, repair';
const DAEMON_PROBE_TIMEOUT_MS = 1000;

/** Termina con el código 1 tras escribir el uso en el error estándar (sin el prefijo `odin:`). */
function usageError(cli, ...lines) {
  for (const line of lines) cli.err(`${line}\n`);
  throw new CliExit(1);
}

/**
 * Decodifica el proyecto de la URL (salvo `literal`) y lo normaliza.
 * @returns {{ project: string, warning: string }}
 * @throws {Error} si la codificación es inválida
 */
export function normalizeCloudCliProjectInput(input, literal) {
  let decoded = goTrim(input ?? '');
  if (!literal) {
    const bad = /%(?![0-9a-fA-F]{2})/.exec(decoded);
    if (bad) throw new Error(`invalid cloud project URL encoding ${JSON.stringify(input)}: invalid URL escape ${JSON.stringify(decoded.slice(bad.index, bad.index + 3))}`);
    decoded = Buffer.from(decoded.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1').toString('utf8');
  }
  const { normalized, warning } = normalizeProject(decoded);
  return { project: normalized, warning };
}

/** Proyecto y banderas de `cloud enroll|unenroll`. */
function parseProjectArgs(command, args) {
  for (const arg of args) {
    if (arg === '--') break;
    if (arg === '--help' || arg === '-h' || arg === 'help') return { help: true };
  }
  let project = '';
  let literal = false;
  let positional = false;
  for (const arg of args) {
    if (!positional && arg === '--') {
      positional = true;
    } else if (!positional && arg === '--literal-project') {
      literal = true;
    } else if (!positional && arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (project !== '') {
      throw new Error(`cloud ${command} requires exactly one project`);
    } else {
      project = goTrim(arg);
      if (project === '') throw new Error(`cloud ${command} requires a non-empty project`);
    }
  }
  if (project === '') throw new Error(`usage: odin cloud ${command} <project> [--literal-project]`);
  return { project, literal, help: false };
}

function cmdProjectEnrollment(cli, config, command) {
  let parsed;
  try {
    parsed = parseProjectArgs(command, cli.args.slice(2));
  } catch (err) {
    return fatal(cli, err);
  }
  if (parsed.help) {
    println(cli, `usage: odin cloud ${command} <project> [--literal-project]`);
    println(cli, command === 'enroll'
      ? 'Enroll a local-first project for explicit cloud replication.'
      : 'Stop future cloud replication for a project without deleting local or remote data.');
    println(cli, '--literal-project skips URL decoding; project normalization still applies.');
    return undefined;
  }
  let normalized;
  try {
    normalized = normalizeCloudCliProjectInput(parsed.project, parsed.literal);
  } catch (err) {
    return fatal(cli, err);
  }
  if (normalized.warning !== '') cli.err(`${normalized.warning}\n`);
  let store;
  try {
    store = cli.openStore(config);
  } catch (err) {
    return fatal(cli, err);
  }
  try {
    if (command === 'enroll') enrollProject(store, normalized.project);
    else unenrollProject(store, normalized.project);
  } catch (err) {
    return fatal(cli, err);
  } finally {
    try {
      store.close();
    } catch {
      // cerrar es de mejor esfuerzo
    }
  }
  if (command === 'enroll') {
    println(cli, `✓ Project ${JSON.stringify(normalized.project)} enrolled for cloud sync`);
  } else {
    println(cli, `✓ Project ${JSON.stringify(normalized.project)} unenrolled from future cloud sync`);
    println(cli, 'Local data, remote data, and pending journal rows were preserved.');
    println(cli, 'Note: an already in-flight push is not cancelled.');
  }
  return undefined;
}

function cmdCloudConfig(cli, config) {
  const args = cli.args.slice(2);
  if (args.length === 1 && args[0] === '--clear') {
    try {
      clearCloudConfig(config.dataDir);
    } catch (err) {
      return fatal(cli, err);
    }
    println(cli, '✓ Persisted cloud server URL and token cleared');
    if (goTrim(cli.env[ENV_CLOUD_SERVER] ?? '') !== '') println(cli, `Note: ${ENV_CLOUD_SERVER} remains active and overrides the cleared persisted server URL.`);
    if (goTrim(cli.env[ENV_CLOUD_TOKEN] ?? '') !== '') println(cli, `Note: ${ENV_CLOUD_TOKEN} remains active and overrides the cleared persisted token.`);
    return undefined;
  }
  if (args.length < 2 || args[0] !== '--server') return usageError(cli, 'usage: odin cloud config --server <url> | --clear');
  let current;
  try {
    current = loadCloudConfig(config.dataDir);
  } catch (err) {
    return fatal(cli, err);
  }
  const server = goTrim(args[1]);
  if (server === '') return usageError(cli, 'error: server URL is required');
  let validated;
  try {
    validated = validateServerUrl(server);
  } catch (err) {
    return usageError(cli, `error: invalid server URL: ${err.message}`);
  }
  try {
    saveCloudConfig(config.dataDir, { ...current, server_url: validated });
  } catch (err) {
    return fatal(cli, err);
  }
  println(cli, `✓ Cloud server set to ${validated}`);
  return undefined;
}

// ─── cloud status ────────────────────────────────────────────────────────────

function parseStatusProject(cli) {
  const args = cli.args.slice(2);
  if (args.length === 0) return '';
  if (args.length !== 2 || goTrim(args[0]) !== '--project') throw new Error('--project <name> is the only supported status option');
  const { normalized, warning } = normalizeProject(args[1]);
  if (warning !== '') cli.err(`${warning}\n`);
  if (goTrim(normalized) === '') throw new Error('--project is required');
  return normalized;
}

function printAuthStatus(cli, token, source, insecure, serverConfigured) {
  if (token === '') {
    println(cli, insecure ? 'Auth status: ready (insecure local-dev mode: ODIN_CLOUD_INSECURE_NO_AUTH=1)' : 'Auth status: token not configured (client token is optional at preflight)');
  } else if (source === SOURCE.env) {
    println(cli, `Auth status: ready (token provided via ${ENV_CLOUD_TOKEN})`);
  } else {
    println(cli, 'Auth status: ready (token read from cloud.json)');
  }
  if (!serverConfigured) {
    println(cli, 'Sync readiness: blocked (no effective server URL)');
    return;
  }
  if (token === '' && !insecure) println(cli, 'Sync readiness: ready to attempt explicit --project sync (project must be enrolled)');
  else println(cli, 'Sync readiness: ready for explicit --project sync (project must be enrolled)');
}

/** Ejecuta `fn(store)` con el almacén abierto, o `null` si la base aún no existe o no se abre. */
function withExistingStore(cli, config, fn, unavailable) {
  if (!existsSync(join(config.dataDir, 'odin.db'))) return unavailable?.(`${config.dataDir} has not been initialized`);
  let store;
  try {
    store = cli.openStore(config);
  } catch (err) {
    return unavailable?.(err.message);
  }
  try {
    return fn(store);
  } finally {
    try {
      store.close();
    } catch {
      // cerrar es de mejor esfuerzo
    }
  }
}

function printProjectEnrollment(cli, config, project) {
  if (project === '') {
    println(cli, 'Project enrollment: not checked (use --project <name>)');
    return;
  }
  const unavailable = (why) => println(cli, `Project enrollment: unavailable (${why})`);
  withExistingStore(cli, config, (store) => {
    let enrolled;
    try {
      enrolled = isProjectEnrolled(store, project);
    } catch (err) {
      unavailable(err.message);
      return;
    }
    println(cli, `Project enrollment: ${enrolled ? 'enrolled' : 'not enrolled'} (${project})`);
  }, unavailable);
}

function printSyncDiagnostic(cli, config, project) {
  withExistingStore(cli, config, (store) => {
    if (project !== '') {
      const state = getSyncState(store, cloudTargetKeyForProject(project));
      const message = goTrim(state?.last_error ?? '');
      if (message === '') return;
      println(cli, 'Sync diagnostic: project-scoped cloud state');
      if (goTrim(state.reason_code ?? '') !== '') println(cli, `reason_code: ${goTrim(state.reason_code)}`);
      println(cli, `reason_message: ${message}`);
      return;
    }
    const summary = cloudSyncSummary(store);
    if (goTrim(summary.last_error) !== '') {
      println(cli, 'Sync diagnostic: project-scoped cloud state');
      if (goTrim(summary.reason_code) !== '') println(cli, `reason_code: ${summary.reason_code}`);
      println(cli, `reason_message: ${summary.last_error}`);
      return;
    }
    const state = getSyncState(store, TARGET_KEY_CLOUD);
    const code = goTrim(state?.reason_code ?? '');
    if (code !== 'non_enrolled_pending_mutations') return;
    println(cli, `Sync diagnostic: ${state.lifecycle}`);
    println(cli, `reason_code: ${code}`);
    if (goTrim(state.reason_message ?? '') !== '') println(cli, `reason_message: ${goTrim(state.reason_message)}`);
  }, () => undefined);
}

/** ¿Responde `/health` el servidor local? */
export async function probeLocalDaemon(port, { fetch: fetchFn = globalThis.fetch, timeoutMs = DAEMON_PROBE_TIMEOUT_MS } = {}) {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    await response.arrayBuffer();
    return response.status >= 200 && response.status < 300 ? { status: 'running', port } : { status: 'unreachable', port };
  } catch (err) {
    const code = err?.cause?.code ?? err?.code;
    if (code === 'ECONNREFUSED') return { status: 'not_running', port, error: err };
    return { status: 'unreachable', port, error: err };
  }
}

async function printDaemonProbe(cli) {
  const raw = goTrim(cli.env.ODIN_PORT ?? '');
  const parsed = /^[+-]?\d+$/.test(raw) ? Number(raw) : 0;
  const port = parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
  const result = await (cli.probeDaemon ?? probeLocalDaemon)(port);
  if (result.status === 'running') {
    println(cli, `Local daemon: running on port ${result.port}`);
  } else if (result.status === 'not_running') {
    println(cli, `Local daemon: not running on port ${result.port}`);
    println(cli, 'Hint: run `odin serve` to resume autosync');
  } else if (result.error) {
    println(cli, `Local daemon: unreachable on port ${result.port} (probe error: ${result.error.message})`);
  } else {
    println(cli, `Local daemon: unreachable on port ${result.port}`);
  }
}

async function cmdCloudStatus(cli, config) {
  let project;
  try {
    project = parseStatusProject(cli);
  } catch (err) {
    return usageError(cli, 'usage: odin cloud status [--project <name>]', `error: ${err.message}`);
  }
  let runtime;
  try {
    runtime = resolveCloudRuntimeConfig(config.dataDir, cli.env);
  } catch (err) {
    return usageError(cli, `error: unable to read cloud runtime config: read cloud config: ${err.message}`);
  }
  const { source } = effectiveToken(config.dataDir, cli.env);
  const token = goTrim(runtime.token);
  if (runtime.server_url === '') {
    println(cli, 'Cloud status: not configured (no effective server URL)');
    printAuthStatus(cli, token, source, false, false);
    printProjectEnrollment(cli, config, project);
    printSyncDiagnostic(cli, config, project);
    return undefined;
  }
  let serverUrl;
  try {
    serverUrl = validateServerUrl(runtime.server_url);
  } catch (err) {
    return usageError(cli, `error: invalid cloud runtime server URL: ${err.message}`);
  }
  const insecure = ['1', 'true', 'yes', 'on'].includes(goTrim(cli.env.ODIN_CLOUD_INSECURE_NO_AUTH ?? '').toLowerCase());
  println(cli, `Cloud status: configured (target=${TARGET_KEY_CLOUD})`);
  println(cli, `Server: ${serverUrl}`);
  println(cli, goTrim(cli.env[ENV_CLOUD_SERVER] ?? '') !== '' ? `Server source: ${ENV_CLOUD_SERVER}` : 'Server source: cloud.json');
  printAuthStatus(cli, token, source, insecure, true);
  if (insecure) println(cli, 'Warning: bearer auth is disabled in insecure mode; do not use in production');
  if (token === '' && !insecure) println(cli, `Hint: if the remote server enforces bearer auth, set ${ENV_CLOUD_TOKEN}`);
  printProjectEnrollment(cli, config, project);
  await printDaemonProbe(cli);
  printSyncDiagnostic(cli, config, project);
  return undefined;
}

// ─── cloud repair ────────────────────────────────────────────────────────────

const REPAIR_USAGE = 'usage: odin cloud repair materialize-mutations --project <name> (--dry-run|--apply)';

async function cmdCloudRepair(cli) {
  const args = cli.args.slice(2);
  if (args.length === 0 || ['--help', '-h', 'help'].includes(args[0])) {
    println(cli, REPAIR_USAGE);
    println(cli, 'repairs existing cloud_mutations into compatible cloud_chunks without deleting remote data');
    return undefined;
  }
  const command = goTrim(args[0]).toLowerCase();
  if (command !== 'materialize-mutations') {
    return usageError(cli, `unknown cloud repair command: ${command}`, 'supported cloud repair commands: materialize-mutations');
  }
  const rest = args.slice(1);
  const at = rest.findIndex((arg) => goTrim(arg) === '--project');
  const project = at === -1 || at + 1 >= rest.length ? '' : goTrim(normalizeProject(rest[at + 1]).normalized);
  if (project === '') return usageError(cli, REPAIR_USAGE, 'error: --project is required');
  const dryRun = rest.some((arg) => goTrim(arg) === '--dry-run');
  const apply = rest.some((arg) => goTrim(arg) === '--apply');
  if (dryRun === apply) return usageError(cli, REPAIR_USAGE, 'error: exactly one of --dry-run or --apply is required');
  const { cloudServeConfigFromEnv } = await import('../../cloud/server/config.js');
  const { CloudStore, Database } = await import('../../cloud/server/index.js');
  const store = new CloudStore(Database.connect(cloudServeConfigFromEnv(cli.env).dsn));
  try {
    await store.migrate();
    const report = await store.backfillMutationChunks(project, apply);
    println(cli, JSON.stringify(report, null, 2));
  } catch (err) {
    return fatal(cli, err);
  } finally {
    await store.close().catch(() => {});
  }
  return undefined;
}

// ─── cloud serve ─────────────────────────────────────────────────────────────

async function cmdCloudServe(cli) {
  const { cloudServeConfigFromEnv, normalizeAllowedProjects, validateCloudServeAuthConfig } = await import('../../cloud/server/config.js');
  try {
    validateCloudServeAuthConfig(cli.env, (message) => cli.err(`${message}\n`));
  } catch (err) {
    return fatal(cli, err);
  }
  const cfg = cloudServeConfigFromEnv(cli.env);
  const { CloudServer, CloudStore, Database } = await import('../../cloud/server/index.js');
  const hooks = cli.cloudServe ?? {};
  const processRef = hooks.processRef ?? process;
  const log = hooks.log ?? ((message) => cli.err(`${message}\n`));
  let store;
  try {
    store = new CloudStore(Database.connect(cfg.dsn));
    await store.migrate();
  } catch (err) {
    await store?.close().catch(() => {});
    return fatal(cli, err);
  }
  try {
    for (const project of normalizeAllowedProjects(cfg.allowedProjects)) {
      const report = await store.backfillMutationChunks(project, true);
      if (report.candidate_mutations > 0 || report.chunks_inserted > 0) {
        cli.err(`odin cloud repair materialize-mutations: project=${report.project} candidates=${report.candidate_mutations} already_materialized=${report.already_materialized} chunks_planned=${report.chunks_planned} chunks_inserted=${report.chunks_inserted}\n`);
      }
    }
  } catch (err) {
    await store.close().catch(() => {});
    return fatal(cli, new Error(`cloud repair materialize-mutations for project: ${err.message}`));
  }
  const server = new CloudServer(store, {
    allowedProjects: cfg.allowedProjects,
    // La validación de arranque ya garantiza que el modo inseguro no trae token ni administración.
    token: cfg.token,
    adminToken: cfg.adminToken,
    port: hooks.port ?? cfg.port,
    host: cfg.bindHost,
    maxPushBodyBytes: cfg.maxPushBodyBytes,
    log,
  });
  const stop = new Promise((resolve) => {
    const onSignal = () => resolve();
    processRef.on('SIGINT', onSignal);
    processRef.on('SIGTERM', onSignal);
    hooks.signal?.addEventListener('abort', onSignal, { once: true });
  });
  println(cli, `Starting odin cloud server on port ${hooks.port ?? cfg.port}`);
  let failure = null;
  try {
    const address = await server.listen();
    hooks.ready?.({ server, address });
    await stop;
  } catch (err) {
    failure = err;
  }
  await server.close();
  await store.close().catch(() => {});
  if (failure) return fatal(cli, failure);
  return undefined;
}

/**
 * `odin cloud <status|enroll|unenroll|config|serve>`: configuración del cliente de la nube,
 * inscripción de proyectos y servidor.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export async function cmdCloud(cli, config) {
  const sub = cli.args[1];
  if (sub === undefined) return usageError(cli, 'usage: odin cloud <subcommand> [options]', `supported subcommands: ${SUBCOMMANDS}`);
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    println(cli, 'usage: odin cloud <subcommand> [options]');
    println(cli, `supported subcommands: ${SUBCOMMANDS}`);
    return undefined;
  }
  switch (sub) {
    case 'status': return cmdCloudStatus(cli, config);
    case 'enroll': return cmdProjectEnrollment(cli, config, 'enroll');
    case 'unenroll': return cmdProjectEnrollment(cli, config, 'unenroll');
    case 'config': return cmdCloudConfig(cli, config);
    case 'serve': return cmdCloudServe(cli);
    case 'repair': return cmdCloudRepair(cli);
    default: return usageError(cli, `unknown cloud command: ${sub}`, `supported subcommands: ${SUBCOMMANDS}`);
  }
}
