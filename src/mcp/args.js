/** Argumentos de una llamada: tipos tolerantes, con valor por defecto si falta o no coincide. */
export const intArg = (args, key, fallback) => (typeof args[key] === 'number' ? Math.trunc(args[key]) : fallback);
export const boolArg = (args, key, fallback) => (typeof args[key] === 'boolean' ? args[key] : fallback);
export const strArg = (args, key) => (typeof args[key] === 'string' ? args[key] : '');

/** `history_cursor`: entero no negativo representable; `0` si falta. */
export function historyCursorArg(args) {
  if (!Object.hasOwn(args, 'history_cursor')) return 0;
  const v = args.history_cursor;
  if (typeof v !== 'number' || v < 0 || Math.trunc(v) !== v || v >= 2 ** 63) throw new Error('history_cursor must be a non-negative integer');
  return v;
}
