import { PROFILE_ADMIN, PROFILE_AGENT, resolveTools } from '../mcp/profiles.js';
import { VERSION } from '../version/index.js';

/** Texto de ayuda de la CLI. */
export function usageText() {
  const agentTools = PROFILE_AGENT.size;
  const adminTools = PROFILE_ADMIN.size;
  const allTools = resolveTools('agent,admin').size;
  return `odin v${VERSION} — Persistent memory for GitHub Copilot

Usage:
  odin <command> [arguments]

Commands:
  serve [port]       Start HTTP API server (default: 7438)
  serve --socket PATH
                     Serve the HTTP API on an owner-only Unix socket instead of TCP
  serve --session-owned  Private ephemeral HTTP server; requires ODIN_TOKEN, stops on stdin EOF
  mcp [--tools=PROFILE] [--project NAME]
                     Start MCP server (stdio transport)
                        Profiles: agent (${agentTools} tools), admin (${adminTools} tools), all (default, ${allTools})
                       Combine: --tools=agent,admin or pick individual tools
                       Example: odin mcp --tools=agent
                       --project NAME  Set process-level default project (overrides cwd detection).
                                       Also accepted as ODIN_PROJECT=NAME env var.
  migrate-copy --data-dir <absolute-source> --output-dir <new-absolute-destination> --confirm-quiescent --json
                     Copy a stopped store completely and migrate only the copy
  compatibility --data-dir <absolute-directory> --json
                     Read-only offline store observation (JSON). It never opens, migrates or repairs
                     the store, and never authorizes automatic opening
  search <query>     Search memories [--type TYPE] [--project PROJECT|--all] [--scope SCOPE] [--limit N] [--match all|any]
  save <title> <msg> Save a memory  [--type TYPE] [--project PROJECT] [--scope SCOPE]
  delete <obs_id>    Delete an observation [--hard] (soft-delete by default; --hard removes permanently)
  delete session <id>
                     Delete a session by ID (session must have no observations)
  delete prompt <id>
                     Delete a prompt by ID (permanent)
  delete project <name> [--hard]
                     Cascade-delete a project: soft-deletes observations (or hard if --hard),
                     removes prompts; with --hard also removes sessions
  timeline <obs_id>  Show chronological context around an observation [--before N] [--after N] [--project PROJECT|--all]
  sync [--import | --status] [--all] [--include-prompts] [--cloud --project PROJECT [--literal-project]]
                     Share memories through Git: export new chunks to .odin-memory/ or import chunks from teammates
                       --import           Import chunks that are not in this database yet
                       --status           Show local, remote and pending chunk counts
                       --all              Export every project (default: current project)
                       --include-prompts  Also share prompts (excluded by default)
  conflicts <sub>   Inspect and manage memory conflict relations
                       list     [--project P|--all]  [--status S]  [--since RFC3339]  [--limit N]
                       show     <relation_id>
                       stats    [--project P|--all]
                       scan     [--project P|--all]  [--since RFC3339]  [--limit N]  [--cursor ID]
                                [--dry-run]  [--apply]  [--max-insert N]  [--semantic]  [--concurrency N]  [--timeout-per-call SECONDS]
                                [--max-semantic N]  [--yes]
                       deferred [--status S]  [--limit N]  [--inspect SYNC_ID]  [--replay]
                       prune    [--max-age-days N]  [--max-per-scope N]  [--dry-run]  [--apply]
  doctor             Run read-only operational diagnostics [--json] [--project P] [--check CODE]
                       repair --project P --check CODE (--plan|--dry-run|--apply)
                       repair mutates state: only --apply writes.
  context [project] [--project PROJECT|--all] [--scope SCOPE] [--older-history]
                     Show recent context from previous sessions
  stats [--project PROJECT|--all]
                     Show memory system statistics
  export [file] [--project PROJECT|--all]
                     Export memories to JSON (default: odin-export.json)
  import <file>      Import memories from a JSON export file
  init [name]        Initialize an Odin project (.odin-memory/config.json) in current directory
                       --force, -f   Overwrite existing .odin-memory/config.json
  projects list      List all projects with observation, session, and prompt counts
  projects merge --from <source> --to <canonical> (--dry-run|--apply)
                     Preview or apply a legacy case, separator or Unicode normalization variant merge
  projects consolidate [--all] [--dry-run]
                     Merge similar project names into one canonical name
                       --all      Scan ALL projects for similar name groups
                       --dry-run  Preview what would be merged (no changes)
  projects prune [--dry-run] [--paths-only]
                     Remove projects with no observations
                       --dry-run     Preview projects without removing data
                       --paths-only  Limit pruning to project names containing / or \\
  projects rescue-ownership --project NAME [--session ID]... [--observation ID]... [--prompt ID]...
                     Assign a project to historical records that have no owner
  projects alias <set|list|remove|resolve>
                     Manage local project aliases (future captures only)

  version            Print version
  help               Show this help

Environment:
  ODIN_DATA_DIR      Odin CLI data directory. Empty or whitespace-only values use the
                     platform default; nonblank values are used as provided (default: ~/.odin-memory)
  ODIN_PORT          Override HTTP server port (default: 7438)
  ODIN_SOCKET        Serve over this Unix socket path instead of TCP (cannot be combined with a port)
  ODIN_HTTP_TOKEN    Optional Bearer auth for the local HTTP server (odin serve).
                     When set, the following routes require Authorization: Bearer <token>:
                       DELETE /sessions/{id}, DELETE /observations/{id}, DELETE /prompts/{id},
                       GET /export, POST /import, POST /observations/consolidate,
                       POST /conflicts/judge-many, POST /sessions/{id}/finalize
                     Comparison is constant-time. Token is read per-request (no restart needed).
                     Other routes remain open when unset (zero-config default).
  ODIN_AGENT_CLI     LLM runner for conflicts scan --semantic (copilot)
  ODIN_PROJECT       Process-level default project override, applied by every entry point
                     with one precedence rule: explicit request project (odin save --project,
                     an MCP tool project argument) > process override (odin mcp --project,
                     then ODIN_PROJECT) > cwd detection.
                     For "odin save": owns the observation when --project is omitted.
                     For "odin mcp": sets the default project, overriding cwd detection for all tools.
  ODIN_TIMEZONE      Timezone for timestamp display.
                     Accepts any IANA zone name (e.g. America/New_York, Europe/Berlin).
                     Falls back to system local time when unset or invalid.

MCP Configuration (add to your agent's config):
  {
    "servers": {
      "odin-memory": {
        "type": "stdio",
        "command": "odin",
        "args": ["mcp", "--tools=agent"]
      }
    }
  }
`;
}
