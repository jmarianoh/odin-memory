# Seguimiento de engram

| Fecha | Origen | Spec `implementacion/` | Notas |
|---|---|---|---|
| 2026-10-27 | v3.6.0 (`ee1d5ad`) | 0.1.0 | Punto de partida: se fija la versión base |
| 2026-11-06 | v3.6.2 (`ec2bf04`) | 0.32.0 | Portado: FTS con `remove_diacritics` (+ índices de proyecto), marcas de tiempo de la aplicación en borrados/ediciones, guarda de restauración local, sesiones `project_owned` aisladas en el diario y en `cloud upgrade`, escaneo semántico que omite pares ilegibles, `mem_save_prompt` con `directory`/`cwd`, pie de `mem_context` por proyecto. No aplica: identidad del servidor local de los hooks de Claude (`hook_local_server.go`, `hook_claude.go`), cuarentena paginada de autosync (`QuarantineIrreparableSyncMutationsPage`; el `#push` de odin no ejecuta cuarentena), refresco incremental del panel (`dashboard_project_refresh.go`), `internal/setup/setup.go` (paquete Pi y texto de protocolo, este ya en odin). Conformidad con v3.6.2: 130/131; el fallo (`store-context`: el historial antiguo mide 954 B < 1100 B) depende de la fecha del dataset y ya fallaba antes del port. Sala limpia: 225 archivos, 201 módulos, 118 tests, 26 variables `ODIN_*` |
