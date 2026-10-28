# 02 — Convenciones

## Lenguaje y estilo

- JavaScript ESM (`"type": "module"`), sin TypeScript ni compilación.
- Tipos con JSDoc (`@param`, `@returns`, `@typedef`). Una función pública siempre lleva JSDoc.
- Comentarios y documentación en español. Identificadores de código en inglés.
- Texto que ve el agente (protocolo, instrucciones MCP, descripciones de herramientas) en inglés.
- Imports con extensión explícita (`./x.js`) y especificadores `node:` para el núcleo de Node.
- Sin dependencias circulares. Un módulo exporta funciones y clases con nombre (no `default`).
- Errores: lanzar `Error` con un `code` estable (cadena en `snake_case`) cuando un llamador deba distinguirlos.
- Tiempo: las fechas persistidas son texto UTC `YYYY-MM-DD HH:MM:SS`. Toda función que dependa del reloj acepta un `now` inyectable.

## Estructura

```
bin/odin.js            punto de entrada ejecutable
src/<área>/            ver 01-arquitectura.md
test/unit/             pruebas por módulo (*.test.js)
test/contract/         pruebas contra contratos fijos de fuentes/
scripts/               verificación del repositorio
static/                recursos estáticos del dashboard
```

## Pruebas

- `node:test` y `node:assert/strict`. Un archivo `*.test.js` por módulo.
- Cada prueba usa un directorio temporal propio (`fs.mkdtemp`) y no toca `~/.odin-memory`.
- Se ejecutan con `npm test`. Para una carpeta concreta, usar un glob entre comillas: `node --test "test/unit/store/*.test.js"` (pasar un directorio no recorre subdirectorios).
- Los contratos externos (esquema SQLite, herramientas MCP…) viven como fixtures JSON en `test/contract/fixtures/`; las pruebas de contrato comparan el comportamiento real con ellos.
- Las filas devueltas por `node:sqlite` tienen prototipo nulo: en `assert.deepEqual` hay que copiarlas con `{ ...fila }`.

## Registro en `implementacion/`

- Cada archivo de `bin/` y `src/` figura en `manifest.json` con su documento y fase.
- Tras cambiar código o su documento: `npm run check:implementacion -- --update`.
- `fuentes/` es espejo exacto del repositorio para el material que debe reproducirse literalmente.
