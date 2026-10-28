import { normalizeProject } from '../../project/canonical.js';
import { detectProjectFull, processOverride } from '../../project/detect.js';
import { resolve as resolveProject } from '../../project/resolution.js';
import { goQuote } from '../../mcp/json.js';
import { addObservation, contentTruncation, validateObservationTitle } from '../../store/observations.js';
import { detectProject } from '../../store/project-history.js';
import { resolveManualSession } from '../../store/sessions.js';
import { goTrim } from '../../store/text.js';
import { fatal, println, withStore } from '../runtime.js';

export const SAVE_USAGE =
  'usage: odin save <title> <content> [--type TYPE] [--project PROJECT] [--scope SCOPE] [--topic TOPIC_KEY]\nUntracked folders inside a HOME Git repository require --project, ODIN_PROJECT, or .odin-memory/config.json project_name.';

const SAVE_FLAGS = new Set(['--type', '--project', '--scope', '--topic']);

/**
 * Interpreta los argumentos de `save`: las opciones pueden ir antes o después de
 * los dos posicionales, y `--` termina las opciones.
 * @param {string[]} args
 * @returns {{ title: string, content: string, type: string, projectName: string, scope: string, topicKey: string }}
 */
export function parseSaveArgs(args) {
  const parsed = { type: 'manual', scope: 'project', projectName: '', topicKey: '' };
  const positionals = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith('-')) {
      if (!SAVE_FLAGS.has(arg)) throw new Error(`unknown save flag: ${arg}`);
      if (i + 1 >= args.length || goTrim(args[i + 1]) === '' || args[i + 1].startsWith('-')) throw new Error(`${arg} requires a value`);
      const value = args[++i];
      if (arg === '--type') parsed.type = value;
      else if (arg === '--project') parsed.projectName = value;
      else if (arg === '--scope') parsed.scope = value;
      else parsed.topicKey = value;
      continue;
    }
    positionals.push(arg);
    if (positionals.length > 2) throw new Error('save requires exactly two positional arguments');
  }
  if (positionals.length !== 2) throw new Error('save requires exactly two positional arguments');
  [parsed.title, parsed.content] = positionals;
  return parsed;
}

/**
 * `odin save <título> <contenido> [opciones]`: guarda una memoria manual.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdSave(cli, config) {
  let args;
  try {
    args = parseSaveArgs(cli.args.slice(1));
  } catch (err) {
    cli.err(`${SAVE_USAGE}\n`);
    return fatal(cli, err);
  }
  try {
    validateObservationTitle(args.title);
  } catch (err) {
    return fatal(cli, err);
  }

  const cwd = cli.cwd();
  const unambiguous = (cause) => new Error(`cannot save without an unambiguous project identity${cause ? `: ${cause.message}` : ''}; use --project <name>`);
  // Rechaza invalidaciones y ambigüedades antes de abrir SQLite, sin crear vínculo de git.
  try {
    resolveProject({
      mode: 'current', explicit: args.projectName, directory: cwd, env: cli.env,
      detect: (dir) => detectProjectFull(dir, { inspectOnly: true, requireExplicitHomeProject: true }),
    });
  } catch (err) {
    return fatal(cli, unambiguous(err));
  }

  withStore(cli, config, (store) => {
    let resolved;
    try {
      resolved = resolveProject({
        mode: 'current', explicit: args.projectName, directory: cwd, env: cli.env,
        detect: (dir) => detectProject(store, dir, { requireExplicitHomeProject: true }),
      });
    } catch (err) {
      return fatal(cli, unambiguous(err));
    }
    if (goTrim(resolved.project ?? '') === '') return fatal(cli, unambiguous(null));

    const override = processOverride('', cli.env);
    let rawProjectName = args.projectName;
    if (rawProjectName === '') rawProjectName = override.ok ? override.value : resolved.project;
    const { normalized: projectName, warning } = normalizeProject(rawProjectName);
    if (warning !== '') cli.err(`${warning}\n`);
    if (goTrim(projectName) === '') return fatal(cli, unambiguous(null));

    const provenance = { source: resolved.source, directory: cwd };
    if (goTrim(args.projectName) !== '') provenance.raw_project = args.projectName;
    else if (override.ok) provenance.raw_project = override.value;

    try {
      const sessionId = resolveManualSession(store, projectName, cwd, provenance);
      const truncation = contentTruncation(store, args.content);
      const { id } = addObservation(store, {
        project_provenance: provenance,
        session_id: sessionId,
        type: args.type,
        title: args.title,
        content: args.content,
        project: projectName,
        scope: args.scope,
        topic_key: args.topicKey,
      });
      println(cli, `Memory saved: #${id} ${goQuote(args.title)} (${args.type})`);
      if (truncation.truncated) {
        cli.err(`⚠ WARNING: Content was truncated from ${truncation.original_bytes} to ${truncation.limit_bytes} bytes. Consider splitting into smaller observations.\n`);
      }
    } catch (err) {
      fatal(cli, err);
    }
  });
}
