import { probeCompatibility } from '../../store/compatibility.js';
import { ensureInstanceId } from '../../store/instance-id.js';
import { migrateCopy } from '../../store/migrate-copy.js';
import { fatal, println } from '../runtime.js';
import { isAbsolute } from 'node:path';

const MIGRATE_COPY_USAGE = 'Usage: odin migrate-copy --data-dir <absolute-source> --output-dir <new-absolute-destination> --confirm-quiescent --json\n';
const COMPATIBILITY_USAGE = 'Usage: odin compatibility --data-dir <absolute-directory> --json';

/**
 * `odin compatibility --data-dir <ruta> --json`: observación de solo lectura de un almacén sin abrirlo.
 * Códigos de salida: 0 correcto, 2 uso o metadatos inválidos.
 * @param {import('../runtime.js').Cli} cli
 * @returns {number}
 */
export function runCompatibility(cli) {
  const args = cli.args.slice(1);
  let dir = '';
  let json = false;
  let invalid = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') {
      if (json) invalid = true;
      json = true;
    } else if (args[i] === '--data-dir') {
      if (dir !== '' || i + 1 === args.length) {
        invalid = true;
        continue;
      }
      dir = args[++i];
    } else {
      invalid = true;
    }
  }
  if (invalid || !json || dir === '') {
    cli.err(`${COMPATIBILITY_USAGE}\n`);
    return 2;
  }
  let result;
  try {
    result = probeCompatibility(dir);
  } catch (err) {
    cli.err(`${err.message}\n`);
    return 2;
  }
  cli.out(`${JSON.stringify(result)}\n`);
  return 0;
}

/**
 * `odin migrate-copy --data-dir <origen> --output-dir <destino> --confirm-quiescent --json`.
 * Todas las opciones se validan antes de leer el origen. Códigos: 0, 1 fallo, 2 uso.
 * @param {import('../runtime.js').Cli} cli
 * @returns {number}
 */
export function runMigrateCopy(cli) {
  const args = cli.args.slice(1);
  const fail = (code, message) => {
    cli.err(`odin migrate-copy: ${message}\n`);
    return code;
  };
  if (args.length === 1 && args[0] === '--help') {
    cli.out(MIGRATE_COPY_USAGE);
    return 0;
  }
  const seen = new Set();
  let source = '';
  let output = '';
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) return fail(2, `duplicate flag ${flag}`);
    seen.add(flag);
    if (flag === '--data-dir' || flag === '--output-dir') {
      if (i + 1 === args.length || args[i + 1].startsWith('--')) return fail(2, `missing value for ${flag}`);
      i++;
      if (!isAbsolute(args[i])) return fail(2, `${flag} must be absolute`);
      if (flag === '--data-dir') source = args[i];
      else output = args[i];
    } else if (flag !== '--confirm-quiescent' && flag !== '--json') {
      return fail(2, `unknown flag ${flag}`);
    }
  }
  for (const flag of ['--data-dir', '--output-dir', '--confirm-quiescent', '--json']) {
    if (!seen.has(flag)) return fail(2, `required flag ${flag}`);
  }
  let result;
  try {
    result = migrateCopy(source, output, true);
  } catch (err) {
    return fail(1, err.message);
  }
  cli.out(`${JSON.stringify(result)}\n`);
  return 0;
}

/**
 * `odin instance-id`: identidad de esta instalación (se crea si no existe).
 * @param {import('../runtime.js').Cli} cli
 * @param {{ dataDir: string }} config
 */
export function cmdInstanceId(cli, config) {
  try {
    println(cli, ensureInstanceId(config.dataDir));
  } catch (err) {
    fatal(cli, err);
  }
}
