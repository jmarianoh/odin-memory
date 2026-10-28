import { join } from 'node:path';
import { CONFIG_DIR } from '../../project/detect.js';
import { Syncer, getUsername } from '../../sync/index.js';
import { goTrim } from '../../store/text.js';
import { requiredProjectValue, resolveCliProject } from '../project.js';
import { fatal, println } from '../runtime.js';

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(goTrim(v ?? '').toLowerCase());

/** `--include-prompts` solo vale para exportar a Git: no se combina con importar, ver el estado ni la nube. */
export function validateSyncPromptPrivacy(args, cloudEnabled) {
  let includePrompts = false;
  let incompatible = cloudEnabled;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--help': case '-h': case 'help':
        return;
      case '--project':
        try {
          requiredProjectValue(args, i);
        } catch {
          return;
        }
        i++; // El valor de un proyecto no es un modo ni una ayuda.
        break;
      case '--include-prompts': includePrompts = true; break;
      case '--import': case '--status': case '--cloud': incompatible = true; break;
      default:
    }
  }
  if (includePrompts && incompatible) throw new Error('--include-prompts is only supported for local Git sync export; cannot combine with --import, --status, or cloud sync');
}

function printSyncUsage(cli) {
  println(cli, 'usage: odin sync [--import | --status] [--all] [--include-prompts] [--cloud --project PROJECT [--literal-project]]');
  println(cli, '--literal-project skips URL decoding of an explicit cloud project; normalization still applies.');
  println(cli, `Local sync exports project-scoped chunks to ${CONFIG_DIR}/; prompts are excluded by default, including with --all.`);
  println(cli, '--include-prompts intentionally shares prompts in local Git export only; incompatible with --import, --status, and cloud (including ODIN_CLOUD_SYNC).');
  println(cli, 'Cloud sync requires an explicit --project and never runs from --help.');
}

function printImportRelationCounts(cli, result) {
  println(cli, `  Relations replayed: ${result.relations_replayed}`);
  println(cli, `  Relations deferred: ${result.relations_deferred}`);
  println(cli, `  Relations dead:     ${result.relations_dead}`);
}

/**
 * `odin sync [--import | --status] [--all] [--include-prompts] [--project P]`: intercambia
 * memoria por Git (chunks comprimidos en `.odin-memory/`). Con `--cloud` o `ODIN_CLOUD_SYNC`
 * delega en `Cli.cloud.sync`, que aporta la sincronización con un servidor.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdSync(cli, config) {
  const args = cli.args.slice(1);
  const envCloud = truthy(cli.env.ODIN_CLOUD_SYNC);
  try {
    validateSyncPromptPrivacy(args, envCloud);
  } catch (err) {
    return fatal(cli, err);
  }
  let doImport = false;
  let doStatus = false;
  let doAll = false;
  let doCloud = false;
  let includePrompts = false;
  let literalProject = false;
  let project = '';
  let projectProvided = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help': case '-h': case 'help':
        return printSyncUsage(cli);
      case '--import': doImport = true; break;
      case '--status': doStatus = true; break;
      case '--all': doAll = true; break;
      case '--cloud': doCloud = true; break;
      case '--include-prompts': includePrompts = true; break;
      case '--literal-project': literalProject = true; break;
      case '--project':
        try {
          project = requiredProjectValue(args, i);
        } catch (err) {
          return fatal(cli, err);
        }
        projectProvided = true;
        i++;
        break;
      default:
        if (arg.startsWith('--project=')) {
          project = arg.slice('--project='.length);
          if (goTrim(project) === '') return fatal(cli, new Error('--project requires a non-empty value'));
          projectProvided = true;
        }
    }
  }
  if (doAll && projectProvided) return fatal(cli, new Error('--all and --project cannot be used together'));
  const cloudEnabled = doCloud || envCloud;
  if (literalProject && (!cloudEnabled || doAll || !projectProvided || goTrim(project) === '')) {
    return fatal(cli, new Error('--literal-project requires cloud sync with an explicit non-empty --project and cannot use --all'));
  }
  if (cloudEnabled) {
    if (!cli.cloud?.sync) return fatal(cli, new Error('cloud sync is not available in this build'));
    return cli.cloud.sync(cli, config, { doImport, doStatus, doAll, project, projectProvided, literalProject });
  }

  const syncDir = join(cli.cwd(), CONFIG_DIR);
  let store;
  try {
    store = cli.openStore(config);
  } catch (err) {
    return fatal(cli, err);
  }
  try {
    if (!doAll) {
      try {
        project = resolveCliProject(cli, store, project, false);
      } catch (err) {
        return fatal(cli, err);
      }
    }
    const syncer = Syncer.local(store, syncDir, project, { log: (m) => cli.err(`${m}\n`) });

    if (doStatus) {
      let status;
      try {
        status = syncer.status();
      } catch (err) {
        return fatal(cli, err);
      }
      println(cli, 'Sync status:');
      println(cli, `  Local chunks:    ${status.local}`);
      println(cli, `  Remote chunks:   ${status.remote}`);
      println(cli, `  Pending import:  ${status.pending}`);
      return undefined;
    }

    if (doImport) {
      let result;
      try {
        result = syncer.import();
      } catch (err) {
        return fatal(cli, err);
      }
      if (result.chunks_imported === 0) {
        println(cli, 'No new chunks to import.');
        if (result.chunks_skipped > 0) println(cli, `  (${result.chunks_skipped} chunks already imported)`);
        printImportRelationCounts(cli, result);
        return undefined;
      }
      println(cli, `Imported ${result.chunks_imported} new chunk(s) from ${CONFIG_DIR}/`);
      println(cli, `  Sessions:     ${result.sessions_imported}`);
      println(cli, `  Observations: ${result.observations_imported}`);
      println(cli, `  Prompts:      ${result.prompts_imported}`);
      if (result.chunks_skipped > 0) println(cli, `  Skipped:      ${result.chunks_skipped} (already imported)`);
      printImportRelationCounts(cli, result);
      return undefined;
    }

    println(cli, doAll ? 'Exporting ALL memories (all projects)...' : `Exporting memories for project ${JSON.stringify(project)}...`);
    if (!includePrompts) println(cli, 'Prompts excluded from Git sync (use --include-prompts to intentionally share them).');
    let result;
    try {
      result = syncer.export(getUsername(cli.env), project, { includePrompts });
    } catch (err) {
      return fatal(cli, err);
    }
    if (result.is_empty) {
      println(cli, doAll ? 'Nothing new to sync — all memories already exported.' : `Nothing new to sync for project ${JSON.stringify(project)} — all memories already exported.`);
      return undefined;
    }
    println(cli, `Created chunk ${result.chunk_id}`);
    println(cli, `  Sessions:     ${result.sessions_exported}`);
    println(cli, `  Observations: ${result.observations_exported}`);
    println(cli, `  Prompts:      ${result.prompts_exported}`);
    if (result.mutations_exported > 0) println(cli, `  Mutations:    ${result.mutations_exported}`);
    println(cli);
    println(cli, 'Warning: sessions, observations, and any included prompts may contain sensitive content.');
    println(cli, `Review ${CONFIG_DIR}/ before sharing; committed content can remain permanently in Git history.`);
    println(cli, 'Excluding prompts later does not erase existing chunks or Git history.');
    println(cli, 'Add to git:');
    println(cli, `  git add ${CONFIG_DIR}/ && git commit -m "sync odin memories"`);
    return undefined;
  } finally {
    try {
      store.close();
    } catch {
      // cerrar es de mejor esfuerzo
    }
  }
}
