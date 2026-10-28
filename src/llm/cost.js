/** Tokens de entrada estimados por comparación de un par (calibrados con el prompt canónico). */
export const ESTIMATED_INPUT_TOKENS_PER_PAIR = 300;
/** Tokens de salida estimados por comparación: el veredicto es una sola línea JSON. */
export const ESTIMATED_OUTPUT_TOKENS_PER_PAIR = 50;

/**
 * Tokens totales estimados de un escaneo semántico sobre `pairCount` pares (para avisar del coste).
 * @param {number} pairCount
 * @returns {{ input: number, output: number }}
 */
export function estimateScanCost(pairCount) {
  return { input: pairCount * ESTIMATED_INPUT_TOKENS_PER_PAIR, output: pairCount * ESTIMATED_OUTPUT_TOKENS_PER_PAIR };
}
