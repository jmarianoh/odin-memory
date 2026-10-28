# 03 — Entorno y dependencias

## Runtime

- Node.js **≥ 24** (`engines` en `package.json`; `bin/odin.js` lo comprueba al arrancar).
- `node:sqlite` es nativo; incluye FTS5 con tokenizador `trigram`.
- Node emite una advertencia experimental al cargar `node:sqlite`; la CLI y el servidor MCP la silencian con `process.removeAllListeners('warning')` solo para esa advertencia.

## Registro npm (Nexus)

Copia `.npmrc.example` a `.npmrc` y sustituye `<HOST_NEXUS>` y `<GRUPO_NPM>`. No se versiona `.npmrc`.

## Dependencias

Todas con versión **exacta** (sin `^` ni `~`). Se incorporan por fases:

| Paquete | Fase | Uso |
|---|---|---|
| `@modelcontextprotocol/sdk` | F3 | Servidor MCP |
| `pg` | F9 | Cliente Postgres de Cloud |
| `ink`, `react`, `htm` | F8 | TUI (`htm` evita JSX) |
| `htmx.org`, `@picocss/pico` | F9 | Se copian a `static/`; no se cargan desde CDN |

Las versiones exactas se fijan al incorporar cada paquete y se anotan aquí. Hasta entonces `package.json` no declara dependencias.

## Verificación del entorno

```bash
node --version                      # v24.x
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec(\"create virtual table t using fts5(a, tokenize='trigram')\");console.log('fts5 ok')"
```
