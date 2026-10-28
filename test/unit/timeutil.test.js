import { test } from 'node:test';
import assert from 'node:assert/strict';
import { now, sleepSync, sqliteDatetime } from '../../src/timeutil/index.js';

test('now() da UTC con 9 decimales y ordena cronológicamente', () => {
  const a = now(new Date('2026-10-27T22:00:00.123Z'));
  assert.equal(a, '2026-10-27 22:00:00.123000000');
  assert.match(now(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{9}$/);
  assert.ok(now(new Date('2026-10-27T22:00:00.124Z')) > a);
});

test('sqliteDatetime() usa el formato corto de datetime(now)', () => {
  assert.equal(sqliteDatetime(new Date('2026-10-27T22:00:00.999Z')), '2026-10-27 22:00:00');
});

test('sleepSync espera al menos lo pedido', () => {
  const start = Date.now();
  sleepSync(30);
  assert.ok(Date.now() - start >= 25);
});
