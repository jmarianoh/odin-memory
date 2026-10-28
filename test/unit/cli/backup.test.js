import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addObservation } from '../../../src/store/observations.js';
import { addPrompt } from '../../../src/store/prompts.js';
import { createSession } from '../../../src/store/sessions.js';
import { cliWorld } from './helpers.js';

function seed(world) {
  const store = world.store();
  createSession(store, 's1', 'mi-repo', '/tmp/a');
  addObservation(store, { session_id: 's1', type: 'decision', title: 'Con <html> & más', content: 'contenido <b>negrita</b> & ampersand', project: 'mi-repo', scope: 'project' });
  addObservation(store, { session_id: 's1', type: 'manual', title: 'Segunda', content: 'otra nota', project: 'mi-repo', scope: 'personal', topic_key: 'notas/una' });
  addPrompt(store, { session_id: 's1', content: 'un prompt', project: 'mi-repo' });
  store.close();
}

test('export escribe la copia en el archivo por defecto y resume los totales', async (t) => {
  const w = cliWorld(t);
  seed(w);
  const r = await w.odin(['export', '--all']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Exported to odin-export.json\n  Sessions:     1\n  Observations: 2\n  Prompts:      1\n');
  const text = readFileSync(join(w.repoDir, 'odin-export.json'), 'utf8');
  const data = JSON.parse(text);
  assert.equal(data.version, '0.2.0');
  assert.equal(data.observations.length, 2);
  // sangrado de dos espacios, sin salto final y con el escape de HTML del formato
  assert.ok(text.startsWith('{\n  "version": "0.2.0",\n'));
  assert.ok(!text.endsWith('\n'));
  assert.ok(text.includes('Con \\u003chtml\\u003e \\u0026 más'));
});

test('export admite archivo y proyecto, y rechaza proyectos desconocidos', async (t) => {
  const w = cliWorld(t);
  seed(w);
  const named = await w.odin(['export', 'copia.json', '--project', 'mi-repo']);
  assert.equal(named.out, 'Exported to copia.json\n  Sessions:     1\n  Observations: 2\n  Prompts:      1\n');
  assert.ok(existsSync(join(w.repoDir, 'copia.json')));
  const implicit = await w.odin(['export', 'implicita.json']);
  assert.equal(implicit.code, 0);
  const unknown = await w.odin(['export', 'x.json', '--project', 'no-existe']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /^odin: .*no-existe/);
  assert.equal((await w.odin(['export', 'x.json', '--project'])).err, 'odin: --project requires a non-empty value\n');
  const bad = await w.odin(['export', join(w.root, 'no', 'existe', 'x.json'), '--all']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^odin: write .*x\.json: open .*x\.json: no such file or directory\n$/);
});

test('la ayuda de export e import no abre el almacén', async (t) => {
  const w = cliWorld(t);
  const exportHelp = await w.odin(['export', '--help']);
  assert.equal(exportHelp.code, 0);
  assert.equal(exportHelp.out, 'Usage: odin export [file.json] [--project NAME | --all]\n\nOptions:\n  --project NAME  Export one project (default: current project)\n  --all           Export every project\n  --help          Show this help\n');
  assert.equal((await w.odin(['import', 'x.json', '--help'])).out, 'Usage: odin import <file.json>\n\nOptions:\n  --help          Show this help\n');
  assert.equal(existsSync(w.dataDir), false);
});

test('import carga una copia y reimportarla no cambia nada', async (t) => {
  const source = cliWorld(t);
  seed(source);
  await source.odin(['export', 'copia.json', '--all']);
  const file = join(source.repoDir, 'copia.json');

  const target = cliWorld(t, { repo: 'otro-repo' });
  const first = await target.odin(['import', file]);
  assert.equal(first.code, 0);
  assert.equal(first.out, `Imported from ${file}\n  Sessions:     1\n  Observations: 2 imported, 0 updated, 0 skipped stale\n  Prompts:      1\n`);
  const again = await target.odin(['import', file]);
  assert.equal(again.out, `Imported from ${file}\n  Sessions:     0\n  Observations: 0 imported, 0 updated, 2 skipped stale\n  Prompts:      0\n`);
  assert.equal((await target.odin(['stats', '--all'])).out.includes('Observations: 2'), true);
});

test('import informa de archivos ausentes, ilegibles o sin formato', async (t) => {
  const w = cliWorld(t);
  assert.equal((await w.odin(['import'])).err, 'usage: odin import <file.json>\n');
  const missing = await w.odin(['import', join(w.root, 'nada.json')]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^odin: read .*nada\.json: open .*nada\.json: no such file or directory\n$/);
  const bad = join(w.root, 'malo.json');
  writeFileSync(bad, '{ no es json');
  const parse = await w.odin(['import', bad]);
  assert.equal(parse.code, 1);
  assert.match(parse.err, /^odin: parse .*malo\.json: /);
  const wrongType = join(w.root, 'tipo.json');
  writeFileSync(wrongType, '{"version":"0.2.0","sessions":"no es una lista"}');
  assert.equal((await w.odin(['import', wrongType])).code, 1);
});
