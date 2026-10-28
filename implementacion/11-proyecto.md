# 11 — Detección de proyecto

Módulos: `src/project/{errors,identity,detect,resolution,inspect,similar,routing-candidate,index}.js`. Ya existentes (capítulos `10-store/02` y `10-store/08`): `canonical.js` (`canonicalizeProjectName`, `normalizeProject`, `normalizeProjectName`) y `worktree.js` (`detectGitWorktreeDir`, `canonicalizePath`, `runtimeWorktreeDirectory`, `directoryIdentity`).

Este paquete responde a «¿en qué proyecto estoy?» a partir de un directorio. No usa la base de datos: la comprobación de existencia y el historial se inyectan como funciones.

## Identidad

| Elemento | Valor |
|---|---|
| Carpeta y archivo de configuración | `.odin-memory/config.json` |
| Variable de proceso | `ODIN_PROJECT` |
| Vínculo del repositorio | `<directorio común de git>/odin-memory-project-identity.json` |

## `errors.js`

Todas extienden `Error`, con `name` igual al nombre de la clase y un `code` estable.

| Clase | `code` | Mensaje |
|---|---|---|
| `AmbiguousProjectError` | `ambiguous_project` | `ambiguous project: multiple git repos found in cwd` |
| `InvalidConfigError(detalle?)` | `invalid_config` | `invalid .odin-memory/config.json` o `invalid .odin-memory/config.json: <detalle>` |
| `ExplicitProjectRequiredError` | `explicit_project_required` | `explicit project required: use --project, ODIN_PROJECT, or .odin-memory/config.json project_name` |
| `RepositoryBindingError(detalle?, opciones?)` | `repository_binding` | `repository identity binding unavailable` o `…: <detalle>` |
| `ProjectHistoryUnavailableError(detalle?)` | `project_history_unavailable` | `project history unavailable` o `…: <detalle>` |
| `ProjectTransitionError(candidato, historial)` | `project_transition` | `Git would select project "<candidato>", but this directory has history under <historial separado por ", ">; choose explicitly or run odin init <project> to set future scope (existing memories are not moved)` (propiedades `candidate`, `historicalProjects`) |
| `UnknownProjectError(nombre)` | `unknown_project` | `unknown project: <nombre>` (propiedad `projectName`) |

## `identity.js` — vínculo del repositorio

El primer nombre de proyecto que se detecta para un repositorio git se **fija** en un archivo dentro de su directorio común de git, para que no cambie aunque después se renombre el directorio o se cambie el remoto. Constantes: `REPOSITORY_BINDING_FILENAME = 'odin-memory-project-identity.json'`, `REPOSITORY_BINDING_VERSION = 1`, `SOURCE_UNBOUND_GIT = 'unbound_git'`.

- `publishFile(temporal, destino)`: `fs.linkSync(temporal, destino)`; falla con `EEXIST` si el destino ya existe (publicación atómica sin reemplazo).
- Contenido: JSON `{"version":1,"id":"<32 hex>","project":"<nombre canónico>"}` más un salto de línea.
- Un vínculo es **válido** si es un objeto con `project` e `id` de tipo cadena, `version === 1`, `id` de 32 caracteres hexadecimales (cualquier caja) y `normalizeProjectName(project)` igual a `project.normalize('NFC')`.
- `readRepositoryBinding(commonDir)` → vínculo (con `project` en NFC) o `null` si el archivo no existe. Si no se puede leer (otro error de E/S): `RepositoryBindingError('cannot read the binding; check Git metadata permissions or configure project_name explicitly')`. Si no es JSON o no es válido: `RepositoryBindingError('binding is invalid; configure project_name explicitly before retrying')`.
- `loadOrCreateRepositoryBinding(commonDir, proyectoHeredado)`: devuelve el vínculo existente. Si no existe: el nombre debe cumplir `normalizeProjectName(nombre) === nombre`, si no → `RepositoryBindingError('cannot establish a canonical project label; configure project_name explicitly')`. Genera `id` (16 bytes aleatorios en hexadecimal), crea `<archivo>.tmp-<id>` con `O_WRONLY|O_CREAT|O_EXCL` y permisos `0o600` (fallo → `cannot create the binding; check Git metadata permissions or configure project_name explicitly: <causa>`), escribe, cierra (fallo de escritura → `cannot persist the binding; …`) y publica con `publishFile`. Si publica, lo devuelve; si falla con `EEXIST` (otro proceso ganó) lee y devuelve el del ganador; otro error → `cannot atomically create the binding; …: <causa>`. El temporal se elimina siempre.

## `detect.js`

### Constantes

Orígenes (`source`): `git_remote`, `git_root`, `git_child`, `dir_basename`, `ambiguous`, `explicit_override`, `session`, `user_selected_after_ambiguous_project`, `request_body`, `config`, `all_projects`, `process_override`, `stored_project`, y `unbound_git` (reexportada). Más `ENV_PROJECT_OVERRIDE = 'ODIN_PROJECT'`, `CONFIG_DIR = '.odin-memory'`, `CONFIG_FILE = 'config.json'`.

Directorios de ruido ignorados al buscar hijos: `node_modules vendor .venv __pycache__ target dist build .idea .vscode` (además de cualquier nombre que empiece por punto). `scanClock.now()` es el reloj del escaneo (sustituible en pruebas).

### Resultado de detección

`{ project?, source?, path?, warning?, error?, available_projects? }`. Los errores van en `error`; **no se lanzan**.

### Utilidades

- `processOverride(explicit, env)` → `{ value, ok }`: el valor explícito recortado si no es vacío; si no, `env.ODIN_PROJECT` recortado; si ninguno, `ok: false`.
- `normalize(nombre)` (interna): `canonicalizeProjectName`; vacío o con `/` o `\` → `unknown`. `normalizeAvailableProject(nombre)`: recorta y pasa a minúsculas; vacío o con `/` o `\` → `unknown`. `fallbackProjectName(dir)`: `normalize(basename(dir))`, o `unknown` si el nombre base es `''` o `.`.
- `extractRepoName(url)`: quita un sufijo `.git`, separa por `/` y `:`, descarta vacíos y devuelve el último segmento recortado (o `''`).
- git (sin shell, tiempo máximo 2 s, errores → vacío): `gitRevParsePath(dir, arg)` ejecuta `git -C <dir> rev-parse --path-format=absolute <arg>` y devuelve la ruta limpia (`.` o vacío → `''`). `detectGitRootDir(dir)`: `commonDir = --git-common-dir` (vacío → `''`); si `--show-toplevel` existe y `--git-dir` es igual a `commonDir` → ese toplevel; si no, la raíz derivada del directorio común (si su nombre base es `.git`, el padre; si no, el directorio sin sufijo `.git`). `detectFromGitRemote(dir)`: `git -C <dir> remote get-url origin` → `extractRepoName(salida recortada)`. `observeGitRoot(dir)` = `detectGitRootDir`.

### Configuración

- `readConfigAt(dir)`: lee `<dir>/.odin-memory/config.json`. No existe → ninguna. Otro error de lectura → resultado de configuración inválida (`read <ruta>: <causa>`). JSON ilegible → `parse <ruta>: <causa>`. `project_name` presente y no cadena → `parse <ruta>: project_name must be a string`. El nombre pasa por `normalizeConfigProjectName`: recortado; vacío → `InvalidConfigError('project_name is required')`; con `/` o `\` → `project_name must be a name, not a path`; con carácter de control (< 0x20 o 0x7f) → `project_name contains control characters`; si no, `normalize(nombre)`. Un error de nombre vuelve a envolverse como configuración inválida, de modo que el mensaje final lleva el prefijo **duplicado**: `invalid .odin-memory/config.json: invalid .odin-memory/config.json: project_name is required`. Esto es parte del contrato.
- Resultado inválido: `{ project: '', source: 'config', path: <dir>, error: InvalidConfigError(detalle) }`; válido: `{ project, source: 'config', path: <dir> }`.
- `detectFromConfig(dir)`: `absDir = canonicalizePath(resolve(dir))`; `raíz = canonicalizePath(detectGitWorktreeDir(absDir))`. Si hay worktree, busca la configuración **subiendo** desde `absDir` hasta `raíz` (inclusive) y devuelve la primera; si no hay worktree, solo mira `absDir`.

### Escaneo de hijos

`scanChildren(dir)` → `{ repos, timedOut }`: abre el directorio y lee **una entrada cada vez**. Plazo de 200 ms (se comprueba antes de abrir, antes y después de cada lectura y antes de registrar un hijo; vencido → `timedOut: true`). Se descartan las entradas que no son directorios (un enlace simbólico no cuenta), las que empiezan por `.` y las de ruido; se registra el hijo si existe `<hijo>/.git` (archivo o carpeta, `statSync`). **Se detiene al registrar el segundo repositorio** (con más de dos hijos solo se conocen los dos primeros que devuelva el sistema de archivos).

### Repositorio de HOME

`requireHomeProjectContext(dir, raíz)` (solo con `requireExplicitHomeProject`): si la raíz del repositorio no es el directorio HOME (`os.homedir()`, comparado con `directoryIdentity`) → permitido. Si `git rev-parse --show-toplevel` de `dir` no es HOME → permitido. Si `dir` es HOME mismo o queda fuera de él → permitido. Si no, `git ls-files --cached -z -- .` en `dir`: sin archivos versionados → `ExplicitProjectRequiredError`. Los fallos al comprobar son errores con un mensaje que pide configurar `project_name`.

### `detectProjectFull(dir, opciones)`

Opciones: `historyLookup(identidadDelDirectorio) → string[]` (puede lanzar), `inspectOnly`, `requireExplicitHomeProject`. `historyDirectory = directoryIdentity(dir)`. El algoritmo `detect(dir)`:

1. `dir === ''` → `.`; si empieza por `-` → `./` + dir.
2. **Configuración** (`detectFromConfig`): si hay resultado, se devuelve.
3. **Git** (`detectFromGitBinding`), si `git rev-parse --git-common-dir` da un directorio:
   - raíz vacía → `{ source: 'git_root', error: RepositoryBindingError('cannot determine the repository root; configure project_name explicitly') }`;
   - con `requireExplicitHomeProject`, error de HOME → `{ path: raíz, error }`;
   - `proyectoHeredado = normalize(basename(raíz))` con origen `git_root`; si el remoto `origin` da nombre → `normalize(remoto)` con origen `git_remote`;
   - lee el vínculo (error → `{ source, path: raíz, error }`); si **no existe**: con `historyLookup`, si lanza → `ProjectHistoryUnavailableError(mensaje)`; si algún proyecto del historial difiere del heredado → `{ source, path: raíz, available_projects: <heredado + historial, sin repetidos y ordenados>, error: ProjectTransitionError }`; con `inspectOnly` → `{ project: heredado, source: 'unbound_git', path: raíz }`; si no, `loadOrCreateRepositoryBinding` (error → `{ source, path: raíz, error }`);
   - resultado `{ project: vínculo.project, source, path: raíz }`.
4. **Hijos**: sin tiempo agotado, con un único hijo → se detecta recursivamente sobre él; si da error se devuelve; si no, `{ project: hijo.project, source: 'git_child', path: hijo.path, warning: 'auto-promoted child repository: <proyecto>' }`. Con varios → `{ project: '', source: 'ambiguous', path: resolve(dir), error: AmbiguousProjectError, available_projects: <nombres base normalizados con normalizeAvailableProject, ordenados> }`.
5. **Nombre del directorio**: `{ project: fallbackProjectName(dir), source: 'dir_basename', path: resolve(dir) }` (también si el escaneo agotó el tiempo).

## `resolution.js`

Modos: `current`, `explicit`, `all`. `resolve(opciones)` con `{ mode, explicit, processOverride, directory, detect, projectExists, requireKnownExplicit, requireKnownProcess, env }`:
1. `mode === 'all'` → `{ source: 'all_projects' }`.
2. `explicit = recortar(explicit)`. Si el modo es `explicit` y queda vacío → `normalizeProjectName` lanza `invalid_project_name` (`… (project is required)`).
3. Si hay `explicit`: `project = normalizeProjectName(explicit)`; con `requireKnownExplicit` → `requireKnown`; devuelve `{ project, source: 'explicit_override' }`.
4. Si hay valor de proceso (`processOverride(opciones.processOverride, env)`): igual, con `requireKnownProcess` y origen `process_override`.
5. Si no, `detect(directory)` (por defecto `detectProjectFull`); si tiene `error`, se **lanza** ese error con la propiedad `result` (el resultado parcial: `path`, `available_projects`…); si no, se devuelve.
- `requireKnown(project, requerido, existe)`: no requerido → nada; sin función `existe` → `Error('project existence check is required for "<project>"')`; si `existe(project)` es falso → `UnknownProjectError(project)`.

## `inspect.js`

`inspectLocalProject(directorio, env)`: detección **sin escribir** y solo con orígenes verificables (la base de los hooks, que no deben adivinar).
1. `directorio` vacío o con `\0` → `Error('inspection requires a usable cwd')`; debe ser un directorio legible (`statSync` + abrirlo y leer una entrada; si no es directorio → `inspection requires a readable directory`; los errores de E/S se propagan).
2. `detectProjectFull(directorio, { inspectOnly: true, requireExplicitHomeProject: true })`; con `error` se lanza.
3. Si el origen es `git_child`: se detecta de nuevo sobre `result.path`; error → se lanza; si el hijo es `unbound_git` o `dir_basename` o su proyecto difiere → `RepositoryBindingError()`.
4. Origen `dir_basename`: `validateBasenameInspection`; orígenes `config`, `git_remote`, `git_root`, `git_child`: válidos; cualquier otro (p. ej. `unbound_git`) → `RepositoryBindingError()`.
5. Devuelve el resultado con `project = normalizeProjectName(project)`.
- `validateBasenameInspection(directorio, env)`: sube desde el directorio (canonicalizado) hasta la raíz del sistema de archivos; en cada nivel, si su identidad no es la inicial y está en `GIT_CEILING_DIRECTORIES` (rutas absolutas separadas por el delimitador de la plataforma) → válido; si existe `<nivel>/.git` (`lstatSync`) → `RepositoryBindingError()` (hay metadatos de git que la detección no reconoció); un error distinto de «no existe» → `RepositoryBindingError('cannot verify Git metadata: <causa>')`.

## `similar.js`

- `levenshtein(a, b)`: distancia de edición por caracteres Unicode (arreglos de puntos de código), con el algoritmo de dos filas intercambiando la cadena más corta como columna.
- `findSimilar(nombre, existentes, maxDistancia)` → `[{ name, match_type, distance }]`:
  - `nombreMin = recortar(nombre).toLowerCase()`; `max = max(0, maxDistancia)`; si `nombreMin` no es vacío, `max = min(max, max(1, floor(bytes(nombreMin) / 2)))`.
  - Para cada candidato distinto de `nombre` (comparación exacta; los repetidos se ignoran): `candidatoMin = recortar(candidato).toLowerCase()`.
    - igual a `nombreMin` → `case-insensitive` (distancia 0);
    - si `bytes(nombreMin) >= 3` y uno contiene al otro → `substring` (0);
    - si no, `levenshtein(nombreMin, candidatoMin) <= max` → `levenshtein` con esa distancia.
  - Resultado: primero los `case-insensitive`, luego los `substring`, luego los `levenshtein` ordenados por distancia (orden estable).

## `routing-candidate.js`

`deriveRoutingCandidate({ designation, git_root, directory })` → `{ key, source, directory, raw_project }` con valores iniciales `{ key: '', source: 'unknown', directory: directory ?? '', raw_project: designation ?? '' }`: con `designation` no vacía, `key = resolve({ mode: 'explicit', explicit: designation }).project` y `source = 'explicit_override'`; si no, con `git_root` no vacío, el nombre base de la ruta limpia pasa por la misma resolución y `source = 'git_root'`. Un error de nombre se relanza con la propiedad `candidate` (el candidato parcial).

## Criterios de aceptación

```bash
node --test "test/unit/project/*.test.js"
npm test
npm run check:implementacion
npm run check:clean-room
```
Las pruebas crean repositorios git reales en directorios temporales (necesitan `git` en el `PATH`).
