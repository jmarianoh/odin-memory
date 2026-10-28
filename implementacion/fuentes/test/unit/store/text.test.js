import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  TRUNCATION_MARKER, byteLength, goFields, goTrim, hashNormalized, newSyncId, normalizeScope, normalizeTopicKey,
  normalizeTopicSegment, nullableString, sanitizeFts, stripPrivateTags, suggestTopicKey, truncateContent,
} from '../../../src/store/index.js';

test('goTrim y goFields siguen el criterio de espacio de Go, no el de JavaScript', () => {
  assert.equal(goTrim(' \u0085 hola 　'), 'hola'); // NBSP, NEL e ideográfico se recortan
  assert.equal(goTrim('﻿hola'), '﻿hola'); // BOM no es espacio para Go
  assert.deepEqual(goFields('  uno\tdos\n\ntres cuatro '), ['uno', 'dos', 'tres', 'cuatro']);
  assert.deepEqual(goFields('   '), []);
});

test('stripPrivateTags reemplaza por [REDACTED], sin distinguir mayúsculas y en varias líneas', () => {
  assert.equal(stripPrivateTags('clave: <private>abc123</private> fin'), 'clave: [REDACTED] fin');
  assert.equal(stripPrivateTags('a <PRIVATE>x\ny</Private> b <private>z</private>'), 'a [REDACTED] b [REDACTED]');
  assert.equal(stripPrivateTags('  sin etiquetas  '), 'sin etiquetas');
  assert.equal(stripPrivateTags('<private>solo</private>'), '[REDACTED]');
});

test('truncateContent corta por bytes sin partir caracteres y añade el marcador', () => {
  assert.equal(truncateContent('hola', 10), 'hola');
  assert.equal(truncateContent('abcdefghij', 4), `abcd${TRUNCATION_MARKER}`);
  // 'é' ocupa 2 bytes: con límite 3, "aéé" (5 bytes) conserva "aé" (3 bytes)
  assert.equal(truncateContent('aéé', 3), `aé${TRUNCATION_MARKER}`);
  // con límite 2 no cabe media 'é': se queda en "a"
  assert.equal(truncateContent('aéé', 2), `a${TRUNCATION_MARKER}`);
  assert.equal(byteLength('😀'), 4);
  assert.equal(truncateContent('😀😀', 5), `😀${TRUNCATION_MARKER}`);
});

test('hashNormalized ignora mayúsculas y espaciado', () => {
  const expected = createHash('sha256').update('hello world').digest('hex');
  assert.equal(hashNormalized('Hello   WORLD'), expected);
  assert.equal(hashNormalized('\n hello\tworld \n'), expected);
  assert.notEqual(hashNormalized('hello worlds'), expected);
});

test('normalizeScope acepta personal y global; todo lo demás es project', () => {
  assert.equal(normalizeScope(' Personal '), 'personal');
  assert.equal(normalizeScope('GLOBAL'), 'global');
  assert.equal(normalizeScope('otro'), 'project');
  assert.equal(normalizeScope(undefined), 'project');
});

test('normalizeTopicKey minúsculas, guiones y tope de 120 bytes sin partir caracteres', () => {
  assert.equal(normalizeTopicKey('  Architecture / Auth  Model '), 'architecture-/-auth-model');
  assert.equal(normalizeTopicKey('   '), '');
  assert.equal(normalizeTopicKey('a'.repeat(200)).length, 120);
  const accented = normalizeTopicKey('é'.repeat(100)); // 200 bytes
  assert.ok(byteLength(accented) <= 120);
  assert.equal(accented, 'é'.repeat(60));
});

test('normalizeTopicSegment deja solo a-z0-9 separados por guiones', () => {
  assert.equal(normalizeTopicSegment('Fix: Login  Crash!'), 'fix-login-crash');
  assert.equal(normalizeTopicSegment('¡¿?!'), '');
  assert.equal(normalizeTopicSegment('x'.repeat(150)).length, 100);
});

test('suggestTopicKey infiere la familia y un segmento estable', () => {
  assert.equal(suggestTopicKey('architecture', 'Hexagonal Boundary', ''), 'architecture/hexagonal-boundary');
  assert.equal(suggestTopicKey('bugfix', 'Bug: login crash', ''), 'bug/login-crash'); // quita el prefijo de familia
  assert.equal(suggestTopicKey('decision', 'decision', ''), 'decision/general'); // segmento == familia
  assert.equal(suggestTopicKey('manual', '', 'uno dos tres cuatro cinco seis siete ocho nueve diez'), 'topic/uno-dos-tres-cuatro-cinco-seis-siete-ocho');
  assert.equal(suggestTopicKey('manual', '', ''), 'topic/general');
  assert.equal(suggestTopicKey('manual', 'Crash in prod', ''), 'bug/crash-in-prod'); // familia por palabras clave
  assert.equal(suggestTopicKey('nota', 'Algo', ''), 'nota/algo'); // tipo desconocido pasa a ser la familia
});

test('suggestTopicKey distingue títulos con caracteres no ASCII con un sufijo estable', () => {
  const a = suggestTopicKey('decision', 'Decisión de caché', '');
  const b = suggestTopicKey('decision', 'Decisión de cache', '');
  assert.match(a, /^decision\/decisi-n-de-cach-u-[0-9a-f]{12}$/);
  assert.equal(b, 'decision/decisi-n-de-cache-u-' + createHash('sha256').update('Decisión de cache').digest('hex').slice(0, 12));
  assert.notEqual(a, b);
  assert.equal(suggestTopicKey('decision', 'Decisión de caché', ''), a);
});

test('sanitizeFts entrecomilla cada palabra y escapa comillas interiores', () => {
  assert.equal(sanitizeFts('fix auth bug'), '"fix" "auth" "bug"');
  assert.equal(sanitizeFts('hello"world'), '"hello""world"');
  assert.equal(sanitizeFts('"ya entrecomillado"'), '"ya" "entrecomillado"');
  assert.equal(sanitizeFts('   '), '');
});

test('nullableString y newSyncId', () => {
  assert.equal(nullableString(''), null);
  assert.equal(nullableString(undefined), null);
  assert.equal(nullableString('x'), 'x');
  assert.match(newSyncId('obs'), /^obs-[0-9a-f]{16}$/);
  assert.notEqual(newSyncId('obs'), newSyncId('obs'));
});
