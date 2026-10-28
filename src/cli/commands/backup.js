import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exportData, exportProject, exportToJsonValue, importData, parseExportData, toGoJson } from '../../store/backup.js';
import { requiredProjectValue, resolveCliProjectScope } from '../project.js';
import { exit, fatal, fsErrorText, println, withStore } from '../runtime.js';

export const EXPORT_HELP =
  'Usage: odin export [file.json] [--project NAME | --all]\n\nOptions:\n  --project NAME  Export one project (default: current project)\n  --all           Export every project\n  --help          Show this help';
export const IMPORT_HELP = 'Usage: odin import <file.json>\n\nOptions:\n  --help          Show this help';

export const DEFAULT_EXPORT_FILE = 'odin-export.json';

/**
 * `odin export [archivo] [--project P|--all]`: vuelca las memorias a JSON.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdExport(cli, config) {
  const args = cli.args.slice(1);
  let outFile = DEFAULT_EXPORT_FILE;
  let projectName = '';
  let allProjects = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') {
      try {
        projectName = requiredProjectValue(args, i);
      } catch (err) {
        return fatal(cli, err);
      }
      i++;
    } else if (args[i] === '--all') {
      allProjects = true;
    } else if (!args[i].startsWith('-')) {
      outFile = args[i];
    }
  }
  withStore(cli, config, (store) => {
    let data;
    try {
      const resolved = resolveCliProjectScope(cli, store, projectName, allProjects, true);
      data = resolved !== '' ? exportProject(store, resolved) : exportData(store);
    } catch (err) {
      return fatal(cli, err);
    }
    try {
      writeFileSync(resolve(cli.cwd(), outFile), toGoJson(exportToJsonValue(data), 2), { mode: 0o644 });
    } catch (err) {
      return fatal(cli, `write ${outFile}: ${fsErrorText(err, outFile)}`);
    }
    println(cli, `Exported to ${outFile}`);
    println(cli, `  Sessions:     ${data.sessions.length}`);
    println(cli, `  Observations: ${data.observations.length}`);
    println(cli, `  Prompts:      ${data.prompts.length}`);
  });
}

/**
 * `odin import <archivo>`: carga una exportación.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdImport(cli, config) {
  if (cli.args.length < 2) {
    cli.err('usage: odin import <file.json>\n');
    exit(1);
  }
  const inFile = cli.args[1];
  let raw;
  try {
    raw = readFileSync(resolve(cli.cwd(), inFile), 'utf8');
  } catch (err) {
    return fatal(cli, `read ${inFile}: ${fsErrorText(err, inFile)}`);
  }
  let data;
  try {
    data = parseExportData(raw);
  } catch (err) {
    return fatal(cli, `parse ${inFile}: ${err.message}`);
  }
  withStore(cli, config, (store) => {
    let result;
    try {
      result = importData(store, data);
    } catch (err) {
      return fatal(cli, err);
    }
    println(cli, `Imported from ${inFile}`);
    println(cli, `  Sessions:     ${result.sessions_imported}`);
    println(cli, `  Observations: ${result.observations_imported} imported, ${result.observations_updated} updated, ${result.observations_skipped_stale} skipped stale`);
    println(cli, `  Prompts:      ${result.prompts_imported}`);
  });
}
