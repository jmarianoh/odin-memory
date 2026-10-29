# Playbook: incorporar cambios de engram

Esta guía vive solo en el repositorio odin-memory. Nada de lo que aquí se menciona debe aparecer en la zona Producto (`bin/`, `src/`, `test/`, `static/`, `docker/`, `implementacion/`, raíz salvo `upstream/`).

## 1. Detectar

```bash
node upstream/scripts/upstream-check.mjs --engram ../engram --to <tag|sha>
```

- Sale con 0 si no hay nada que portar y con 3 si hay cambios portables o de contrato.
- Escribe `upstream/reports/<fecha>-<desde>-<hasta>.md`.
- `--skip-binary` evita compilar engram (omite esquema SQL y herramientas MCP).
- El workflow semanal `upstream-watch.yml` hace lo mismo y abre un issue.

## 2. Portar

Para cada módulo afectado del reporte:
1. Leer el diff en engram: `git -C ../engram diff <desde>..<hasta> -- <ruta>`.
2. Portar con la identidad de odin (`ODIN_*`, `odin-memory`, `.odin-memory/`, `odin.db`). Un identificador de engram nunca se copia tal cual.
3. Si cambió el esquema SQLite: migración idempotente (`addColumnIfNotExists`) y nota en `cambios/<versión>.md`.
4. Añadir o ajustar tests en `test/`.

## 3. Documentar (`implementacion/`)

1. Actualizar el capítulo del módulo y, si procede, `fuentes/` (copias exactas).
2. Subir `implementacion/VERSION` (semver: parche = corrección, menor = funcionalidad, mayor = ruptura).
3. Escribir `implementacion/cambios/<versión>.md`: archivos a crear/modificar/borrar, migraciones, tests nuevos.
4. `npm run check:implementacion -- --update`.

## 4. Verificar

```bash
npm test
npm run check:implementacion
npm run check:clean-room
# Conformidad diferencial: ENGRAM_BIN (binario del destino) o ENGRAM_SRC (checkout, se compila con go build)
ENGRAM_SRC=../engram node --test "upstream/conformance/*.conformance.test.mjs"
```

## 5. Cerrar

1. Reemplazar las instantáneas: repetir el paso 1 con `--write-contracts`.
2. Actualizar `upstream/engram.lock.json` (tag, commit, fecha).
3. Anotar una entrada en `upstream/CHANGELOG.md`.
4. Para el repositorio cerrado: copiar la carpeta `implementacion/` actualizada; el agente aplica `cambios/<versión>.md` (ver `implementacion/60-aplicar-actualizacion.md`).

## 6. Validar en sala limpia (F10)

Antes de entregar una versión de `implementacion/` al repositorio cerrado:

```bash
node upstream/scripts/clean-room-rebuild-check.mjs            # comprobaciones sobre una copia de implementacion/
node upstream/scripts/clean-room-rebuild-check.mjs --rebuild  # además monta fuentes/ + src/, instala dependencias y corre la suite
```

El script copia **solo** `implementacion/` a un directorio vacío y verifica: ningún término prohibido, enlaces internos resueltos, manifiesto completo (módulos, documentos y tests existen; cada módulo se nombra en su documento), `fuentes/` con todos los tests y sin importar módulos no declarados, todas las variables `ODIN_*` y subcomandos del código documentados, dependencias coherentes con `03-entorno-dependencias.md` y `fuentes/` idéntico al repositorio. Con `--rebuild` reconstruye el árbol, hace `npm install` y ejecuta `check:clean-room`, `check:implementacion` y la suite completa.

Resultado con la especificación 0.31.0: correcto (218 archivos, 200 módulos, 113 tests, 26 variables `ODIN_*`).

Lo que el script no puede validar es que un agente **sin acceso al repositorio** reconstruya el producto leyendo solo los documentos. Se hizo una muestra con un agente nuevo sobre dos módulos (más las comprobaciones del script); señaló una laguna: las firmas de `errors.js` y `text.js` estaban repartidas por varios capítulos, lo que se corrigió con `implementacion/10-store/12-errores-y-texto.md`. Una reconstrucción completa por un agente (el criterio de aceptación definitivo del plan) debe hacerse en el entorno cerrado con el Nexus real; las lagunas que aparezcan se corrigen en la documentación y se anotan en `upstream/CHANGELOG.md`.

## Reglas

- Los cambios de documentación, CI y las integraciones de otros agentes se ignoran (ver `port-map.json`).
- Si un archivo aparece "sin mapear", decide en `port-map.json` si se porta o se excluye.
- Una ruptura de formato (esquema, chunks, protocolo) requiere versión mayor de la especificación.
