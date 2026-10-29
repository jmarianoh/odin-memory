# 03 — Entorno y dependencias

## Runtime

- Node.js **≥ 24** (`engines` en `package.json`; `bin/odin.js` lo comprueba al arrancar).
- `node:sqlite` es nativo; incluye FTS5 con tokenizador `trigram`.
- Node emite una advertencia experimental al cargar `node:sqlite`. `bin/odin.js` la descarta con `silenceSqliteWarning()` (`src/runtime/warnings.js`), que filtra solo esa advertencia y deja pasar las demás.

## Registro npm (Nexus)

Copia `.npmrc.example` a `.npmrc` y sustituye `<HOST_NEXUS>` y `<GRUPO_NPM>`. No se versiona `.npmrc`.

## Dependencias

Todas con versión **exacta** (sin `^` ni `~`). Se incorporan por fases:

| Paquete | Fase | Uso |
|---|---|---|
| `pg` | F9.1 | Cliente Postgres del servidor de la nube (solo se carga con `odin cloud serve`) |
| `embedded-postgres` (desarrollo) | F9.1 | Postgres real y desechable para las pruebas de la nube |
| `ink`, `react`, `htm` | F8 | TUI (`htm` evita JSX) |
| `htmx.org`, `@picocss/pico` | F9.3 | Panel web; el servidor los sirve desde `node_modules` (no hay CDN) |

El servidor MCP (F3) **no** usa ningún SDK: el protocolo se implementa a mano (`12-mcp/README.md`).

Las versiones exactas se fijan al incorporar cada paquete y se anotan aquí:

| Paquete | Versión | Fase |
|---|---|---|
| `ink` | 8.0.0 | F8 |
| `react` | 19.3.1 | F8 |
| `htm` | 3.1.1 | F8 |
| `pg` | 8.23.1 | F9.1 |
| `embedded-postgres` (`devDependencies`) | 18.4.0-beta.17 | F9.1 |
| `htmx.org` | 2.0.8 | F9.3 |
| `@picocss/pico` | 2.1.1 | F9.3 |

`package-lock.json` se versiona. `embedded-postgres` instala un binario por plataforma (`@embedded-postgres/<plataforma>`) cuyo `postinstall` (`node scripts/hydrate-symlinks.js`) hay que ejecutar a mano si npm no lo lanza; detalles y alternativa (`ODIN_TEST_DATABASE_URL`) en `30-cloud/README.md`. No hay más dependencias.

## Verificación del entorno

```bash
node --version                      # v24.x
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec(\"create virtual table t using fts5(a, tokenize='trigram')\");console.log('fts5 ok')"
```

## Versión del producto

`src/version/index.js` exporta `VERSION` (la `version` de `package.json`, leída al cargar), `MIN_NODE_MAJOR` (24) y `nodeIsSupported(versión = process.versions.node)` (el mayor es ≥ 24).
