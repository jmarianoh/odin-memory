/**
 * Traduce el evento de Ink (`input`, `key`) al nombre de tecla que entiende `model.js`:
 * `up`, `down`, `left`, `right`, `enter`, `esc`, `backspace`, `delete`, `tab`, `home`, `end`,
 * `ctrl+<letra>`, `alt+<letra>` o, para texto, el propio carácter (o los caracteres pegados).
 * @param {string} input
 * @param {Record<string, boolean>} key
 * @returns {string}
 */
export function keyName(input, key) {
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
  if (key.return) return 'enter';
  if (key.escape) return 'esc';
  if (key.backspace) return 'backspace';
  if (key.delete) return 'delete';
  if (key.tab) return 'tab';
  if (key.home) return 'home';
  if (key.end) return 'end';
  if (key.ctrl && input) return `ctrl+${input.toLowerCase()}`;
  if (key.meta && input) return `alt+${input.toLowerCase()}`;
  return input;
}
