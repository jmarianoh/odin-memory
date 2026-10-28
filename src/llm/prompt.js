/**
 * Fragmento de una observación que se incrusta en el prompt de comparación.
 * Los campos vacíos se toleran.
 * @typedef {{ id?: string, title?: string, content?: string, type?: string, project?: string }} ObservationSnippet
 */

/**
 * Prompt canónico, bloqueado: cambiarlo cambia el significado de los veredictos
 * guardados y rompe la comparación entre modelos.
 * @param {ObservationSnippet} a
 * @param {ObservationSnippet} b
 * @returns {string}
 */
export function buildPrompt(a, b) {
  return `You are a semantic memory auditor. Compare the two observations below and classify their relationship.

=== Observation A ===
ID: ${a.id ?? ''}
Title: ${a.title ?? ''}
Content: ${a.content ?? ''}

=== Observation B ===
ID: ${b.id ?? ''}
Title: ${b.title ?? ''}
Content: ${b.content ?? ''}

Choose EXACTLY ONE relation from this locked vocabulary:
- conflicts_with   — the observations make contradictory claims
- supersedes       — observation A replaces or overrides observation B (or vice versa)
- scoped           — one is a narrower instance of the other
- related          — they share a topic but do not conflict
- compatible       — they are consistent and complementary
- not_conflict     — they are unrelated; no meaningful semantic overlap

Respond with a single-line JSON object and nothing else:
{"Relation":"<verb>","Confidence":<0.0–1.0>,"Reasoning":"<≤200 chars>"}`;
}

/** Adapta los fragmentos del almacén (`sync_id`) al formato del prompt. */
export const buildStorePrompt = (a, b) =>
  buildPrompt({ id: a.sync_id, title: a.title, type: a.type, content: a.content }, { id: b.sync_id, title: b.title, type: b.type, content: b.content });
