import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReviewDate, osc52Sequence, truncateStr, wrapLines } from '../../../src/tui/format.js';
import { keyName } from '../../../src/tui/keys.js';
import {
  blur, focus, inputValue, inputView, newTextInput, sanitizeInput, setValue, updateTextInput,
} from '../../../src/tui/text-input.js';

test('truncateStr deja una sola línea y corta por caracteres', () => {
  assert.equal(truncateStr('hola\nmundo', 20), 'hola mundo');
  assert.equal(truncateStr('abcdef', 3), 'abc...');
  assert.equal(truncateStr('abc', 3), 'abc');
  assert.equal(truncateStr('ñandú🙂xyz', 5), 'ñandú...');
  assert.equal(truncateStr(null, 5), '');
});

test('formatReviewDate muestra solo la fecha', () => {
  assert.equal(formatReviewDate('2027-04-28 10:11:12'), '2027-04-28');
  assert.equal(formatReviewDate('2027-04-28T10:11:12Z'), '2027-04-28');
  assert.equal(formatReviewDate('2027-04-28T10:11:12.5+02:00'), '2027-04-28');
  assert.equal(formatReviewDate(' 2027-04-28 '), '2027-04-28');
  assert.equal(formatReviewDate('2027-04-28 raro'), '2027-04-28');
  assert.equal(formatReviewDate('corto'), 'corto');
});

test('wrapLines respeta saltos, rompe por palabras y corta las muy largas', () => {
  assert.deepEqual(wrapLines('uno dos tres cuatro', 9), ['uno dos', 'tres', 'cuatro']);
  assert.deepEqual(wrapLines('a\n\nb', 10), ['a', '', 'b']);
  assert.deepEqual(wrapLines('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapLines('ab abcdefgh', 4), ['ab', 'abcd', 'efgh']);
  assert.deepEqual(wrapLines('abcde', 4), ['abcd', 'e'], 'una palabra un carácter más larga también se corta');
  assert.deepEqual(wrapLines('', 5), ['']);
  assert.deepEqual(wrapLines('x y', 0), ['x', 'y'], 'una anchura inválida usa 1');
  assert.deepEqual(wrapLines('ñandú 🙂🙂🙂', 5), ['ñandú', '🙂🙂🙂']);
});

test('osc52Sequence codifica en base64 entre ESC ] 52 y BEL', () => {
  assert.equal(osc52Sequence('hola ñ'), `\x1b]52;c;${Buffer.from('hola ñ').toString('base64')}\x07`);
});

test('keyName traduce los eventos de Ink', () => {
  assert.equal(keyName('', { upArrow: true }), 'up');
  assert.equal(keyName('', { downArrow: true }), 'down');
  assert.equal(keyName('', { leftArrow: true }), 'left');
  assert.equal(keyName('', { rightArrow: true }), 'right');
  assert.equal(keyName('', { return: true }), 'enter');
  assert.equal(keyName('', { escape: true }), 'esc');
  assert.equal(keyName('', { backspace: true }), 'backspace');
  assert.equal(keyName('', { delete: true }), 'delete');
  assert.equal(keyName('', { tab: true }), 'tab');
  assert.equal(keyName('', { home: true }), 'home');
  assert.equal(keyName('', { end: true }), 'end');
  assert.equal(keyName('C', { ctrl: true }), 'ctrl+c');
  assert.equal(keyName('d', { meta: true }), 'alt+d');
  assert.equal(keyName('j', {}), 'j');
  assert.equal(keyName('texto pegado', {}), 'texto pegado');
});

const typed = (text, input = focus(newTextInput())) => updateTextInput(input, text, text);

test('campo de texto: escribir, mover, borrar y límites', () => {
  let input = focus(newTextInput({ charLimit: 8 }));
  input = typed('hola', input);
  assert.deepEqual([inputValue(input), input.cursor], ['hola', 4]);
  input = updateTextInput(input, 'left');
  input = updateTextInput(input, 'left');
  input = typed('XY', input);
  assert.equal(inputValue(input), 'hoXYla');
  assert.equal(input.cursor, 4);
  input = updateTextInput(input, 'backspace');
  assert.equal(inputValue(input), 'hoXla');
  input = updateTextInput(input, 'delete');
  assert.equal(inputValue(input), 'hoXa');
  input = updateTextInput(input, 'home');
  assert.equal(input.cursor, 0);
  input = updateTextInput(input, 'backspace');
  assert.equal(inputValue(input), 'hoXa', 'al principio no borra hacia atrás');
  input = updateTextInput(input, 'end');
  input = updateTextInput(input, 'delete');
  assert.equal(inputValue(input), 'hoXa', 'al final no borra hacia delante');
  input = typed('123456789', input);
  assert.equal(inputValue(input), 'hoXa1234', 'respeta el límite');
  assert.equal(inputValue(typed('z', input)), 'hoXa1234');
  assert.equal(inputValue(updateTextInput(input, 'ctrl+u')), '');
  const mid = updateTextInput(updateTextInput(input, 'home'), 'right');
  assert.equal(inputValue(updateTextInput(mid, 'ctrl+k')), 'h');
  assert.equal(inputValue(updateTextInput(mid, 'ctrl+u')), 'oXa1234');
  assert.equal(updateTextInput(input, 'ctrl+a').cursor, 0);
  assert.equal(updateTextInput(updateTextInput(input, 'ctrl+a'), 'ctrl+e').cursor, 8);
  assert.equal(updateTextInput(updateTextInput(input, 'ctrl+b'), 'ctrl+f').cursor, 8);
  assert.equal(inputValue(updateTextInput(updateTextInput(input, 'ctrl+a'), 'ctrl+d')), 'oXa1234');
  assert.equal(inputValue(updateTextInput(input, 'ctrl+h')), 'hoXa123');
});

test('campo de texto: palabras, pegado y saneado', () => {
  let input = typed('uno  dos tres');
  input = updateTextInput(input, 'ctrl+w');
  assert.equal(inputValue(input), 'uno  dos ');
  input = updateTextInput(input, 'ctrl+w');
  assert.equal(inputValue(input), 'uno  ');
  input = updateTextInput(updateTextInput(typed('uno dos tres'), 'home'), 'alt+d');
  assert.equal(inputValue(input), ' dos tres');
  assert.equal(inputValue(updateTextInput(input, 'alt+d')), ' tres');
  assert.equal(inputValue(typed('a\tb\nc\rd')), 'a b c d', 'tabuladores y saltos pasan a espacios');
  assert.equal(inputValue(typed('a\x00b\x1bc')), 'abc', 'se descartan los controles');
  assert.deepEqual(sanitizeInput([...'x\ty']), ['x', ' ', 'y']);
  assert.equal(inputValue(setValue(newTextInput({ charLimit: 3 }), 'abcdef')), 'abc');
  assert.equal(setValue(newTextInput(), 'abc').cursor, 3);
});

test('un campo sin foco no cambia y la vista distingue los estados', () => {
  const idle = newTextInput({ placeholder: 'Buscar...' });
  assert.equal(updateTextInput(idle, 'a', 'a'), idle);
  assert.deepEqual(inputView(idle), { before: '', cursor: '', after: 'Buscar...', placeholder: true });
  assert.deepEqual(inputView(focus(idle)), { before: '', cursor: 'B', after: 'uscar...', placeholder: true });
  const filled = typed('hola');
  assert.deepEqual(inputView(filled), { before: 'hola', cursor: ' ', after: '', placeholder: false });
  assert.deepEqual(inputView(updateTextInput(updateTextInput(filled, 'left'), 'left')), { before: 'ho', cursor: 'l', after: 'a', placeholder: false });
  assert.deepEqual(inputView(blur(filled)), { before: 'hola', cursor: '', after: '', placeholder: false });
  const narrow = typed('abcdefghij', focus(newTextInput({ width: 4 })));
  assert.deepEqual(inputView(narrow), { before: 'hij', cursor: ' ', after: '', placeholder: false }, 'una ventana de 4 que contiene el cursor');
  assert.deepEqual(inputView(updateTextInput(narrow, 'home')), { before: '', cursor: 'a', after: 'bcd', placeholder: false });
});
