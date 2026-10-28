import { InvalidCheckError, buildReport, completeResult, errorReport, normalizeProjectName, STATUS, SEVERITY } from './core.js';
import { CHECK, DEFAULT_CHECKS, finding } from './checks.js';
import { Registry } from './registry.js';

export { InvalidCheckError, buildReport, errorReport, normalizeProjectName, STATUS, SEVERITY };
export { CHECK, finding, Registry };
export { assessCallerBinding, storeSessionReader } from './caller-binding.js';

/** El registro con los chequeos predeterminados. */
export const defaultRegistry = () => new Registry(DEFAULT_CHECKS);

/** Códigos registrados, ordenados. */
export const registeredCodes = () => defaultRegistry().codes();

function runCheck(scope, check) {
  return completeResult(check.run(scope), check.code);
}

/**
 * Ejecuta los chequeos de solo lectura.
 * @param {{ store: import('../store/store.js').Store, project?: string, readSqliteLockSnapshot?: Function, detectProject?: Function }} scope
 * @param {{ registry?: Registry }} [options]
 */
export class Runner {
  #registry;

  constructor({ registry = defaultRegistry() } = {}) {
    this.#registry = registry;
  }

  runAll(scope) {
    return buildReport(scope.project ?? '', this.#registry.checks().map((check) => runCheck(scope, check)));
  }

  /** @throws {InvalidCheckError} si el código no está registrado */
  runOne(scope, code) {
    return buildReport(scope.project ?? '', [runCheck(scope, this.#registry.lookup(code))]);
  }
}
