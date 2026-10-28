import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionActivity } from '../../../src/mcp/activity.js';
import { addErrorMetadata, defaultSessionId, errorWithMeta, readProjectErrorResult, respondWithProject, writeProjectErrorResult } from '../../../src/mcp/envelope.js';
import * as errors from '../../../src/mcp/errors.js';
import { errorResult, jsonMarshal, textResult } from '../../../src/mcp/json.js';
import { boolArg, historyCursorArg, intArg, strArg } from '../../../src/mcp/args.js';
import { promptJson, relationJson, relationsJson } from '../../../src/mcp/serialize.js';

const body = (result) => JSON.parse(result.content[0].text);

test('jsonMarshal ordena claves y escapa los caracteres de HTML y los separadores de línea', () => {
  assert.equal(jsonMarshal({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(jsonMarshal({ t: '<a href="x">&</a>' }), '{"t":"\\u003ca href=\\"x\\"\\u003e\\u0026\\u003c/a\\u003e"}');
  assert.equal(jsonMarshal({ t: 'a b c' }), '{"t":"a\\u2028b\\u2029c"}');
  assert.equal(jsonMarshal([]), '[]');
  assert.deepEqual(textResult('x'), { content: [{ type: 'text', text: 'x' }] });
  assert.deepEqual(errorResult('x'), { content: [{ type: 'text', text: 'x' }], isError: true });
});

test('argumentos tolerantes: el tipo incorrecto cae en el valor por defecto', () => {
  assert.equal(intArg({ n: 3.9 }, 'n', 1), 3);
  assert.equal(intArg({ n: -3.9 }, 'n', 1), -3);
  assert.equal(intArg({ n: '3' }, 'n', 1), 1);
  assert.equal(intArg({}, 'n', 7), 7);
  assert.equal(boolArg({ b: true }, 'b', false), true);
  assert.equal(boolArg({ b: 'true' }, 'b', false), false);
  assert.equal(strArg({ s: 'x' }, 's'), 'x');
  assert.equal(strArg({ s: 4 }, 's'), '');
  assert.equal(historyCursorArg({}), 0);
  assert.equal(historyCursorArg({ history_cursor: 12 }), 12);
  for (const bad of [-1, 1.5, '3', null, 2 ** 63]) assert.throws(() => historyCursorArg({ history_cursor: bad }), /non-negative integer/);
});

test('respondWithProject lleva el proyecto, la procedencia y las advertencias', () => {
  const plain = body(respondWithProject({ project: 'p', source: 'git_root', path: '/r' }, 'hola'));
  assert.deepEqual(plain, { project: 'p', project_source: 'git_root', project_path: '/r', result: 'hola' });
  const extra = body(respondWithProject({ project: 'p', source: 's', path: '', warning: 'cuidado' }, 't', { results: [1] }));
  assert.deepEqual(extra, { project: 'p', project_source: 's', project_path: '', result: 't', warning: 'cuidado', results: [1] });
  assert.deepEqual(body(respondWithProject({}, 'x')), { project: '', project_source: '', project_path: '', result: 'x' });
});

test('errorWithMeta añade la pista que corresponde al código', () => {
  const r = errorWithMeta('unknown_project', 'no existe', ['a', 'b']);
  assert.equal(r.isError, true);
  assert.deepEqual(body(r), {
    available_projects: ['a', 'b'], error_code: 'unknown_project', message: 'no existe',
    hint: 'Use one of the available_projects values, or omit project to auto-detect.',
  });
  assert.deepEqual(body(errorWithMeta('otro_codigo', 'm')), { available_projects: null, error_code: 'otro_codigo', message: 'm' });
  for (const code of ['explicit_project_required', 'ambiguous_project', 'invalid_project_choice', 'missing_recovery_token', 'invalid_recovery_token', 'unknown_session']) {
    assert.ok(body(errorWithMeta(code, 'm')).hint, code);
  }
});

test('addErrorMetadata fusiona campos y respeta resultados que no son JSON', () => {
  const r = addErrorMetadata(errorWithMeta('x', 'm'), { extra: 1 });
  assert.equal(body(r).extra, 1);
  assert.equal(body(r).error_code, 'x');
  const notJson = textResult('texto plano');
  assert.equal(addErrorMetadata(notJson, { a: 1 }).content[0].text, 'texto plano');
  assert.equal(addErrorMetadata({ content: [] }, { a: 1 }).content.length, 0);
  const sinCambios = errorWithMeta('x', 'm');
  assert.equal(addErrorMetadata(sinCambios, {}), sinCambios);
});

const coded = (code, extra = {}) => Object.assign(new Error('detalle'), { code, ...extra });

test('writeProjectErrorResult traduce cada error a su código estructurado', () => {
  const res = { available_projects: ['uno', 'dos'], path: '/dir' };
  const expectCode = (err, code, available) => {
    const b = body(writeProjectErrorResult(null, 's', res, err));
    assert.equal(b.error_code, code);
    if (available !== undefined) assert.deepEqual(b.available_projects, available);
    return b;
  };
  expectCode(coded('explicit_project_required'), 'explicit_project_required', null);
  expectCode(coded('project_transition'), 'project_transition_conflict', ['uno', 'dos']);
  expectCode(coded('project_history_unavailable'), 'project_history_unavailable', null);
  expectCode(coded('database_generation_changed'), 'database_generation_changed', ['uno', 'dos']);
  expectCode(coded('project_ownership_ambiguous'), 'session_project_ownership_ambiguous', ['uno', 'dos']);
  assert.match(expectCode(coded('repository_binding'), 'repository_binding_unavailable', null).message, /^Cannot determine project: detalle\./);
  expectCode(coded('invalid_config'), 'invalid_project_config', ['uno', 'dos']);
  expectCode(errors.invalidProjectChoice('x', ['uno']), 'invalid_project_choice', ['uno']);
  assert.match(expectCode(errors.invalidProjectChoice('', ['uno']), 'invalid_project_choice').message, /^Project choice is empty/);
  assert.match(expectCode(errors.invalidProjectChoice('x', ['uno']), 'invalid_project_choice').message, /^Project choice "x" is not one of/);
  expectCode(errors.missingRecoveryToken('x', ['uno']), 'missing_recovery_token', ['uno']);
  expectCode(errors.invalidRecoveryToken('x', ['uno']), 'invalid_recovery_token', ['uno']);
  expectCode(errors.invalidExplicitProject('x/y', 'contains a path'), 'invalid_project', ['uno', 'dos']);
  expectCode(errors.projectNameCollision('A', 'a', ['A', 'a']), 'project_name_collision', ['uno', 'dos']);
  const unknownSession = expectCode(errors.unknownSession('zz'), 'unknown_session', ['uno', 'dos']);
  assert.equal(unknownSession.invalid_session_id, 'zz');
  assert.equal(unknownSession.retry_without_session_id, true);
  expectCode(errors.unknownProject('x', ['uno']), 'unknown_project', ['uno']);
  expectCode(errors.sessionProjectMismatch('s', 'uno', 'dos'), 'session_project_mismatch', ['uno', 'dos']);
});

test('un error de ambigüedad emite un token de recuperación solo si hay actividad registrada', (t) => {
  const res = { available_projects: ['uno', 'dos'], path: '' };
  const err = coded('ambiguous_project', { message: 'varios' });
  const sinActividad = body(writeProjectErrorResult(null, 's', res, err));
  assert.equal(sinActividad.error_code, 'ambiguous_project');
  assert.equal('recovery_token' in sinActividad, false);
  assert.equal(sinActividad.message, 'Cannot determine project: varios');
  const activity = new SessionActivity();
  const conActividad = body(writeProjectErrorResult(activity, 's', { ...res, path: '' }, err));
  assert.equal(conActividad.token_ttl_seconds, 300);
  assert.equal(typeof conActividad.recovery_token, 'string'); // vacío si el directorio no admite candidatos
  assert.equal(defaultSessionId(''), 'manual-save');
  assert.equal(defaultSessionId('p'), 'manual-save-p');
  void t;
});

test('readProjectErrorResult añade el proyecto parcial y la pista de lectura', () => {
  const res = { project: 'p', source: 'git_root', path: '/r', available_projects: ['uno'] };
  const unknown = body(readProjectErrorResult(null, res, errors.unknownProject('x', ['uno'])));
  assert.equal(unknown.error_code, 'unknown_project');
  assert.equal(unknown.message, 'Project "x" not found in store');
  assert.equal(unknown.project, 'p');
  assert.equal(unknown.project_source, 'git_root');
  assert.equal(unknown.project_path, '/r');
  const ambiguous = body(readProjectErrorResult(null, res, coded('ambiguous_project', { message: 'varios' })));
  assert.match(ambiguous.hint, /^Ask the user to choose a project, then retry the same read tool/);
  assert.equal(ambiguous.project, 'p');
});

test('serialización: prompts omiten lo vacío y las relaciones usan null en lados vacíos', () => {
  assert.deepEqual(promptJson({ id: 1, sync_id: 'a', session_id: 's', content: 'c', created_at: 't', project: '', source_inbox_id: null }), {
    id: 1, sync_id: 'a', session_id: 's', content: 'c', created_at: 't',
  });
  assert.deepEqual(promptJson({ id: 1, sync_id: 'a', session_id: 's', content: 'c', created_at: 't', project: 'p', source_inbox_id: 'i' }).project, 'p');
  const rel = { id: 1, sync_id: 'r', source_id: 'a', target_id: 'b', relation: 'related', reason: null, source_title: 'x', target_missing: true, confidence: 0.5 };
  assert.deepEqual(relationJson(rel), { id: 1, sync_id: 'r', source_id: 'a', target_id: 'b', relation: 'related', confidence: 0.5 });
  assert.deepEqual(relationsJson({ as_source: [], as_target: [rel] }), { as_source: null, as_target: [relationJson(rel)] });
  assert.equal(jsonMarshal(relationsJson({ as_source: [], as_target: [] })), '{"as_source":null,"as_target":null}');
});
