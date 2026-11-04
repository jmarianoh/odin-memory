---
description: "Genera el resumen de spec.md (escenarios, fuera de alcance, decisiones y dudas) para que el PO lo apruebe en Jira"
---

# Resumen de la spec para el PO

El PO trabaja solo en Jira y nunca entra a GitLab. Este comando genera, igual en las 20 células, el comentario que la célula publica en la historia para pasarla a "Spec en revisión".

## Entrada del usuario

```text
$ARGUMENTS
```

Puede traer la ruta de la spec o la clave de Jira. Si no trae nada, usa la spec activa (`.specify/feature.json` → `feature_directory`).

## Ejecución

1. Lee `spec.md` completo. Toma la clave de Jira del encabezado; si falta, detente y pide agregarla.
2. Arma el resumen en lenguaje de negocio, **sin términos técnicos** (nada de capas, endpoints, códigos HTTP ni nombres de archivos; un código de error se describe por su significado, p. ej. "el sistema rechaza el monto y explica que supera el límite"):

   ```markdown
   **Resumen de la spec · <CLAVE> · <título>**

   **Qué va a poder hacer el usuario**
   - <una línea por historia o escenario principal>

   **Escenarios de aceptación** (estos serán las pruebas automáticas)
   1. Dado …, cuando …, entonces …

   **Fuera de alcance**
   - <…>

   **Decisiones tomadas por la célula** (supuestos y aclaraciones ya resueltas)
   - <…>

   **Dudas para el PO** (necesitamos tu respuesta en este hilo)
   1. <cada [NEEDS CLARIFICATION] pendiente, como pregunta cerrada con opciones si es posible>

   **Para aprobar**: responde las dudas y mueve la historia a "Lista para desarrollo".
   ```

3. Entrega el resumen en el chat, listo para pegar.
4. **Publicación**:
   - Si hay un servidor MCP de Jira disponible y el usuario lo confirma, publícalo como comentario en la historia.
   - Si no hay MCP pero existe `funcionalidades/<funcionalidad>/jira/<CLAVE>.md` en el repo de la célula (Jira simulado del piloto), agrégalo al final de la sección "Comentarios" de ese archivo, con la fecha y el autor "Célula".
5. Recuerda el siguiente paso: cuando el PO responda, registrar las respuestas en "Aclaraciones" de `spec.md` (o correr `/speckit-clarify`).

## Reglas

- No cambies `spec.md` en este comando.
- No agregues escenarios que no estén en la spec.
