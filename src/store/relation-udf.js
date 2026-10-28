/** Separador de unidad (U+001F) con el que se codifican los términos origen en SQL. */
export const TERM_SEPARATOR = '\x1f';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'from', 'by', 'at', 'as', 'is', 'are', 'be',
  'was', 'were', 'we', 'it', 'this', 'that', 'use', 'used', 'using', 'add', 'added', 'update', 'updated', 'fix',
  'fixed', 'implement', 'implemented',
]);

/** Separa por todo lo que no sea letra, dígito (Nd), `+` o `#`. */
const NON_TERM = /[^\p{L}\p{Nd}+#]+/u;
const HAS_ALNUM = /[\p{L}\p{Nd}]/u;

/**
 * Términos significativos de un título: minúsculas, sin palabras vacías, sin
 * duplicados y ordenados.
 * @param {string} title
 * @returns {string[]}
 */
export function saveCandidateTerms(title) {
  const terms = new Set();
  for (const term of String(title ?? '').toLowerCase().split(NON_TERM)) {
    if (term === '' || !HAS_ALNUM.test(term) || STOPWORDS.has(term)) continue;
    terms.add(term);
  }
  return [...terms].sort();
}

/**
 * Decide si un candidato es relevante para un guardado: mismo topic_key, dos o
 * más términos de título en común, o un único término en común cuando ambos
 * títulos solo tienen uno.
 * @param {string[]} sourceTerms
 * @param {string} sourceTopic
 * @param {string} title título del candidato
 * @param {string|null} topic topic_key del candidato
 */
export function saveCandidateRelevant(sourceTerms, sourceTopic, title, topic) {
  if (sourceTopic !== '' && topic != null && sourceTopic === topic) return true;
  const targetTerms = new Set(saveCandidateTerms(title));
  let shared = 0;
  for (const source of sourceTerms) if (targetTerms.has(source)) shared++;
  return shared >= 2 || (shared === 1 && sourceTerms.length === 1 && targetTerms.size === 1);
}

/** Nombre de la función SQL que invoca `saveCandidateRelevant`. */
export const SAVE_CANDIDATE_RELEVANT_FN = 'odin_save_candidate_relevant';

/**
 * Registra las funciones SQL propias en una conexión.
 * @param {import('node:sqlite').DatabaseSync} raw
 */
export function registerSqlFunctions(raw) {
  raw.function(SAVE_CANDIDATE_RELEVANT_FN, { deterministic: true }, (encodedTerms, sourceTopic, title, topic) => {
    const terms = typeof encodedTerms === 'string' && encodedTerms !== '' ? encodedTerms.split(TERM_SEPARATOR) : [];
    const relevant = saveCandidateRelevant(
      terms,
      typeof sourceTopic === 'string' ? sourceTopic : '',
      typeof title === 'string' ? title : '',
      typeof topic === 'string' ? topic : null,
    );
    return relevant ? 1 : 0;
  });
}
