# odin-memory

Memoria persistente para GitHub Copilot (VS Code y Copilot CLI).

Un agente de IA olvida todo al terminar la sesión. odin-memory le da una memoria local, buscable y compartible:

```
Copilot (VS Code / Copilot CLI)
    ↓ MCP stdio
odin (Node.js ≥ 24)
    ↓
SQLite + FTS5 (~/.odin-memory/odin.db)
```

- **Servidor MCP** con herramientas `mem_*` (guardar, buscar, contexto, sesiones, revisión, conflictos).
- **CLI** `odin` y **API HTTP local** (puerto 7438).
- **Git Sync**: chunks comprimidos para compartir memoria entre máquinas.
- **Doctor** y **self-tests** de diagnóstico.
- **TUI** para explorar lo que el agente recuerda.
- **Cloud** opcional: réplica y acceso compartido con dashboard web.

## Requisitos

Node.js 24 o superior. No requiere compilar módulos nativos: usa `node:sqlite`.

## Uso rápido

```bash
npm install
node bin/odin.js version
npm test
```

## Estado

En construcción por fases. El plan y la especificación para reconstruir el proyecto desde cero están en [`implementacion/`](implementacion/README.md).

## Licencia

MIT. Ver [LICENSE](LICENSE).
