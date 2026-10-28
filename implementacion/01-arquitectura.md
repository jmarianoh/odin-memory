# 01 — Arquitectura

```
                 ┌────────────────────────────────────────────┐
 Copilot ──MCP──▶│ src/mcp   (herramientas mem_*)             │
 hooks ──HTTP──▶ │ src/server (API HTTP local)                │
 usuario ──CLI─▶ │ src/cli   (comandos odin)                  │
                 └───────────────┬────────────────────────────┘
                                 ▼
                 ┌────────────────────────────────────────────┐
                 │ src/store  (node:sqlite + FTS5)            │◀── src/project
                 └───────┬──────────────┬─────────────────────┘
                         ▼              ▼
                  src/sync (Git)   src/cloud (Postgres, dashboard, autosync)
```

## Módulos de `src/`

| Directorio | Responsabilidad |
|---|---|
| `store/` | Esquema, migraciones, operaciones de memoria, búsqueda, relaciones, contexto |
| `project/` | Detección y canonicalización del nombre de proyecto |
| `mcp/` | Servidor MCP, perfiles de herramientas, instrucciones |
| `server/` | Router HTTP, autenticación, contrato de runtime |
| `sync/` | Manifest y chunks de Git Sync |
| `diagnostic/` | Checks de doctor y reparaciones |
| `llm/` | Ejecución de comparaciones semánticas mediante `copilot -p` |
| `selftest/` | Pruebas de fiabilidad y rendimiento sobre un directorio temporal |
| `setup/` | Instaladores de configuración para Copilot |
| `hooks/` | Manejadores de hooks de Copilot |
| `tui/` | Interfaz de terminal |
| `cloud/` | Servidor, store Postgres, autenticación, dashboard y autosync |
| `cli/` | Un módulo por comando |
| `version/` | Versión del producto y comprobación de runtime |

## Reglas de dependencia

- `store/` no importa `mcp/`, `server/`, `cli/` ni `tui/`.
- `mcp/`, `server/` y `cli/` consumen `store/` y `project/`; nunca se importan entre sí.
- `cloud/` depende de `store/` y `sync/`; `store/` no conoce `cloud/`.
- Ningún módulo lee `process.env` directamente salvo `cli/` y `bin/`: la configuración se pasa por parámetro.
