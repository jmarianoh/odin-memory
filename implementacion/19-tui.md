# 19 — Interfaz de terminal (TUI)

## Qué cubre este capítulo

`odin tui` abre una interfaz de terminal para buscar, leer y administrar la memoria sin recordar comandos. La entrega F8 (spec 0.23.0) trae nueve pantallas: panel, búsqueda, resultados, recientes, detalle de observación, cronología, sesiones, detalle de sesión y preparación de Copilot. Las pantallas de la nube llegan con F9.4 y se añadirán como entradas del panel.

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
| `model.js` | `SCREEN`, `initialState`, `initialCommands`, `update`, `DASHBOARD_MENU`, `detailMetadata`, `detailContentLines`, `detailLayout`, `timelineRows`, `timelineViewport`, `visibleItems`, `sessionDeleteErrorMessage` |
| `text-input.js` | Campo de texto inmutable: `newTextInput`, `updateTextInput`, `inputView`, `setValue`, `focus`/`blur`, `inputValue`, `sanitizeInput` |
| `format.js` | `truncateStr`, `formatReviewDate`, `localTime`, `wrapLines`, `osc52Sequence` |
| `commands.js` | `executeCommand(cmd, ctx)`, `setupAgents(ctx)`, `LIST_LIMIT` |
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

`update(estado, mensaje, deps)` devuelve `{ state, cmds }`. Los **mensajes** son `{ type: 'key', key, input }`, `size`, y los resultados `stats`, `search-results`, `recent-observations`, `observation-detail`, `timeline`, `recent-sessions`, `session-observations`, `session-deleted`, `setup-installed`, `update-check`, `clipboard-copied`, `clipboard-clear`, `spinner-tick`. Los resultados con `error` solo ponen `errorMsg` (la pantalla no cambia). Cualquier tecla limpia `errorMsg`.

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
| `copy` | `osc52Sequence(contenido)` | `clipboard-copied` |

Todo error del almacén vuelve como mensaje con `error`, nunca se propaga. Al arrancar se lanzan `load-stats` y `check-update`; `App` pide el tamaño del terminal y lo actualiza con el evento `resize`.

## Teclas

`keyName` produce `up`, `down`, `left`, `right`, `enter`, `esc`, `backspace`, `delete`, `tab`, `home`, `end`, `ctrl+<letra>`, `alt+<letra>` o el propio texto (varios caracteres si se pegó). `ctrl+c` sale desde cualquier pantalla, también con el campo de búsqueda activo.

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

## Criterios de aceptación

```bash
node --test "test/unit/tui/*.test.js" test/unit/cli/tui.test.js
npm test
```

Las pruebas de integración montan la aplicación real sobre flujos simulados (`test/unit/tui/helpers.js`: `mountTui`, `press`, `frame`). Manual, en un terminal real: `node bin/odin.js tui`, navegar con `j`/`k`, abrir una observación, pulsar `c` y pegar en otro programa, y salir con `q`.
