# 15.2 — Copias (export/import) e init

Módulos: `src/cli/commands/backup.js`, `src/cli/commands/init.js`, `src/cli/init-config.js`. La lógica de la copia está en `src/store/backup.js` (`10-store/10-exportacion-importacion.md`); aquí solo la capa de comando.

## `export`

```
odin export [file.json] [--project NAME | --all]
```

- Argumentos: `--project` (con `requiredProjectValue`), `--all`; cualquier otro argumento **que no empiece por `-`** es el archivo de salida (el último gana; por defecto `odin-export.json`). Los desconocidos que empiezan por `-` se ignoran.
- Resuelve el proyecto con `resolveCliProjectScope(..., true)`: con proyecto, `exportProject`; sin él (`--all`, o ninguno detectado), `exportData`.
- Escribe `toGoJson(exportToJsonValue(datos), 2)` **sin salto de línea final**, con modo 0644, en `resolve(cli.cwd(), archivo)` (una ruta relativa se resuelve contra el directorio de trabajo inyectado). Si falla la escritura: `fatal("write <archivo>: <fsErrorText>")`, por ejemplo `write x.json: open x.json: no such file or directory`.
- Salida:

```
Exported to <archivo>
  Sessions:     <n>
  Observations: <n>
  Prompts:      <n>
```

## `import`

```
odin import <file.json>
```

- Sin argumento: `usage: odin import <file.json>`, código 1.
- Lee el archivo (`resolve(cli.cwd(), archivo)`); error → `fatal("read <archivo>: <fsErrorText>")`. `parseExportData(texto)`; error → `fatal("parse <archivo>: <mensaje>")`. `importData(store, datos)`; error → `fatal`.
- Salida:

```
Imported from <archivo>
  Sessions:     <n>
  Observations: <n> imported, <n> updated, <n> skipped stale
  Prompts:      <n>
```

## Ayudas cortas

Se imprimen **en la salida estándar** con código 0 y sin abrir el almacén cuando `--help` aparece en cualquier posición posterior (lo decide el despachador):

```
Usage: odin export [file.json] [--project NAME | --all]

Options:
  --project NAME  Export one project (default: current project)
  --all           Export every project
  --help          Show this help
```

```
Usage: odin import <file.json>

Options:
  --help          Show this help
```

(sin salto de línea extra además del de `println`).

## `init`

```
odin init [project_name] [--force]
```

No abre el almacén. Argumentos, en orden:

- `-h`, `--help` o `help`: imprime `usage: odin init [project_name] [--force]` en la salida estándar y termina con 0 (se evalúa en cuanto aparece, aunque haya otros argumentos).
- `-f` o `--force`: sobrescribir.
- Otro que empiece por `-`: error `odin: unknown flag: <x>` + línea en blanco + el uso, código 1.
- Primer otro argumento = nombre; un segundo → `odin: unexpected argument: <x>` + línea en blanco + el uso, código 1.

Validación del nombre (si falta se usa `basename(cwd)`), recortado con `goTrim`: vacío → `project name is required`; contiene `/` o `\` → `project name must be a name, not a path`; algún carácter < 0x20 o 0x7f → `project name contains control characters`. Todo `fatal`.

Contenido escrito (`toGoJson({ project_name: nombre }, 2)` + `\n`), por ejemplo:

```json
{
  "project_name": "mi-proyecto"
}
```

(`<`, `>` y `&` se escapan como `<`, `>`, `&`.) Salida: `Initialized Odin project "<nombre>" in .odin-memory/config.json`.

### `writeInitConfig(cwd, datos, force)` (`src/cli/init-config.js`)

1. Crea `<cwd>/.odin-memory` (modo 0755). Si ya existe: debe ser un directorio real — un enlace simbólico → `.odin-memory must be a real directory, not a symlink`; un archivo → `.odin-memory must be a directory`. Otros fallos: `create .odin-memory directory: …` / `inspect .odin-memory directory: …`.
2. Si `config.json` existe y es un enlace simbólico → `.odin-memory/config.json must not be a symlink` (ni siquiera con `--force`).
3. Sin `--force`: creación exclusiva (`O_WRONLY|O_CREAT|O_EXCL`, 0644). Si existe → `.odin-memory/config.json already exists (use --force to overwrite)`. Si la escritura falla se borra el archivo parcial.
4. Con `--force`: escribe un temporal en el mismo directorio (`config.json.<pid>.<tiempo>.tmp`, creado con 0600 y luego 0644) y lo renombra sobre el destino; el temporal se borra si algo falla. Errores: `create replacement config: …`, `write replacement config: …`, `publish replacement config: …`.
