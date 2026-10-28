import { StoreError } from './errors.js';
import { addObservation } from './observations.js';
import { byteLength, cutBytes, goFields, hashNormalized, nullableString } from './text.js';
import { normalizeProject } from '../project/canonical.js';

const MIN_LEARNING_BYTES = 20;
const MIN_LEARNING_WORDS = 4;
const TITLE_MAX_BYTES = 60;

/** Encabezado de sección: `## Aprendizajes [Clave]`, `## Key Learnings` o `## Learnings`, con `###` también. */
const LEARNING_HEADER = /^#{2,3}\s+(?:Aprendizajes(?:\s+Clave)?|Key\s+Learnings?|Learnings?):?\s*$/gim;

/** Quita negritas, código en línea y cursivas de Markdown y colapsa espacios. */
export function cleanMarkdown(text) {
  const plain = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1');
  return goFields(plain).join(' ');
}

const isLearning = (text) => byteLength(text) >= MIN_LEARNING_BYTES && goFields(text).length >= MIN_LEARNING_WORDS;

/**
 * Extrae los aprendizajes de la sección de aprendizajes de un texto. Se usa la
 * última sección con elementos válidos; dentro de ella, la lista numerada si la
 * hay y, si no, las viñetas. Cada elemento se limpia de Markdown y debe tener al
 * menos 20 bytes y 4 palabras.
 * @param {string} text
 * @returns {string[]}
 */
export function extractLearnings(text) {
  const headers = [...text.matchAll(LEARNING_HEADER)];
  for (let i = headers.length - 1; i >= 0; i--) {
    let section = text.slice(headers[i].index + headers[i][0].length);
    const next = section.search(/\n#{1,3} /);
    if (next >= 0) section = section.slice(0, next);
    let learnings = [...section.matchAll(/^\s*\d+[.)]\s+(.+)/gm)].map((m) => cleanMarkdown(m[1])).filter(isLearning);
    if (learnings.length === 0) {
      learnings = [...section.matchAll(/^\s*[-*]\s+(.+)/gm)].map((m) => cleanMarkdown(m[1])).filter(isLearning);
    }
    if (learnings.length > 0) return learnings;
  }
  return [];
}

/**
 * Guarda como observaciones `passive` los aprendizajes de un texto, omitiendo los
 * que ya existen (mismo hash y proyecto).
 * @param {import('./store.js').Store} store
 * @param {{ session_id: string, content: string, project?: string, source?: string }} p
 * @returns {{ extracted: number, saved: number, duplicates: number }}
 */
export function passiveCapture(store, p) {
  const project = normalizeProject(p.project ?? '').normalized;
  const result = { extracted: 0, saved: 0, duplicates: 0 };
  const learnings = extractLearnings(p.content ?? '');
  result.extracted = learnings.length;
  for (const learning of learnings) {
    const exists = store.db.get(
      "SELECT id FROM observations WHERE normalized_hash = ? AND ifnull(project, '') = ifnull(?, '') AND deleted_at IS NULL LIMIT 1",
      hashNormalized(learning), nullableString(project),
    );
    if (exists) {
      result.duplicates++;
      continue;
    }
    const title = byteLength(learning) > TITLE_MAX_BYTES ? `${cutBytes(learning, TITLE_MAX_BYTES)}...` : learning;
    try {
      addObservation(store, {
        session_id: p.session_id, type: 'passive', title, content: learning, project, scope: 'project', tool_name: p.source,
      });
    } catch (err) {
      const failure = new StoreError('passive_capture_failed', `passive capture save: ${err.message}`);
      failure.cause = err;
      failure.result = result;
      throw failure;
    }
    result.saved++;
  }
  return result;
}

/** Clasifica una herramienta del agente por su efecto. */
export function classifyTool(toolName) {
  switch (toolName) {
    case 'write': case 'edit': case 'patch': return 'file_change';
    case 'bash': return 'command';
    case 'read': case 'view': return 'file_read';
    case 'grep': case 'glob': case 'ls': return 'search';
    default: return 'tool_use';
  }
}
