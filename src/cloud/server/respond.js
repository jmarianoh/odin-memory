import { BodyTooLargeError, sendJson } from '../../server/http.js';
import { goTrim } from '../../store/text.js';

/** Respuesta JSON de un objeto libre: las claves salen por orden alfabético, como en un mapa. */
export const sendMap = (res, status, fields) => sendJson(res, status, Object.fromEntries(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/** Error accionable: `{ error_class, error_code, error }` con las claves por orden alfabético. */
export const actionable = (res, status, errorClass, errorCode, message) => sendMap(res, status, { error_class: errorClass, error_code: errorCode, error: goTrim(message) });

/** Cuerpo completo con tope de bytes. */
export function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      fn(value);
    };
    req.on('data', (part) => {
      size += part.length;
      if (size > limit) {
        parts.length = 0;
        finish(reject, new BodyTooLargeError());
        req.resume();
        return;
      }
      parts.push(part);
    });
    req.on('end', () => finish(resolve, Buffer.concat(parts)));
    req.on('error', (err) => finish(reject, err));
    req.on('aborted', () => finish(reject, new Error('unexpected EOF')));
  });
}

