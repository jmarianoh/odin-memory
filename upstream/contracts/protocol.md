## Engram Persistent Memory — Protocol

You have access to Engram, a persistent memory system that survives across sessions and compactions.
The agent MUST follow this protocol without waiting for activation.

## AVAILABLE TOOLS

Use the Engram tools actually exposed by your host. The names below are logical
names; use the host-specific registered names for calls. Availability and tool
discovery depend on the host, not a universal bootstrap or deferred-tool split.

- mem_save, mem_search, mem_context, mem_session_summary
- mem_get_observation, mem_save_prompt, mem_current_project, mem_judge, mem_compare
- mem_update, mem_review, mem_pin, mem_unpin, mem_suggest_topic_key
- mem_session_start, mem_session_end, mem_doctor, mem_capture_passive

**Fallback**: If tools are unexpectedly unavailable, run engram setup <agent>
with your host's supported agent name and restart that host. Setup repairs its
Engram registration; use that host's configuration and discovery conventions.

## SELECTIVE MEMORY

Persist verified knowledge that is durable and costly to reconstruct: decisions with rationale,
non-obvious root causes, real constraints, and resumption-relevant pending work.
Group related conclusions deliberately, not every task, response, or event.
Exclude secrets, private data, speculation, raw dumps, and routine progress.

Search when materially useful for recall or related work; mere project mentions do not require a search.
For recall: mem_context, then mem_search with distinctive keywords, then mem_get_observation for full content.
Narrow by project/type after broad recall as needed.

For selected writes, use mem_search on the bounded topic in the intended project and scope before writing.
Read candidates in full with mem_get_observation; snippets are not identity evidence.
For the same bounded topic use mem_update by ID: keep topic_key, preserve every still-valid fact,
and record superseded facts as history. For a genuinely new topic use mem_save with a deliberate,
distinct topic_key. If already covered, write nothing.
On ambiguous identity or failed lookup, do not overwrite or fall back to a duplicate save.
A failed read is not evidence of absence. A suggested topic_key is a hint, not proof of identity.
Never merge across projects or scopes. Structure content as What, Why, Where, Learned.

Honestly report unavailable memory evidence; never claim unconfirmed persistence.
Do not blindly repeat writes. Complete unrelated work even if bookkeeping fails.
Do not add per-event learning sections or ceremonial delivery blocks.

## DELIVERY GUARANTEE

Memory operations are internal bookkeeping, never the user-facing answer. Complete required memory work before composing the completed-task reply; send the complete answer as the final message of the turn with no later tool calls. If memory work fails or needs follow-up, still send the answer.

## SESSION CLOSE PROTOCOL (REQUIRED)

At significant explicit closure or handoff, call mem_session_summary with Goal, Instructions,
Discoveries, Accomplished, Next Steps, Relevant Files. Ordinary task completion does not require a summary.
Summary persistence does not end the session. Follow the host-specific lifecycle
contract; adapters may own registration and closure independently of summaries.

### PASSIVE CAPTURE — adapter-specific safety net

Automatic capture is adapter-specific: supported adapters forward
eligible delegated/subagent tool outputs for extraction. Ordinary responses are
not universally captured; writing the section alone does not guarantee storage.
Use mem_save as the primary path for significant, verified knowledge.

You can also call mem_capture_passive(content) directly with any text that contains a learning section.
This explicit extraction path is a safety net, not a replacement for mem_save.

### AFTER COMPACTION

If you see a message about compaction or context reset, or if you see "FIRST ACTION REQUIRED" in your context:
1. IMMEDIATELY call mem_session_summary with the compacted summary content — this persists what was done before compaction
2. Then call mem_context to recover any additional context from previous sessions
3. Only THEN continue working

Do not skip step 1. Without it, everything done before compaction is lost from memory.
