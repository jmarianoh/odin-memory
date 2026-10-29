/**
 * Campo de texto de una línea, inmutable: cada operación devuelve un campo nuevo. El valor se guarda
 * como lista de caracteres (puntos de código) y el cursor es un índice en esa lista.
 * @typedef {{ placeholder: string, charLimit: number, width: number, value: string[], cursor: number, focused: boolean }} TextInput
 */

/** @returns {TextInput} */
export function newTextInput({ placeholder = '', charLimit = 0, width = 0 } = {}) {
  return { placeholder, charLimit, width, value: [], cursor: 0, focused: false };
}

/** Tabuladores y saltos de línea pasan a ser espacios y los demás controles se descartan. */
export function sanitizeInput(chars) {
  const out = [];
  for (const ch of chars) {
    if (ch === '\t' || ch === '\n' || ch === '\r') out.push(' ');
    else if (!/\p{Cc}/u.test(ch)) out.push(ch);
  }
  return out;
}

export const inputValue = (input) => input.value.join('');
export const focus = (input) => ({ ...input, focused: true });
export const blur = (input) => ({ ...input, focused: false });

export function setValue(input, text) {
  let value = sanitizeInput([...String(text)]);
  if (input.charLimit > 0 && value.length > input.charLimit) value = value.slice(0, input.charLimit);
  return { ...input, value, cursor: value.length };
}

function insert(input, chars) {
  let add = sanitizeInput(chars);
  if (input.charLimit > 0) {
    const remaining = input.charLimit - input.value.length;
    if (remaining <= 0) return input;
    add = add.slice(0, remaining);
  }
  const value = [...input.value.slice(0, input.cursor), ...add, ...input.value.slice(input.cursor)];
  return { ...input, value, cursor: input.cursor + add.length };
}

const move = (input, delta) => ({ ...input, cursor: Math.min(input.value.length, Math.max(0, input.cursor + delta)) });

function deleteBefore(input) {
  if (input.cursor === 0) return input;
  return { ...input, value: [...input.value.slice(0, input.cursor - 1), ...input.value.slice(input.cursor)], cursor: input.cursor - 1 };
}

function deleteAfter(input) {
  if (input.cursor >= input.value.length) return input;
  return { ...input, value: [...input.value.slice(0, input.cursor), ...input.value.slice(input.cursor + 1)] };
}

const isSpace = (ch) => /\s/u.test(ch);

function deleteWordBefore(input) {
  let next = input;
  while (next.cursor > 0 && isSpace(next.value[next.cursor - 1])) next = deleteBefore(next);
  while (next.cursor > 0 && !isSpace(next.value[next.cursor - 1])) next = deleteBefore(next);
  return next;
}

function deleteWordAfter(input) {
  let next = input;
  while (next.cursor < next.value.length && isSpace(next.value[next.cursor])) next = deleteAfter(next);
  while (next.cursor < next.value.length && !isSpace(next.value[next.cursor])) next = deleteAfter(next);
  return next;
}

/**
 * Aplica una tecla. `key` es el nombre de la tecla (`left`, `ctrl+a`, …) y `text` lo que escribió
 * (varios caracteres si se pegó). Un campo sin foco no cambia.
 * @param {TextInput} input
 * @param {string} key
 * @param {string} [text]
 * @returns {TextInput}
 */
export function updateTextInput(input, key, text = '') {
  if (!input.focused) return input;
  switch (key) {
    case 'left': case 'ctrl+b': return move(input, -1);
    case 'right': case 'ctrl+f': return move(input, 1);
    case 'home': case 'ctrl+a': return { ...input, cursor: 0 };
    case 'end': case 'ctrl+e': return { ...input, cursor: input.value.length };
    case 'backspace': case 'ctrl+h': return deleteBefore(input);
    case 'delete': case 'ctrl+d': return deleteAfter(input);
    case 'ctrl+u': return { ...input, value: input.value.slice(input.cursor), cursor: 0 };
    case 'ctrl+k': return { ...input, value: input.value.slice(0, input.cursor) };
    case 'ctrl+w': return deleteWordBefore(input);
    case 'alt+d': return deleteWordAfter(input);
    default: return text === '' ? input : insert(input, [...text]);
  }
}

/**
 * Cómo se dibuja: texto antes del cursor, el carácter bajo el cursor (en vídeo inverso; un espacio al
 * final) y lo que sigue. Con el valor más ancho que `width`, se ve una ventana que contiene el cursor.
 * Vacío, muestra el texto de ayuda.
 * @returns {{ before: string, cursor: string, after: string, placeholder: boolean }}
 */
export function inputView(input) {
  let { value, cursor } = input;
  if (input.width > 0 && value.length > input.width) {
    const start = Math.max(0, cursor - input.width + 1);
    value = value.slice(start, Math.min(value.length, start + input.width));
    cursor -= start;
  }
  if (value.length === 0 && input.placeholder !== '') {
    const [first, ...rest] = [...input.placeholder];
    return { before: '', cursor: input.focused ? first : '', after: input.focused ? rest.join('') : input.placeholder, placeholder: true };
  }
  if (!input.focused) return { before: value.join(''), cursor: '', after: '', placeholder: false };
  return { before: value.slice(0, cursor).join(''), cursor: value[cursor] ?? ' ', after: value.slice(cursor + 1).join(''), placeholder: false };
}
