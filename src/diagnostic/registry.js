import { goTrim } from '../store/text.js';
import { InvalidCheckError } from './core.js';

/**
 * Conjunto ordenado de chequeos: cada uno tiene `code` y `run(scope)`.
 */
export class Registry {
  #checks = new Map();

  /** @param {{ code: string, run: Function }[]} checks */
  constructor(checks = []) {
    for (const check of checks) {
      if (!check) continue;
      const code = goTrim(check.code ?? '');
      if (code === '') continue;
      this.#checks.set(code, check);
    }
  }

  /** Los chequeos ordenados por código. */
  checks() {
    return [...this.#checks.keys()].sort().map((code) => this.#checks.get(code));
  }

  codes() {
    return [...this.#checks.keys()].sort();
  }

  lookup(code) {
    const check = this.#checks.get(goTrim(code ?? ''));
    if (!check) throw new InvalidCheckError(goTrim(code ?? ''));
    return check;
  }
}
