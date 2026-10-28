# 00 — Visión y alcance

## Qué es

odin-memory es un sistema de **memoria persistente para el agente GitHub Copilot**, tanto en VS Code (agent mode) como en Copilot CLI. El agente guarda decisiones, hallazgos y correcciones durante una sesión y los recupera en sesiones posteriores, aunque cambie el contexto o se compacte la conversación.

Principios:
- **Local primero.** La base SQLite local es la fuente de verdad. La sincronización (Git o Cloud) es opcional.
- **Un solo proceso de usuario.** Sin servicios externos obligatorios.
- **Agnóstico de modelo, específico de agente.** Solo se integra con Copilot.
- **Sin compilación.** JavaScript ESM con JSDoc.

## Componentes

| Componente | Descripción |
|---|---|
| Store | Persistencia SQLite + FTS5: observaciones, sesiones, prompts, relaciones, alias de proyecto |
| Detección de proyecto | Resuelve el proyecto actual desde git, configuración o directorio |
| Servidor MCP | Herramientas `mem_*` por stdio |
| CLI `odin` | Comandos de uso, mantenimiento y diagnóstico |
| API HTTP local | Mismos datos por HTTP (puerto 7438) |
| Git Sync | Intercambio de memoria mediante chunks comprimidos versionables |
| Doctor / self-tests | Diagnóstico y reparación guiada; pruebas de fiabilidad y rendimiento |
| Integración Copilot | Configuración MCP, instrucciones y hooks para VS Code y Copilot CLI |
| TUI | Explorador interactivo en terminal |
| Cloud | Servidor Postgres con dashboard web, autenticación y autosincronización |

## Identidad fija

| Elemento | Valor |
|---|---|
| Binario | `odin` |
| Datos | `~/.odin-memory/odin.db` (`ODIN_DATA_DIR` lo sustituye; debe ser ruta absoluta) |
| Variables | prefijo `ODIN_` |
| Servidor MCP | `odin-memory` |
| Puerto HTTP | 7438 |
| Carpeta de sync | `.odin-memory/` |

## Fuera de alcance

Otros agentes distintos de Copilot y la exportación a bases de conocimiento externas.
