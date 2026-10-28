import { normalizeProject } from '../../project/canonical.js';
import { observeGitRoot } from '../../project/detect.js';
import { deriveRoutingCandidate } from '../../project/routing-candidate.js';
import { goQuote } from '../../mcp/json.js';
import { toGoJson } from '../../store/backup.js';
import { isProjectEnrolled } from '../../store/journal.js';
import { detectProject } from '../../store/project-history.js';
import {
  mergeExplicitProjectVariants, mergeProjects, migrateProject, previewExplicitProjectMerge, pruneProject,
} from '../../store/project-maintenance.js';
import {
  PROJECT_ALIAS_KIND_CWD, PROJECT_ALIAS_KIND_KEY, listProjectAliases, listProjectNames, listProjectsWithStats, removeProjectAlias,
  resolveProjectAlias, setProjectAlias,
} from '../../store/projects.js';
import { goTrim } from '../../store/text.js';
import { exit, fatal, padLeft, padRight, println, scanLeadingInt, withStore } from '../runtime.js';

const ALIAS_USAGE =
  'usage: odin projects alias set (--key <key>|--cwd <directory>) --project <project>\n       odin projects alias list\n       odin projects alias remove (--key <key>|--cwd <directory>)\n       odin projects alias resolve [--designation <name>] [--cwd <directory>]\n';

const byBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** Uso de `projects` en el error estándar. */
function printProjectsUsage(cli) {
  cli.err(ALIAS_USAGE);
  cli.err('usage: odin projects list\n');
  cli.err('       odin projects merge --from <source> --to <canonical> (--dry-run|--apply)\n');
  cli.err('       odin projects consolidate [--all] [--dry-run]\n');
  cli.err('       odin projects prune [--dry-run] [--paths-only]\n');
}

/**
 * Lee la respuesta del usuario como `fmt.Scanln` a una cadena: el primer token de
 * la línea. `error` vale «unexpected newline» ante una línea vacía y «EOF» al
 * acabarse la entrada.
 * @returns {{ answer: string, n: number, error: string|null }}
 */
function scanInputLine(cli) {
  const line = cli.readLine();
  if (line === null) return { answer: '', n: 0, error: 'EOF' };
  const token = line.trim().split(/\s+/)[0] ?? '';
  if (token === '') return { answer: '', n: 0, error: 'unexpected newline' };
  return { answer: token, n: 1, error: null };
}

/** Respuesta normalizada (minúsculas, sin espacios) de la siguiente línea. */
function readAnswer(cli) {
  return scanInputLine(cli).answer.trim().toLowerCase();
}

/**
 * `odin projects [list|merge|consolidate|prune|alias]`.
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdProjects(cli, config) {
  const sub = cli.args.length > 1 ? cli.args[1] : 'list';
  switch (sub) {
    case 'alias':
      return cmdProjectsAlias(cli, config);
    case 'merge':
      return cmdProjectsMerge(cli, config);
    case 'consolidate':
      return cmdProjectsConsolidate(cli, config);
    case 'prune':
      return cmdProjectsPrune(cli, config);
    case 'list':
    case '':
      return cmdProjectsList(cli, config);
    default:
      cli.err(`unknown projects subcommand: ${sub}\n`);
      printProjectsUsage(cli);
      return exit(1);
  }
}

// ─── list ────────────────────────────────────────────────────────────────────

function cmdProjectsList(cli, config) {
  withStore(cli, config, (store) => {
    let projects;
    try {
      projects = listProjectsWithStats(store);
    } catch (err) {
      return fatal(cli, err);
    }
    if (projects.length === 0) {
      println(cli, 'No projects found.');
      return;
    }
    println(cli, `Projects (${projects.length}):`);
    for (const p of projects) {
      const sessionWord = p.session_count === 1 ? 'session' : 'sessions';
      const promptWord = p.prompt_count === 1 ? 'prompt' : 'prompts';
      println(
        cli,
        `  ${padRight(p.name, 30)} ${padLeft(p.observation_count, 4)} obs   ${padLeft(p.session_count, 3)} ${padRight(sessionWord, 9)}  ${padLeft(p.prompt_count, 3)} ${promptWord}`,
      );
    }
  });
}

// ─── merge ───────────────────────────────────────────────────────────────────

function cmdProjectsMerge(cli, config) {
  let from = '';
  let to = '';
  let dryRun = false;
  let apply = false;
  const seen = new Set();
  const args = cli.args.slice(2);
  const usageExit = () => {
    printProjectsUsage(cli);
    return exit(1);
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) return usageExit();
    seen.add(flag);
    switch (flag) {
      case '--from':
      case '--to':
        if (i + 1 >= args.length || args[i + 1].startsWith('--')) return usageExit();
        i++;
        if (flag === '--from') from = args[i];
        else to = args[i];
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--apply':
        apply = true;
        break;
      default:
        return usageExit();
    }
  }
  if (goTrim(from) === '' || goTrim(to) === '' || dryRun === apply) return usageExit();

  withStore(cli, config, (store) => {
    try {
      const preview = previewExplicitProjectMerge(store, from, to);
      if (dryRun) {
        println(
          cli,
          `[dry-run] Source ${goQuote(preview.source)} -> target ${goQuote(preview.canonical)}: observations ${preview.observations_updated}, sessions ${preview.sessions_updated}, prompts ${preview.prompts_updated}. Sync identity changes: ${preview.sync_identity_changes}. No changes made. Point-in-time preview; apply revalidates and counts may differ.`,
        );
        return;
      }
      const result = mergeExplicitProjectVariants(store, [from], to);
      println(
        cli,
        `Merged source ${goQuote(preview.source)} into target ${goQuote(result.canonical)}: observations ${result.observations_updated}, sessions ${result.sessions_updated}, prompts ${result.prompts_updated}. Sync identity may also change.`,
      );
    } catch (err) {
      fatal(cli, err);
    }
  });
}

// ─── consolidate ─────────────────────────────────────────────────────────────

/** Grupos de proyectos cuyos nombres normalizan al mismo valor (solo los de dos o más). */
export function groupSimilarProjects(projects) {
  const byNormalized = new Map();
  for (const p of projects) {
    const { normalized } = normalizeProject(p.name);
    if (normalized === '') continue;
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, []);
    byNormalized.get(normalized).push(p);
  }
  const groups = [];
  for (const [canonical, members] of byNormalized) {
    if (members.length < 2) continue;
    groups.push({ names: members.map((m) => m.name).sort(byBytes), canonical });
  }
  return groups.sort((a, b) => byBytes(a.canonical, b.canonical));
}

/** Nombres existentes que normalizan igual que `name` pero se escriben distinto. */
export function findNormalizationEquivalentProjects(name, existing) {
  const { normalized } = normalizeProject(name);
  if (normalized === '') return [];
  const matches = [];
  for (const candidate of existing) {
    if (candidate === name || normalizeProject(candidate).normalized !== normalized) continue;
    matches.push({ name: candidate, match_type: 'normalization-equivalent' });
  }
  return matches;
}

/** Registros que una fusión movió de verdad. */
const mergedRecordCount = (result) => result.observations_updated + result.sessions_updated + result.prompts_updated;

/** Nombra los orígenes que el almacén dejó intactos, para que una fusión parcial no parezca completa. */
function reportUnmergedSources(cli, sources, result) {
  const merged = new Set(result.sources_merged);
  const skipped = [];
  const seen = new Set();
  for (const source of sources) {
    if (goTrim(source) === '' || source === result.canonical) continue;
    if (merged.has(goTrim(source)) || seen.has(source)) continue;
    seen.add(source);
    skipped.push(source);
  }
  if (skipped.length === 0) return;
  println(cli, `  Not merged (no records moved): ${skipped.join(', ')}`);
}

/** Índices (base 1) de una lista separada por comas, o `null` tras avisar de uno inválido. */
function parseSelection(cli, answer, limit, indent) {
  const picked = [];
  for (const raw of answer.split(',')) {
    const part = raw.trim();
    const idx = scanLeadingInt(part);
    if (idx === null || idx < 1 || idx > limit) {
      cli.err(`${indent}Invalid selection: ${goQuote(part)} (expected 1-${limit})\n`);
      return { picked, invalid: true };
    }
    picked.push(idx);
  }
  return { picked, invalid: false };
}

function cmdProjectsConsolidate(cli, config) {
  let doAll = false;
  let dryRun = false;
  for (const arg of cli.args.slice(2)) {
    if (arg === '--all') doAll = true;
    else if (arg === '--dry-run') dryRun = true;
  }
  withStore(cli, config, (store) => {
    try {
      if (doAll) consolidateAll(cli, store, dryRun);
      else consolidateCurrent(cli, store, dryRun);
    } catch (err) {
      if (err.name === 'CliExit') throw err;
      fatal(cli, err);
    }
  });
}

function consolidateCurrent(cli, store, dryRun) {
  const res = detectProject(store, cli.cwd());
  if (res.error) throw res.error;
  const { normalized: canonical } = normalizeProject(res.project);
  const allNames = listProjectNames(store);
  if (!allNames.includes(canonical)) {
    println(cli, `Note: ${goQuote(canonical)} has no existing memories. Merging will move memories into this new project name.`);
  }
  const similar = findNormalizationEquivalentProjects(canonical, allNames);
  const statsByName = new Map(listProjectsWithStats(store).map((p) => [p.name, p]));
  if (similar.length === 0) {
    println(cli, `No similar project names found for ${goQuote(canonical)}. Nothing to consolidate.`);
    return;
  }
  println(cli, `Detected project: ${goQuote(canonical)}\n`);
  println(cli, 'Found similar project names:');
  similar.forEach((sm, i) => {
    const obs = statsByName.get(sm.name)?.observation_count ?? 0;
    println(cli, `  [${i + 1}] ${padRight(sm.name, 30)} ${padLeft(obs, 3)} obs  (${sm.match_type})`);
  });
  cli.out(`\nSelect which to merge into ${goQuote(canonical)} (comma-separated numbers, 'all', or 'none'): `);
  const scan = scanInputLine(cli);
  if (scan.error !== null && dryRun && scan.n === 0) throw new Error(`dry-run requires a confirmed selection: ${scan.error}`);
  const answer = scan.answer.trim().toLowerCase();
  if (answer === 'none' || answer === 'n' || answer === '') {
    if (dryRun && answer === '') throw new Error('dry-run requires a confirmed selection');
    println(cli, 'Cancelled.');
    return;
  }
  let sources = [];
  if (answer === 'all' || answer === 'a') {
    sources = similar.map((sm) => sm.name);
  } else {
    const { picked, invalid } = parseSelection(cli, answer, similar.length, '');
    if (invalid) {
      if (dryRun) exit(1);
      return;
    }
    sources = picked.map((idx) => similar[idx - 1].name);
  }
  if (sources.length === 0) {
    println(cli, 'Nothing selected.');
    return;
  }
  if (dryRun) {
    println(cli, `\n[dry-run] Would merge ${sources.length} project(s) into ${goQuote(canonical)}`);
    return;
  }
  println(cli, `\nMerging ${sources.length} project(s) into ${goQuote(canonical)}...`);
  const result = mergeProjects(store, sources, canonical);
  if (mergedRecordCount(result) === 0) {
    println(cli, `Nothing merged into ${goQuote(result.canonical)}: the store moved no records for the ${sources.length} selected project(s).`);
    return;
  }
  println(cli, `Done! Merged ${result.sources_merged.length} project(s) into ${goQuote(result.canonical)}:`);
  println(cli, `  Observations: ${result.observations_updated}`);
  println(cli, `  Sessions:     ${result.sessions_updated}`);
  println(cli, `  Prompts:      ${result.prompts_updated}`);
  reportUnmergedSources(cli, sources, result);
}

function consolidateAll(cli, store, dryRun) {
  const projects = listProjectsWithStats(store);
  const groups = groupSimilarProjects(projects);
  if (groups.length === 0) {
    println(cli, 'No similar project name groups found.');
    return;
  }
  println(cli, `Found ${groups.length} group(s) of similar project names:\n`);
  const statsByName = new Map(projects.map((p) => [p.name, p]));
  groups.forEach((g, gi) => {
    println(cli, `Group ${gi + 1}:`);
    g.names.forEach((name, j) => {
      const obs = statsByName.get(name)?.observation_count ?? 0;
      const marker = name === g.canonical ? '→ ' : '  ';
      println(cli, `  ${marker}[${j + 1}] ${padRight(name, 30)} ${padLeft(obs, 3)} obs`);
    });
    println(cli, `  Suggested canonical: ${goQuote(g.canonical)} (→)`);
    if (dryRun) {
      println(cli, `  [dry-run] Would merge into ${goQuote(g.canonical)}\n`);
      return;
    }
    println(cli, '\n  Options:');
    println(cli, `    all     — merge everything into ${goQuote(g.canonical)}`);
    println(cli, `    1,3,... — merge only selected numbers into ${goQuote(g.canonical)}`);
    println(cli, '    rename  — choose a different canonical name');
    println(cli, "    skip    — don't touch this group");
    cli.out('  Choice: ');
    let answer = readAnswer(cli);
    if (answer === 'skip' || answer === 's' || answer === 'n' || answer === '') {
      println(cli, '  Skipped.');
      println(cli);
      return;
    }
    let renameTarget = '';
    if (answer === 'rename' || answer === 'r') {
      cli.out('  Enter canonical name: ');
      const input = scanInputLine(cli).answer.trim();
      if (input === '') {
        println(cli, '  Empty input, skipping.');
        println(cli);
        return;
      }
      // La fusión solo apunta al canónico equivalente del grupo; el renombrado se aplica
      // después como migración explícita para que la identidad de sincronización lo siga.
      renameTarget = normalizeProject(input).normalized;
      answer = 'all';
    }
    const mergeCanonical = normalizeProject(g.canonical).normalized;
    const sources = [];
    if (answer === 'all' || answer === 'a' || answer === 'y' || answer === 'yes') {
      for (const name of g.names) if (name !== mergeCanonical) sources.push(name);
    } else {
      for (const raw of answer.split(',')) {
        const part = raw.trim();
        const idx = scanLeadingInt(part);
        if (idx === null || idx < 1 || idx > g.names.length) {
          cli.err(`  Invalid selection: ${goQuote(part)} (expected 1-${g.names.length})\n`);
          println(cli);
          continue;
        }
        const selected = g.names[idx - 1];
        if (selected !== mergeCanonical) sources.push(selected);
      }
    }
    if (sources.length === 0) {
      println(cli, '  Nothing to merge.');
      println(cli);
      return;
    }
    let result;
    try {
      result = mergeProjects(store, sources, mergeCanonical);
    } catch (err) {
      cli.err(`  Error merging: ${err.message}\n`);
      println(cli);
      return;
    }
    if (mergedRecordCount(result) === 0) {
      println(cli, `  Nothing merged into ${goQuote(mergeCanonical)}: the store moved no records for the ${sources.length} selected project(s).`);
    } else {
      println(cli, `  Merged: ${result.observations_updated} obs, ${result.sessions_updated} sessions, ${result.prompts_updated} prompts`);
      reportUnmergedSources(cli, sources, result);
    }
    if (renameTarget !== '' && renameTarget !== mergeCanonical) {
      let migrated;
      try {
        migrated = migrateProject(store, mergeCanonical, renameTarget);
      } catch (err) {
        cli.err(`  Error renaming ${goQuote(mergeCanonical)} → ${goQuote(renameTarget)}: ${err.message}\n`);
        println(cli);
        return;
      }
      println(
        cli,
        `  Renamed ${goQuote(mergeCanonical)} → ${goQuote(renameTarget)}: ${migrated.observations_updated} obs, ${migrated.sessions_updated} sessions, ${migrated.prompts_updated} prompts`,
      );
    }
    println(cli);
  });
}

// ─── prune ───────────────────────────────────────────────────────────────────

const isPathLikeProjectName = (name) => /[/\\]/.test(name);

function cmdProjectsPrune(cli, config) {
  let dryRun = false;
  let pathsOnly = false;
  for (const arg of cli.args.slice(2)) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--paths-only') pathsOnly = true;
  }
  withStore(cli, config, (store) => {
    let allStats;
    try {
      allStats = listProjectsWithStats(store);
    } catch (err) {
      return fatal(cli, err);
    }
    const candidates = allStats
      .filter((p) => p.observation_count === 0 && !(pathsOnly && !isPathLikeProjectName(p.name)))
      .sort((a, b) => byBytes(a.name, b.name));
    if (candidates.length === 0) {
      println(cli, pathsOnly ? 'No path-named projects to prune.' : 'No empty projects to prune.');
      return;
    }
    println(cli, `Found ${candidates.length} project(s) with 0 observations:\n`);
    candidates.forEach((p, i) => {
      println(cli, `  [${i + 1}] ${padRight(p.name, 30)} ${padLeft(p.session_count, 3)} sessions  ${padLeft(p.prompt_count, 3)} prompts`);
    });
    if (dryRun) {
      println(cli, `\n[dry-run] Would prune ${candidates.length} project(s)`);
      return;
    }
    cli.out("\nSelect which to prune (comma-separated numbers, 'all', or 'none'): ");
    const answer = readAnswer(cli);
    if (answer === 'none' || answer === 'n' || answer === '') {
      println(cli, 'Cancelled.');
      return;
    }
    let selected;
    if (answer === 'all' || answer === 'a') {
      selected = candidates;
    } else {
      const { picked, invalid } = parseSelection(cli, answer, candidates.length, '');
      if (invalid) return;
      selected = picked.map((idx) => candidates[idx - 1]);
    }
    if (selected.length === 0) {
      println(cli, 'Nothing selected.');
      return;
    }
    let totalSessions = 0;
    let totalPrompts = 0;
    let successful = 0;
    for (const p of selected) {
      try {
        const result = pruneProject(store, p.name);
        successful++;
        totalSessions += result.sessions_deleted;
        totalPrompts += result.prompts_deleted;
      } catch (err) {
        cli.err(`Error pruning ${goQuote(p.name)}: ${err.message}\n`);
      }
    }
    println(cli, `\nPruned ${successful} project(s): ${totalSessions} sessions, ${totalPrompts} prompts removed.`);
  });
}

// ─── alias ───────────────────────────────────────────────────────────────────

const ALIAS_FLAGS = {
  set: ['--key', '--cwd', '--project'],
  remove: ['--key', '--cwd'],
  resolve: ['--designation', '--cwd'],
  list: [],
};

/**
 * Los alias son locales y solo valen a futuro. `resolve` previsualiza la
 * derivación: no inscribe, no crea vínculo de git ni cambia el envío.
 */
function cmdProjectsAlias(cli, config) {
  try {
    runProjectsAlias(cli, config, cli.args.slice(2));
  } catch (err) {
    if (err.name === 'CliExit') throw err;
    cli.err(`project alias: ${err.message}\n`);
    exit(1);
  }
}

function runProjectsAlias(cli, config, args) {
  if (args.length === 0) throw new Error('expected set, list, remove, or resolve');
  if (args[0] === '--help' && args.length === 1) {
    cli.out(ALIAS_USAGE);
    return;
  }
  const action = args[0];
  if (!Object.hasOwn(ALIAS_FLAGS, action)) throw new Error(`unknown command ${goQuote(action)}`);
  const allowed = ALIAS_FLAGS[action];
  const flags = new Map();
  for (let i = 1; i < args.length; i++) {
    const name = args[i];
    if (!allowed.includes(name)) throw new Error(`unexpected argument ${goQuote(name)}`);
    if (flags.has(name)) throw new Error(`duplicate flag ${name}`);
    if (i + 1 === args.length || args[i + 1].length === 0 || args[i + 1].startsWith('--')) throw new Error(`${name} requires a value`);
    flags.set(name, args[++i]);
  }
  let kind = PROJECT_ALIAS_KIND_KEY;
  let key = flags.get('--key') ?? '';
  if (action === 'set' || action === 'remove') {
    const hasKey = flags.has('--key');
    const hasCwd = flags.has('--cwd');
    if (hasKey === hasCwd) throw new Error('exactly one of --key or --cwd is required');
    if (hasCwd) {
      kind = PROJECT_ALIAS_KIND_CWD;
      key = flags.get('--cwd');
    }
    if (action === 'set' && (flags.get('--project') ?? '') === '') throw new Error('--project is required');
  }
  let candidate;
  if (action === 'resolve') {
    const cwd = flags.get('--cwd') || cli.cwd();
    const root = (flags.get('--designation') ?? '') === '' ? observeGitRoot(cwd) : '';
    candidate = deriveRoutingCandidate({ designation: flags.get('--designation') ?? '', git_root: root, directory: cwd });
  }
  withStore(cli, config, (store) => {
    try {
      switch (action) {
        case 'set': {
          const alias = setProjectAlias(store, kind, key, flags.get('--project'));
          println(cli, `Alias set: ${alias.kind} ${alias.key} -> ${alias.project}`);
          break;
        }
        case 'remove':
          println(cli, removeProjectAlias(store, kind, key) ? 'Alias removed.' : 'Alias not found.');
          break;
        case 'list': {
          const aliases = listProjectAliases(store);
          if (aliases.length === 0) println(cli, 'No project aliases.');
          for (const alias of aliases) println(cli, `${alias.kind}\t${alias.key}\t${alias.project}`);
          break;
        }
        default: {
          const aliases = resolveProjectAlias(store, candidate.key, candidate.directory);
          const enrolled = !aliases.conflict && aliases.project !== '' && isProjectEnrolled(store.db, aliases.project);
          let disposition = 'inbox';
          let target = candidate.key === '' ? 'unsorted' : candidate.key;
          if (enrolled) {
            disposition = 'enrolled';
            target = aliases.project;
          }
          cli.out(`${toGoJson({ candidate, aliases, conflict: aliases.conflict, enrolled, disposition, project: target })}\n`);
        }
      }
    } catch (err) {
      throw new Error(err.message);
    }
  });
}
