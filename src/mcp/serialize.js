/** Proyecciones JSON de los registros del almacén (omiten lo vacío, como el contrato de la API). */

export function promptJson(p) {
  const out = { id: p.id, sync_id: p.sync_id, session_id: p.session_id, content: p.content, created_at: p.created_at };
  if (p.project) out.project = p.project;
  if (p.source_inbox_id) out.source_inbox_id = p.source_inbox_id;
  return out;
}

/** Relación sin los campos auxiliares de enlace (`source_int_id`, `*_title`, `*_missing`) ni los nulos. */
export function relationJson(rel) {
  const out = {};
  for (const key of [
    'id', 'sync_id', 'source_id', 'target_id', 'relation', 'reason', 'evidence', 'confidence', 'judgment_status',
    'marked_by_actor', 'marked_by_kind', 'marked_by_model', 'session_id', 'created_at', 'updated_at',
  ]) {
    if (rel[key] !== null && rel[key] !== undefined) out[key] = rel[key];
  }
  return out;
}

/**
 * Entrada de `relations` de un resultado compacto. Un lado sin relaciones se
 * serializa como `null` (no como lista vacía), igual que el contrato original.
 */
export const relationsJson = (rels) => ({
  as_source: rels.as_source.length > 0 ? rels.as_source.map(relationJson) : null,
  as_target: rels.as_target.length > 0 ? rels.as_target.map(relationJson) : null,
});
