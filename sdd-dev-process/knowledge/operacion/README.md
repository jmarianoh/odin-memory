# Operación

Cómo se levanta, despliega y diagnostica **este servicio**. Esta carpeta es del repo: el instalador la crea una vez y no la vuelve a tocar.

## Qué va aquí

- Cómo levantarlo en local y contra QA (variables de ambiente necesarias, sin valores secretos).
- Feature flags del servicio y quién los enciende.
- Runbooks: síntomas frecuentes, dónde mirar los logs y cómo revertir.
- Dependencias de despliegue (qué capa debe estar antes en producción).

## Qué no va aquí

| Contenido | Dónde |
| --- | --- |
| Pipeline y jobs de CI | `.gitlab-ci.yml` |
| Causa raíz de un incidente | La historia del MAU en Jira |
| Secretos y credenciales | Fuera del repo |
