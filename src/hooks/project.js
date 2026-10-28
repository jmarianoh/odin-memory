import { isAbsolute } from 'node:path';
import { inspectLocalProject } from '../project/inspect.js';

/**
 * Cwd de una carga de hook: exactamente un campo `cwd` en minúsculas, con valor cadena, en un
 * único objeto JSON sin nada después. Un decodificador de mapa aceptaría en silencio claves
 * duplicadas, así que se recorre el texto.
 * @param {string} text
 * @returns {string|null}
 */
export function hookProjectCwd(text) {
  if (!/^[\s\S]*$/u.test(text) || text.includes('�')) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.cwd !== 'string') return null;
  // JSON.parse se queda con la última de las claves repetidas: se cuentan en el texto.
  let count = 0;
  scanKeys(text, (key, depth) => {
    if (depth === 1 && key === 'cwd') count += 1;
  });
  return count === 1 ? value.cwd : null;
}

/** Recorre las claves de objeto del texto JSON con su profundidad (el objeto raíz es 1). */
function scanKeys(text, visit) {
  let depth = 0;
  let i = 0;
  const stack = [];
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          out += text.slice(j, j + 2);
          j += 2;
        } else {
          out += text[j];
          j += 1;
        }
      }
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k += 1;
      if (text[k] === ':' && stack[stack.length - 1] === '{') {
        let key = out;
        try {
          key = JSON.parse(`"${out}"`);
        } catch {
          // clave con un escape inválido: no coincide con cwd
        }
        visit(key, depth);
      }
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push(c);
      depth += 1;
    } else if (c === '}' || c === ']') {
      stack.pop();
      depth -= 1;
    }
    i += 1;
  }
}

/**
 * `odin hook resolve-hook-project`: lee una carga con `cwd` absoluto y responde
 * `{project, project_source, project_path}` (vacío si no hay un proyecto respaldado).
 * Solo inspecciona: nunca escribe.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
export function resolveHookProject(text, env = process.env) {
  const output = {};
  const cwd = hookProjectCwd(text);
  if (cwd !== null && isAbsolute(cwd)) {
    try {
      const result = inspectLocalProject(cwd, env);
      // Las claves salen en orden alfabético, como las de un mapa.
      output.project = result.project;
      output.project_path = result.path;
      output.project_source = result.source;
    } catch {
      // sin proyecto verificable: respuesta vacía
    }
  }
  return output;
}
