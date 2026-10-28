#!/usr/bin/env node
import { silenceSqliteWarning } from '../src/runtime/warnings.js';
import { MIN_NODE_MAJOR, nodeIsSupported } from '../src/version/index.js';

silenceSqliteWarning();

if (!nodeIsSupported()) {
  process.stderr.write(`odin requiere Node ${MIN_NODE_MAJOR} o superior (detectado ${process.versions.node}).\n`);
  process.exit(1);
}

const { run } = await import('../src/cli/index.js');
process.exitCode = await run(process.argv.slice(2));
