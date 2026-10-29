import { canonicalJson, canonicalizeForProject } from '../codec.js';
import { goTrim } from '../../store/text.js';

const text = (v) => (typeof v === 'string' ? v : '');

/** Identificador de una carga heredada: su `sync_id` si lo trae o, si no, la clave. */
function firstLegacyId(fields, fallback) {
  const id = fields.sync_id;
  return typeof id === 'string' && goTrim(id) !== '' ? goTrim(id) : fallback;
}

/**
 * Completa con valores deterministas los campos que faltan en las altas heredadas de sesión,
 * observación y prompt; un valor presente pero mal formado sigue siendo inválido.
 * @throws {Error}
 */
export function normalizeLegacyMutationPayload(entry, project) {
  const entity = goTrim(entry.entity);
  const op = goTrim(entry.op);
  let payload = goTrim(text(entry.payload));
  if (entity !== 'session' && entity !== 'observation' && entity !== 'prompt') return payload;
  if (payload.startsWith('"')) {
    const inner = JSON.parse(payload);
    payload = inner;
  }
  const fields = JSON.parse(payload);
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('payload must be an object');
  const key = entity === 'session' ? entry.entity_key : goTrim(entry.entity_key);
  const fill = (defaults) => {
    for (const [field, value] of Object.entries(defaults)) if (!(field in fields)) fields[field] = value;
  };
  if (op === 'upsert') {
    if (entity === 'session') {
      fill({ id: firstLegacyId(fields, key), directory: '.' });
    } else if (entity === 'observation') {
      fill({ sync_id: key });
      const id = firstLegacyId(fields, key);
      fill({ session_id: `legacy-${id}`, type: 'legacy', title: id, content: id, scope: 'project' });
    } else {
      fill({ sync_id: key });
      const id = firstLegacyId(fields, key);
      fill({ session_id: `legacy-${id}`, content: id, project });
    }
  }
  return canonicalJson(fields);
}

/**
 * Pasa una mutación empujada por la misma canonicalización que los chunks, para que su forma guardada
 * coincida con la que tendría al reproducirse desde un chunk.
 * @param {{ project: string, entity: string, entity_key: string, op: string, payload: string }} entry
 * @returns {{ project: string, entity: string, entity_key: string, op: string, payload: string }}
 * @throws {Error}
 */
export function canonicalMutationEntry(entry) {
  const project = goTrim(entry.project);
  const payload = normalizeLegacyMutationPayload(entry, project);
  const doc = { mutations: [{ project, entity: entry.entity, entity_key: entry.entity_key, op: entry.op, payload }] };
  const canonical = JSON.parse(canonicalizeForProject(JSON.stringify(doc), project));
  if (canonical.mutations.length !== 1) throw new Error('expected one canonical mutation');
  const m = canonical.mutations[0];
  return { project: m.project, entity: m.entity, entity_key: m.entity_key, op: m.op, payload: m.payload };
}
