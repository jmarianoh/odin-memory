# upstream — seguimiento de engram

Zona exclusiva del repositorio odin-memory. **No se copia al repositorio cerrado** y nada del producto la referencia.

| Archivo | Función |
|---|---|
| `engram.lock.json` | Versión de engram portada actualmente |
| `port-map.json` | Mapa de rutas de origen → módulos JS → documentos |
| `forbidden-terms.txt` | Términos que la zona Producto no puede contener (lo lee `npm run check:clean-room`) |
| `contracts/` | Instantáneas de los contratos de origen |
| `scripts/` | `snapshot-contracts.mjs`, `upstream-check.mjs` |
| `conformance/` | Pruebas diferenciales contra el binario de engram |
| `reports/` | Reportes generados |
| `playbook.md` | Procedimiento de actualización |
