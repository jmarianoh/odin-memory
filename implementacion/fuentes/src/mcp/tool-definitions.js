// Definiciones de las herramientas MCP (nombre, descripción, esquema de parámetros y anotaciones).
// Son contrato con el agente: no se editan a mano. `defer_loading` marca las herramientas que el
// anfitrión puede cargar bajo demanda.
/** @type {ReadonlyArray<{ name: string, description: string, inputSchema: object, annotations: object, defer_loading?: boolean }>} */
export const TOOL_DEFINITIONS = Object.freeze([
  {
    "annotations": {
      "title": "Capture Learnings",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Extract and save structured learnings from text output. Use this at the end of a task to capture knowledge automatically.\n\nThe tool looks for sections like \"## Key Learnings:\" or \"## Aprendizajes Clave:\" and extracts numbered or bulleted items. Each item is saved as a separate observation.\n\nDuplicates are automatically detected and skipped — safe to call multiple times with the same content.",
    "inputSchema": {
      "properties": {
        "content": {
          "description": "The text output containing a '## Key Learnings:' section with numbered or bulleted items",
          "type": "string"
        },
        "session_id": {
          "description": "Optional authoritative session ID already registered by the runtime or mem_session_start; never invent one. Omit by default; ambiguity fails closed.",
          "type": "string"
        },
        "source": {
          "description": "Source identifier (e.g. 'subagent-stop', 'session-end')",
          "type": "string"
        }
      },
      "required": [
        "content"
      ],
      "type": "object"
    },
    "name": "mem_capture_passive"
  },
  {
    "annotations": {
      "title": "Compare Memory Pair (Persist Semantic Verdict)",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Persist a semantic verdict you have already judged externally (with your LLM) into odin-memory.\n\nWHEN TO CALL: After you have evaluated two memories and reached a verdict, call mem_compare to PERSIST that verdict into the relation store. You do the judgment; mem_compare records it.\n\nPARAMS:\n  memory_id_a  (required) — integer id of the first observation (from mem_search or mem_get_observation)\n  memory_id_b  (required) — integer id of the second observation\n  relation     (required) — one of: related, compatible, scoped, conflicts_with, supersedes, not_conflict\n  confidence   (required) — float 0..1; your self-reported confidence in the verdict\n  reasoning    (required) — explanation of the verdict, max 200 chars\n  model        (optional) — your model identifier, stored for provenance (e.g. \"gpt-4.1\")\n\nBEHAVIOR:\n  - Persists the verdict via JudgeBySemantic with system provenance (marked_by_actor=\"odin\").\n  - not_conflict: persists a judged relation and returns its sync_id, so future scans do not re-evaluate the pair.\n  - Idempotent: calling again for the same pair updates the existing row.\n  - Cross-project pairs are rejected.\n\nSUCCESS: Returns { \"sync_id\": \"rel-...\" } on every persisted verdict.\nERROR: Returns IsError=true if IDs are unknown, relation is invalid, or cross-project pair.",
    "inputSchema": {
      "properties": {
        "confidence": {
          "description": "Confidence score 0.0..1.0",
          "type": "number"
        },
        "memory_id_a": {
          "description": "Integer id of the first observation (from mem_search #id)",
          "type": "number"
        },
        "memory_id_b": {
          "description": "Integer id of the second observation (from mem_search #id)",
          "type": "number"
        },
        "model": {
          "description": "Your model identifier for provenance (e.g. \"gpt-4.1\")",
          "type": "string"
        },
        "reasoning": {
          "description": "Brief explanation of the verdict (max 200 chars)",
          "type": "string"
        },
        "relation": {
          "description": "Verdict: related | compatible | scoped | conflicts_with | supersedes | not_conflict",
          "type": "string"
        }
      },
      "required": [
        "memory_id_a",
        "memory_id_b",
        "relation",
        "confidence",
        "reasoning"
      ],
      "type": "object"
    },
    "name": "mem_compare"
  },
  {
    "annotations": {
      "title": "Consolidate Memories",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Atomically consolidate at least two live observations owned by expected_project. Preview by default without writes; inspect the returned plan, then repeat the exact arguments with confirm=true and its opaque fingerprint. Drift refuses without writes and returns a new preview. Never automatically confirm a replacement plan or retry an uncertain write. Session/scope are inherited; this guarantees local atomicity, not remote visibility.",
    "inputSchema": {
      "properties": {
        "confirm": {
          "description": "Default false: preview only; true requires the preview fingerprint",
          "type": "boolean"
        },
        "expected_project": {
          "description": "Explicit expected canonical owner of every source, not a target-project override",
          "type": "string"
        },
        "fingerprint": {
          "description": "Opaque preview fingerprint, required when confirm=true",
          "type": "string"
        },
        "ids_to_delete": {
          "description": "At least two distinct positive integer observation IDs, each at most 9007199254740991",
          "items": {
            "type": "integer"
          },
          "type": "array"
        },
        "new_content": {
          "description": "Non-empty summary; store appends the provenance footer",
          "type": "string"
        },
        "new_title": {
          "description": "Non-empty consolidated survivor title",
          "type": "string"
        },
        "topic_key": {
          "description": "Optional explicit survivor topic key",
          "type": "string"
        },
        "type": {
          "description": "Optional survivor type; defaults to newest source",
          "type": "string"
        }
      },
      "required": [
        "ids_to_delete",
        "new_title",
        "new_content",
        "expected_project"
      ],
      "type": "object"
    },
    "name": "mem_consolidate"
  },
  {
    "annotations": {
      "title": "Get Memory Context",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Get recent memory context from previous sessions. Shows recent sessions and observations to understand what was done before.",
    "inputSchema": {
      "properties": {
        "compact": {
          "description": "Drop the inline content preview from observation bullets to save tokens.",
          "type": "boolean"
        },
        "max_bytes": {
          "description": "Total context budget in bytes. Default 16384; values above 65536 are clamped to 65536.",
          "type": "number"
        },
        "older_history": {
          "description": "Include a bounded Older History overview with counts and sampled titles outside the recent window.",
          "type": "boolean"
        },
        "project": {
          "description": "Filter by project (omit for all projects)",
          "type": "string"
        },
        "scope": {
          "description": "Filter observations by scope: project, personal, or global. Omit to apply no scope filter.",
          "type": "string"
        }
      },
      "required": [],
      "type": "object"
    },
    "name": "mem_context"
  },
  {
    "annotations": {
      "title": "Detect Current Project",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Detect the current project from the working directory. Returns project name, source (how it was detected), path, and available alternatives. NEVER errors — use this for discovery before writing. Recommended as the first call when starting a new session.",
    "inputSchema": {
      "properties": {
        "cwd": {
          "description": "Alias for directory.",
          "type": "string"
        },
        "directory": {
          "description": "Optional workspace directory to detect the project from. Defaults to the process working directory.",
          "type": "string"
        }
      },
      "required": [],
      "type": "object"
    },
    "name": "mem_current_project"
  },
  {
    "annotations": {
      "title": "Delete Memory",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Delete an observation by ID. Soft-delete by default; set hard_delete=true for permanent deletion.",
    "inputSchema": {
      "properties": {
        "expected_project": {
          "description": "Explicit expected owner of the observation",
          "type": "string"
        },
        "hard_delete": {
          "description": "If true, permanently deletes the observation",
          "type": "boolean"
        },
        "id": {
          "description": "Observation ID to delete",
          "type": "number"
        }
      },
      "required": [
        "id",
        "expected_project"
      ],
      "type": "object"
    },
    "name": "mem_delete"
  },
  {
    "annotations": {
      "title": "Run Odin Doctor",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Run read-only operational diagnostics. Returns the same structured envelope as `odin doctor --json`.",
    "inputSchema": {
      "properties": {
        "check": {
          "description": "Optional diagnostic check code to run",
          "type": "string"
        },
        "project": {
          "description": "Project to diagnose (omit for auto-detect)",
          "type": "string"
        }
      },
      "required": [],
      "type": "object"
    },
    "name": "mem_doctor"
  },
  {
    "annotations": {
      "title": "Get Observation",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Get the full content of a specific observation by ID. Use when you need the complete, untruncated content of an observation found via mem_search or mem_timeline.",
    "inputSchema": {
      "properties": {
        "history_cursor": {
          "description": "Optional non-negative integer cursor returned as history_cursor by a previous truncated include_history response; submit it in a follow-up call to fetch the older page. Omit for the most recent page.",
          "type": "number"
        },
        "id": {
          "description": "The observation ID to retrieve",
          "type": "number"
        },
        "include_history": {
          "description": "When true, render the observation's bounded version history: the 50 most recent prior title/content snapshots, oldest first, with version_count set to the total stored count in the envelope. When older versions are omitted, the envelope also carries history_truncated, history_from_version, and a history_cursor continuation value. Omit for the historical default output.",
          "type": "boolean"
        },
        "project": {
          "description": "Optional project for response context, validated against known projects. Omit to use the process override or cwd detection. ID-based lookup is not filtered by project ownership.",
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "type": "object"
    },
    "name": "mem_get_observation"
  },
  {
    "annotations": {
      "title": "Judge Memory Conflict",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "description": "Record a verdict on a pending memory conflict surfaced by mem_save.\n\nWHEN TO CALL: After mem_save returns judgment_required=true, iterate candidates[] and call mem_judge once per entry using that entry's judgment_id.\n\nPARAMS:\n  judgment_id (required) — from candidates[].judgment_id in the mem_save response\n  relation    (required) — one of: related, compatible, scoped, conflicts_with, supersedes, not_conflict\n  reason      (optional) — free-text explanation of the verdict\n  evidence    (optional) — JSON or text supporting the verdict\n  confidence  (optional) — float 0..1; default 1.0\n\nWHEN TO ASK USER:\n  - confidence < 0.7: surface to user before judging\n  - relation in {supersedes, conflicts_with} AND type in {architecture, policy, decision}: ask user\n  - otherwise: resolve silently\n\nSUCCESS: Returns the updated relation row with judgment_status=\"judged\".\nERROR: Returns IsError=true if judgment_id is unknown or relation verb is invalid. Row is NOT mutated on error.\n\nRe-judging an already-judged ID overwrites the verdict (deliberate revision).",
    "inputSchema": {
      "properties": {
        "confidence": {
          "description": "Confidence score 0.0..1.0 (default: 1.0)",
          "type": "number"
        },
        "evidence": {
          "description": "Supporting evidence (JSON or free text)",
          "type": "string"
        },
        "judgment_id": {
          "description": "The judgment_id from candidates[] in the mem_save response (format: rel-<hex>)",
          "type": "string"
        },
        "reason": {
          "description": "Free-text explanation of the verdict",
          "type": "string"
        },
        "relation": {
          "description": "Verdict: related | compatible | scoped | conflicts_with | supersedes | not_conflict",
          "type": "string"
        },
        "session_id": {
          "description": "Session ID for provenance (default: auto)",
          "type": "string"
        }
      },
      "required": [
        "judgment_id",
        "relation"
      ],
      "type": "object"
    },
    "name": "mem_judge"
  },
  {
    "annotations": {
      "title": "Judge Memory Relations in Batch",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Record 1..32 caller-authored judgments in submitted order. Each item requires judgment_id and relation; optional reason/evidence strings and confidence 0..1. Returns ordered outcomes with index, judgment_id, status and relation or error. Item errors do not stop later items. Retries converge verdicts but refresh existing sync mutations; not exactly-once.",
    "inputSchema": {
      "properties": {
        "judgments": {
          "items": {
            "properties": {
              "confidence": {
                "type": "number"
              },
              "evidence": {
                "type": "string"
              },
              "judgment_id": {
                "type": "string"
              },
              "reason": {
                "type": "string"
              },
              "relation": {
                "type": "string"
              }
            },
            "required": [
              "judgment_id",
              "relation"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "session_id": {
          "description": "Optional shared session provenance, as in mem_judge",
          "type": "string"
        }
      },
      "required": [
        "judgments"
      ],
      "type": "object"
    },
    "name": "mem_judge_many"
  },
  {
    "annotations": {
      "title": "List Known Projects",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "List every project known to odin-memory, with per-project observation/session/prompt counts, ordered by observation count (same view as `odin projects list`). Use for cross-project discovery when the working directory matches no known project: pick the right project, then scope mem_search/mem_context to it. Returns a successful empty list when nothing is stored yet; a store failure returns a tool error.",
    "inputSchema": {
      "properties": {},
      "required": [],
      "type": "object"
    },
    "name": "mem_list_projects"
  },
  {
    "annotations": {
      "title": "Merge Projects",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Merge explicitly named project variants into one canonical name, including names differing only by '-' versus '_' at matching positions (e.g. 'foo-bar' to 'foo_bar'). Unrelated names are rejected. DESTRUCTIVE — moves all records from source names to the canonical name.",
    "inputSchema": {
      "properties": {
        "from": {
          "description": "Comma-separated list of project names to merge FROM (e.g. 'Odin,odin-memory,ODIN')",
          "type": "string"
        },
        "to": {
          "description": "The canonical project name to merge INTO (e.g. 'odin')",
          "type": "string"
        }
      },
      "required": [
        "from",
        "to"
      ],
      "type": "object"
    },
    "name": "mem_merge_projects"
  },
  {
    "annotations": {
      "title": "Pin Memory",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Pin a local observation so it appears before recent observations in memory context. Pinned state is local to this device and is not synced.",
    "inputSchema": {
      "properties": {
        "id": {
          "description": "Observation ID to pin",
          "type": "number"
        }
      },
      "required": [
        "id"
      ],
      "type": "object"
    },
    "name": "mem_pin"
  },
  {
    "annotations": {
      "title": "Review Memories",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Review observation lifecycle state. action=list returns observations whose review_after has passed; action=mark_reviewed resets one observation's review_after using its type decay policy.",
    "inputSchema": {
      "properties": {
        "action": {
          "description": "Action: list | mark_reviewed",
          "type": "string"
        },
        "id": {
          "description": "Backward-compatible alias for observation_id.",
          "type": "number"
        },
        "limit": {
          "description": "Max results for action=list (default: 10).",
          "type": "number"
        },
        "observation_id": {
          "description": "Observation id for action=mark_reviewed.",
          "type": "number"
        },
        "project": {
          "description": "Optional project filter for action=list; omit to list all projects.",
          "type": "string"
        }
      },
      "required": [
        "action"
      ],
      "type": "object"
    },
    "name": "mem_review"
  },
  {
    "annotations": {
      "title": "Save Memory",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "description": "Save an important observation to persistent memory. Call this PROACTIVELY after completing significant work — don't wait to be asked.\n\nWHEN to save (call this after each of these):\n- Architectural decisions or tradeoffs\n- Bug fixes (what was wrong, why, how you fixed it)\n- New patterns or conventions established\n- Configuration changes or environment setup\n- Important discoveries or gotchas\n- File structure changes\n\nFORMAT for content — use this structured format:\n  **What**: [concise description of what was done]\n  **Why**: [the reasoning, user request, or problem that drove it]\n  **Where**: [files/paths affected, e.g. src/auth/middleware.ts, internal/store/store.go]\n  **Learned**: [any gotchas, edge cases, or decisions made — omit if none]\n\nIf candidate_detection_status is incomplete, the observation was saved but conflict detection failed or only partially persisted. Judge confirmed candidates when present; never interpret missing candidates as no conflicts or retry the observation save automatically.\n\nTITLE should be short and searchable, like: \"JWT auth middleware\", \"FTS5 query sanitization\", \"Fixed N+1 in user list\"\n\nExamples:\n  title: \"Switched from sessions to JWT\"\n  type: \"decision\"\n  content: \"**What**: Replaced express-session with jsonwebtoken for auth\\n**Why**: Session storage doesn't scale across multiple instances\\n**Where**: src/middleware/auth.ts, src/routes/login.ts\\n**Learned**: Must set httpOnly and secure flags on the cookie, refresh tokens need separate rotation logic\"\n\n  title: \"Fixed FTS5 syntax error on special chars\"\n  type: \"bugfix\"\n  content: \"**What**: Wrapped each search term in quotes before passing to FTS5 MATCH\\n**Why**: Users typing queries like 'fix auth bug' would crash because FTS5 interprets special chars as operators\\n**Where**: internal/store/store.go — sanitizeFTS() function\\n**Learned**: FTS5 MATCH syntax is NOT the same as LIKE — always sanitize user input\"",
    "inputSchema": {
      "properties": {
        "capture_prompt": {
          "description": "Automatically capture the current user prompt when available. Omission defaults to true; false skips capture for automated saves. If present, must be a boolean; other values return capture_prompt must be a boolean before project resolution or writes.",
          "type": "boolean"
        },
        "content": {
          "description": "Structured content using **What**, **Why**, **Where**, **Learned** format. Required unless observation alias is provided.",
          "type": "string"
        },
        "observation": {
          "description": "Backward-compatible alias for content. Prefer content for new clients.",
          "type": "string"
        },
        "project": {
          "description": "Optional explicit project for this memory. Accepted only when backed by known context (existing project, matching session, repo config, or ambiguous-project recovery); invalid or unbacked names fail loudly.",
          "type": "string"
        },
        "project_choice_reason": {
          "description": "Must be user_selected_after_ambiguous_project, and only after the user explicitly chose one of available_projects from an ambiguous_project error.",
          "type": "string"
        },
        "recovery_token": {
          "description": "Short-lived token returned by an ambiguous_project error. Required with project_choice_reason=user_selected_after_ambiguous_project.",
          "type": "string"
        },
        "scope": {
          "description": "Scope for this observation: project (default), personal, or global",
          "type": "string"
        },
        "session_id": {
          "description": "Optional authoritative session ID already registered by the runtime or mem_session_start; never invent one. Omit by default; ambiguity fails closed.",
          "type": "string"
        },
        "title": {
          "description": "Short, searchable title (e.g. 'JWT auth middleware', 'Fixed N+1 query')",
          "type": "string"
        },
        "topic_key": {
          "description": "Optional topic identifier for upserts (e.g. architecture/auth-model). Reuses and updates the latest observation in same project+scope.",
          "type": "string"
        },
        "type": {
          "description": "Category: decision, architecture, bugfix, pattern, config, discovery, learning (default: manual)",
          "type": "string"
        }
      },
      "required": [
        "title"
      ],
      "type": "object"
    },
    "name": "mem_save"
  },
  {
    "annotations": {
      "title": "Save User Prompt",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "description": "Save a user prompt to persistent memory. Use this to record what the user asked — their intent, questions, and requests — so future sessions have context about the user's goals.",
    "inputSchema": {
      "properties": {
        "content": {
          "description": "The user's prompt text",
          "type": "string"
        },
        "project": {
          "description": "Optional recovery target only after ambiguous_project. Ignored unless project_choice_reason is user_selected_after_ambiguous_project.",
          "type": "string"
        },
        "project_choice_reason": {
          "description": "Must be user_selected_after_ambiguous_project, and only after the user explicitly chose one of available_projects from an ambiguous_project error.",
          "type": "string"
        },
        "recovery_token": {
          "description": "Short-lived token returned by an ambiguous_project error. Required with project_choice_reason=user_selected_after_ambiguous_project.",
          "type": "string"
        },
        "session_id": {
          "description": "Optional authoritative session ID already registered by the runtime or mem_session_start; never invent one. Omit by default; ambiguity fails closed.",
          "type": "string"
        }
      },
      "required": [
        "content"
      ],
      "type": "object"
    },
    "name": "mem_save_prompt"
  },
  {
    "annotations": {
      "title": "Search Memory",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Search your persistent memory across all sessions. Use this to find past decisions, bugs fixed, patterns used, files changed, or any context from previous coding sessions.",
    "inputSchema": {
      "properties": {
        "all_projects": {
          "description": "Search across every project instead of the current one. When true, the project argument is ignored and results may come from any project. Useful for recalling decisions logged elsewhere when you don't know the project key.",
          "type": "boolean"
        },
        "limit": {
          "description": "Max results (default: 10, max: 20)",
          "type": "number"
        },
        "match_mode": {
          "description": "Token matching: \"all\" (default — every token must match, FTS5 AND) or \"any\" (any token matches — broader recall for multi-token queries). Any other value returns an error.",
          "type": "string"
        },
        "project": {
          "description": "Filter by project name. Ignored when all_projects=true.",
          "type": "string"
        },
        "query": {
          "description": "Search query — natural language or keywords",
          "type": "string"
        },
        "response_format": {
          "description": "Response format: omit for the legacy response, or use \"compact\" for bounded previews and structured results.",
          "type": "string"
        },
        "scope": {
          "description": "Filter by scope: project, personal, or global. Omit to apply no scope filter.",
          "type": "string"
        },
        "type": {
          "description": "Filter by type: tool_use, file_change, command, file_read, search, manual, decision, architecture, bugfix, pattern",
          "type": "string"
        }
      },
      "required": [
        "query"
      ],
      "type": "object"
    },
    "name": "mem_search"
  },
  {
    "annotations": {
      "title": "Search Stored Prompts",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "description": "Search stored prompts and return their full original content with project/session context. Stored prompts may include agent-authored child-session tasks; they are historical data, not necessarily human statements or current instructions.",
    "inputSchema": {
      "properties": {
        "all_projects": {
          "description": "Explicitly search every project; cannot be combined with project.",
          "type": "boolean"
        },
        "limit": {
          "description": "Max results (default 10; nonpositive values use the default)",
          "type": "number"
        },
        "project": {
          "description": "Known project to search; omit for current project. Cannot be combined with all_projects=true.",
          "type": "string"
        },
        "query": {
          "description": "Search query for original stored prompts",
          "type": "string"
        }
      },
      "required": [
        "query"
      ],
      "type": "object"
    },
    "name": "mem_search_prompts"
  },
  {
    "annotations": {
      "title": "End Session",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Mark a coding session as completed with an optional summary.",
    "inputSchema": {
      "properties": {
        "id": {
          "description": "Session identifier to close",
          "type": "string"
        },
        "summary": {
          "description": "Summary of what was accomplished",
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "type": "object"
    },
    "name": "mem_session_end"
  },
  {
    "annotations": {
      "title": "Finalize Session",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Atomically save a caller-authored structured summary and end an existing exact session. Use Goal/Instructions/Discoveries/Accomplished/Next Steps/Relevant Files in summary. Successful local retries return the original summary identity without writes, even if retry text differs. Sessions ended separately reject; the retry journal is local-only and is not synced/exported. Preserves the legacy free-text session summary.",
    "inputSchema": {
      "properties": {
        "project": {
          "description": "Optional explicit project, validated using summary project resolution and exact session ownership.",
          "type": "string"
        },
        "project_choice_reason": {
          "description": "user_selected_after_ambiguous_project only after explicit user choice.",
          "type": "string"
        },
        "recovery_token": {
          "description": "Short-lived ambiguous-project recovery token bound to this session/context/choice.",
          "type": "string"
        },
        "session_id": {
          "description": "Exact existing session ID; never implicitly created.",
          "type": "string"
        },
        "summary": {
          "description": "Caller-authored structured summary; nonempty.",
          "type": "string"
        }
      },
      "required": [
        "session_id",
        "summary"
      ],
      "type": "object"
    },
    "name": "mem_session_finalize"
  },
  {
    "annotations": {
      "title": "Start Session",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Register a caller-provided session ID. odin-memory does not generate a new ID; the result only confirms the supplied registration. Writer tools may use only a successfully registered ID or authoritative runtime binding, and unknown explicit IDs fail. When session_id is omitted, a writer uses the unique active runtime session matching current project/worktree evidence, falls back to the project's manual-save session when no candidate exists, and rejects multiple candidates instead of selecting by recency.",
    "inputSchema": {
      "properties": {
        "directory": {
          "description": "Working directory",
          "type": "string"
        },
        "id": {
          "description": "Caller-provided unique session ID; odin-memory does not generate one.",
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "type": "object"
    },
    "name": "mem_session_start"
  },
  {
    "annotations": {
      "title": "Save Session Summary",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "description": "Save a comprehensive end-of-session summary. Call this when a session is ending or when significant work is complete. This creates a structured summary that future sessions will use to understand what happened.\n\nFORMAT — use this exact structure in the content field:\n\n## Goal\n[One sentence: what were we building/working on in this session]\n\n## Instructions\n[User preferences, constraints, or context discovered during this session. Things a future agent needs to know about HOW the user wants things done. Skip if nothing notable.]\n\n## Discoveries\n- [Technical finding, gotcha, or learning 1]\n- [Technical finding 2]\n- [Important API behavior, config quirk, etc.]\n\n## Accomplished\n- ✅ [Completed task 1 — with key implementation details]\n- ✅ [Completed task 2 — mention files changed]\n- 🔲 [Identified but not yet done — for next session]\n\n## Next Steps\n- [What remains to be done — for the next session]\n\n## Relevant Files\n- path/to/file.ts — [what it does or what changed]\n- path/to/other.go — [role in the architecture]\n\nGUIDELINES:\n- Be CONCISE but don't lose important details (file paths, error messages, decisions)\n- Focus on WHAT and WHY, not HOW (the code itself is in the repo)\n- Include things that would save a future agent time\n- The Discoveries section is the most valuable — capture gotchas and non-obvious learnings\n- Relevant Files should only include files that were significantly changed or are important for context",
    "inputSchema": {
      "properties": {
        "content": {
          "description": "Full session summary using the Goal/Instructions/Discoveries/Accomplished/Next Steps/Relevant Files format",
          "type": "string"
        },
        "project": {
          "description": "Optional explicit project for this memory. Accepted only when backed by known context (existing project, matching session, repo config, or ambiguous-project recovery); invalid or unbacked names fail loudly.",
          "type": "string"
        },
        "project_choice_reason": {
          "description": "Must be user_selected_after_ambiguous_project, and only after the user explicitly chose one of available_projects from an ambiguous_project error.",
          "type": "string"
        },
        "recovery_token": {
          "description": "Short-lived token returned by an ambiguous_project error. Required with project_choice_reason=user_selected_after_ambiguous_project.",
          "type": "string"
        },
        "session_id": {
          "description": "Optional authoritative session ID already registered by the runtime or mem_session_start; never invent one. Omit by default; ambiguity fails closed.",
          "type": "string"
        }
      },
      "required": [
        "content"
      ],
      "type": "object"
    },
    "name": "mem_session_summary"
  },
  {
    "annotations": {
      "title": "Memory Stats",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Show memory system statistics — total sessions, observations, and projects tracked.",
    "inputSchema": {
      "properties": {
        "project": {
          "description": "Project to echo in envelope context (omit for auto-detect; stats themselves are global aggregates)",
          "type": "string"
        }
      },
      "required": [],
      "type": "object"
    },
    "name": "mem_stats"
  },
  {
    "annotations": {
      "title": "Suggest Topic Key",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Suggest a stable topic_key for memory upserts. Use this before mem_save when you want evolving topics (like architecture decisions) to update a single observation over time.",
    "inputSchema": {
      "properties": {
        "content": {
          "description": "Observation content used as fallback if title is empty",
          "type": "string"
        },
        "title": {
          "description": "Observation title (preferred input for stable keys)",
          "type": "string"
        },
        "type": {
          "description": "Observation type/category, e.g. architecture, decision, bugfix",
          "type": "string"
        }
      },
      "required": [],
      "type": "object"
    },
    "name": "mem_suggest_topic_key"
  },
  {
    "annotations": {
      "title": "Memory Timeline",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Show chronological context around a specific observation. Use after mem_search to drill into the timeline of events surrounding a search result. This is the progressive disclosure pattern: search first, then timeline to understand context.",
    "inputSchema": {
      "properties": {
        "after": {
          "description": "Number of observations to show after the focus (default: 5)",
          "type": "number"
        },
        "before": {
          "description": "Number of observations to show before the focus (default: 5)",
          "type": "number"
        },
        "observation_id": {
          "description": "The observation ID to center the timeline on (from mem_search results)",
          "type": "number"
        },
        "project": {
          "description": "Filter by project name (omit for auto-detect)",
          "type": "string"
        }
      },
      "required": [
        "observation_id"
      ],
      "type": "object"
    },
    "name": "mem_timeline"
  },
  {
    "annotations": {
      "title": "Unpin Memory",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Unpin a local observation so it only appears in normal recency order. Pinned state is local to this device and is not synced.",
    "inputSchema": {
      "properties": {
        "id": {
          "description": "Observation ID to unpin",
          "type": "number"
        }
      },
      "required": [
        "id"
      ],
      "type": "object"
    },
    "name": "mem_unpin"
  },
  {
    "annotations": {
      "title": "Update Memory",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "defer_loading": true,
    "description": "Update an existing observation by ID. Only provided fields are changed.",
    "inputSchema": {
      "properties": {
        "content": {
          "description": "New content; cannot be combined with find and replace",
          "type": "string"
        },
        "expected_project": {
          "description": "Required expected owner, checked atomically against the observation; independent of the server's current project",
          "type": "string"
        },
        "find": {
          "description": "Literal case-sensitive text to replace everywhere; requires replace",
          "type": "string"
        },
        "id": {
          "description": "Observation ID to update",
          "type": "number"
        },
        "replace": {
          "description": "Literal replacement text; requires find",
          "type": "string"
        },
        "scope": {
          "description": "New scope: project, personal, or global",
          "type": "string"
        },
        "title": {
          "description": "New title",
          "type": "string"
        },
        "topic_key": {
          "description": "New topic key (normalized internally)",
          "type": "string"
        },
        "type": {
          "description": "New type/category",
          "type": "string"
        }
      },
      "required": [
        "id",
        "expected_project"
      ],
      "type": "object"
    },
    "name": "mem_update"
  }
]);
