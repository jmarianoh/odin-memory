import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { SessionActivity, resolveAmbiguousChoicePath } from '../../../src/mcp/activity.js';
import { initRepo, tempDir } from '../project/helpers.js';

const MIN = 60_000;

function clock(start = 1_000_000) {
  const c = { now: start, tick: (ms) => { c.now += ms; }, read: () => c.now };
  return c;
}

test('el aviso de guardado solo salta tras el plazo, con actividad y sin guardados recientes', () => {
  const c = clock();
  const a = new SessionActivity(10 * MIN, c.read);
  assert.equal(a.nudgeIfNeeded('s'), ''); // sesión desconocida
  a.recordToolCall('s');
  c.tick(11 * MIN);
  assert.equal(a.nudgeIfNeeded('s'), ''); // pasó el plazo pero apenas hubo llamadas (≤ 5) y ningún guardado
  for (let i = 0; i < 5; i++) a.recordToolCall('s');
  assert.equal(a.nudgeIfNeeded('s'), '\n\n⚠️ No mem_save calls for this project in 11 minutes. Did you make any decisions, fix bugs, or discover something worth persisting?');
  a.recordSave('s');
  assert.equal(a.nudgeIfNeeded('s'), ''); // acaba de guardar
  c.tick(9 * MIN);
  assert.equal(a.nudgeIfNeeded('s'), '');
  c.tick(2 * MIN);
  assert.match(a.nudgeIfNeeded('s'), /in 11 minutes/);
});

test('un guardado reciente del proyecto silencia el aviso en otras sesiones', () => {
  const c = clock();
  const a = new SessionActivity(10 * MIN, c.read);
  for (let i = 0; i < 7; i++) a.recordToolCall('s');
  c.tick(12 * MIN);
  assert.match(a.nudgeIfNeeded('s', 'proy'), /No mem_save/);
  a.recordProjectSave('proy');
  assert.equal(a.nudgeIfNeeded('s', 'proy'), '');
  assert.match(a.nudgeIfNeeded('s', 'otro'), /No mem_save/);
  c.tick(11 * MIN); // la frescura del proyecto caduca
  assert.match(a.nudgeIfNeeded('s', 'proy'), /No mem_save/);
  a.recordProjectSave('  ');
  a.recordSaveForProject('s', 'proy');
  assert.equal(a.nudgeIfNeeded('s', 'proy'), '');
});

test('activityScore y prompt vigente', () => {
  const a = new SessionActivity(10 * MIN, clock().read);
  assert.equal(a.activityScore('x'), '');
  a.recordToolCall('x');
  assert.equal(a.activityScore('x'), 'Session activity: 1 tool call, 0 saves');
  for (let i = 0; i < 6; i++) a.recordToolCall('x');
  assert.equal(a.activityScore('x'), 'Session activity: 7 tool calls, 0 saves — high activity with no saves, consider persisting important decisions');
  a.recordSave('x');
  assert.equal(a.activityScore('x'), 'Session activity: 7 tool calls, 1 save');
  assert.equal(a.currentPrompt('x', 'p'), null);
  a.recordPrompt('x', 'p', 'haz algo');
  assert.equal(a.currentPrompt('x', 'p'), 'haz algo');
  assert.equal(a.currentPrompt('x', 'otro'), null);
  a.recordPrompt('x', 'p', '');
  assert.equal(a.currentPrompt('x', 'p'), null);
  a.clearSession('x');
  assert.equal(a.activityScore('x'), '');
});

function ambiguousParent(t) {
  const parent = realpathSync(tempDir(t));
  initRepo(join(parent, 'Uno'));
  initRepo(join(parent, 'dos'));
  mkdirSync(join(parent, 'sin-git'));
  return parent;
}

test('resolveAmbiguousChoicePath encuentra el hijo git único por nombre en minúsculas', (t) => {
  const parent = ambiguousParent(t);
  assert.equal(resolveAmbiguousChoicePath(parent, 'uno'), join(parent, 'Uno'));
  assert.equal(resolveAmbiguousChoicePath(parent, 'dos'), join(parent, 'dos'));
  assert.equal(resolveAmbiguousChoicePath(parent, 'sin-git'), ''); // sin .git
  assert.equal(resolveAmbiguousChoicePath(parent, 'nada'), '');
  assert.equal(resolveAmbiguousChoicePath(parent, ''), '');
  assert.equal(resolveAmbiguousChoicePath('', 'uno'), '');
  assert.equal(resolveAmbiguousChoicePath(join(parent, 'inexistente'), 'uno'), '');
});

test('los tokens de recuperación atan sesión, candidatos, directorio y proyecto elegido', (t) => {
  const parent = ambiguousParent(t);
  const c = clock();
  const a = new SessionActivity(10 * MIN, c.read);
  const token = a.issueAmbiguousProjectRecoveryToken('s', ['uno', 'dos'], parent);
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal(a.validateAmbiguousProjectRecoveryToken('s', token, 'uno', ['dos', 'uno'], parent), true);
  assert.equal(a.validateAmbiguousProjectRecoveryToken('s', token, 'uno', ['uno', 'dos'], parent), true); // misma elección: reutilizable
  assert.equal(a.validateAmbiguousProjectRecoveryToken('s', token, 'dos', ['uno', 'dos'], parent), false); // otra elección: no
  assert.equal(a.validateAmbiguousProjectRecoveryToken('otra', token, 'uno', ['uno', 'dos'], parent), false); // otra sesión
  assert.equal(a.validateAmbiguousProjectRecoveryToken('s', 'falso', 'uno', ['uno', 'dos'], parent), false);
  assert.equal(a.validateAmbiguousProjectRecoveryToken('s', token, '', ['uno', 'dos'], parent), false);
  assert.equal(a.validateAmbiguousProjectRecoveryToken('s', token, 'uno', ['uno', 'tres'], parent), false); // candidatos distintos
  assert.equal(a.validateAmbiguousProjectRecoveryToken('s', token, 'uno', ['uno', 'dos'], realpathSync(tempDir(t))), false);
  c.tick(5 * MIN);
  assert.equal(a.validateAmbiguousProjectRecoveryToken('s', token, 'uno', ['uno', 'dos'], parent), false); // caducado
  assert.equal(a.validateAmbiguousProjectRecoveryToken('s', token, 'uno', ['uno', 'dos'], parent), false); // y eliminado
});

test('no se emite token si el contexto no permite candidatos distintos', (t) => {
  const parent = ambiguousParent(t);
  const a = new SessionActivity(10 * MIN, clock().read);
  assert.equal(a.issueAmbiguousProjectRecoveryToken('s', ['uno'], parent), ''); // un solo candidato
  assert.equal(a.issueAmbiguousProjectRecoveryToken('s', ['uno', 'uno'], parent), ''); // repetido
  assert.equal(a.issueAmbiguousProjectRecoveryToken('s', ['uno', 'inexistente'], parent), '');
  assert.equal(a.issueAmbiguousProjectRecoveryToken('s', ['uno', 'dos'], join(parent, 'no-existe')), '');
  execFileSync('git', ['--version']);
});
