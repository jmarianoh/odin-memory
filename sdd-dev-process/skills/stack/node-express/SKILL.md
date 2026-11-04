---
name: node-express
description: Buenas prácticas para APIs y BFF con Node.js y Express 5, basadas en las guías oficiales de expressjs.com y nodejs.org. Usar al crear o revisar rutas, middlewares, controllers, servicios, manejo de errores, validación, seguridad, logging, configuración o tests (supertest) en un repo Express.
license: MIT
metadata:
  author: sdd-dev-process (gerencia)
  version: "0.1.0"
  fuentes: "expressjs.com (security, performance, error handling) · nodejs.org/learn (security best practices)"
---

# Node.js + Express

No hay una skill oficial del equipo de Express. Esta skill resume las guías oficiales de [expressjs.com](https://expressjs.com) y [nodejs.org](https://nodejs.org/en/learn). **El template del arquetipo manda**: si el repo ya tiene una convención (módulos ESM o CommonJS, JavaScript o TypeScript, framework de tests, logger), síguela y avisa si choca con esta skill.

## 1. Antes de escribir código

1. Revisa la versión de Express en `package.json`. Esta skill asume **Express 5**; con Express 4, el manejo de errores asíncronos cambia (ver sección 4).
2. Revisa la versión de Node (`.nvmrc`, `engines`, imagen del `Dockerfile`). Usa solo APIs disponibles en esa versión LTS.
3. Mira cómo están organizadas las rutas vecinas y repite el patrón.

## 2. Estructura por capas

```
src/
├── app.(js|ts)          # crea la app: middlewares, rutas, 404, manejador de errores. No hace listen
├── server.(js|ts)       # listen, señales y cierre ordenado
├── config/              # lectura y validación de variables de ambiente, una sola vez al arrancar
├── routes/              # define rutas y encadena middlewares; sin lógica de negocio
├── controllers/         # traduce HTTP ↔ dominio: lee req, llama al servicio, arma res
├── services/            # reglas de negocio; no conocen req ni res
├── clients/             # llamadas a otros servicios (con timeout)
├── middlewares/         # auth, validación, correlación de requests
└── errors/              # clases de error con status y código de negocio
```

- Separar `app` de `server` permite testear con supertest sin abrir puertos.
- Un controller no habla con la base de datos ni con otros servicios: eso es del servicio o del cliente.
- Cada endpoint implementa exactamente el contrato del plan (ruta, campos, códigos de respuesta y códigos de error del cuerpo).

## 3. Validación de entrada

- Valida `params`, `query` y `body` con un esquema (la librería que use el template, por ejemplo Zod o Joi) en un middleware antes del controller.
- Rechaza campos desconocidos en escritura; ignora campos desconocidos al **leer** respuestas de otros servicios (tolerant reader).
- Limita el tamaño del cuerpo: `app.use(express.json({ limit: '100kb' }))`, ajustado a lo que pida el contrato.
- Redirecciones: solo a hosts permitidos; valida con `new URL(...)` dentro de un `try`.

## 4. Manejo de errores

- **Express 5:** si un handler `async` lanza o una promesa rechaza, Express llama a `next(err)` solo. No hace falta `try/catch` alrededor de cada `await`.
- **Express 4:** envuelve los handlers asíncronos o llama `next(err)` explícitamente; sin eso, la promesa rechazada no llega al manejador.
- Callbacks y timers (`setTimeout`, APIs con callback) no pasan por las promesas: usa `try/catch` y `next(err)`.
- Un solo manejador de errores, con firma de cuatro argumentos, registrado **después** de todas las rutas:

```js
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status ?? 500;
  logger.error({ err, requestId: req.id }, 'error en request');
  res.status(status).json({
    codigo: err.codigo ?? 'ERROR_INTERNO',
    mensaje: status >= 500 ? 'Ocurrió un error inesperado' : err.message,
  });
});
```

- No escuches `uncaughtException` para seguir funcionando: deja que el proceso caiga y que el orquestador lo reinicie.
- Agrega un manejador de 404 propio antes del de errores, para no exponer el mensaje por defecto.

## 5. Seguridad (guía oficial de producción)

- `app.use(helmet())` y `app.disable('x-powered-by')`.
- Rate limit en login y en rutas sensibles.
- Cookies con `httpOnly`, `secure`, `sameSite` y un nombre genérico; `app.set('trust proxy', 1)` si va detrás de un proxy.
- Queries parametrizadas; nunca concatenar la entrada en SQL o NoSQL.
- CORS con lista de orígenes por ambiente, sin comodín en productivo.
- `npm audit --omit=dev` sin vulnerabilidades altas o críticas.
- Si el pedido tiene superficie sensible, aplica además la skill `sdd-seguridad`.

## 6. Rendimiento y operación

- Nada de funciones síncronas (`fs.readFileSync`, `crypto.*Sync`) dentro de un request; solo al arrancar.
- Trabajo de CPU pesado fuera del event loop (worker threads con un pool fijo).
- Logs con el logger del template (por ejemplo Pino), estructurados y sin datos sensibles. Nada de `console.log` en código productivo.
- `NODE_ENV=production` en los ambientes productivos.
- Clientes HTTP salientes con timeout explícito y propagación del identificador de correlación.
- Procesos sin estado: sesiones y caché compartida en un almacén externo.
- Cierre ordenado: al recibir `SIGTERM`, deja de aceptar conexiones, termina las que están en curso y cierra conexiones a base de datos.

## 7. Tests

- Unitarios para servicios (sin HTTP). Integración de rutas con `supertest` contra `app`, sin levantar el servidor.
- Mocks solo en los bordes (clientes HTTP, base de datos), nunca del servicio que se está probando.
- El nombre del test que cubre un escenario empieza con el número de la spec: `004 › responde 422 si el monto supera el límite`.
- Usa el runner del template (Jest, Vitest o `node:test`) y su comando de `package.json`.

## Fuentes

- [Express: Production best practices · security](https://expressjs.com/en/advanced/best-practice-security.html)
- [Express: Production best practices · performance and reliability](https://expressjs.com/en/advanced/best-practice-performance.html)
- [Express: Error handling](https://expressjs.com/en/guide/error-handling.html)
- [Express: Migrating to Express 5](https://expressjs.com/en/guide/migrating-5.html)
- [Node.js: Security best practices](https://nodejs.org/en/learn/getting-started/security-best-practices)
