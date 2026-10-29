import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

let counter = 0;

/**
 * Un Postgres real para las pruebas: el indicado en `ODIN_TEST_DATABASE_URL` o, si no hay, uno embebido
 * y desechable. `createDatabase()` entrega un DSN a una base nueva y vacía.
 */
export async function startPostgres() {
  const external = process.env.ODIN_TEST_DATABASE_URL;
  let embedded = null;
  let dir = '';
  let admin;
  if (external) {
    admin = new pg.Client({ connectionString: external });
  } else {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = mkdtempSync(join(tmpdir(), 'odin-pg-'));
    const port = await freePort();
    embedded = new EmbeddedPostgres({ databaseDir: join(dir, 'data'), user: 'odin', password: 'odin', port, persistent: false, onLog: () => {}, onError: () => {} });
    await embedded.initialise();
    await embedded.start();
    admin = new pg.Client({ connectionString: `postgres://odin:odin@127.0.0.1:${port}/postgres` });
  }
  await admin.connect();
  const base = new URL(external ?? `postgres://odin:odin@127.0.0.1:${admin.port}/postgres`);
  const created = [];
  return {
    async createDatabase() {
      const name = `odin_t${process.pid}_${Date.now().toString(36)}_${counter++}`;
      await admin.query(`CREATE DATABASE ${name}`);
      created.push(name);
      const url = new URL(base);
      url.pathname = `/${name}`;
      return url.href;
    },
    async stop() {
      for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
      if (embedded) await embedded.stop().catch(() => {});
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
