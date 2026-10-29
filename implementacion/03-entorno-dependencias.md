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
| `pg` | F9 | Cliente Postgres de Cloud |
| `ink`, `react`, `htm` | F8 | TUI (`htm` evita JSX) |
| `htmx.org`, `@picocss/pico` | F9 | Se copian a `static/`; no se cargan desde CDN |

El servidor MCP (F3) **no** usa ningún SDK: el protocolo se implementa a mano (`12-mcp/README.md`).

Las versiones exactas se fijan al incorporar cada paquete y se anotan aquí:

| Paquete | Versión | Fase |
|---|---|---|
| `ink` | 8.0.0 | F8 |
| `react` | 19.3.1 | F8 |
| `htm` | 3.1.1 | F8 |

`package-lock.json` se versiona. Hasta F9 no hay más dependencias.

## Verificación del entorno

```bash
node --version                      # v24.x
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec(\"create virtual table t using fts5(a, tokenize='trigram')\");console.log('fts5 ok')"
```
