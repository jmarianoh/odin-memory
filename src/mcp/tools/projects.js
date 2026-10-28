import { processOverride } from '../../project/detect.js';
import { resolve } from '../../project/resolution.js';
import { listProjectsWithStats, stats, suggestTopicKey } from '../../store/index.js';
import { goTrim } from '../../store/text.js';
import { strArg } from '../args.js';
import { readProjectErrorResult, respondWithProject } from '../envelope.js';
import { errorResult, jsonMarshal, textResult } from '../json.js';
import { captureProjectDetector, resolveReadProject, workingDirectory } from '../projects.js';

export function currentProject(ctx) {
  return (args) => {
    const { store, config } = ctx;
    let cwd = workingDirectory(ctx);
    const directory = goTrim(strArg(args, 'directory'));
    const alias = goTrim(strArg(args, 'cwd'));
    if (directory !== '') cwd = directory;
    else if (alias !== '') cwd = alias;

    let res;
    if (processOverride(config.defaultProject ?? '', ctx.env).ok) {
      try {
        res = resolve({ mode: 'current', processOverride: config.defaultProject, env: ctx.env });
      } catch (error) {
        res = { source: 'process_override', error };
      }
    } else {
      res = captureProjectDetector(store)(cwd);
    }
    const envelope = {
      project: res.project ?? '', project_source: res.source ?? '', project_path: res.path ?? '', cwd,
      available_projects: res.available_projects ?? null,
    };
    if (res.warning) envelope.warning = res.warning;
    if (res.error) envelope.error_hint = res.error.message;
    return textResult(jsonMarshal(envelope));
  };
}

export function listProjects(ctx) {
  return () => {
    const projects = listProjectsWithStats(ctx.store);
    return textResult(jsonMarshal({ projects, count: projects.length }));
  };
}

export function suggestTopicKeyTool() {
  return (args) => {
    const type = strArg(args, 'type');
    const title = strArg(args, 'title');
    const content = strArg(args, 'content');
    if (goTrim(title) === '' && goTrim(content) === '') return errorResult('provide title or content to suggest a topic_key');
    const topicKey = suggestTopicKey(type, title, content);
    if (topicKey === '') return errorResult('could not suggest topic_key from input');
    return textResult(`Suggested topic_key: ${topicKey}`);
  };
}

export function statsTool(ctx) {
  return (args) => {
    const projectOverride = strArg(args, 'project');
    let res = { source: 'all_projects' };
    if (goTrim(projectOverride) !== '' || goTrim(ctx.config.defaultProject ?? '') !== '') {
      const resolved = resolveReadProject(ctx, projectOverride);
      res = resolved.res;
      if (resolved.err) return readProjectErrorResult(ctx.activity, res, resolved.err);
    }
    const s = stats(ctx.store);
    const projects = s.projects.length > 0 ? s.projects.join(', ') : 'none yet';
    return respondWithProject(
      res,
      `Memory System Stats:\n- Sessions: ${s.total_sessions}\n- Observations: ${s.total_observations}\n- Prompts: ${s.total_prompts}\n- Projects: ${projects}`,
    );
  };
}
