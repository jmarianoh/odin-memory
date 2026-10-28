#!/usr/bin/env node
import { MIN_NODE_MAJOR, VERSION, nodeIsSupported } from '../src/version/index.js';

if (!nodeIsSupported()) {
  process.stderr.write(
    `odin requiere Node ${MIN_NODE_MAJOR} o superior (detectado ${process.versions.node}).\n`,
  );
  process.exit(1);
}

const [command] = process.argv.slice(2);

switch (command) {
  case 'version':
  case '--version':
  case '-v':
    process.stdout.write(`odin-memory ${VERSION}\n`);
    break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write('odin-memory: memoria persistente para GitHub Copilot.\n\nUso: odin <comando>\n\nComandos disponibles: version, help\n');
    break;
  default:
    process.stderr.write(`comando desconocido: ${command}\n`);
    process.exit(1);
}
