---
name: sdd-seguridad
description: Checklist de seguridad para pedidos con superficie sensible (auth, datos personales, pagos, endpoint público con efecto) en NestJS, Express, Angular y Flutter, y plantilla del informe seguridad.md. Usar en la revisión del SDD Seguridad, cuando el SDD Reviewer evalúa el punto de seguridad o al planificar un pedido sensible.
---

# Revisión de seguridad

Severidades: 🔴 **Crítico** (explotable o expone dinero o datos ya) · 🟠 **Alto** (explotable con condiciones) · 🟡 **Medio** (debilita una defensa) · 🔵 **Bajo** (mejora). Veredicto `sin bloqueantes` solo con cero 🔴 y cero 🟠.

Cada hallazgo lleva `archivo:línea`, la evidencia (código o salida de comando) y la corrección. Sin evidencia no hay hallazgo.

## Base (siempre)

- [ ] Secretos solo por variables de ambiente o el gestor de secretos; nada en el código, en `assets/`, en `environment*.ts` ni en el binario de la app.
- [ ] Toda entrada se valida en el servidor (tipo, rango, largo, formato) antes de procesar, guardar o enviar a otro sistema. El cliente no es fuente de verdad.
- [ ] Sin concatenar entradas en queries SQL o NoSQL, comandos de sistema, rutas de archivo ni URLs de redirección.
- [ ] Errores al cliente con mensaje genérico; el detalle va solo a los logs. Sin stack traces, nombres de tablas ni versiones.
- [ ] Logs estructurados, sin contraseñas, tokens, números de tarjeta, CVV, RUT completos ni cuerpos completos de requests.
- [ ] Timeouts en todo cliente HTTP saliente; reintentos solo en operaciones idempotentes.
- [ ] TLS sin desactivar la verificación de certificados. CORS sin comodín en ambientes productivos.
- [ ] Control de acceso en cada endpoint (OWASP A01): el usuario solo ve y modifica lo suyo; los IDs que llegan del cliente se verifican contra el usuario autenticado.
- [ ] Dependencias sin vulnerabilidades altas o críticas conocidas (comando del stack, abajo).

## Por superficie

**Autenticación y autorización**
- [ ] Tokens con expiración corta, firma verificada, algoritmo fijo (sin `none`) y audiencia o emisor validados.
- [ ] Rate limit en login, recuperación de clave y validación de OTP.
- [ ] Ninguna ruta nueva queda fuera del guard o middleware de auth sin una razón escrita en el plan.

**Datos personales** (Ley 19.628 y Ley 21.719 de protección de datos personales)
- [ ] Solo se piden y guardan los datos que la spec necesita.
- [ ] Datos personales enmascarados en pantallas, logs y respuestas que no los necesitan completos.
- [ ] Nada de datos personales en URLs, query strings, analítica ni almacenamiento local sin cifrar.

**Pagos y dinero**
- [ ] Los montos se calculan y validan en el servidor; el monto que envía el cliente nunca se usa sin comparar contra la fuente (deuda, orden, nómina).
- [ ] Montos en enteros (pesos o centavos) o decimal exacto; nunca `float` ni `double` para dinero.
- [ ] Operaciones de cobro, pago o abono idempotentes (llave de idempotencia o estado), para evitar doble cobro ante reintentos o doble clic.
- [ ] Límites y validaciones de negocio (monto máximo, cuentas destino, horarios) del lado del servidor.
- [ ] No se guardan número de tarjeta completo, CVV ni datos de banda (PCI DSS); se usa el token de la pasarela.
- [ ] Callbacks o webhooks de pasarelas verificados (firma o secreto compartido) antes de cambiar el estado de un pago.
- [ ] Estados de un pago con transiciones válidas explícitas; un pago confirmado no vuelve a pendiente.

**Endpoint público nuevo con efecto**
- [ ] Autenticación o justificación escrita de por qué es público.
- [ ] Límite de tamaño del cuerpo y rate limit.
- [ ] Respuesta sin más datos de los que pide el contrato.

## Por stack

**NestJS**
- [ ] `ValidationPipe` global con `whitelist: true` y `forbidNonWhitelisted: true`; DTO con `class-validator` en cada entrada.
- [ ] Guards de auth y de roles en controllers nuevos; nada de `@Public()` sin justificación.
- [ ] `helmet` y `@nestjs/throttler` activos; `ConfigModule` para secretos.
- [ ] Filtro de excepciones que no expone detalles internos.

**Express**
- [ ] `helmet()`, `app.disable('x-powered-by')` y manejador propio de 404 y de errores.
- [ ] `express.json({ limit })` con un límite explícito; validación de entrada con un esquema (por ejemplo, Zod o Joi).
- [ ] Rate limit en rutas de auth; cookies con `httpOnly`, `secure` y `sameSite`; `trust proxy` configurado si va detrás de un proxy.
- [ ] Redirecciones solo a hosts permitidos.

**Angular**
- [ ] Sin `bypassSecurityTrust*` ni `[innerHTML]` con contenido de usuario sin sanitizar.
- [ ] Tokens fuera de `localStorage` cuando la arquitectura lo permite; si no, justificado en el plan.
- [ ] Interceptor que agrega credenciales solo a dominios propios.
- [ ] Ningún secreto ni URL interna sensible en `environment*.ts` (todo eso llega al navegador).

**Flutter**
- [ ] Tokens y datos sensibles en almacenamiento seguro (Keychain o Keystore, por ejemplo con `flutter_secure_storage`), nunca en `SharedPreferences`.
- [ ] Sin claves ni secretos en el código Dart ni en `assets/`: el binario se puede descompilar.
- [ ] Solo HTTPS; evaluar certificate pinning en flujos de pago.
- [ ] Sin `print` ni `debugPrint` con datos sensibles; build de release con `--obfuscate --split-debug-info`.
- [ ] Deep links validados antes de navegar o ejecutar acciones.

## Dependencias

| Stack | Comando (solo lectura) |
| --- | --- |
| NestJS, Express, Angular | `npm audit --omit=dev` |
| Flutter | `flutter pub outdated` y, si está disponible, `osv-scanner --lockfile=pubspec.lock` |

No corras `npm audit fix`, `npm install` ni `flutter pub upgrade`: actualizar dependencias es un FDT aparte.

## Ethical hacking

Antes de cada pase, el área de ethical hacking prueba la versión en QA. Esta revisión no la reemplaza: la prepara.

- `seguridad.md` va como insumo para esa área: superficies, hallazgos y su estado.
- Un hallazgo de ethical hacking es un defecto de Jira enlazado a la historia. Crítico y alto bloquean el pase. La corrección pasa por esta revisión antes del MR.
- Si el hallazgo no estaba en esta checklist, se agrega aquí por MR a sdd-dev-process.

## Informe

Usa [references/plantilla-informe.md](references/plantilla-informe.md) y guárdalo como `seguridad.md` en la carpeta del pedido.
