# 12.4 — Vínculo con el proceso anfitrión

Módulo: `src/hostbind/index.js`.

El anfitrión (el agente que lanza el servidor MCP) y sus hooks son procesos hermanos. Un hook puede ser cancelado y un servidor MCP no se reinicia cuando cambia la sesión (`/clear`, reanudar, bifurcar). Por eso los hooks **publican** «proceso anfitrión → sesión que atiende» y el servidor lo **lee** a través de su propio proceso padre cuando una escritura omite `session_id` (`resolveHostBoundSession`, `12-mcp/03`).

Un vínculo nunca crea ni elige una identidad: registra la sesión que el propio anfitrión comunicó y solo vale mientras el proceso que lo publicó siga siendo el mismo (PID más hora de arranque). Cualquier vínculo ausente, ilegible u obsoleto significa «sin vínculo».

## API

- `NoProcessError` (`message = 'hostbind: no such process'`): el PID no corresponde a un proceso en ejecución.
- `processStart(pid)` → cadena opaca que cambia si el PID se reutiliza:
  - Linux: campo 22 (`starttime`) de `/proc/<pid>/stat`, contando los campos **desde el último `)`** (el nombre del comando puede contener espacios o paréntesis); menos de 20 campos tras él → error de formato. Archivo inexistente → `NoProcessError`.
  - Windows: `powershell.exe -NoProfile -NonInteractive -Command "(Get-Process -Id <pid> -ErrorAction Stop).StartTime.ToUniversalTime().Ticks"` (tiempo máximo 5 s); salida vacía o código de salida → `NoProcessError`.
  - Resto (macOS…): `ps -o lstart= -p <pid>` con `LC_ALL=C` (tiempo máximo 5 s); salida vacía o código de salida distinto de cero → `NoProcessError`.
- `publish(dataDir, pid, sessionId, { processStart?, now? })`: exige `dataDir` no vacío, `pid` entero > 1 y `sessionId` no vacío tras recortar (si no, `hostbind: data directory, host pid, and session id are required`). Obtiene la señal de arranque (un PID inexistente lanza `NoProcessError`), crea `<dataDir>/host-sessions/` (modo 0700) y escribe de forma **atómica** (archivo temporal `.bind-…` con modo 0600 y `rename`) `<pid>.json` con `{"pid":…,"start":"…","session_id":"…","updated_at":"<ISO-8601 UTC sin milisegundos>"}`. Después poda (mejor esfuerzo) los vínculos de otros PID cuya señal de arranque ya no coincide o cuyo proceso no existe; si la identidad no se puede determinar, conserva el archivo.
- `lookup(dataDir, pid, { processStart? })` → la sesión vinculada o `null`: `null` si faltan datos, no hay archivo, no es JSON, `pid` del archivo distinto, `session_id` vacío, falta `start`, o la señal de arranque actual difiere (o no se puede calcular).

Los hooks de Copilot (F7) llaman a `publish` con el PID del proceso anfitrión; el servidor usa `process.ppid`.

## Pruebas

`test/unit/hostbind/hostbind.test.js` (con procesos simulados mediante `processStart` inyectado).
