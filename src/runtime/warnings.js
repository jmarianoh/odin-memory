/**
 * Silencia únicamente la advertencia experimental de `node:sqlite`, que Node
 * emite al cargar el módulo y ensucia stderr (el canal de avisos de MCP). Debe
 * ejecutarse antes de importar cualquier módulo que cargue `node:sqlite`.
 * Las demás advertencias pasan intactas.
 * @returns {() => void} función que restaura el comportamiento original
 */
export function silenceSqliteWarning() {
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...args) {
    const first = args[0];
    const type = typeof first === 'string' ? first : first?.type;
    if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
    return original.call(process, warning, ...args);
  };
  return () => {
    process.emitWarning = original;
  };
}
