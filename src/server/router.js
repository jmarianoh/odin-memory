/**
 * Enrutador mínimo con patrones `MÉTODO /ruta/{parámetro}`. Un segmento literal
 * gana sobre uno con comodín; una ruta conocida con otro método responde 405
 * con la cabecera `Allow`, y una desconocida 404. `GET` atiende también a `HEAD`.
 */

/** @typedef {{ method: string, segments: ({ literal: string } | { param: string })[], handler: Function, pattern: string }} Route */

const segmentsOf = (path) => path.split('/').slice(1);

function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export class Router {
  constructor() {
    /** @type {Route[]} */
    this.routes = [];
  }

  /**
   * @param {string} pattern p. ej. `GET /sessions/{id}`
   * @param {Function} handler
   */
  add(pattern, handler) {
    const space = pattern.indexOf(' ');
    const method = pattern.slice(0, space);
    const path = pattern.slice(space + 1);
    const segments = segmentsOf(path).map((s) => (s.startsWith('{') && s.endsWith('}') ? { param: s.slice(1, -1) } : { literal: s }));
    this.routes.push({ method, segments, handler, pattern });
  }

  /** Rutas cuyo camino coincide con `pathSegments`, con sus parámetros. */
  #candidates(pathSegments) {
    const found = [];
    for (const route of this.routes) {
      if (route.segments.length !== pathSegments.length) continue;
      const params = {};
      let wildcards = 0;
      let ok = true;
      for (const [i, seg] of route.segments.entries()) {
        if ('literal' in seg) {
          if (seg.literal !== pathSegments[i]) {
            ok = false;
            break;
          }
        } else {
          if (pathSegments[i] === '') {
            ok = false;
            break;
          }
          params[seg.param] = decode(pathSegments[i]);
          wildcards++;
        }
      }
      if (ok) found.push({ route, params, wildcards });
    }
    return found;
  }

  /**
   * @param {string} method
   * @param {string} path ruta sin consulta
   * @returns {{ kind: 'match', route: Route, params: Record<string,string> } | { kind: 'method', allow: string[] } | { kind: 'none' }}
   */
  match(method, path) {
    const candidates = this.#candidates(segmentsOf(path));
    if (candidates.length === 0) return { kind: 'none' };
    const wanted = method === 'HEAD' ? ['HEAD', 'GET'] : [method];
    const hits = candidates.filter((c) => wanted.includes(c.route.method)).sort((a, b) => a.wildcards - b.wildcards);
    if (hits.length > 0) return { kind: 'match', route: hits[0].route, params: hits[0].params };
    const allow = new Set(candidates.map((c) => c.route.method));
    if (allow.has('GET')) allow.add('HEAD');
    return { kind: 'method', allow: [...allow].sort() };
  }
}
