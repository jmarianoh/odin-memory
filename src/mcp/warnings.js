/** Avisos no bloqueantes que acompañan a un guardado. */

/** Aviso de truncamiento del contenido, o `''`. */
export function truncationWarning(truncation) {
  if (!truncation?.truncated) return '';
  return `\n⚠ WARNING: Content was truncated from ${truncation.original_bytes} to ${truncation.limit_bytes} bytes. Consider splitting into smaller observations.`;
}

const isAsciiLetter = (ch) => ch !== undefined && /^[A-Za-z]$/.test(ch);
const isAsciiDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9';
const isPathWordCharacter = (ch) => /^[\p{L}\p{Nd}\p{M}.\-_]$/u.test(ch);
const isUriTokenCharacter = (ch) => isPathWordCharacter(ch) || ":/?#[]@!$&'()*+,;=%~".includes(ch);

/** Si `chars[index]` abre un URI (`esquema://…` o `file:/…`) devuelve el índice de su final; si no, `index`. */
function uriTokenEnd(chars, start) {
  if (!isAsciiLetter(chars[start])) return start;
  if (start > 0 && isPathWordCharacter(chars[start - 1])) return start;
  let colon = start + 1;
  while (colon < chars.length && (isAsciiLetter(chars[colon]) || isAsciiDigit(chars[colon]) || '+-.'.includes(chars[colon]))) colon++;
  if (colon >= chars.length || chars[colon] !== ':') return start;
  const hasAuthority = colon + 2 < chars.length && chars[colon + 1] === '/' && chars[colon + 2] === '/';
  const hasAuthoritylessFilePath = colon + 1 < chars.length && chars[colon + 1] === '/' && chars.slice(start, colon).join('').toLowerCase() === 'file';
  if (!hasAuthority && !hasAuthoritylessFilePath) return start;
  let end = colon + 2;
  if (hasAuthority) end++;
  while (end < chars.length && isUriTokenCharacter(chars[end])) end++;
  return end;
}

const isAbsolutePathBoundary = (chars, index) => index === 0 || (chars[index - 1] !== '/' && !isPathWordCharacter(chars[index - 1]));

/**
 * Reconoce rutas absolutas habituales (`C:\…`, `\\servidor`, `/usr/…`) sin
 * depender del sistema operativo. Las rutas tipo ruta de API (`/api/v1`) también
 * coinciden: es solo un aviso.
 */
export function containsAbsoluteFilesystemPath(content) {
  const chars = Array.from(content);
  for (let i = 0; i < chars.length;) {
    const uriEnd = uriTokenEnd(chars, i);
    if (uriEnd > i) {
      i = uriEnd;
      continue;
    }
    const ch = chars[i];
    if (isAsciiLetter(ch) && i + 2 < chars.length && chars[i + 1] === ':' && (chars[i + 2] === '/' || chars[i + 2] === '\\')) return true;
    if (ch === '\\' && i + 2 < chars.length && chars[i + 1] === '\\' && chars[i + 2] !== '\\' && chars[i + 2] !== '/') return true;
    if (ch === '/' && (i + 1 === chars.length || chars[i + 1] !== '/') && isAbsolutePathBoundary(chars, i)) return true;
    i++;
  }
  return false;
}

/** Aviso de ruta absoluta no portable, o `''`. */
export function absolutePathWarning(content) {
  if (!containsAbsoluteFilesystemPath(content)) return '';
  return '\n⚠ WARNING: Content contains an absolute filesystem path that may not be portable across machines. Use a repository-relative path instead.';
}
