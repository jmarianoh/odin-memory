# 19 — Interfaz de terminal (TUI)

## Qué cubre este capítulo

`odin tui` abre una interfaz de terminal para buscar, leer y administrar la memoria sin recordar comandos. La entrega F8 (spec 0.23.0) trajo nueve pantallas: panel, búsqueda, resultados, recientes, detalle de observación, cronología, sesiones, detalle de sesión y preparación de Copilot. La entrega F9.4 (spec 0.31.0) añade cuatro de sincronización con la nube: menú de la nube, configuración del servidor, estado e inscripción de proyectos (sección «Sincronización con la nube»).

La TUI se construye con **Ink** (React para terminal) y **htm** (plantillas sin JSX) y sigue la arquitectura de Elm: toda la lógica vive en una función pura `update(estado, mensaje)` que se prueba sin terminal; la vista y la ejecución de comandos son capas finas.

## Dependencias (versiones exactas)

| Paquete | Versión | Uso |
|---|---|---|
| `ink` | 8.0.0 | Renderizado a terminal, entrada de teclado (`useInput`), salida (`useApp`) |
| `react` | 19.3.1 | Requerido por Ink (`peerDependency >=19.3.0`) |
| `htm` | 3.1.1 | Plantillas con etiquetas sin compilación (`htm.bind(React.createElement)`) |

Se instalan con `npm install --save-exact ink@8.0.0 react@19.3.1 htm@3.1.1` (en el entorno cerrado, desde el Nexus; `package.json` y `package-lock.json` fijan las versiones). Ink 8 exige Node ≥ 22.

## Archivos (`src/tui/`)

| Archivo | Contenido |
|---|---|
| `model.js` | `SCREEN`, `initialState`, `initialCommands`, `update`, `DASHBOARD_MENU`, `CLOUD_SETTINGS_MENU`, `CLOUD_CONFIG_FOCUS`, `CLOUD_CONFIG_ACTIONS`, `detailMetadata`, `detailContentLines`, `detailLayout`, `timelineRows`, `timelineViewport`, `visibleItems`, `sessionDeleteErrorMessage` |
| `text-input.js` | Campo de texto inmutable: `newTextInput`, `updateTextInput`, `inputView`, `setValue`, `focus`/`blur`, `inputValue`, `sanitizeInput` |
| `format.js` | `truncateStr`, `formatReviewDate`, `localTime`, `wrapLines`, `osc52Sequence` |
| `commands.js` | `executeCommand(cmd, ctx)`, `setupAgents(ctx)`, `LIST_LIMIT` |
| `cloud.js` | `pingCloudServer`, `loadCloudSettings`, `saveCloudServerUrl`, `loadCloudStatus`, `listCloudEnrollment`, `toggleCloudEnrollment`, `PING_STATUS`, `CLOUD_HEALTH_PATH`, `CLOUD_PING_TIMEOUT_MS` |
| `keys.js` | `keyName(input, key)`: evento de Ink → nombre de tecla |
| `palette.js` | `COLORS` y `LOGO_GRADIENT` |
| `view.js` | `View({ state })`: un componente por pantalla |
| `app.js` | `App` (estado, teclado, comandos, temporizadores) y `runTui(context)` |
| `../cli/commands/tui.js` | `cmdTui` |

## `odin tui`

- Se despacha como comando con almacén. Si la entrada o la salida no son un terminal interactivo: `odin: the tui needs an interactive terminal` (código 1). Un fallo al abrir el almacén o dentro de la TUI se informa con `odin: <mensaje>` (código 1); el almacén se cierra siempre.
- `Cli.runTui(context)` sustituye a `runTui` en las pruebas; recibe `{ store, version, env, home, cwd }`.
- `runTui` entra en la pantalla alternativa (`ESC [ ? 1049 h`) y la deja al salir (`l`), y monta Ink con `exitOnCtrlC: false` y `patchConsole: false` (Ctrl+C lo trata el modelo).

## Mensajes y comandos

`update(estado, mensaje, deps)` devuelve `{ state, cmds }`. Los **mensajes** son `{ type: 'key', key, input }`, `size`, y los resultados `stats`, `search-results`, `recent-observations`, `observation-detail`, `timeline`, `recent-sessions`, `session-observations`, `session-deleted`, `setup-installed`, `cloud-config-loaded`, `cloud-status-loaded`, `cloud-enrollment-loaded`, `cloud-enrollment-toggled`, `cloud-ping`, `cloud-url-saved`, `update-check`, `clipboard-copied`, `clipboard-clear`, `spinner-tick`. Los resultados con `error` solo ponen `errorMsg` (la pantalla no cambia). Cualquier tecla limpia `errorMsg`.

Los **comandos** son descripciones que ejecuta `app.js`: `quit`, `print` (escribe en la salida), `clear-feedback` (temporizador), y los de `commands.js`:

| Comando | Efecto | Mensaje de respuesta |
|---|---|---|
| `load-stats` | `stats(store)` | `stats` |
| `check-update` | `checkLatest(versión, { env })` (opt-in, ver `20-selftest.md`) | `update-check` |
| `search` | `searchObservations(consulta, { limit: 50 })` | `search-results` |
| `load-recent` | `allObservations('', '', 50)` | `recent-observations` |
| `load-detail` | `getObservation(id)`; si no existe `observation #N not found` | `observation-detail` |
| `load-timeline` | `timeline(id, 10, 10)` | `timeline` |
| `load-sessions` | `allSessions('', 50)` | `recent-sessions` |
| `load-session-observations` | `sessionObservations(id, 200)` | `session-observations` |
| `delete-session` | `deleteSession(id)` | `session-deleted` (con `error` si falla) |
| `install` | `setupClient(destino, …)` (ver `21-copilot-vscode.md`) | `setup-installed` (`{ agent, changes }`) |
| `load-cloud-config` (`generation`) | `loadCloudSettings(datos, env)` | `cloud-config-loaded` (`serverUrl`, `tokenSource`) |
| `load-cloud-status` (`generation`) | `loadCloudStatus(almacén, env)` | `cloud-status-loaded` (`serverUrl`, `lastSync`, `pendingCount`, `lastError`) |
| `load-cloud-enrollment` | `listCloudEnrollment(almacén)` | `cloud-enrollment-loaded` (`items`) |
| `toggle-cloud-enrollment` (`item`) | `toggleCloudEnrollment(almacén, item)` | `cloud-enrollment-toggled` |
| `save-cloud-url` (`serverUrl`) | `saveCloudServerUrl(datos, url)` | `cloud-url-saved` |
| `ping-cloud` (`origin`, `generation`, `serverUrl`) | `pingCloudServer(url, token, ctx.fetch)` con el token efectivo | `cloud-ping` (`origin`, `generation`, `serverUrl`, `status`, `error`) |
| `copy` | `osc52Sequence(contenido)` | `clipboard-copied` |

Todo error del almacén vuelve como mensaje con `error`, nunca se propaga. Al arrancar se lanzan `load-stats` y `check-update`; `App` pide el tamaño del terminal y lo actualiza con el evento `resize`.

## Teclas

`keyName` produce `up`, `down`, `left`, `right`, `enter`, `esc`, `backspace`, `delete`, `tab`, `shift+tab`, `home`, `end`, `ctrl+<letra>`, `alt+<letra>` o el propio texto (varios caracteres si se pegó). `ctrl+c` sale desde cualquier pantalla, también con el campo de búsqueda activo.

| Pantalla | Teclas |
|---|---|
| Panel | `j`/`k`/flechas mueven; `enter` o espacio eligen; `s` o `/` buscan; `q` sale |
| Búsqueda (campo activo) | texto, `←`/`→`, `home`/`end`, `backspace`, `delete`, `ctrl+a/e/b/f/h/d/u/k/w`, `alt+d`; `enter` busca (vacío no hace nada); `esc` vuelve al panel |
| Búsqueda (campo inactivo) | `i` o `/` activan el campo; `esc`/`q` vuelven al panel |
| Resultados | `j`/`k` con ventana; `enter` detalle; `c` copiar; `t` cronología; `/` o `s` nueva búsqueda; `esc`/`q` vuelven a la búsqueda (vacía) |
| Recientes | como los resultados; `esc`/`q` vuelven al panel recargando las estadísticas |
| Detalle | `j`/`k` desplazan (acotado a la ventana); `c` copiar; `t` cronología; `esc`/`q` vuelven a la pantalla de origen recargándola |
| Cronología | `j`/`k` desplazan (acotado); `esc`/`q` vuelven al origen recargándolo |
| Sesiones | `j`/`k`; `enter` abre; `d` pide confirmar; con la confirmación: `y`/`Y` borra, `n`/`N`/`esc` cancela (el resto se ignora); mientras borra se ignoran las teclas; `esc`/`q` vuelven al panel |
| Detalle de sesión | como una lista; `esc`/`q` vuelven a la lista con la sesión elegida seleccionada |
| Menú de la nube | `j`/`k`/flechas; `enter`/espacio eligen (`Configure server`, `View status`, `Enroll projects`, `Back`); `esc`/`q` vuelven al panel recargando las estadísticas |
| Configuración (campo activo) | texto y edición como en la búsqueda (`q`, `j`… se escriben); `tab` pasa a «Test connection», `shift+tab` a «Cancel»; `enter` pasa a «Test connection»; `esc` vuelve al menú sin descartar lo escrito |
| Configuración (campo inactivo) | `tab`/`j`/`↓` siguiente y `shift+tab`/`k`/`↑` anterior (cíclico: campo → probar → guardar → cancelar); `i` activa el campo; `enter`/espacio: sobre el campo lo activa, sobre «Cancel» vuelve, sobre «Test connection»/«Save server» comprueba; `esc`/`q` vuelven; mientras comprueba se ignora todo |
| Estado de la nube | `r` actualiza; `esc`/`q` vuelven al menú (con el cursor en `View status`) |
| Inscripción | `j`/`k`; `enter`/espacio alterna el proyecto (ignorado mientras carga); `r` recarga; `esc`/`q` vuelven al menú (cursor en `Enroll projects`) |
| Preparación | `j`/`k`; `enter` instala el destino elegido; mientras instala se ignora todo; al terminar `enter`/`esc`/`q` vuelven al panel; `esc`/`q` vuelven antes de elegir |

### Listas y ventanas

Las listas muestran elementos de **dos líneas** (identificador, tipo, insignias, título, proyecto y fecha; debajo un extracto de 80 caracteres). Elementos visibles: `max(3, ⌊(alto − marco) / 2⌋)` con marco 10 en resultados, 8 en recientes y 12 en el detalle de sesión; en sesiones (una línea) `max(5, alto − 8)`. El cursor arrastra la ventana (`scroll`) al salir por abajo o por arriba, y se muestra `showing a-b of n` cuando no cabe todo. Una lista vacía muestra su mensaje (`No memories found. Try a different query.`, `No observations yet.`, `No sessions yet.`).

### Detalle de una observación

Metadatos (en este orden, con los tres últimos solo si existen): `Type`, `Title`, `Session`, `Created` (hora local, `ODIN_TIMEZONE`), `State` (`active` o `needs_review`, que sale en amarillo), `Pinned`, `Review` (`YYYY-MM-DD`), `Tool`, `Project`. El contenido se parte con `wrapLines` a `ancho − 8` (20 si no se conoce el ancho; mínimo 1).

Disposición vertical, de arriba abajo: relleno (1), cabecera (3: título, regla y margen), `n` metadatos, línea en blanco, `Content`, ventana de contenido, indicador `line a-b of N` (solo si hay desbordamiento), ayuda (2: margen y texto) y relleno (1) → marco fijo = `n + 10`. La ventana es `alto − (n + 10)`; en una terminal baja se quitan metadatos **del final** hasta que quede al menos una línea de contenido. Sin alto conocido la ventana es 5. Una prueba comprueba que ninguna pantalla supera la altura del terminal.

### Cronología

`timelineRows` produce, en orden: la sesión (`Session: <id>  Project: <p>`), `Before` con sus entradas y un conector, las dos filas de la observación enfocada (`▌ #id [tipo]  título` y `▌ contenido` recortado a 120), un conector y `After` con sus entradas. Se muestran `alto − 7` filas (mínimo 3; 30 sin alto) desde `scroll`, acotado.

## Portapapeles

`c` emite la secuencia OSC 52 `ESC ] 52 ; c ; <base64> BEL` por la salida (el terminal la copia al portapapeles) y muestra `✓ Copied!` durante 2 s. No hay lectura del portapapeles del sistema: un pegado llega al campo de texto como texto de varios caracteres.

## Estética

Paleta propia (`palette.js`): texto `#e6e8ef`, atenuado `#8b93a7`, bordes `#4b5263`, acento `#7aa2f7`, verde `#9ece6a`, melocotón `#ff9e64`, rojo `#f7768e`, amarillo `#e0af68`, turquesa `#73daca`, malva `#bb9af7`, cian `#7dcfff`. El logotipo «ODIN» lleva un degradado de cinco tonos y marco doble; las estadísticas van en una tarjeta con borde simple; el campo de búsqueda con borde en el acento y el cursor en vídeo inverso. El error se muestra debajo de la pantalla como `Error: <mensaje>`.

## Preparación de Copilot

Lista los destinos de `21-copilot-vscode.md` y `22-copilot-cli.md` (`VS Code Copilot — MCP server, instructions and hooks` y `Copilot CLI — …`), con la ruta de su configuración MCP. Al instalar muestra un giro (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, un fotograma cada 80 ms mientras dura) y después `✓ Registered <destino>`, una fila por pieza (`MCP server`, `Instructions`, `Hooks` con su acción y ruta) y `Next Steps` (recargar VS Code o reiniciar el CLI). Un fallo muestra `✗ Installation failed: <causa>`.

## Sincronización con la nube

El panel gana la opción `Cloud sync settings` (índice 4, antes de `Quit`, que pasa al 5). Abre un menú con cuatro opciones.

### Configuración del servidor

Muestra el campo `Server URL:` (texto de ayuda `https://odin.example.com`, hasta 512 caracteres), `Token source:` (`not set`, `read from cloud.json` o `set via ODIN_CLOUD_TOKEN`; si no viene del entorno añade la pista `Set ODIN_CLOUD_TOKEN to override cloud.json.token`) y tres acciones (`Test connection`, `Save server`, `Cancel`). Al abrirla se limpian avisos y foco y se lanza `load-cloud-config`: al llegar rellena el campo con la URL efectiva (`ODIN_CLOUD_SERVER` sustituye a la guardada) y lo activa.

«Test connection» y «Save server» validan la URL con la misma regla que `odin cloud config` (`server URL is required`, `scheme must be http or https`, …; el error se muestra como `Error: <mensaje>` y no se comprueba nada) y lanzan `ping-cloud` con `origin: 'config'`; mientras responde se muestra `Checking server...` y `Connection: checking`. Resultado:

- Siempre se muestra `Connection: <estado>` y, si hay `error`, `Error: <causa>`.
- Probar no guarda nada.
- Guardar solo guarda si el estado es `reachable` o `unauthorized` (un 401 prueba que el servidor existe); en otro caso `Error: server is unreachable`. Al guardar (`save-cloud-url`) se reescribe **solo** `server_url` de `cloud.json` conservando el token; después el foco queda en «Save server» y el campo inactivo. Un `cloud.json` ilegible no se pisa (el error se muestra).

### Comprobación de conexión

`pingCloudServer(url, token, fetch)` valida la URL (error → `unreachable` con la causa), hace `GET <url sin barras finales>/health` con `Authorization: Bearer <token>` si hay token, con 3 s de límite, y clasifica: 2xx → `reachable`; 401 → `unauthorized`; cualquier otro código → `unreachable` con `unexpected status <código>`; un fallo de red → `unreachable` con la causa del error de red (`error.cause.message` si existe). La redirección la sigue `fetch`. `ctx.fetch` permite sustituirlo en pruebas.

### Generación de peticiones

`cloudGeneration` sube al abrir la configuración, al abrir o refrescar el estado y al comprobar. Las respuestas de `cloud-config-loaded`, `cloud-status-loaded` y `cloud-ping` que traen otra generación se descartan; además se descartan si ya no se está en su pantalla, y los `cloud-ping` cuya URL ya no coincide con el campo (sin espacios sobrantes) o con la del estado. Así una respuesta tardía no pisa lo que el usuario ve ahora.

### Estado

Abre con `Loading cloud status...` y `load-cloud-status`; al llegar muestra, con las etiquetas alineadas: `Server URL` (`not configured`), `Connection health` (`not checked` hasta que responde el ping), `Last successful sync` (`never`), `Pending mutations` y `Last error` (`none`). Si hay URL se lanza un ping con `origin: 'status'` y el mismo `generation`. `Last error` muestra el error del ping si lo hay y, si no, el último error de sincronización guardado. Los datos salen de `cloudSyncSummary` (destinos `cloud:<proyecto>`, ver `30-cloud/`): última sincronización con éxito, último error y mutaciones pendientes de proyectos inscritos. `r` repite la carga.

### Inscripción

Lista, en orden de bytes, los proyectos locales normalizados que salen de observaciones no borradas, sesiones, prompts e inscripciones, con `[x]` si están inscritos y `[ ]` si no (`No local projects found.` si no hay ninguno). `enter` alterna: inscribe con `enrollProject` o desinscribe con `unenrollProject` (mismas reglas que `odin cloud enroll`/`unenroll`) y recarga; mientras carga se ignora. Tras recargar el cursor se acota a la lista. Un error se muestra como `Error: <mensaje>` bajo la lista.

## Criterios de aceptación

```bash
node --test "test/unit/tui/*.test.js" test/unit/cli/tui.test.js
npm test
```

Las pruebas de integración montan la aplicación real sobre flujos simulados (`test/unit/tui/helpers.js`: `mountTui`, `press`, `frame`). Manual, en un terminal real: `node bin/odin.js tui`, navegar con `j`/`k`, abrir una observación, pulsar `c` y pegar en otro programa, y salir con `q`.
