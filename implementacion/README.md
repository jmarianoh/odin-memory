# implementacion — especificación para reconstruir odin-memory

Esta carpeta contiene todo lo necesario para que un agente construya **desde cero** el proyecto odin-memory en un repositorio vacío, sin acceso a internet salvo un registro npm privado (Nexus).

## Cómo usarla

1. Crea un repositorio vacío y copia **solo** esta carpeta (`implementacion/`) en su raíz.
2. Configura el registro npm: copia `fuentes/.npmrc.example` a `.npmrc` y sustituye los placeholders.
3. Entrega el prompt maestro (abajo) a un agente con acceso de escritura al repositorio.
4. Verifica con `99-checklist-verificacion.md`.

## Orden de lectura

| Orden | Documento | Contenido |
|---|---|---|
| 1 | `00-vision-alcance.md` | Qué es el producto y qué incluye |
| 2 | `01-arquitectura.md` | Módulos y flujo de datos |
| 3 | `02-convenciones.md` | Estilo, estructura, idioma, reglas de calidad |
| 4 | `03-entorno-dependencias.md` | Node, dependencias exactas, Nexus |
| 5 | `50-plan-construccion.md` | Fases en orden, con criterios de aceptación ejecutables |
| 6 | Capítulos por área (`10-…` a `30-…`) | Especificación detallada de cada módulo |
| 7 | `fuentes/` | Material que debe copiarse byte a byte |
| 8 | `99-checklist-verificacion.md` | Verificación final |

Para actualizar un repositorio ya construido, lee `60-aplicar-actualizacion.md` y aplica los `cambios/<versión>.md` posteriores a tu versión actual.

## Prompt maestro

> Eres el constructor de odin-memory. En este repositorio solo existe la carpeta `implementacion/`. Lee `implementacion/README.md` y los documentos en el orden indicado. Después:
> 1. Copia cada archivo de `implementacion/fuentes/` a la raíz del repositorio, conservando su ruta relativa.
> 2. Ejecuta las fases de `50-plan-construccion.md` en orden. No avances a la siguiente fase hasta que los comandos de aceptación de la actual terminen con éxito.
> 3. Escribe el código desde las especificaciones de los capítulos. Los tests de `fuentes/test/` son el criterio de aceptación: no los modifiques para que pasen.
> 4. Al terminar, ejecuta `99-checklist-verificacion.md`.
> No inventes dependencias: usa solo las de `03-entorno-dependencias.md`.

## Contenido de `fuentes/`

Espejo exacto del repositorio: cada archivo se copia a la raíz con su misma ruta relativa. Incluye `package.json`, scripts de verificación, configuración y los tests completos. El script `npm run check:implementacion` falla si una copia se desvía del archivo real.
