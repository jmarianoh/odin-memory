import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const fixture = JSON.parse(readFileSync(new URL('../../contract/fixtures/sqlite-schema.json', import.meta.url), 'utf8'));
const normalize = (sql) => sql.replace(/\s+/g, '').toLowerCase();

test('el esquema creado coincide objeto por objeto con el contrato', (t) => {
  const store = openTempStore(t);
  const actual = store.db.all(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  const byKey = (o) => `${o.type}:${o.name}`;
  const actualMap = new Map(actual.map((o) => [byKey(o), o]));
  const expectedMap = new Map(fixture.objects.map((o) => [byKey(o), o]));

  assert.deepEqual([...actualMap.keys()].sort(), [...expectedMap.keys()].sort());
  for (const [key, expected] of expectedMap) {
    const got = actualMap.get(key);
    assert.equal(got.tbl_name, expected.tbl_name, `${key}: tbl_name`);
    assert.equal(normalize(got.sql), normalize(expected.sql), `${key}: sql`);
  }
});

test('user_version queda en la versión del esquema', (t) => {
  const store = openTempStore(t);
  assert.equal(store.db.get('PRAGMA user_version').user_version, SCHEMA_VERSION);
  assert.equal(fixture.user_version, SCHEMA_VERSION);
});

test('las columnas de observations conservan el orden del contrato', (t) => {
  const store = openTempStore(t);
  const cols = store.db.all('PRAGMA table_info(observations)').map((c) => c.name);
  assert.deepEqual(cols, [
    'id', 'sync_id', 'session_id', 'type', 'title', 'content', 'tool_name', 'project', 'scope',
    'topic_key', 'normalized_hash', 'revision_count', 'duplicate_count', 'last_seen_at', 'pinned',
    'created_at', 'updated_at', 'deleted_at', 'review_after', 'superseded_by_sync_id', 'expires_at',
    'embedding', 'embedding_model', 'embedding_created_at',
  ]);
});
