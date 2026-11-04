# Integraciones

Sistemas externos con los que habla **este servicio**. Esta carpeta es del repo: el instalador la crea una vez y no la vuelve a tocar.

## Qué va aquí

- Un archivo por sistema (`<sistema>.md`): para qué se usa, autenticación (flujo y scopes, nunca secretos), timeouts y reintentos, errores del proveedor y cómo se mapean.
- Notas de ambientes de prueba o sandbox del proveedor.

## Qué no va aquí

| Contenido | Dónde |
| --- | --- |
| Contratos de los servicios de la funcionalidad | `celula-<célula>/funcionalidades/<funcionalidad>/contracts/` y, si el API o MS es compartido, `celula-<célula>/servicios/<repo>/contracts/` |
| Secretos y credenciales | Fuera del repo |
