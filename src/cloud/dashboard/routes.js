import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sendText } from '../../server/http.js';
import { goTrim } from '../../store/text.js';
import { generateManagedToken, KIND, PRINCIPAL_SOURCE, ROLE } from '../server/tokens.js';
import { auditEvent, isManagedAdmin } from '../server/admin.js';
import { actionable, readBuffer } from '../server/respond.js';
import { REASON, UPGRADE_ERROR_CLASS, UPGRADE_ERROR_CODE } from '../constants.js';
import {
  ERR_CONTRIBUTOR_NOT_FOUND, ERR_OBSERVATION_NOT_FOUND, ERR_PROJECT_FORBIDDEN, ERR_PROJECT_INVALID, ERR_PROJECT_NOT_FOUND, ERR_PROMPT_NOT_FOUND, ERR_SESSION_NOT_FOUND,
} from '../server/dashboard-model.js';
import { encodeQuery, loginPathWithNext, parsePaginationRaw, postLoginPath, reclampPagination, sanitizeNext } from './format.js';
import { html, toText } from './html.js';
import { DashboardSessions, readCookie, sessionCookie, SESSION_COOKIE } from './session.js';
import * as views from './views.js';

/** Rutas del panel web: acceso con token, navegador de memoria, proyectos, contribuidores y administración. */

const LOGIN_BODY_LIMIT = 16 * 1024;
const require = createRequire(import.meta.url);
const packageDir = (name) => fileURLToPath(new URL('.', `file://${require.resolve(`${name}/package.json`)}`));

/** Archivos estáticos: dos vienen de las dependencias, la hoja de estilos del propio proyecto. */
const STATIC = {
  'htmx.min.js': { path: () => `${packageDir('htmx.org')}dist/htmx.min.js`, type: 'text/javascript; charset=utf-8' },
  'pico.min.css': { path: () => `${packageDir('@picocss/pico')}css/pico.min.css`, type: 'text/css; charset=utf-8' },
  'styles.css': { path: () => fileURLToPath(new URL('../../../static/styles.css', import.meta.url)), type: 'text/css; charset=utf-8' },
};
const staticCache = new Map();

const isHtmx = (req) => goTrim(req.headers['hx-request'] ?? '').toLowerCase() === 'true';

function sendHtml(res, status, fragment, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(toText(fragment));
}

const redirect = (res, location) => {
  res.writeHead(303, { Location: location });
  res.end();
};

/** Estado y mensaje de un error de lectura del modelo. */
function classifyStoreError(label, err) {
  switch (err?.code) {
    case ERR_PROJECT_INVALID:
    case ERR_PROJECT_NOT_FOUND:
      return [404, 'Project not found', 'No replicated dashboard data exists for that project.'];
    case ERR_PROJECT_FORBIDDEN:
      return [403, 'Project access denied', 'You are not allowed to access that project scope.'];
    case ERR_CONTRIBUTOR_NOT_FOUND:
      return [404, 'Contributor not found', 'No contributor with that name has been seen in this cloud workspace.'];
    case ERR_SESSION_NOT_FOUND:
      return [404, 'Session not found', 'No session with that identifier exists in the specified project.'];
    case ERR_OBSERVATION_NOT_FOUND:
      return [404, 'Observation not found', 'No observation with that identifier exists in the specified session.'];
    case ERR_PROMPT_NOT_FOUND:
      return [404, 'Prompt not found', 'No prompt with that identifier exists in the specified session.'];
    default:
      return [503, `${goTrim(label) || 'Dashboard data'} unavailable`, 'Cloud dashboard data is temporarily unavailable.'];
  }
}

/** Fecha de un filtro: RFC 3339 o `AAAA-MM-DD` (medianoche UTC). */
function parseAuditTime(value) {
  const text = goTrim(value);
  if (text === '') return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(text) && !Number.isNaN(new Date(text).getTime())) return new Date(text);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) return new Date(`${text}T00:00:00Z`);
  throw new Error(`invalid_time_format: ${JSON.stringify(text)} is not RFC3339 or YYYY-MM-DD`);
}

function parseAuditFilter(query) {
  return {
    contributor: goTrim(query.get('contributor') ?? ''), project: goTrim(query.get('project') ?? ''), outcome: goTrim(query.get('outcome') ?? ''),
    occurredAtFrom: parseAuditTime(query.get('from') ?? ''), occurredAtTo: parseAuditTime(query.get('to') ?? ''),
  };
}

function auditListUrl(filter) {
  const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pairs = [['contributor', filter.contributor], ['project', filter.project], ['outcome', filter.outcome]].filter(([, v]) => v !== '');
  if (filter.occurredAtFrom) pairs.push(['from', stamp(filter.occurredAtFrom)]);
  if (filter.occurredAtTo) pairs.push(['to', stamp(filter.occurredAtTo)]);
  return pairs.length === 0 ? '/dashboard/admin/audit-log/list' : `/dashboard/admin/audit-log/list?${encodeQuery(pairs)}`;
}

/**
 * @param {import('../server/server.js').CloudServer} server
 * @param {{ secret?: string, version?: string }} [options]
 */
export function installDashboard(server, options = {}) {
  const sessions = new DashboardSessions(options.secret ?? '');
  const version = options.version ?? '';
  const store = () => server.store;
  const openMode = () => server.token === '';
  const add = (pattern, handler) => server.router.add(pattern, { handler, auth: false });

  /** La persona de la cookie, revalidada contra la base si es gestionada; `null` si no hay sesión válida. */
  async function sessionPrincipal(req) {
    const claimed = sessions.parse(readCookie(req, SESSION_COOKIE));
    if (claimed === null) return null;
    if (claimed.source !== PRINCIPAL_SOURCE.managedToken) {
      return Object.values(PRINCIPAL_SOURCE).includes(claimed.source) && claimed.source !== PRINCIPAL_SOURCE.managedToken ? claimed : null;
    }
    try {
      const current = await store().getPrincipal(claimed.id);
      if (!current.enabled) return null;
      return { id: current.id, kind: current.kind, displayName: current.displayName, role: current.role, enabled: true, source: PRINCIPAL_SOURCE.managedToken, tokenId: claimed.tokenId };
    } catch {
      return null;
    }
  }

  /** Contexto de una petición ya autenticada. */
  function context(req, res, extra, principal) {
    const admin = principal !== null && principal.role === ROLE.admin && (principal.source === PRINCIPAL_SOURCE.managedToken || principal.source === PRINCIPAL_SOURCE.legacyEnvAdmin);
    let viewPromise = null;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const d = {
      req, res, principal, query: url.searchParams, rawQuery: url.search.slice(1), requestUri: `${url.pathname}${url.search}`, params: extra.params ?? {},
      name: goTrim(principal?.displayName ?? '') || 'OPERATOR', isAdmin: admin, canManage: isManagedAdmin(principal), htmx: isHtmx(req),
      view() {
        if (viewPromise === null) {
          viewPromise = principal !== null && (principal.source === PRINCIPAL_SOURCE.managedToken || principal.kind === KIND.human || principal.kind === KIND.serviceAccount)
            ? store().listProjectGrants(principal.id).then((grants) => store().dashboardViewForGrants(grants.map((g) => g.project)))
            : store().dashboardView(server.allowlist.enrolled());
        }
        return viewPromise;
      },
      page(title, tab, content) {
        return views.layout({ title, username: d.name, activeTab: tab, isAdmin: d.isAdmin, version, content });
      },
      send(status, fragment) {
        sendHtml(res, status, fragment);
      },
      /** Página completa, o solo el fragmento si la pide htmx. */
      render(title, tab, fragment, status = 200) {
        sendHtml(res, status, d.htmx ? fragment : d.page(title, tab, fragment));
      },
      storeError(tab, label, err) {
        const [status, headline, message] = classifyStoreError(label, err);
        server.log(`[odin-cloud] dashboard ${label.toLowerCase()} store error: ${err?.message ?? err}`);
        const fragment = html`<div class="empty-state" role="alert"><h3>${headline}</h3><p>${message}</p></div>`;
        if (d.htmx) return sendHtml(res, status, fragment);
        return sendHtml(res, status, d.page(label, tab, html`<section class="frame-section"><p class="section-kicker">DEGRADED</p><h2>${label}</h2>${fragment}</section>`));
      },
      /** Fragmento de una lista que falló: sin página alrededor. */
      partialUnavailable(message = 'Dashboard data is temporarily unavailable.') {
        sendHtml(res, 502, views.emptyState('Service Unavailable', message));
      },
      forbidden() {
        sendText(res, 403, 'forbidden');
      },
    };
    return d;
  }

  /** Envuelve un manejador: exige sesión (o modo abierto) y arma el contexto. */
  const guarded = (handler) => async (c) => {
    const { req, res } = c;
    let principal = null;
    if (!openMode()) {
      principal = await sessionPrincipal(req);
      if (principal === null) {
        req.resume();
        const login = loginPathWithNext(req.url ?? '/');
        if (isHtmx(req)) {
          res.writeHead(401, { 'HX-Redirect': login });
          res.end();
        } else {
          redirect(res, login);
        }
        return;
      }
    }
    try {
      await handler(context(req, res, c, principal));
    } catch (err) {
      server.log(`[odin-cloud] dashboard handler error: ${err?.stack ?? err}`);
      if (!res.headersSent) sendText(res, 500, 'internal error');
    }
  };
  const get = (path, handler) => add(`GET ${path}`, guarded(handler));
  const post = (path, handler) => add(`POST ${path}`, guarded(handler));
  const adminOnly = (handler) => (d) => (d.isAdmin ? handler(d) : d.forbidden());
  const trimmed = (value) => goTrim(value ?? '');

  // ─── Estáticos, salud y acceso ────────────────────────────────────────────

  add('GET /dashboard/static/{file}', ({ res, params }) => {
    const entry = Object.hasOwn(STATIC, params.file) ? STATIC[params.file] : null;
    if (entry === null) return sendText(res, 404, '404 page not found');
    if (!staticCache.has(params.file)) staticCache.set(params.file, readFileSync(entry.path()));
    res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'public, max-age=300' });
    return res.end(staticCache.get(params.file));
  });

  add('GET /dashboard/health', ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok","subsystem":"dashboard"}');
  });

  add('GET /dashboard/login', async ({ req, res }) => {
    const next = sanitizeNext(new URL(req.url, 'http://localhost').searchParams.get('next') ?? '');
    if (openMode() || (await sessionPrincipal(req)) !== null) return redirect(res, postLoginPath(next));
    return sendHtml(res, 200, views.loginPage({ error: '', next, version }));
  });

  /** Auditoría de un acceso; el éxito falla cerrado, el rechazo es de mejor esfuerzo. */
  async function auditLogin(principal, outcome, reasonCode, extraMetadata = {}) {
    const source = principal?.source ?? 'unauthenticated';
    await store().insertAuthAuditEvent({
      actorPrincipalId: principal?.source === PRINCIPAL_SOURCE.managedToken ? principal.id : '', actorSource: source, action: 'dashboard.login', outcome, reasonCode,
      metadata: { source, role: principal?.role ?? '', ...extraMetadata },
    });
  }

  add('POST /dashboard/login', async ({ req, res }) => {
    let form;
    try {
      form = new URLSearchParams((await readBuffer(req, LOGIN_BODY_LIMIT)).toString('utf8'));
    } catch (err) {
      return sendText(res, err?.name === 'BodyTooLargeError' ? 413 : 400, err?.name === 'BodyTooLargeError' ? `login payload too large (max ${LOGIN_BODY_LIMIT} bytes)` : 'invalid form payload');
    }
    const token = trimmed(form.get('token'));
    const next = sanitizeNext(form.get('next') ?? '') || sanitizeNext(new URL(req.url, 'http://localhost').searchParams.get('next') ?? '');
    if (openMode() || (await sessionPrincipal(req)) !== null) return redirect(res, postLoginPath(next));
    if (token === '') return sendHtml(res, 200, views.loginPage({ error: 'token is required', next, version }));
    const outcome = await server.principalForToken(token);
    if (outcome.failure !== null) {
      try {
        await auditLogin(null, 'denied', 'invalid_token');
      } catch (err) {
        server.log(`[odin-cloud] dashboard login audit insert failed (best-effort): ${err.message}`);
      }
      return sendHtml(res, 200, views.loginPage({ error: 'invalid token', next, version }));
    }
    const { principal } = outcome;
    const extra = {};
    if (principal.source === PRINCIPAL_SOURCE.legacyEnvAdmin) {
      try {
        if (await store().hasActiveAdmin()) extra.recovery = true;
      } catch (err) {
        server.log(`[odin-cloud] dashboard legacy recovery check failed (active admin lookup): ${err.message}`);
        extra.recovery_check_failed = true;
      }
    }
    try {
      await auditLogin(principal, 'success', '', extra);
    } catch (err) {
      server.log(`[odin-cloud] dashboard login audit failed: ${err.message}`);
      return sendText(res, 500, 'unable to create dashboard session');
    }
    res.writeHead(303, { Location: postLoginPath(next), 'Set-Cookie': sessionCookie(req, sessions.mint(principal)) });
    return res.end();
  });

  add('POST /dashboard/logout', ({ req, res }) => {
    req.resume();
    res.writeHead(303, { Location: '/dashboard/login', 'Set-Cookie': sessionCookie(req, '', true) });
    res.end();
  });

  // ─── Inicio, estadísticas y actividad ─────────────────────────────────────

  const home = (d) => d.render('Dashboard', 'dashboard', views.dashboardHome(d.name));
  get('/dashboard', home);
  get('/dashboard/', home);

  get('/dashboard/stats', async (d) => {
    let overview;
    try {
      overview = (await d.view()).adminOverview();
    } catch (err) {
      return d.storeError('dashboard', 'Stats', err);
    }
    return d.render('Stats', 'dashboard', views.statsSection(overview));
  });

  get('/dashboard/activity', async (d) => {
    let rows;
    try {
      rows = (await d.view()).listRecentObservations(trimmed(d.query.get('project')), trimmed(d.query.get('q')), 25);
    } catch (err) {
      return d.storeError('dashboard', 'Activity', err);
    }
    return d.render('Activity', 'dashboard', views.activitySection(rows, d.rawQuery));
  });

  // ─── Navegador ────────────────────────────────────────────────────────────

  get('/dashboard/browser', async (d) => {
    const project = trimmed(d.query.get('project'));
    const search = trimmed(d.query.get('q'));
    const type = trimmed(d.query.get('type'));
    let projects = [];
    let types = [];
    try {
      const view = await d.view();
      projects = view.listProjects('').map((p) => p.Project);
      types = view.listDistinctTypes();
    } catch {
      // Sin datos el navegador sigue mostrando su estructura.
    }
    return d.render('Browser', 'browser', views.browserPage({ projects, types, project, search, type }));
  });

  /** Lista paginada del navegador o de una vista parcial por proyecto. */
  async function pagedList(d, { tab, label, fetchPage, render, base, shell }) {
    const { page, pageSize } = parsePaginationRaw(d.query);
    let view;
    let rows;
    let total;
    try {
      view = await d.view();
      ({ rows, total } = fetchPage(view, pageSize, (page - 1) * pageSize));
    } catch (err) {
      return d.storeError(tab, label, err);
    }
    const { pg, refetch } = reclampPagination(page, pageSize, total);
    if (refetch) {
      try {
        rows = fetchPage(view, pageSize, pg.offset).rows;
      } catch (err) {
        server.log(`[odin-cloud] dashboard re-fetch ${label.toLowerCase()} page ${pg.page}: ${err.message}`);
      }
    }
    if (d.htmx) return d.send(200, render(rows, pg, base));
    return d.send(200, d.page('Browser', 'browser', shell()));
  }

  const q = (d) => trimmed(d.query.get('q'));
  const browserShell = (d) => () => views.browserPage({ projects: [], types: [], project: trimmed(d.query.get('project')), search: q(d), type: trimmed(d.query.get('type')) });

  get('/dashboard/browser/observations', (d) => pagedList(d, {
    tab: 'browser', label: 'Observations', base: '/dashboard/browser/observations', render: views.observationsPartial, shell: browserShell(d),
    fetchPage: (view, limit, offset) => view.listRecentObservationsPaginated(trimmed(d.query.get('project')), q(d), trimmed(d.query.get('type')), limit, offset),
  }));
  get('/dashboard/browser/sessions', (d) => pagedList(d, {
    tab: 'browser', label: 'Sessions', base: '/dashboard/browser/sessions', render: views.sessionsPartial, shell: browserShell(d),
    fetchPage: (view, limit, offset) => view.listRecentSessionsPaginated(trimmed(d.query.get('project')), q(d), limit, offset),
  }));
  get('/dashboard/browser/prompts', (d) => pagedList(d, {
    tab: 'browser', label: 'Prompts', base: '/dashboard/browser/prompts', render: views.promptsPartial, shell: browserShell(d),
    fetchPage: (view, limit, offset) => view.listRecentPromptsPaginated(trimmed(d.query.get('project')), q(d), limit, offset),
  }));

  get('/dashboard/browser/sessions/{sessionID}', (d) => {
    const sessionId = d.params.sessionID;
    if (goTrim(sessionId) === '') return d.render('Session Detail', 'browser', views.emptyState('Session Not Found', 'No dashboard data exists for that session identifier.'), 404);
    d.query.set('q', sessionId);
    return pagedList(d, {
      tab: 'browser', label: 'Sessions', base: '/dashboard/browser/sessions', render: views.sessionsPartial, shell: browserShell(d),
      fetchPage: (view, limit, offset) => view.listRecentSessionsPaginated(trimmed(d.query.get('project')), sessionId, limit, offset),
    });
  });

  // ─── Proyectos ────────────────────────────────────────────────────────────

  get('/dashboard/projects', (d) => d.render('Projects', 'projects', views.projectsPage(q(d))));

  get('/dashboard/projects/list', async (d) => {
    const { page, pageSize } = parsePaginationRaw(d.query);
    let view;
    let controls;
    let result;
    try {
      view = await d.view();
      result = view.listProjectsPaginated(q(d), pageSize, (page - 1) * pageSize);
      controls = new Map((await store().listProjectSyncControls()).map((c) => [c.project, c]));
    } catch (err) {
      server.log(`[odin-cloud] dashboard projects list store error: ${err.message}`);
      return d.partialUnavailable();
    }
    const { pg, refetch } = reclampPagination(page, pageSize, result.total);
    const rows = refetch ? view.listProjectsPaginated(q(d), pageSize, pg.offset).rows : result.rows;
    return d.send(200, views.projectsListPartial(rows, controls, pg));
  });

  get('/dashboard/projects/{project}', async (d) => {
    const project = trimmed(d.params.project);
    if (project === '') return d.render('Project Detail', 'projects', views.emptyState('Project Not Found', 'No replicated dashboard data exists for that project.'), 404);
    let detail;
    let control = null;
    try {
      const view = await d.view();
      detail = view.projectDetail(project);
      control = await store().getProjectSyncControl(detail.Project).catch(() => null);
    } catch (err) {
      return d.storeError('projects', 'Project detail', err);
    }
    return d.send(200, d.page('Project Detail', 'projects', views.projectDetailPage(project, detail.Stats, control)));
  });

  const projectPartial = (label, render, fetchPage) => async (d) => {
    const name = trimmed(d.params.name);
    let rows;
    try {
      rows = fetchPage(await d.view(), name, q(d), trimmed(d.query.get('type'))).rows;
    } catch (err) {
      return d.storeError('projects', label, err);
    }
    return d.send(200, render(rows));
  };
  get('/dashboard/projects/{name}/observations', projectPartial('Project observations', views.observationsPartial, (v, name, query, type) => v.listRecentObservationsPaginated(name, query, type, 50, 0)));
  get('/dashboard/projects/{name}/sessions', projectPartial('Project sessions', views.sessionsPartial, (v, name, query) => v.listRecentSessionsPaginated(name, query, 50, 0)));
  get('/dashboard/projects/{name}/prompts', projectPartial('Project prompts', views.promptsPartial, (v, name, query) => v.listRecentPromptsPaginated(name, query, 50, 0)));

  // ─── Contribuidores ───────────────────────────────────────────────────────

  get('/dashboard/contributors', (d) => d.render('Contributors', 'contributors', views.contributorsPage(q(d))));

  get('/dashboard/contributors/list', async (d) => {
    const { page, pageSize } = parsePaginationRaw(d.query);
    let view;
    let result;
    try {
      view = await d.view();
      result = view.listContributorsPaginated(q(d), pageSize, (page - 1) * pageSize);
    } catch (err) {
      server.log(`[odin-cloud] dashboard contributors list store error: ${err.message}`);
      return d.partialUnavailable();
    }
    const { pg, refetch } = reclampPagination(page, pageSize, result.total);
    return d.send(200, views.contributorsListPartial(refetch ? view.listContributorsPaginated(q(d), pageSize, pg.offset).rows : result.rows, pg));
  });

  get('/dashboard/contributors/{contributor}', async (d) => {
    const name = trimmed(d.params.contributor);
    if (name === '') return d.render('Contributor Detail', 'contributors', views.emptyState('Contributor Not Found', 'No dashboard data exists for that contributor.'), 404);
    let detail;
    try {
      detail = (await d.view()).getContributorDetail(name);
    } catch (err) {
      return d.storeError('contributors', 'Contributor detail', err);
    }
    return d.send(200, d.page('Contributor Detail', 'contributors', views.contributorDetailPage(detail)));
  });

  // ─── Detalles ─────────────────────────────────────────────────────────────

  const detailPage = (title, label, notFoundTitle, invalidMessage, lookup, render, needsSync) => async (d) => {
    const project = trimmed(d.params.project);
    const sessionId = d.params.sessionID;
    const syncId = trimmed(d.params.syncID);
    const invalid = project === '' || goTrim(sessionId) === '' || (needsSync ? syncId === '' || syncId.length > 128 : sessionId.length > 128);
    if (invalid) return d.send(404, d.page(title, 'browser', views.emptyState(notFoundTitle, invalidMessage)));
    let result;
    try {
      result = lookup(await d.view(), project, sessionId, syncId);
    } catch (err) {
      return d.storeError('browser', label, err);
    }
    return d.send(200, d.page(`${title} Detail`, 'browser', render(result)));
  };
  get('/dashboard/sessions/{project}/{sessionID}', detailPage('Session', 'Session detail', 'Session Not Found', 'Invalid session identifier.', (v, p, s) => v.getSessionDetail(p, s), views.sessionDetailPage, false));
  get('/dashboard/observations/{project}/{sessionID}/{syncID}', detailPage('Observation', 'Observation detail', 'Observation Not Found', 'Invalid observation identifier.', (v, p, s, id) => v.getObservationDetail(p, s, id), views.observationDetailPage, true));
  get('/dashboard/prompts/{project}/{sessionID}/{syncID}', detailPage('Prompt', 'Prompt detail', 'Prompt Not Found', 'Invalid prompt identifier.', (v, p, s, id) => v.getPromptDetail(p, s, id), views.promptDetailPage, true));

  // ─── Administración ───────────────────────────────────────────────────────

  get('/dashboard/admin', adminOnly(async (d) => {
    let health = null;
    let controls;
    try {
      const view = await d.view();
      health = { ...view.counts(), DBConnected: await store().ping() };
      controls = await store().listProjectSyncControls();
    } catch (err) {
      if (controls === undefined) return d.storeError('admin', 'Admin', err);
    }
    return d.render('Admin', 'admin', views.adminPage(health, controls.filter((c) => !c.syncEnabled).length));
  }));

  get('/dashboard/admin/health', adminOnly(async (d) => {
    let health = null;
    try {
      health = { ...(await d.view()).counts(), DBConnected: await store().ping() };
    } catch {
      health = null;
    }
    return d.render('Admin Health', 'admin', views.adminHealthPage(health));
  }));

  async function visibleControls(d) {
    const view = await d.view();
    return (await store().listProjectSyncControls()).filter((c) => view.canSee(c.project));
  }

  get('/dashboard/admin/projects', adminOnly(async (d) => {
    let controls;
    try {
      controls = await visibleControls(d);
    } catch (err) {
      return d.storeError('admin', 'Project controls', err);
    }
    return d.render('Admin Projects', 'admin', views.adminProjectsPage(controls));
  }));

  get('/dashboard/admin/projects/{name}/sync/form', adminOnly(async (d) => {
    const name = trimmed(d.params.name);
    let control = { project: name, syncEnabled: true, pausedReason: null };
    try {
      const found = (await d.view()).canSee(name) ? await store().getProjectSyncControl(name) : null;
      if (found) control = found;
    } catch {
      // Sin control guardado se muestra el valor por defecto.
    }
    return d.send(200, views.syncToggleForm(control));
  }));

  post('/dashboard/admin/projects/{name}/sync', adminOnly(async (d) => {
    const name = trimmed(d.params.name);
    const form = await readForm(d);
    if (form === null) return undefined;
    const enabledRaw = trimmed(form.get('enabled'));
    if (enabledRaw !== 'true' && enabledRaw !== 'false') return sendText(d.res, 400, "invalid value for enabled: must be 'true' or 'false'");
    try {
      const view = await d.view();
      view.scopedProject(name);
      await store().setProjectSyncEnabled(name, enabledRaw === 'true', d.name, trimmed(form.get('reason')));
    } catch (err) {
      if (err?.code === ERR_PROJECT_FORBIDDEN || err?.code === ERR_PROJECT_INVALID) return sendText(d.res, 403, 'forbidden');
      return sendText(d.res, 500, 'store error');
    }
    return redirectAdmin(d, '/dashboard/admin/projects');
  }));

  /** Cuerpo de un formulario; responde el error y devuelve `null` si no se puede leer. */
  async function readForm(d) {
    try {
      return new URLSearchParams((await readBuffer(d.req, LOGIN_BODY_LIMIT)).toString('utf8'));
    } catch (err) {
      if (err?.name === 'BodyTooLargeError') sendText(d.res, 413, `payload too large (max ${LOGIN_BODY_LIMIT} bytes)`);
      else sendText(d.res, 400, 'invalid form');
      return null;
    }
  }

  function redirectAdmin(d, location) {
    if (d.htmx) {
      d.res.writeHead(200, { 'HX-Redirect': location });
      return d.res.end();
    }
    return redirect(d.res, location);
  }

  get('/dashboard/admin/audit-log', adminOnly((d) => {
    let filter;
    try {
      filter = parseAuditFilter(d.query);
    } catch (err) {
      return sendText(d.res, 400, err.message);
    }
    return d.render('Audit Log', 'admin', views.auditLogPage(auditListUrl(filter)));
  }));

  get('/dashboard/admin/audit-log/list', adminOnly(async (d) => {
    let filter;
    try {
      filter = parseAuditFilter(d.query);
    } catch (err) {
      return sendText(d.res, 400, err.message);
    }
    const { page, pageSize } = parsePaginationRaw(d.query);
    // Una vista acotada a unos proyectos no ve el registro: no se direcciona por proyecto.
    const scoped = d.principal !== null && d.principal.source === PRINCIPAL_SOURCE.managedToken && !(await d.view()).canSeeAll();
    const fetchPage = async (offset) => (scoped ? { rows: [], total: 0 } : store().listAuditEntriesPaginated(filter, pageSize, offset));
    let result;
    try {
      result = await fetchPage((page - 1) * pageSize);
    } catch (err) {
      server.log(`[odin-cloud] dashboard audit log list store error: ${err.message}`);
      return d.partialUnavailable('Audit log data is temporarily unavailable.');
    }
    const { pg, refetch } = reclampPagination(page, pageSize, result.total);
    let rows = result.rows;
    if (refetch) {
      try {
        rows = (await fetchPage(pg.offset)).rows;
      } catch (err) {
        server.log(`[odin-cloud] dashboard re-fetch audit log page ${pg.page}: ${err.message}`);
      }
    }
    return d.send(200, views.auditLogListPartial(rows, pg, filter));
  }));

  // ─── Usuarios gestionados ─────────────────────────────────────────────────

  get('/dashboard/admin/users', adminOnly((d) => d.render('Managed Users', 'admin', views.managedUsersPage(d.canManage))));

  get('/dashboard/admin/users/list', adminOnly(async (d) => {
    let users = [];
    try {
      users = await store().listHumanUsers();
    } catch (err) {
      server.log(`[odin-cloud] dashboard managed users list store error: ${err.message}`);
      return d.partialUnavailable('Managed user data is temporarily unavailable.');
    }
    return d.send(200, views.managedUsersListPartial(users, d.canManage));
  }));

  get('/dashboard/admin/users/{principalID}', adminOnly(async (d) => {
    const id = trimmed(d.params.principalID);
    if (id === '') return sendText(d.res, 400, 'principal id is required');
    let user;
    let tokens;
    let grants;
    try {
      user = (await store().listHumanUsers()).find((u) => u.principal_id === id);
      if (user) [tokens, grants] = await Promise.all([store().listPrincipalTokens(id), store().listProjectGrants(id)]);
    } catch (err) {
      return sendText(d.res, 500, `list users: ${err.message}`);
    }
    if (!user) return d.send(404, d.page('Managed User', 'admin', views.emptyState('Managed User Not Found', 'No managed user exists with that principal id.')));
    return d.send(200, d.page('Managed User', 'admin', views.managedUserDetailPage({ user, tokens, grants, canManage: d.canManage })));
  }));

  /** Acción de administración: exige administrador gestionado y anota el evento tras el cambio. */
  const adminAction = (action) => async (d) => {
    if (!d.canManage) {
      const body = JSON.stringify({ error: 'forbidden: managed admin principal is required', error_class: UPGRADE_ERROR_CLASS.policy, error_code: REASON.policyForbidden });
      d.res.writeHead(403, { 'Content-Type': 'application/json' });
      return d.res.end(`${body}\n`);
    }
    const form = await readForm(d);
    if (form === null) return undefined;
    return action(d, form);
  };
  const audit = async (d, ...args) => {
    try {
      await store().insertAuthAuditEvent(auditEvent(d.principal, ...args));
      return true;
    } catch (err) {
      sendText(d.res, 500, `record audit: ${err.message}`);
      return false;
    }
  };

  post('/dashboard/admin/users', adminAction(async (d, form) => {
    const username = trimmed(form.get('username'));
    if (username === '') return sendText(d.res, 400, 'username is required');
    const role = trimmed(form.get('role')) || ROLE.member;
    let user;
    try {
      user = await store().createHumanUser({ username, email: form.get('email') ?? '', displayName: form.get('display_name') ?? '', role });
    } catch (err) {
      return sendText(d.res, 400, `create user: ${err.message}`);
    }
    if (!(await audit(d, 'user.create', user.principal_id, '', { kind: 'human', role, username }))) return undefined;
    return redirectAdmin(d, '/dashboard/admin/users');
  }));

  const toggleUser = (enabled, action) => adminAction(async (d) => {
    const id = trimmed(d.params.principalID);
    if (id === '') return sendText(d.res, 400, 'principal id is required');
    try {
      await store().setHumanUserEnabled(id, enabled);
    } catch (err) {
      return sendText(d.res, 400, `set user enabled: ${err.message}`);
    }
    if (!(await audit(d, action, id, '', { enabled }))) return undefined;
    return redirectAdmin(d, '/dashboard/admin/users');
  });
  post('/dashboard/admin/users/{principalID}/enable', toggleUser(true, 'user.enable'));
  post('/dashboard/admin/users/{principalID}/disable', toggleUser(false, 'user.disable'));

  post('/dashboard/admin/users/{principalID}/tokens', adminAction(async (d, form) => {
    if (server.hasher === null) return sendText(d.res, 500, 'managed token hasher is not configured');
    const id = trimmed(d.params.principalID);
    if (id === '') return sendText(d.res, 400, 'principal id is required');
    const name = trimmed(form.get('name'));
    let user;
    try {
      user = (await store().listHumanUsers()).find((u) => u.principal_id === id);
    } catch (err) {
      return sendText(d.res, 500, `list users: ${err.message}`);
    }
    if (!user) return sendText(d.res, 404, 'managed user not found');
    const disabled = () => d.send(409, d.page('Cannot Create Token', 'admin', views.emptyState('Cannot Create Token', `Enable this managed user before creating a managed token.${trimmed(user.username) !== '' ? ` User ${user.username} is currently disabled.` : ''}`)));
    if (!user.enabled) return disabled();
    const managed = generateManagedToken('live');
    let token;
    try {
      token = await store().createPrincipalTokenWithAudit(
        { principalId: id, tokenPrefix: managed.prefix, tokenHash: server.hasher.hash(managed.raw), name, createdByPrincipalId: d.principal.id },
        auditEvent(d.principal, 'token.create', id, '', { token_prefix: managed.prefix, name }),
      );
    } catch (err) {
      if (err.code === 'principal_disabled') return disabled();
      if (err.code === 'principal_not_found') return sendText(d.res, 404, 'managed user not found');
      if (err.code === 'audit_insert_failed') return sendText(d.res, 500, `record audit: ${err.message}`);
      return sendText(d.res, 400, `create token: ${err.message}`);
    }
    return d.send(200, d.page('Token Created', 'admin', views.tokenCreatedPage(user, managed.raw, token)));
  }));

  post('/dashboard/admin/tokens/{tokenID}/revoke', adminAction(async (d, form) => {
    const tokenId = trimmed(d.params.tokenID);
    if (tokenId === '') return sendText(d.res, 400, 'token id is required');
    const reason = trimmed(form.get('reason'));
    const principalId = trimmed(form.get('principal_id'));
    try {
      await store().revokePrincipalToken(tokenId, d.principal.id, reason);
    } catch (err) {
      return sendText(d.res, 400, `revoke token: ${err.message}`);
    }
    if (!(await audit(d, 'token.revoke', '', '', { id: tokenId, reason }))) return undefined;
    return redirectAdmin(d, principalId === '' ? '/dashboard/admin/users' : `/dashboard/admin/users/${principalId}`);
  }));

  post('/dashboard/admin/users/{principalID}/grants', adminAction(async (d, form) => {
    const id = trimmed(d.params.principalID);
    if (id === '') return sendText(d.res, 400, 'principal id is required');
    const project = trimmed(form.get('project'));
    if (project === '') return sendText(d.res, 400, 'project is required');
    try {
      await store().createProjectGrant({ principalId: id, project, grantedByPrincipalId: d.principal.id });
    } catch (err) {
      return sendText(d.res, 400, `create grant: ${err.message}`);
    }
    if (!(await audit(d, 'grant.create', id, project, { project }))) return undefined;
    return redirectAdmin(d, `/dashboard/admin/users/${id}`);
  }));

  post('/dashboard/admin/users/{principalID}/grants/{project}/revoke', adminAction(async (d) => {
    const id = trimmed(d.params.principalID);
    const project = trimmed(d.params.project);
    if (id === '' || project === '') return sendText(d.res, 400, 'principal id and project are required');
    try {
      await store().revokeProjectGrant(id, project);
    } catch (err) {
      return sendText(d.res, 400, `revoke grant: ${err.message}`);
    }
    if (!(await audit(d, 'grant.revoke', id, project, { project }))) return undefined;
    return redirectAdmin(d, `/dashboard/admin/users/${id}`);
  }));

  // ─── Primer administrador ─────────────────────────────────────────────────

  /** La página de arranque solo la usa el acceso heredado de administración. */
  async function legacyRecovery(c) {
    const { req, res } = c;
    const principal = openMode() ? null : await sessionPrincipal(req);
    if (principal === null) {
      req.resume();
      redirect(res, loginPathWithNext(req.url ?? '/'));
      return null;
    }
    if (principal.source !== PRINCIPAL_SOURCE.legacyEnvAdmin) {
      req.resume();
      try {
        await store().insertAuthAuditEvent({
          actorPrincipalId: principal.source === PRINCIPAL_SOURCE.managedToken ? principal.id : '', actorSource: principal.source, action: 'bootstrap.dashboard', outcome: 'denied',
          reasonCode: 'legacy_recovery_credential_required', metadata: { source: principal.source },
        });
      } catch (err) {
        server.log(`[odin-cloud] dashboard bootstrap audit insert failed (best-effort): ${err.message}`);
      }
      actionable(res, 403, UPGRADE_ERROR_CLASS.policy, REASON.policyForbidden, 'forbidden: legacy dashboard recovery credential is required');
      return null;
    }
    return principal;
  }

  add('GET /dashboard/bootstrap', async (c) => {
    const principal = await legacyRecovery(c);
    if (principal !== null) sendHtml(c.res, 200, views.bootstrapPage());
  });

  add('POST /dashboard/bootstrap', async (c) => {
    const actor = await legacyRecovery(c);
    if (actor === null) return;
    const { req, res } = c;
    const record = (outcome, reasonCode, target = '') => store().insertAuthAuditEvent({
      actorSource: actor.source, targetPrincipalId: target, action: 'bootstrap.dashboard', outcome, reasonCode, metadata: { source: actor.source },
    });
    let form;
    try {
      form = new URLSearchParams((await readBuffer(req, LOGIN_BODY_LIMIT)).toString('utf8'));
    } catch (err) {
      if (err?.name === 'BodyTooLargeError') return sendText(res, 413, `bootstrap payload too large (max ${LOGIN_BODY_LIMIT} bytes)`);
      await record('denied', 'invalid_form').catch(() => {});
      return sendText(res, 400, 'invalid form');
    }
    const username = trimmed(form.get('username'));
    if (username === '') {
      await record('denied', 'username_required').catch(() => {});
      return actionable(res, 400, UPGRADE_ERROR_CLASS.repairable, UPGRADE_ERROR_CODE.payloadInvalid, 'username is required');
    }
    let user;
    try {
      user = await store().createFirstAdminHumanUser({ username, email: form.get('email') ?? '', displayName: form.get('display_name') ?? '' });
    } catch (err) {
      if (err.code === 'admin_already_exists') {
        await record('denied', 'managed_admin_exists').catch(() => {});
        return actionable(res, 409, UPGRADE_ERROR_CLASS.policy, REASON.policyForbidden, 'first managed admin already exists');
      }
      await record('denied', 'create_admin_failed').catch(() => {});
      return actionable(res, 400, UPGRADE_ERROR_CLASS.repairable, UPGRADE_ERROR_CODE.payloadInvalid, `create first admin: ${err.message}`);
    }
    try {
      await record('success', '', user.principal_id);
    } catch (err) {
      return actionable(res, 500, UPGRADE_ERROR_CLASS.blocked, UPGRADE_ERROR_CODE.internal, `record auth audit: ${err.message}`);
    }
    return redirect(res, '/dashboard/login');
  });

  return { sessions };
}
