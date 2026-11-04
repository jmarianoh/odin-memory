---
applyTo: "src/**/*.controller.ts,src/**/dto/**,src/**/*.dto.ts"
---

# Controllers y DTO (estándar SDD)

- Cada endpoint implementa exactamente lo que dice el contrato referenciado en `plan.md` (ruta, método, campos, tipos, códigos de respuesta y códigos de error del cuerpo).
- Si el contrato y la spec técnica no coinciden, detente: el contrato manda y la diferencia se reporta.
- Tolerant reader: al consumir otro servicio, ignora campos desconocidos y no falles por campos opcionales ausentes.
- No agregues endpoints, campos ni códigos de error que no estén en el contrato.
