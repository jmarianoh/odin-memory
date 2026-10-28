import { byteLength, goTrim } from '../store/text.js';

/** Distancia de Levenshtein entre dos cadenas, contando caracteres Unicode. */
export function levenshtein(a, b) {
  let ra = [...a];
  let rb = [...b];
  if (ra.length === 0) return rb.length;
  if (rb.length === 0) return ra.length;
  if (ra.length > rb.length) [ra, rb] = [rb, ra];
  let prev = Array.from({ length: ra.length + 1 }, (_, i) => i);
  let curr = new Array(ra.length + 1).fill(0);
  for (let j = 1; j <= rb.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= ra.length; i++) {
      const cost = ra[i - 1] === rb[j - 1] ? 0 : 1;
      curr[i] = Math.min(prev[i] + 1, curr[i - 1] + 1, prev[i - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[ra.length];
}

/**
 * Nombres de proyecto existentes parecidos a `name`, por este orden: mismo
 * nombre con otras mayúsculas, uno contenido en el otro (con ≥ 3 caracteres) y
 * a poca distancia de edición (ordenados por distancia). La distancia máxima
 * efectiva es `min(maxDistance, max(1, longitud_en_bytes / 2))`.
 * @param {string} name
 * @param {string[]} existing
 * @param {number} maxDistance
 * @returns {{ name: string, match_type: 'case-insensitive'|'substring'|'levenshtein', distance: number }[]}
 */
export function findSimilar(name, existing, maxDistance) {
  const nameLower = goTrim(name).toLowerCase();
  let effectiveMax = Math.max(0, maxDistance);
  if (nameLower.length > 0) {
    const half = Math.max(1, Math.floor(byteLength(nameLower) / 2));
    effectiveMax = Math.min(effectiveMax, half);
  }
  const caseMatches = [];
  const subMatches = [];
  const levMatches = [];
  const seen = new Set();
  for (const candidate of existing) {
    if (candidate === name) continue;
    const candidateLower = goTrim(candidate).toLowerCase();
    if (candidateLower === nameLower) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        caseMatches.push({ name: candidate, match_type: 'case-insensitive', distance: 0 });
      }
      continue;
    }
    if (byteLength(nameLower) >= 3 && (candidateLower.includes(nameLower) || nameLower.includes(candidateLower))) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        subMatches.push({ name: candidate, match_type: 'substring', distance: 0 });
      }
      continue;
    }
    const distance = levenshtein(nameLower, candidateLower);
    if (distance <= effectiveMax && !seen.has(candidate)) {
      seen.add(candidate);
      levMatches.push({ name: candidate, match_type: 'levenshtein', distance });
    }
  }
  levMatches.sort((a, b) => a.distance - b.distance);
  return [...caseMatches, ...subMatches, ...levMatches];
}
