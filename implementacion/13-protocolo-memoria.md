# 13 — Protocolo de memoria

## Qué cubre este capítulo

El texto que se entrega al agente para que use las herramientas `mem_*` de forma disciplinada. Vive en `src/setup/protocol.js`; la instalación (`odin setup`) lo coloca donde cada cliente de Copilot lo lee como instrucciones, y los hooks lo complementan con el contexto de la sesión. **Cambiar el texto cambia el comportamiento del agente**: se mantiene literal en `fuentes/` (a través de `protocol.js`).

## Exportaciones de `src/setup/protocol.js`

| Nombre | Descripción |
|---|---|
| `PROTOCOL_BEGIN` / `PROTOCOL_END` | `<!-- BEGIN ODIN MEMORY PROTOCOL -->` y `<!-- END ODIN MEMORY PROTOCOL -->`: delimitan el bloque gestionado dentro de un archivo que también contiene texto del usuario |
| `MEMORY_PROTOCOL` | El protocolo, que empieza por `## Odin Persistent Memory — Protocol` |
| `instructionsFile()` | Archivo de instrucciones propio de VS Code: front matter `name: 'Odin persistent memory'`, `description: 'Protocol for using the Odin persistent memory tools.'`, `applyTo: '**'` y el protocolo |
| `protocolBlock()` | El protocolo entre sus dos marcas, terminado en salto de línea |
| `upsertProtocolBlock(texto)` | Inserta el bloque al final (con una línea en blanco de separación) o sustituye el existente, conservando lo demás. Idempotente |
| `removeProtocolBlock(texto)` | Quita el bloque; devuelve `null` si no estaba (o si las marcas están en orden inverso) y `''` si el archivo solo contenía el bloque |

## Secciones del protocolo (en este orden)

1. **AVAILABLE TOOLS**: las 17 herramientas `mem_*` con sus nombres lógicos (el anfitrión puede registrarlas con prefijo) y el **Fallback**: si faltan, ejecutar `odin setup vscode-copilot` o `odin setup copilot-cli` y reiniciar.
2. **SELECTIVE MEMORY**: guardar solo conocimiento verificado, duradero y costoso de reconstruir (decisiones con su porqué, causas raíz no obvias, restricciones reales, trabajo pendiente para retomar); excluir secretos, especulación y progreso rutinario. Antes de escribir: `mem_search` en el proyecto y ámbito previstos, leer candidatos completos con `mem_get_observation`, `mem_update` por ID para el mismo tema (conservando `topic_key` y los hechos vigentes) o `mem_save` con un `topic_key` nuevo y deliberado; no sobrescribir ni duplicar ante identidad ambigua; nunca mezclar proyectos ni ámbitos; contenido con Qué, Por qué, Dónde, Aprendido.
3. **DELIVERY GUARANTEE**: la memoria es contabilidad interna; terminar su trabajo antes de redactar la respuesta y enviar la respuesta completa como último mensaje, sin llamadas posteriores.
4. **SESSION CLOSE PROTOCOL (REQUIRED)**: ante un cierre o traspaso explícito, `mem_session_summary` con Goal, Instructions, Discoveries, Accomplished, Next Steps, Relevant Files. Guardar el resumen no cierra la sesión: la cierra el hook de fin de sesión.
5. **PASSIVE CAPTURE**: el hook de fin de subagente reenvía la salida elegible para su extracción; `mem_save` sigue siendo el camino principal y `mem_capture_passive` una red de seguridad.
6. **AFTER COMPACTION**: si aparece «FIRST ACTION REQUIRED» o un aviso de compactación: (1) llamar de inmediato a `mem_session_summary` con el resumen compactado, (2) `mem_context`, (3) solo entonces continuar.

El texto completo está en el código; esta lista es el contrato que deben respetar las pruebas (`test/unit/setup/setup.test.js` comprueba el encabezado, las marcas, el fallback y la frase «FIRST ACTION REQUIRED»).

## Dónde se entrega

| Cliente | Archivo | Forma |
|---|---|---|
| VS Code | `<perfil>/prompts/odin-memory.instructions.md` (o `.github/instructions/odin-memory.instructions.md` con `--workspace`) | Archivo propio completo (`instructionsFile()`); se borra entero con `--remove` |
| CLI de Copilot | `~/.copilot/copilot-instructions.md` | Bloque gestionado dentro de un archivo compartido (`upsertProtocolBlock`) |

Detalle en `21-copilot-vscode.md` y `22-copilot-cli.md`.
