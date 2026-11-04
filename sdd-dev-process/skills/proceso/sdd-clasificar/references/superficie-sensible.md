# Superficie sensible

Lista única. La usan `sdd-clasificar` (nivel), el SDD Orquestador (si exige SDD Seguridad) y el SDD Reviewer (punto 8 del checklist). Ningún otro archivo debe tener su propia versión.

| # | Superficie | Ejemplos |
| --- | --- | --- |
| 1 | **Autenticación y autorización** | Login, tokens, refresh, sesiones, guards de NestJS, middleware de auth en Express, guards de rutas en Angular, almacenamiento de tokens en Flutter |
| 2 | **Bypass de auth** | Rutas que saltan el guard, flags que desactivan validaciones, modos debug con sesión, usuarios de prueba |
| 3 | **Datos personales** | Nombre, RUT, email, teléfono, dirección, fecha de nacimiento, datos laborales en nóminas, ubicación del dispositivo |
| 4 | **Pagos y dinero** | Montos, cobros, reversas, reembolsos, comisiones, nóminas de pago, botón de pago, pago de servicios e impuestos, tarjetas, liquidaciones a comercios, integración con pasarelas o adquirentes |
| 5 | **Endpoint público nuevo con efecto** | Ruta nueva que lee datos guardados, escribe datos o pasa lo que recibe a una consulta, un archivo u otro servicio. No cuentan: una lista fija en el código, un cálculo en memoria, un chequeo de salud o de versión |
| 6 | **Secretos y credenciales** | `.env*`, `*secret*`, `*credentials*`, claves, certificados, keystores, `google-services.json`, `GoogleService-Info.plist` |
| 7 | **Configuración de despliegue** | Pipelines, `Dockerfile`, variables de ambiente, firma de apps, configuración de tiendas |
| 8 | **Acceso a datos** | Queries, migraciones, esquema de base de datos, repositorios, permisos de lectura o escritura |
| 9 | **Rutas marcadas por el líder técnico** | Módulos que el líder técnico declaró en `.github/instructions/` como de revisión obligatoria |

**Ante la duda, cuenta como sensible.** Una revisión de más cuesta tiempo; una de menos, un incidente.

## Qué no es superficie sensible

Textos de pantalla, formato y estilo, comentarios, documentación, tests que no usan datos reales, y refactor interno sin cambio de contrato ni de acceso a datos.
