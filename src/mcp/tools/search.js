import { normalizeProject } from '../../project/canonical.js';
import { SOURCE_ALL_PROJECTS } from '../../project/detect.js';
import {
  DEFAULT_OBSERVATION_VERSION_PAGE_SIZE, compactSearchProjection, getObservation, getObservationVersionPage,
  observationState, searchObservationPreviews, searchPrompts, searchPreviewRelations, timeline,
} from '../../store/index.js';
import { goTrim, truncate } from '../../store/text.js';
import { formatLocal } from '../../timeutil/index.js';
import { boolArg, historyCursorArg, intArg, strArg } from '../args.js';
import { defaultSessionId, readProjectErrorResult, respondWithProject } from '../envelope.js';
import { errorResult } from '../json.js';
import { resolveReadProject, storedProjectFallback } from '../projects.js';
import { promptJson, relationsJson } from '../serialize.js';

export function searchTool(ctx) {
  return (args) => {
    const { store, activity } = ctx;
    const query = strArg(args, 'query');
    const type = strArg(args, 'type');
    const projectOverride = strArg(args, 'project');
    const scope = strArg(args, 'scope');
    const matchMode = strArg(args, 'match_mode');
    const responseFormat = strArg(args, 'response_format');
    const allProjects = boolArg(args, 'all_projects', false);
    const limit = intArg(args, 'limit', 10);
    if (matchMode !== '' && matchMode !== 'all' && matchMode !== 'any') return errorResult(`invalid match_mode ${JSON.stringify(matchMode)}: must be "all" or "any"`);
    if (responseFormat !== '' && responseFormat !== 'compact') return errorResult(`invalid response_format ${JSON.stringify(responseFormat)}: must be "compact"`);
    const compact = responseFormat === 'compact';

    let detected;
    let project = '';
    if (allProjects) {
      detected = { source: SOURCE_ALL_PROJECTS };
    } else {
      const { res, err } = resolveReadProject(ctx, projectOverride);
      if (err) return readProjectErrorResult(activity, res, err);
      project = normalizeProject(res.project ?? '').normalized;
      detected = { ...res, project };
    }
    const searchProject = scope === 'personal' && goTrim(projectOverride) === '' ? '' : project;
    const sessionId = defaultSessionId(project);
    activity.recordToolCall(sessionId);

    let results;
    try {
      results = searchObservationPreviews(store, query, { type, project: searchProject, scope, limit, match_mode: matchMode });
    } catch (err) {
      return errorResult(`Search error: ${err.message}. Try simpler keywords.`);
    }
    if (results.length === 0) return respondWithProject(detected, `No memories found for: ${JSON.stringify(query)}`);
    const relations = searchPreviewRelations(store, results);

    if (compact) {
      let text = `Found ${results.length} memories.`;
      text += activity.nudgeIfNeeded(sessionId, project);
      const projection = compactSearchProjection(results, relations).map((entry) =>
        entry.relations ? { ...entry, relations: relationsJson(entry.relations) } : entry,
      );
      return respondWithProject(detected, text, { results: projection });
    }

    let out = `Found ${results.length} memories:\n\n`;
    let anyTruncated = false;
    const structured = [];
    for (const [i, r] of results.entries()) {
      const projectDisplay = r.project != null ? ` | project: ${r.project}` : '';
      let preview = r.preview;
      if (r.truncated) {
        anyTruncated = true;
        preview += ' [preview]';
      }
      const state = observationState(r.review_after);
      const stateDisplay = state === 'needs_review' ? ' | state: needs_review' : '';
      out += `[${i + 1}] #${r.id} (${r.type}) — ${r.title}\n    ${preview}\n    ${formatLocal(r.created_at)}${projectDisplay} | scope: ${r.scope}${stateDisplay}\n`;
      const entry = { id: r.id, sync_id: r.sync_id, title: r.title, type: r.type, state, scope: r.scope, pinned: r.pinned };
      if (r.project != null) entry.project = r.project;
      if (r.topic_key != null && r.topic_key !== '') entry.topic_key = r.topic_key;
      if (r.review_after != null) entry.review_after = r.review_after;
      structured.push(entry);
      const rels = relations[r.sync_id];
      if (rels) {
        for (const rel of rels.as_source) {
          const missingTitle = rel.target_missing || rel.target_title === '' ? 'deleted' : rel.target_title;
          if (rel.relation === 'supersedes' && rel.judgment_status === 'judged') out += `    supersedes: #${rel.target_int_id} (${missingTitle})\n`;
          else if (rel.relation === 'conflicts_with' && rel.judgment_status === 'judged') out += `    conflicts: #${rel.target_int_id} (${missingTitle})\n`;
          else if (rel.judgment_status === 'pending') out += `    conflict: contested by #${rel.target_id} (pending)\n`;
        }
        for (const rel of rels.as_target) {
          const missingTitle = rel.source_missing || rel.source_title === '' ? 'deleted' : rel.source_title;
          if (rel.relation === 'supersedes' && rel.judgment_status === 'judged') out += `    superseded_by: #${rel.source_int_id} (${missingTitle})\n`;
          else if (rel.judgment_status === 'pending') out += `    conflict: contested by #${rel.source_id} (pending)\n`;
        }
      }
      out += '\n';
    }
    if (anyTruncated) out += '---\nResults above are previews (300 chars). To read the full content of a specific memory, call mem_get_observation(id: <ID>).\n';
    out += activity.nudgeIfNeeded(sessionId, project);
    return respondWithProject(detected, out, { results: structured });
  };
}

export function searchPromptsTool(ctx) {
  return (args) => {
    const { store, activity } = ctx;
    const query = args.query;
    if (typeof query !== 'string' || query === '') return errorResult('query parameter is required');
    let project = '';
    if (Object.hasOwn(args, 'project')) {
      if (typeof args.project !== 'string' || goTrim(args.project) === '') return errorResult('project must not be blank');
      project = args.project;
    }
    let all = false;
    if (Object.hasOwn(args, 'all_projects')) {
      if (typeof args.all_projects !== 'boolean') return errorResult('all_projects must be a boolean');
      all = args.all_projects;
    }
    if (all && project !== '') return errorResult('project and all_projects cannot be used together');
    let res = { source: SOURCE_ALL_PROJECTS };
    if (!all) {
      const resolved = resolveReadProject(ctx, project);
      res = resolved.res;
      if (resolved.err) return readProjectErrorResult(activity, res, resolved.err);
    }
    let prompts;
    try {
      prompts = searchPrompts(store, query, res.project ?? '', intArg(args, 'limit', 10));
    } catch (err) {
      return errorResult(`Search prompts error: ${err.message}`);
    }
    return respondWithProject(res, `Found ${prompts.length} stored prompts.`, { results: prompts.map(promptJson) });
  };
}

export function getObservationTool(ctx) {
  return (args) => {
    const { store, activity } = ctx;
    const id = intArg(args, 'id', 0);
    if (id === 0) return errorResult('id is required');
    const obs = getObservation(store, id);
    if (!obs) return errorResult(`Observation #${id} not found`);
    const { res, err } = (() => {
      const resolved = resolveReadProject(ctx, strArg(args, 'project'));
      return storedProjectFallback(obs, resolved.res, resolved.err);
    })();
    const projectLine = obs.project != null ? `\nProject: ${obs.project}` : '';
    const topic = obs.topic_key != null ? `\nTopic: ${obs.topic_key}` : '';
    const tool = obs.tool_name != null ? `\nTool: ${obs.tool_name}` : '';
    let result =
      `#${obs.id} [${obs.type}] ${obs.title}\n${obs.content}\nSession: ${obs.session_id}${projectLine}\nScope: ${obs.scope}${topic}${tool}` +
      `\nDuplicates: ${obs.duplicate_count}\nRevisions: ${obs.revision_count}\nCreated: ${formatLocal(obs.created_at)}`;
    const extra = {};
    if (boolArg(args, 'include_history', false)) {
      let cursor;
      try {
        cursor = historyCursorArg(args);
      } catch (e) {
        return errorResult(e.message);
      }
      let page;
      try {
        page = getObservationVersionPage(store, id, DEFAULT_OBSERVATION_VERSION_PAGE_SIZE, cursor);
      } catch (e) {
        return errorResult(`Failed to read observation history: ${e.message}`);
      }
      const { versions } = page;
      extra.version_count = page.total;
      const history = [];
      if (versions.length > 0) {
        let block = page.has_more
          ? `\n\nHistory (${versions.length} of ${page.total} previous versions — older versions omitted):`
          : `\n\nHistory (${versions.length} previous version${versions.length !== 1 ? 's' : ''}):`;
        for (const v of versions) {
          block += `\n\n--- Version ${v.version} (${formatLocal(v.created_at)}) ---\n${v.title}\n${v.content}`;
          history.push({ version: v.version, title: v.title, content: v.content, created_at: v.created_at });
        }
        result += block;
      }
      extra.history = history;
      if (page.has_more) {
        extra.history_truncated = true;
        extra.history_from_version = versions[0].version;
        extra.history_cursor = page.next_cursor;
      }
    }
    if (err) return readProjectErrorResult(activity, res, err);
    return respondWithProject(res, result, extra);
  };
}

export function timelineTool(ctx) {
  return (args) => {
    const { store, activity } = ctx;
    const observationId = intArg(args, 'observation_id', 0);
    if (observationId === 0) return errorResult('observation_id is required');
    const before = intArg(args, 'before', 5);
    const after = intArg(args, 'after', 5);
    const { res, err } = resolveReadProject(ctx, strArg(args, 'project'));
    if (err) return readProjectErrorResult(activity, res, err);
    const focus = getObservation(store, observationId);
    if (!focus) return errorResult('Timeline error: observation not found');
    if (focus.project == null || goTrim(focus.project).toLowerCase() !== (res.project ?? '').toLowerCase()) {
      return errorResult('Timeline error: observation not found in resolved project');
    }
    let result;
    try {
      result = timeline(store, observationId, before, after);
    } catch (e) {
      return errorResult(`Timeline error: ${e.message}`);
    }
    let out = '';
    if (result.session_info) {
      const summary = result.session_info.summary != null ? ` — ${truncate(result.session_info.summary, 100)}` : '';
      out += `Session: ${result.session_info.project} (${result.session_info.started_at})${summary}\n`;
      out += `Total observations in session: ${result.total_in_range}\n\n`;
    }
    if (result.before.length > 0) {
      out += '─── Before ───\n';
      for (const e of result.before) out += `  #${e.id} [${e.type}] ${e.title} — ${truncate(e.content, 150)}\n`;
      out += '\n';
    }
    out += `>>> #${result.focus.id} [${result.focus.type}] ${result.focus.title} <<<\n`;
    out += `    ${truncate(result.focus.content, 500)}\n`;
    out += `    ${formatLocal(result.focus.created_at)}\n\n`;
    if (result.after.length > 0) {
      out += '─── After ───\n';
      for (const e of result.after) out += `  #${e.id} [${e.type}] ${e.title} — ${truncate(e.content, 150)}\n`;
    }
    return respondWithProject(res, out);
  };
}
