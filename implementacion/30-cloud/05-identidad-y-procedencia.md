# 30.05 — Identidades gestionadas, administración y procedencia de prompts

Spec 0.27.0 (F9.2c, primera parte). Añade al servidor de la nube personas con tokens propios y permisos por proyecto, su API de administración, la auditoría de autenticación y las rutas de **procedencia de prompts**; añade al cliente la comprobación previa que usa esas rutas y la orden `odin cloud bootstrap`.

## Modos de autenticación (resumen)

| Modo | Cuándo | Principal | Proyectos permitidos |
|---|---|---|---|
| Abierto | sin `ODIN_CLOUD_TOKEN` | `null` | lista del servidor |
| Heredado de sincronización | token = `ODIN_CLOUD_TOKEN` | `{id:'legacy:sync', kind:'legacy', displayName:'LEGACY_SYNC', role:'member', source:'legacy_env_sync'}` | lista del servidor |
| Heredado de administración | token = `ODIN_CLOUD_ADMIN` | `{id:'legacy:admin', …'OPERATOR', role:'admin', source:'legacy_env_admin'}` | lista del servidor |
| Gestionado | token `odc_…` con resumen en la base | fila de `cloud_principals` (`source:'managed_token'`, `tokenId`) | **solo** los permisos de `cloud_project_grants` del principal |

Orden de `#authenticate(req)` (cabecera ya validada como `Bearer <secreto>`): token de sincronización → token de administración → (si hay `hasher`) token gestionado. Sin `hasher` (no hay `ODIN_CLOUD_TOKEN_PEPPER`) cualquier otro secreto es `unknown token`. Un fallo responde 401 de texto plano `unauthorized: <motivo>` y anota en la auditoría `{actorSource:'request', action:'sync.auth', outcome:'denied', reasonCode:<código>, metadata:{source:'request'}}`. Códigos: `missing_header`, `malformed_bearer`, `unknown_token`, `token_revoked`, `principal_disabled`, `token_principal_mismatch`, `resolver_error` (error inesperado; solo se registra en el log del servidor).

Resolución de un token gestionado (`#resolveManaged`): `findPrincipalTokenByHash(hasher.hash(secreto))` → si `token.principalId` está vacío o difiere del `principal.id` → `mismatch`; si `revokedAt` → `tokenRevoked`; si el principal no está habilitado → `principalDisabled`; después `markPrincipalTokenUsed(token.id)` (actualiza `last_used_at`; sus errores de carrera se traducen a los mismos códigos). El principal resultante es `{…fila, source:'managed_token', tokenId}`.

### Autorización por proyecto (`server.authorizeProject(res, proyecto, principal)`)

1. Con token configurado y principal `null` → 403 `policy_forbidden` «forbidden: principal is required».
2. Principal «gestionado» (`source==='managed_token'` o `kind` `human`/`service_account`): permitido si `listProjectGrants(principal.id)` contiene `normalizeProjectGrant(proyecto)`.
3. Cualquier otro: la lista permitida del servidor.
4. Si no se permite: log, auditoría `{actorPrincipalId:<id numérico o ''>, actorSource:<source|'request'>, project, action:'sync.authorize', outcome:'denied', reasonCode:'project_forbidden'}` y 403 `policy_forbidden` «forbidden: project "p" is not allowed».

`GET /sync/mutations/pull`: un principal gestionado ve las mutaciones de **sus proyectos concedidos**; los demás, las de la lista permitida. `project` de la respuesta es el primero de esa lista. El autor de un chunk (`created_by`) es el `id` del principal si no es heredado.

## Tokens (`src/cloud/server/tokens.js`)

- Formato: `odc_<entorno>_<8 hex>_<secreto>`. `entorno` = argumento en minúsculas con `[^a-z0-9]+`→`-` y sin guiones en los bordes (vacío → `live`). El secreto son 32 bytes aleatorios en base64url con `_`→`-` (así `_` solo separa campos). `prefix` = `odc_<entorno>_<8 hex>` (se puede mostrar y guardar); el secreto nunca.
- `ManagedTokenHasher(pepper)`: pimienta de **al menos 32 bytes** (`dedicated cloud token pepper is required` / `… must be at least 32 bytes`), distinta de `ODIN_JWT_SECRET`. `hash(token)` = `"hmac-sha256:v1:" + base64url(HMAC-SHA256(pimienta, "odin-cloud-token:v1:" + token recortado))`; token vacío → `managed token is required`. `verify(token, resumen)` compara en tiempo constante y devuelve `false` si el resumen no empieza por el prefijo de versión.
- Constantes: `PRINCIPAL_SOURCE` (`managed_token`, `legacy_env_sync`, `legacy_env_admin`, `bootstrap_cli`, `insecure_dev`), `ROLE` (`admin`, `member`), `KIND` (`human`, `service_account`, `legacy`), `AuthError` con `code`.

## Almacén de identidades (`src/cloud/server/identity.js`)

DDL (se ejecuta en `migrate()` después de las tablas de chunks y mutaciones):

```sql
CREATE TABLE IF NOT EXISTS cloud_principals (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('human','service_account')), display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')), enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
-- índices idx_cloud_principals_kind / _role / _enabled
CREATE TABLE IF NOT EXISTS cloud_human_users (
  principal_id BIGINT PRIMARY KEY REFERENCES cloud_principals(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL, email TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS cloud_principal_tokens (
  id BIGSERIAL PRIMARY KEY, principal_id BIGINT NOT NULL REFERENCES cloud_principals(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
  created_by_principal_id BIGINT REFERENCES cloud_principals(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, revoked_by_principal_id BIGINT REFERENCES cloud_principals(id), revocation_reason TEXT);
-- índices idx_cloud_principal_tokens_prefix (token_prefix) y _principal_revoked (principal_id, revoked_at)
CREATE TABLE IF NOT EXISTS cloud_project_grants (
  principal_id BIGINT NOT NULL REFERENCES cloud_principals(id) ON DELETE CASCADE, project TEXT NOT NULL,
  granted_by_principal_id BIGINT REFERENCES cloud_principals(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (principal_id, project));
CREATE TABLE IF NOT EXISTS cloud_auth_audit_log (
  id BIGSERIAL PRIMARY KEY, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_principal_id BIGINT REFERENCES cloud_principals(id), actor_source TEXT NOT NULL,
  target_principal_id BIGINT REFERENCES cloud_principals(id), project TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL,
  reason_code TEXT, metadata JSONB);
```

Copiar la definición literal de `cloud_auth_audit_log` y sus índices de `DDL` en `store.js` (el servidor los define; este documento solo fija los nombres y las restricciones).

`identityMethods` se mezcla en `CloudStore.prototype` (`Object.assign`). Todas las funciones recortan sus textos con `goTrim`; los errores llevan `.code` y mensaje `cloudstore: …`.

| Método | Comportamiento |
|---|---|
| `createHumanUser({username,email,displayName,role})` | `username` obligatorio (`username is required`); rol en `admin`/`member` (`invalid_role`); `displayName` por defecto el usuario. Transacción; con rol `admin` toma el cerrojo `pg_advisory_xact_lock(hashtext('odin_cloud_active_admin_guard'))`. Devuelve `{principal_id, username, email, display_name, role, enabled, created_at}` (`created_at` RFC 3339 UTC sin ceros finales) |
| `createFirstAdminHumanUser` | Igual con rol `admin`, pero bajo el cerrojo falla con `admin_already_exists` si ya hay un administrador **habilitado** |
| `listHumanUsers()` | Por `principal_id` ascendente |
| `setHumanUserEnabled(id, enabled)` | Inexistente → error `not_found`. Deshabilitar al último administrador habilitado → `last_active_admin` (bajo el mismo cerrojo) |
| `createPrincipalTokenWithAudit(params, audit)` | Exige `principalId`, `tokenPrefix`, `tokenHash`; principal inexistente → `principal_not_found`; deshabilitado → `principal_disabled`. Inserta el token y, si `audit` no es `null`, el evento en la **misma transacción** (un fallo de auditoría deshace el token y se reporta como `audit_insert_failed` con `cause`). Devuelve los metadatos del token (sin hash) |
| `recoverStrandedAdminTokenWithAudit({tokenPrefix,tokenHash,name,revokeExisting}, audit)` | Ver «Recuperación» |
| `listPrincipalTokens(id)` | Metadatos por `id` ascendente: `{id, principalId, tokenPrefix, name, createdByPrincipalId, createdAt, lastUsedAt, revokedAt, revokedByPrincipalId, revocationReason}` (fechas o `null`) |
| `findPrincipalTokenByHash(hash)` | `{token, principal}` o error `token_not_found` (hash vacío → `token hash is required`). `principal` = `{id, kind, displayName, role, enabled}` |
| `markPrincipalTokenUsed(id)` | Actualiza `last_used_at`; `token_not_found`, `token_revoked`, `principal_disabled` |
| `revokePrincipalToken(id, revocadoPor, motivo)` | Marca `revoked_at`, `revoked_by_principal_id` (vacío → NULL) y el motivo recortado; inexistente o ya revocado → `not_found` |
| `createProjectGrant(principalId, proyecto, concedidoPor)` / `listProjectGrants(id)` / `revokeProjectGrant(id, proyecto)` | El proyecto se normaliza con `normalizeProjectGrant`; repetir una concesión es inocuo; `listProjectGrants` devuelve `{principal_id, project, granted_by_principal_id, created_at}` por proyecto |
| `hasActiveAdmin()` | ¿Hay un administrador habilitado? |
| `insertAuthAuditEvent(evento)` / `listAuthAuditEvents({limit})` | Ver «Auditoría» |

`normalizeProjectGrant(p)`: nombre canónico del proyecto (`normalizeProject`), con `[^a-z0-9._]+`→`-` y sin guiones en los bordes; vacío si no queda nada.

### Auditoría de autenticación

`insertAuthAuditEvent({actorPrincipalId, actorSource, targetPrincipalId, project, action, outcome, reasonCode, metadata})`: `actorSource`, `action` y `outcome` obligatorios (`actor source is required`, `action is required`, `outcome is required`); los ids vacíos y el proyecto vacío se guardan como NULL; `metadata` vacío se guarda como NULL. **Nunca guarda secretos**: se rechaza (`cloudstore: sensitive auth audit metadata is not allowed: <clave>`) cualquier clave, en cualquier nivel de objetos y listas, cuyo nombre en minúsculas contenga `token`, `authorization`, `cookie`, `secret`, `hash`, `password` o `bearer`, salvo la clave exacta `token_prefix` y la clave `issued_token` cuando su valor es booleano. `listAuthAuditEvents({limit})` devuelve los más recientes primero (límite por defecto 100; no positivo o mayor que 500 → 100), con `{id, occurredAt, actorPrincipalId, actorSource, targetPrincipalId, project, action, outcome, reasonCode, metadata}`.

Acciones que se anotan: `sync.auth` (denegada), `sync.authorize` (denegada), `user.create`, `user.enable`, `user.disable`, `token.create`, `token.revoke`, `grant.create`, `grant.revoke` (todas `success`, con `actorSource` del principal) y `bootstrap.cli`.

### Recuperación del administrador atascado

`recoverStrandedAdminTokenWithAudit` (solo la usa `odin cloud bootstrap recover-token`) bloquea los administradores humanos habilitados (`FOR UPDATE`) y el cerrojo anterior, y exige:

1. **Exactamente un** administrador humano habilitado (`requires exactly one enabled managed human admin, found N`).
2. Sin tokens en `cloud_principal_tokens` (`requires zero principal tokens, found N`), **o** con `revokeExisting`: exactamente un token activo (`replacement requires exactly one active principal token, found N`), propiedad de ese administrador y **sin uso** (`replacement requires one unused active token owned by the sole enabled managed human admin`); ese token se revoca con motivo `stranded_admin_token_replaced` y `revoked_by` el administrador.

Después inserta el token (`created_by` = el administrador) y el evento `{actorSource:'bootstrap_cli', action:'bootstrap.cli', outcome:'success', reasonCode:'stranded_admin_token_recovered', target:<admin>}`. Los fallos de elegibilidad llevan `.code === 'recovery_ineligible'`.

## API de administración (`src/cloud/server/admin.js`)

Todas las rutas exigen autenticación y un **administrador gestionado habilitado** (principal con `source==='managed_token'` y `role==='admin'`); si no: 403 con `forbidden: managed admin principal is required` (los tokens heredados **no** sirven). Los cuerpos son JSON con campos de texto y **solo** los campos listados (vacío o `null` ⇒ todos vacíos; campo desconocido o de otro tipo ⇒ 400). Los errores de entrada usan `error_code` `upgrade_repairable_payload_invalid` (400).

| Ruta | Cuerpo | Respuesta |
|---|---|---|
| `GET /admin/users` | — | Lista de usuarios |
| `POST /admin/users` | `username`, `email`, `display_name`, `role` (por defecto `member`) | 201 usuario; 400 si falla el almacén |
| `POST /admin/users/{principalID}/enable` · `/disable` | — | 200 `{"enabled":bool,"principal_id":"…","status":"ok"}`; 400 si falla (p. ej. último administrador) |
| `GET /admin/users/{principalID}/tokens` | — | Lista de metadatos de tokens |
| `POST /admin/users/{principalID}/tokens` | `name` | 201 `{"raw_token":"odc_…","token":{metadatos},"status":"ok"}`; 404 `managed user not found`; usuario deshabilitado → 409 `policy_forbidden` «managed user "id" is disabled; enable the user before creating a managed token». **El token en claro solo aparece en esta respuesta** |
| `POST /admin/tokens/{tokenID}/revoke` | `reason` | 200; 400 si el token no existe o ya está revocado |
| `GET /admin/users/{principalID}/grants` | — | Lista de permisos |
| `POST /admin/users/{principalID}/grants` | `project` | 201 permiso (`project` normalizado, `granted_by_principal_id`); vacío → 400 |
| `POST /admin/users/{principalID}/grants/{project}/revoke` | — | 200 |

Cada acción exitosa anota su evento de auditoría (si la anotación falla responde 500 `record auth audit: …`). Los metadatos de token en JSON usan claves en `snake_case` (`token_prefix`, `created_by_principal_id`, `last_used_at`, `revoked_at`, …) y omiten las fechas/ids vacíos. `respond.js` aporta `sendMap` (objeto con claves ordenadas), `actionable(res, status, clase, razón, mensaje)` (error accionable `{error, error_class, error_code, …}`) y `readBuffer(req, tope)`.

## Procedencia de prompts (`src/cloud/server/provenance.js`)

Un *prompt con buzón de origen* nace en una sesión cuyo dueño es otro proyecto: antes de enviarlo hay que saber a quién pertenece la sesión, enlazar el par `(sesión, buzón)` con ese prompt y, si lo afirma una persona, anotar la atestación.

DDL (ejecutado después de las tablas de identidad):

```sql
CREATE TABLE IF NOT EXISTS cloud_session_authority (
  session_id TEXT PRIMARY KEY, owner_project TEXT NOT NULL, registered_by TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS cloud_prompt_pair_claims (
  session_id TEXT NOT NULL REFERENCES cloud_session_authority(session_id), source_inbox_id TEXT NOT NULL,
  sync_id TEXT NOT NULL UNIQUE, prompt_project TEXT NOT NULL, claimed_by TEXT NOT NULL, claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, source_inbox_id));
CREATE TABLE IF NOT EXISTS cloud_prompt_source_attestations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, session_id TEXT NOT NULL, source_inbox_id TEXT NOT NULL, sync_id TEXT NOT NULL,
  owner_project TEXT NOT NULL, prompt_project TEXT NOT NULL, actor_id TEXT NOT NULL, attested_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
```

Métodos de `CloudStore` (`provenanceMethods`):

- `registerSessionAuthority(sesión, proyecto, actor)`: inserta `ON CONFLICT DO NOTHING`; si ya existía con **otro** dueño → `session_authority_conflict`. Repetir con el mismo dueño es inocuo.
- `getSessionAuthority(sesión)` → fila o `null`. `getPromptPairClaim(sesión, buzón)` → fila o `null`.
- `claimPromptPair(sesión, buzón, syncId, proyectoDelPrompt, actor)`: inserta solo si la sesión tiene autoridad. Si no insertó: par ya enlazado con el mismo `sync_id` y proyecto → inocuo; con otro → `prompt_pair_claim_conflict` («pair already bound»); sin autoridad → `session_authority_not_found`; si no, el `sync_id` ya estaba enlazado a otro par → `prompt_pair_claim_conflict` («sync id already bound»).
- `attestPromptSource(sesión, buzón, syncId, dueño, proyectoDelPrompt, actor)`: inserta una atestación **nueva** (cada llamada es un registro) únicamente si coinciden la autoridad (dueño) y el enlace exactos; si no, `attestation_unbound`. Devuelve `{id}`.
- `verifyPromptSourceAttestation(id, sesión, buzón, syncId, dueño, proyectoDelPrompt)` → `true` solo si hay una atestación con exactamente esos seis valores.

Rutas (todas con autenticación; cuerpos JSON de un solo objeto con **exactamente** los campos de cada ruta y sus tipos; otro campo, otro tipo o JSON inválido → 400 `invalid <etiqueta> request`; cuerpo mayor que el tope de subida → 413 `<etiqueta> request too large`; los proyectos se canonicalizan antes de usarse):

| Ruta | Campos | Reglas y respuestas |
|---|---|---|
| `POST /sync/session-authorities` | `session_id`, `project` (etiqueta `session authority`) | Vacíos → 400 `session_id and project are required`. Sin principal y sin modo de autenticación → 401 `authentication unavailable`. Exige `authorizeProject`. Registra la autoridad (actor = `principal.id` o `legacy:authenticated`). 409 `session authority conflict`; 200 `{"status":"ok"}` |
| `POST /sync/prompt-pair-claims` | `session_id`, `source_inbox_id`, `sync_id`, `owner_project`, `project` (`prompt pair claim`) | Requiere modo con autenticación y principal (401 `authentication unavailable`). Vacíos → 400 `session_id, source_inbox_id, sync_id, owner_project and project are required`. Exige permiso sobre **ambos** proyectos. Si la sesión no tiene autoridad o su dueño no es `owner_project` → 404 `{"error":"session authority unavailable","error_code":"session_authority_unavailable"}`. Conflicto → 409 `prompt pair claim conflict`; 200 `{"status":"ok"}` |
| `POST /sync/prompt-source-attestations` | `session_id`, `source_inbox_id`, `sync_id`, `owner_project`, `prompt_project` (`attestation`) | Sin principal → 401 `human authentication required`; `principal.kind` distinto de `human` → 403 `human principal required`. Exige **permiso concedido** (`cloud_project_grants`, no la lista del servidor ni el rol) sobre ambos proyectos: 403 `owner project forbidden` / `prompt project forbidden`. Registra la autoridad (409 `session authority conflict`), enlaza el par (409 `prompt pair conflict`) y anota la atestación (409 `attestation binding conflict`). 200 `{"attestation_id":N,"status":"ok"}` |
| `POST /sync/prompt-source-attestations/verify` | `audit_id` (número), `session_id`, `source_inbox_id`, `sync_id`, `owner_project`, `prompt_project` (`verification`) | Sin principal → 401 `authentication required`; `audit_id` no positivo o campo vacío → 400 `audit id and all verification fields are required`; mismos permisos concedidos que la atestación; no coincide → 409 `attestation binding conflict`; 200 `{"attestation_id":N,"status":"ok"}` |

## Cliente

### `MutationTransport` (ampliación de `src/cloud/remote.js`)

Tres métodos nuevos, con argumentos **posicionales**, que envían `POST` JSON (`Content-Type: application/json`, mismo tiempo de espera, autenticación y clasificación de errores por estado que el resto; un estado distinto de 200 es un error de estado; una respuesta sin `status:"ok"` es `cloud: invalid <operación> response`). Un helper privado `#provenance(operación, ruta, carga)` los comparte:

- `registerSessionAuthority(sessionId, ownerProject)` → `session-authorities` con `{session_id, project}` (operación `register session authority`).
- `claimPromptPair(sessionId, sourceInboxId, syncId, ownerProject, promptProject)` → `prompt-pair-claims` con `{session_id, source_inbox_id, sync_id, owner_project, project}` (`claim prompt pair`).
- `attestPromptSource(sessionId, sourceInboxId, syncId, ownerProject, promptProject)` → `prompt-source-attestations` con `{…, prompt_project}`; cualquier campo vacío → `cloud: attest prompt source: all fields are required`; devuelve el `attestation_id` (entero positivo, si no `invalid … response`).

### Identidad local de un prompt (`src/store/sync-queue.js`)

- `localSessionProvenance(store, sessionId)` → `{owner, eligible}`: `owner` es `sessions.project` (vacío si la sesión no existe); `eligible` solo si `sessions.local_creation_project` no es nulo ni vacío y es igual al `owner` (la sesión se creó localmente bajo ese mismo proyecto y no cambió después).
- `localPromptCreationIdentity(store, syncId)` → `{session, inbox, project, eligible}`: lee la fila viva de `user_prompts` por `sync_id` (si hay más de una → no elegible) o, si no existe, su fila en `prompt_tombstones`. `eligible` solo si `local_creation_session_id`, `local_creation_inbox_id` y `local_creation_project` son no vacíos e iguales a los valores actuales `session_id`, `source_inbox_id` y `project`. Sin fila o `syncId` vacío → todo vacío y no elegible.

### Comprobación previa en el autosync (`src/cloud/autosync.js`)

En `#pushPage`, cada prompt pasa por `promptIdentity(mutación, proyecto)` (carga legible; `sync_id` igual a la clave; mismo proyecto; `session_id` no vacío; si no, `prompt seq N: <motivo>` como antes). Si además lleva `source_inbox_id`, `#preflightPrompt(mutación, {syncId, session, inbox, project})`:

1. El transporte debe tener `registerSessionAuthority` y `claimPromptPair` (si no, error `remote prompt authority unavailable`).
2. Lee `localPromptCreationIdentity(store, syncId)` y `localSessionProvenance(store, session)`; si falla la lectura → error `read local prompt origin: …`.
3. Si la identidad de creación no es elegible o difiere en sesión, buzón o proyecto → `PromptPreflightError('unverified keyed prompt origin')`; si el dueño de la sesión no es elegible o está vacío → `PromptPreflightError('unverified local session owner')`.
4. `registerSessionAuthority(sesión, dueño)` (error → `register session authority: …`) y `claimPromptPair(sesión, buzón, syncId, dueño, proyecto)` (error → `claim prompt pair: …`).

Un fallo omite esa mutación (no se envía ni se acusa) y se acumula como `prompt seq N: …` (un `PromptPreflightError` conserva su tipo). `safeOutboundBlock(err)` es verdadero para `NonEnrolledPendingError`, `PromptPreflightError`, un `JoinedError` no vacío cuyos elementos sean todos seguros y un error cuya `cause` lo sea: en ese caso se anota el bloqueo (`markSyncBlocked`) y se lee igualmente. El motivo anotado es `non_enrolled_pending_mutations` si el bloqueo es solo de proyectos no inscritos y `prompt_provenance_blocked` en los demás casos. Un prompt sin buzón de origen se envía como antes.

### `odin cloud bootstrap` (`src/cli/commands/cloud-bootstrap.js`)

```
usage: odin cloud bootstrap admin --username <name> [--email <email>] [--grant-project <project>]... [--issue-token [name]]
       odin cloud bootstrap recover-token [--name <name>] [--revoke-existing]
admin creates the first managed admin for a self-hosted cloud deployment
recover-token issues one token for the eligible stranded managed admin
--revoke-existing replaces exactly one unused active bootstrap token
```

Sin subcomando: error `a bootstrap subcommand is required`; desconocido: `unknown cloud bootstrap subcommand: X`; `--help`/`-h`: imprime el uso, salida 0. Un error de banderas imprime el uso en la salida estándar y `error: <motivo>` en la de error (código 1).

- `admin`: conecta con `ODIN_DATABASE_URL`, ejecuta `migrate()`, crea el primer administrador (`createFirstAdminHumanUser`), concede cada `--grant-project` (normalizado) y, con `--issue-token` (requiere `ODIN_CLOUD_TOKEN_PEPPER`; `--issue-token [nombre]` toma el siguiente argumento si no empieza por `--`), emite un token gestionado. Salida: `✓ Managed admin created: username=U principal_id=N`, `✓ Project grant created: project=P` por permiso y, con token, una línea en blanco, `Token issued — SHOWN ONCE, copy and store it now, it cannot be retrieved again:` y el token. Si ya hay un administrador: `error: a managed admin already exists; refusing to create a duplicate first admin via CLI bootstrap` (código 1). Audita `bootstrap.cli` con `success`, `bootstrap_completed` y `denied`/`managed_admin_already_exists`.
- `recover-token`: requiere la pimienta (`error: recover-token requires ODIN_CLOUD_TOKEN_PEPPER to be configured (a dedicated cloud token pepper, distinct from ODIN_JWT_SECRET)`); llama a `recoverStrandedAdminTokenWithAudit` (nombre por defecto `cli-bootstrap-recovery`) e imprime `Managed admin token recovered — SHOWN ONCE, copy and store it now, it cannot be retrieved again:` y el token.

`odin cloud serve` construye el `ManagedTokenHasher` a partir de `ODIN_CLOUD_TOKEN_PEPPER` cuando está definida (pimienta inválida ⇒ error de arranque).

## Variables de entorno nuevas

| Variable | Lado | Efecto |
|---|---|---|
| `ODIN_CLOUD_TOKEN_PEPPER` | servidor / bootstrap | Pimienta (≥ 32 bytes) del resumen de tokens gestionados. Sin ella solo valen los tokens heredados |
| `ODIN_CLOUD_ADMIN` | servidor | Ya descrita en el README del capítulo; su token **no** sirve para `/admin` |

## Pruebas

`test/unit/cloud/identity.test.js` (Postgres real): token y resumen, nombres de permisos, protección del último administrador, ciclo de vida de los tokens, auditoría sin secretos, acceso por permisos y rechazos de token, API de administración, procedencia, recuperación, bootstrap por CLI. `test/unit/cloud/autosync.test.js` y `test/unit/store/sync-queue.test.js` cubren la comprobación previa y las identidades locales. Contraste con el servidor de referencia: `upstream/conformance/cloud.conformance.test.mjs` («personas, tokens y permisos gestionados»).
