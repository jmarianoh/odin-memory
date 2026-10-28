# 20 — Autopruebas y comprobación de versión

## Qué cubre este capítulo

La entrega F6.3 (spec 0.20.0) añade `odin test`, unas autopruebas aisladas que verifican en el equipo del usuario que el almacén guarda, busca y soporta escrituras simultáneas, y mide el rendimiento de la búsqueda. Incluye también la comprobación de nueva versión al arrancar.

| Pieza | Dónde |
|---|---|
| Ejecutor y forma del informe | `src/selftest/index.js` |
| Escenarios | `src/selftest/scenarios.js` |
| Hilo que escribe en la prueba de concurrencia | `src/selftest/worker.js` |
| Comando | `src/cli/commands/selftest.js` |
| Comprobación de versión | `src/version/check.js` |

## `odin test [reliability|performance] [--quick] [--json]`

- Se despacha **antes** de resolver la configuración, de comprobar versión y de abrir ningún almacén: nunca lee el directorio de datos del usuario ni la configuración de la nube. Cada ejecución crea un directorio temporal propio (`odin-self-test-*`), que borra al terminar (un fallo al borrar se ignora).
- Código de salida: `0` correcto, `1` error de uso, `2` algún escenario falló.
- Argumentos: `--quick`, `--json`, `--help`/`-h`/`help`, y como máximo **una** suite (`all`, `reliability`, `performance`; sin distinguir mayúsculas ni espacios). Un argumento que empieza por `-` y no es conocido: `unknown test flag "x"`; una segunda suite: `only one test suite may be selected`; una suite desconocida: `unknown test suite "x"`. Un error de uso imprime `error: <mensaje>` y una línea en blanco por el error estándar y después el uso por la salida estándar.

Uso (salida estándar):

```
usage: odin test [reliability|performance] [--quick] [--json]

Run isolated local reliability and performance self-tests.
Without a suite, runs reliability and performance. --quick bounds the smoke run.
--json writes the stable odin-self-test/v1 report to stdout.
The test uses a fresh temporary directory and never reads configured data or cloud settings.
```

### Informe

`--json` escribe en una línea (con los escapes HTML habituales) y salto de línea final:

```
{ schema_version: "odin-self-test/v1", suite, quick, passed, duration_ms, scenarios[] }
Scenario { name, suite, passed, duration_ms, error?, metrics? }   // metrics: { operations, throughput_ops_per_second }
```

Sin `--json`:

```
Odin self-test (<suite> suite, <quick|full> mode)
PASS  <suite>/<name>  <ms>ms[  <N> operations][  <X.X> ops/s][  <error>]
Result: <PASS|FAIL> (<ms>ms)
```

(`FAIL` en lugar de `PASS` para un escenario que falló, con su error al final; las operaciones sin decimales y el rendimiento con uno.)

`runSelfTest(options, hooks)` devuelve el informe; la suite desconocida no ejecuta nada (la CLI nunca la deja llegar). Si no se puede crear el directorio temporal, el informe lleva un único escenario `setup` fallido (`create temporary directory: <causa>`). Un escenario que lanza error queda como fallido con su mensaje y **no** detiene a los demás. Ganchos de prueba: `makeTempDir`, `removeDir`, `scenarios` (sustituye cualquier escenario).

### Escenarios

| Suite | Nombre | Qué hace |
|---|---|---|
| `reliability` | `database_save_search_context` | Crea sesión `selftest-reliability-session` en el proyecto `selftest-reliability`, guarda una decisión «Self-test database migration», la busca con `database migration` (proyecto, ámbito `project`, límite 5; la primera debe ser esa) y comprueba que `formatContext` la incluye |
| `reliability` | `concurrent_local_writes` | **Hilos reales** (`worker_threads`), cada uno con su conexión: 8 hilos × 50 escrituras (`--quick`: 4 × 10) de tipo `note` en el proyecto `selftest-concurrent`, cada hilo en su sesión. Al terminar, el total de observaciones debe ser exactamente hilos × escrituras. Un fallo de un hilo es `concurrent write: <causa>` |
| `performance` | `store_search` | Siembra 1000 registros (`--quick`: 100) y hace 200 búsquedas (`--quick`: 20) de `shared keyword` con límite 20; cada una debe devolver resultados. Métricas: `operations` y `throughput_ops_per_second` (0 si la duración es 0). **Ningún umbral de tiempo decide el resultado** |

Los títulos son `Concurrent local write <hilo>-<n>` y `Self-test search record <NNNN>` (cuatro dígitos); el contenido, `Self-test concurrent local write <hilo>-<n>` y `Self-test search corpus shared keyword record <NNNN>`.

El hilo (`worker.js`) abre el almacén del mismo directorio, escribe sus observaciones y responde `{ ok: true }` o `{ error }`; el almacén reintenta por sí solo ante bloqueos de SQLite.

## Comprobación de versión (`src/version/check.js`)

Al arrancar, los comandos que no son de larga duración avisan por el **error estándar** si hay una versión nueva. Para trabajar sin red por defecto y en un entorno cerrado, **solo se hace si `ODIN_UPDATE_CHECK_URL` está definida**: debe apuntar a un servicio que responda `GET` con `{"tag_name": "vX.Y.Z"}` (el formato de la API de versiones de GitHub). Sin esa variable no hay red ni mensaje.

- `ODIN_NO_UPDATE_CHECK` (`1`, `true`, `yes`, `on`; sin distinguir mayúsculas) la desactiva.
- `ODIN_UPDATE_TOKEN` (opcional) se envía como `Authorization: Bearer <token>`. La petición lleva `Accept: application/json` y un plazo de **2 s**.
- `checkLatest(actual, { env, fetch, timeoutMs })` devuelve `{ status, message? }`:
  - Desactivada o sin URL: `status ''` y sin mensaje.
  - Versión actual vacía, `dev` o que no sea de la forma `X.Y.Z`: `check_failed` con `Could not check for updates: current version is unknown.` / `development builds do not map to a release version.` / `current version does not map to a plain release version.`
  - Fallos: tiempo agotado `…the release server took too long to respond.`; red `Could not check for updates: <causa>.`; estado distinto de 200 `…the release server returned <código> <texto>.` (con ` Set ODIN_UPDATE_TOKEN to authenticate.` si es 401 o 403); cuerpo ilegible `…could not read the release server response.`; sin versión válida `…the release server did not return a release version.`
  - Misma versión o más antigua: `up_to_date`. Más nueva: `update_available` con `Update available: <actual> -> <nueva>\nTo update:\n  npm install -g odin-memory@latest`.
- Una versión «plana» son exactamente tres números sin ceros a la izquierda ni sufijos y dentro del rango entero seguro; el prefijo `v` se ignora. La comparación es numérica por componentes.
- `shouldCheckForUpdates(args)`: no comprueban `mcp`, `serve`, `protocol-mode`, `tui`, `doctor`, `version`, `--version`, `-v`, `help`, `--help`, `-h`, `init`, `hook`, `test` ni `cloud serve`; sí el resto.
- La CLI imprime el mensaje (salvo si es `up_to_date` o vacío) seguido de una línea en blanco. Gancho de prueba: `Cli.checkForUpdates(versión)`.

## Criterios de aceptación

```bash
node --test test/unit/selftest/*.test.js test/unit/cli/selftest.test.js test/unit/version-check.test.js
node bin/odin.js test --quick
npm test
```
