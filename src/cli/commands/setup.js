import { SLUGS, setupClient } from '../../setup/install.js';
import { exit, println } from '../runtime.js';

const USAGE = [
  'usage: odin setup <vscode-copilot|copilot-cli> [--workspace] [--insiders] [--no-hooks] [--remove] [--dry-run]',
  '',
  '  vscode-copilot   Register the MCP server, the memory protocol instructions and the hooks for VS Code Copilot.',
  '                   Writes to the user profile; with --workspace, to .vscode/mcp.json, .github/instructions/ and .github/hooks/.',
  '  copilot-cli      Register the MCP server (~/.copilot/mcp-config.json), the instructions block',
  '                   (~/.copilot/copilot-instructions.md) and the hooks (~/.copilot/hooks/) for the Copilot CLI.',
  '',
  '  --workspace      (vscode-copilot) Configure the current folder instead of the user profile.',
  '  --insiders       (vscode-copilot) Use the VS Code Insiders profile.',
  '  --no-hooks       Do not install the hooks.',
  '  --remove         Remove what setup installed.',
  '  --dry-run        Show what would change without writing anything.',
  '',
  'COPILOT_HOME overrides ~/.copilot.',
];

const LABELS = { mcp: 'MCP server', instructions: 'Instructions', hooks: 'Hooks' };

/**
 * `odin setup <cliente> [opciones]`: registra odin en VS Code Copilot o en el CLI de Copilot.
 * @param {import('../runtime.js').Cli} cli
 */
export function cmdSetup(cli) {
  const args = cli.args.slice(1);
  const usage = () => USAGE.forEach((line) => println(cli, line));
  if (args.length === 0 || ['--help', '-h', 'help'].includes(args[0])) {
    usage();
    return args.length === 0 ? exit(1) : undefined;
  }
  const slug = args[0];
  if (!SLUGS.includes(slug)) {
    cli.err(`unknown setup target ${JSON.stringify(slug)}\n\n`);
    usage();
    return exit(1);
  }
  const flags = { workspace: false, insiders: false, hooks: true, remove: false, dryRun: false };
  for (const arg of args.slice(1)) {
    switch (arg) {
      case '--workspace': flags.workspace = true; break;
      case '--insiders': flags.insiders = true; break;
      case '--no-hooks': flags.hooks = false; break;
      case '--remove': flags.remove = true; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--help': case '-h': usage(); return undefined;
      default:
        cli.err(`unknown setup argument ${JSON.stringify(arg)}\n\n`);
        usage();
        return exit(1);
    }
  }
  if (slug === 'copilot-cli' && (flags.workspace || flags.insiders)) {
    cli.err('--workspace and --insiders only apply to vscode-copilot\n');
    return exit(1);
  }
  let changes;
  try {
    changes = setupClient(slug, { env: cli.env, home: cli.home, cwd: cli.cwd(), platform: process.platform, ...flags });
  } catch (err) {
    cli.err(`odin setup ${slug} failed: ${err.message}\n`);
    return exit(1);
  }
  println(cli, `${flags.remove ? 'Removing' : 'Setting up'} odin for ${slug === 'vscode-copilot' ? 'VS Code Copilot' : 'the Copilot CLI'}${flags.dryRun ? ' (dry run, nothing is written)' : ''}:`);
  for (const change of changes) println(cli, `  ${LABELS[change.item].padEnd(12)} ${change.action.padEnd(9)} ${change.path}`);
  if (!flags.dryRun && changes.some((c) => c.action !== 'unchanged' && c.action !== 'absent')) {
    println(cli, slug === 'vscode-copilot' ? 'Reload VS Code (Developer: Reload Window) to pick up the changes.' : 'Restart the Copilot CLI to pick up the changes.');
  }
  return undefined;
}
