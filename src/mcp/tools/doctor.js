import { Runner, errorReport } from '../../diagnostic/index.js';
import { inspectProject } from '../../store/index.js';
import { normalizeProject } from '../../project/canonical.js';
import { goTrim } from '../../store/text.js';
import { strArg } from '../args.js';
import { readProjectErrorResult } from '../envelope.js';
import { errorResult, jsonMarshal, textResult } from '../json.js';
import { resolveReadProject } from '../projects.js';

/** `mem_doctor`: el mismo informe que `odin doctor --json`; un informe con estado `error` marca el resultado como error. */
export function doctorTool(ctx) {
  return (args) => {
    const projectOverride = strArg(args, 'project');
    const check = strArg(args, 'check');
    const { res, err } = resolveReadProject(ctx, projectOverride, (dir) => inspectProject(ctx.store, dir), true);
    if (err) return readProjectErrorResult(ctx.activity, res, err);
    const project = normalizeProject(res.project ?? '').normalized;
    const scope = { store: ctx.store, project };
    let report;
    try {
      const runner = new Runner();
      report = goTrim(check) !== '' ? runner.runOne(scope, check) : runner.runAll(scope);
    } catch (error) {
      report = errorReport(project, error);
    }
    let text;
    try {
      text = jsonMarshal(report);
    } catch (error) {
      return errorResult(`Doctor JSON error: ${error.message}`);
    }
    const result = textResult(text);
    if (report.status === 'error') result.isError = true;
    return result;
  };
}
