import { runSelfTest, SUITE_ALL, SUITE_PERFORMANCE, SUITE_RELIABILITY } from '../../selftest/index.js';
import { toGoJson } from '../../store/backup.js';
import { goTrim } from '../../store/text.js';

export const TEST_EXIT_SUCCESS = 0;
export const TEST_EXIT_USAGE = 1;
export const TEST_EXIT_FAILURE = 2;

const SUITES = [SUITE_ALL, SUITE_RELIABILITY, SUITE_PERFORMANCE];

/** @returns {{ options: { suite: string, quick: boolean }, json: boolean, help: boolean }} */
export function parseTestArgs(args) {
  const options = { suite: SUITE_ALL, quick: false };
  let json = false;
  let help = false;
  let suiteSeen = false;
  for (const arg of args) {
    switch (arg) {
      case '--quick': options.quick = true; break;
      case '--json': json = true; break;
      case '--help': case '-h': case 'help': help = true; break;
      default: {
        if (arg.startsWith('-')) throw new Error(`unknown test flag ${JSON.stringify(arg)}`);
        if (suiteSeen) throw new Error('only one test suite may be selected');
        const suite = goTrim(arg).toLowerCase();
        if (!SUITES.includes(suite)) throw new Error(`unknown test suite ${JSON.stringify(arg)}`);
        options.suite = suite;
        suiteSeen = true;
      }
    }
  }
  return { options, json, help };
}

function printUsage(cli) {
  const lines = [
    'usage: odin test [reliability|performance] [--quick] [--json]',
    '',
    'Run isolated local reliability and performance self-tests.',
    'Without a suite, runs reliability and performance. --quick bounds the smoke run.',
    '--json writes the stable odin-self-test/v1 report to stdout.',
    'The test uses a fresh temporary directory and never reads configured data or cloud settings.',
  ];
  for (const line of lines) cli.out(`${line}\n`);
}

const fixed = (n, digits) => n.toFixed(digits);

function printReport(cli, report) {
  cli.out(`Odin self-test (${report.suite} suite, ${report.quick ? 'quick' : 'full'} mode)\n`);
  for (const s of report.scenarios) {
    let line = `${s.passed ? 'PASS' : 'FAIL'}  ${s.suite}/${s.name}  ${s.duration_ms}ms`;
    if (s.metrics && 'operations' in s.metrics) line += `  ${fixed(s.metrics.operations, 0)} operations`;
    if (s.metrics && 'throughput_ops_per_second' in s.metrics) line += `  ${fixed(s.metrics.throughput_ops_per_second, 1)} ops/s`;
    if (s.error) line += `  ${s.error}`;
    cli.out(`${line}\n`);
  }
  cli.out(`Result: ${report.passed ? 'PASS' : 'FAIL'} (${report.duration_ms}ms)\n`);
}

/**
 * `odin test [suite] [--quick] [--json]`: autopruebas aisladas. Devuelve el código de salida:
 * 0 correcto, 1 uso, 2 alguna falló. Se despacha antes de resolver configuración.
 * @param {import('../runtime.js').Cli} cli
 * @returns {Promise<number>}
 */
export async function runTest(cli) {
  let parsed;
  try {
    parsed = parseTestArgs(cli.args.slice(1));
  } catch (err) {
    cli.err(`error: ${err.message}\n\n`);
    printUsage(cli);
    return TEST_EXIT_USAGE;
  }
  if (parsed.help) {
    printUsage(cli);
    return TEST_EXIT_SUCCESS;
  }
  const report = await (cli.selfTest ?? runSelfTest)(parsed.options);
  if (parsed.json) cli.out(`${toGoJson(report)}\n`);
  else printReport(cli, report);
  return report.passed ? TEST_EXIT_SUCCESS : TEST_EXIT_FAILURE;
}
