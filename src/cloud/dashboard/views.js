import { emptyDash, formatTimestamp, formatTimestampOrNever, inlinePreview, pathEscape, queryEscape, PAGE_SIZES, renderStructuredContent, truncate, typeBadgeVariant } from './format.js';
import { html, raw } from './html.js';

/** Páginas y fragmentos del panel. Todas devuelven un fragmento seguro (`html`). */

// ─── Piezas comunes ─────────────────────────────────────────────────────────

const TABS = [['/dashboard/', 'Dashboard', 'dashboard'], ['/dashboard/browser', 'Browser', 'browser'], ['/dashboard/projects', 'Projects', 'projects'], ['/dashboard/contributors', 'Contributors', 'contributors']];
const versionMarker = (version) => (version ? ` · ${version}` : ' · version unknown');

export function layout({ title, username, activeTab, isAdmin, version, content }) {
  const tabs = [...TABS, ...(isAdmin ? [['/dashboard/admin', 'Admin', 'admin']] : [])];
  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} — Odin Cloud</title>
<link rel="stylesheet" href="/dashboard/static/pico.min.css"/>
<link rel="stylesheet" href="/dashboard/static/styles.css"/>
<script src="/dashboard/static/htmx.min.js"></script>
</head>
<body class="shell-body">
<div class="shell-backdrop">
<div class="status-ribbon"><span class="status-pill">CLOUD ACTIVE</span><span class="status-copy">shared memory index / local-first replication / org policy controls</span></div>
<div class="app-shell">
<header class="shell-header">
<div class="brand-stack"><a href="/dashboard/" class="brand">Odin Cloud</a><p class="brand-subtitle">Memory that outlasts the session.</p></div>
<div class="user-info"><span class="user-name">${username}</span>
<form method="post" action="/dashboard/logout" style="margin:0"><button type="submit" class="user-link logout-link">Logout</button></form></div>
</header>
<nav class="shell-nav"><div role="tablist">${tabs.map(([href, label, id]) => html`<a href="${href}" role="tab" aria-selected="${String(id === activeTab)}">${label}</a>`)}</div></nav>
<main class="shell-main">${content}</main>
<footer class="shell-footer"><small>ODIN CLOUD / SHARED MEMORY INDEX / LIVE SYNC READY${versionMarker(version)}</small></footer>
</div>
</div>
</body>
</html>
`;
}

export function loginPage({ error, next, version }) {
  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Login — Odin Cloud</title>
<link rel="stylesheet" href="/dashboard/static/pico.min.css"/>
<link rel="stylesheet" href="/dashboard/static/styles.css"/>
</head>
<body class="shell-body">
<div class="shell-backdrop">
<main class="login-shell">
<section class="login-sidepanel">
<p class="section-kicker">CLOUD ACTIVE</p>
<h1>Odin Cloud</h1>
<p class="login-lead">Bring Odin memory into a shared browser workspace without losing the local-first model.</p>
</section>
<section class="login-container">
<p class="section-kicker">SIGN IN</p>
<h2>Sign In</h2>
<p class="login-copy">Use your cloud runtime token to open a signed dashboard session.</p>
${error ? html`<div class="login-error" role="alert">${error}</div>` : ''}
<form method="post" action="/dashboard/login" class="login-form">
${next ? html`<input type="hidden" name="next" value="${next}"/>` : ''}
<label>Cloud token<input type="password" name="token" placeholder="token" required autocomplete="off"/></label>
<button type="submit" class="shell-button">Sign In</button>
</form>
</section>
</main>
<div class="login-footer"><small>ODIN CLOUD / SHARED MEMORY INDEX / LIVE SYNC READY${versionMarker(version)}</small></div>
</div>
</body>
</html>
`;
}

export const statusBadge = (label, variant) => html`<span class="badge badge-${variant}">${label}</span>`;
export const emptyState = (title, message) => html`<div class="empty-state"><p class="section-kicker">NO SIGNAL YET</p><h3>${title}</h3><p>${message}</p></div>`;
const sectionHeader = (kicker, heading, extra = '') => html`<div class="section-header"><div><p class="section-kicker">${kicker}</p><h2>${heading}</h2></div>${extra}</div>`;
const section = (kicker, heading, body, extra = '') => html`<section class="frame-section">${sectionHeader(kicker, heading, extra)}${body}</section>`;

function buildPageUrl(base, page, pageSize, extra) {
  const params = Object.entries(extra ?? {}).filter(([, v]) => v !== '' && v != null).concat([['page', String(page)], ['pageSize', String(pageSize)]]);
  return `${base}?${params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${queryEscape(k)}=${queryEscape(v)}`).join('&')}`;
}

/** Barra de páginas; con `target` navega con htmx, si no con enlaces normales. */
export function paginationBar(pg, base, { target = '', include = '', extra = {} } = {}) {
  if (!pg.show) return '';
  const link = (page, size, label, cls = 'page-btn') => {
    const href = buildPageUrl(base, page, size, target ? {} : extra);
    return target
      ? html`<a class="${cls}" hx-get="${buildPageUrl(base, page, size, {})}" hx-target="${target}" hx-swap="innerHTML" hx-include="${include}">${label}</a>`
      : html`<a href="${href}" class="${cls}">${label}</a>`;
  };
  return html`<div class="pagination-bar">
<span class="pagination-info">${pg.start}–${pg.end} of ${pg.totalItems}</span>
<div class="pagination-pages">${pg.hasPrev ? link(pg.page - 1, pg.pageSize, '←') : ''}${pg.numbers().map((n) => (n === -1 ? html`<span class="page-ellipsis">…</span>` : n === pg.page ? html`<span class="page-btn active">${n}</span>` : link(n, pg.pageSize, n)))}${pg.hasNext ? link(pg.page + 1, pg.pageSize, '→') : ''}</div>
<div class="pagination-size"><span class="pagination-size-label">Show</span>${PAGE_SIZES.map((size) => (size === pg.pageSize ? html`<span class="page-btn active">${size}</span>` : link(1, size, size)))}</div>
</div>`;
}

const sessionHref = (project, sessionId) => `/dashboard/sessions/${pathEscape(project)}/${pathEscape(sessionId)}`;
const detailHref = (kind, row) => `/dashboard/${kind}/${pathEscape(row.Project)}/${pathEscape(row.SessionID)}/${pathEscape(row.SyncID)}`;
const BROWSER_INCLUDE = '#browser-project, #browser-search, #browser-type';

// ─── Inicio y navegador ─────────────────────────────────────────────────────

export const dashboardHome = (username) => html`<section class="hero-panel">
<div class="hero-copy"><p class="section-kicker">OPERATOR ${username}</p><h2>Welcome to Odin Cloud</h2>
<p class="hero-lead">Your shared memory workspace is ready. Local SQLite stays authoritative, while cloud turns it into an index your team and agents can use.</p></div>
<div class="data-frame" id="dashboard-stats" hx-get="/dashboard/stats" hx-trigger="load" hx-swap="innerHTML"><p class="htmx-indicator terminal-note">Loading stats...</p></div>
</section>`;

export const statsSection = (overview) => html`<section class="frame-section"><p class="section-kicker">STATS</p><h2>Cloud Stats</h2><div class="metric-strip">
<a href="/dashboard/projects" class="metric-card stat-card-link"><span class="metric-value">${overview.Projects}</span><span class="metric-label">Projects</span></a>
<a href="/dashboard/contributors" class="metric-card stat-card-link"><span class="metric-value">${overview.Contributors}</span><span class="metric-label">Contributors</span></a>
<a href="/dashboard/browser" class="metric-card stat-card-link"><span class="metric-value">${overview.Chunks}</span><span class="metric-label">Chunks</span></a></div></section>`;

export function activitySection(rows, rawQuery) {
  const body = rows.length === 0
    ? html`<div class="empty-state"><h3>No Activity</h3><p>No recent observations are available.</p></div>`
    : html`<table class="data-table"><thead><tr><th>Project</th><th>Type</th><th>Title</th><th>Session</th><th>Created</th></tr></thead><tbody>${rows.map((row) => html`<tr><td>${row.Project}</td><td>${row.Type}</td><td>${row.Title}</td><td><a href="${`/dashboard/browser/sessions/${pathEscape(row.SessionID)}`}">${row.SessionID}</a></td><td>${formatTimestamp(row.CreatedAt)}</td></tr>`)}</tbody></table>`;
  return html`<section class="frame-section"><p class="section-kicker">ACTIVITY</p><h2>Recent Observation Activity</h2>${body}</section>`;
}

function browserUrl(project, search, type) {
  const params = [['project', project], ['q', search], ['type', type]].filter(([, v]) => v).map(([k, v]) => `${k}=${queryEscape(v)}`).sort();
  return params.length > 0 ? `/dashboard/browser?${params.join('&')}` : '/dashboard/browser';
}

export function browserPage({ projects, types, project, search, type }) {
  const tab = (path, label, active) => html`<a role="tab" aria-selected="${String(active)}" class="${active ? 'active' : ''}" hx-get="${path}" hx-target="#browser-content" hx-swap="innerHTML" hx-include="${BROWSER_INCLUDE}" hx-on::after-request="document.querySelectorAll('#browser-tabs [role=tab]').forEach(t=>t.classList.remove('active'));this.classList.add('active')">${label}</a>`;
  return html`<section class="frame-section browser-shell">
${sectionHeader('KNOWLEDGE BROWSER', 'Knowledge Browser')}
<div class="browser-controls">
<select id="browser-project" name="project" hx-get="/dashboard/browser/observations" hx-target="#browser-content" hx-swap="innerHTML" hx-include="#browser-search, #browser-type"><option value="">All Projects</option>${projects.map((p) => html`<option value="${p}" ${p === project ? raw('selected') : ''}>${p}</option>`)}</select>
<input id="browser-search" type="search" name="q" placeholder="Search..." value="${search}" hx-get="/dashboard/browser/observations" hx-target="#browser-content" hx-swap="innerHTML" hx-trigger="keyup changed delay:300ms" hx-include="#browser-project, #browser-type"/>
</div>
<input type="hidden" id="browser-type" name="type" value="${type}"/>
${types.length > 0 ? html`<div class="filter-strip"><a href="${browserUrl(project, search, '')}" class="type-pill ${type === '' ? 'active' : ''}">All Types</a>${types.map((t) => html`<a href="${browserUrl(project, search, t)}" class="type-pill ${t === type ? 'active' : ''}">${t}</a>`)}</div>` : ''}
<div class="browser-subtabs" role="tablist" id="browser-tabs">${tab('/dashboard/browser/observations', 'Observations', true)}${tab('/dashboard/browser/sessions', 'Sessions', false)}${tab('/dashboard/browser/prompts', 'Prompts', false)}</div>
<div class="browser-content-frame" id="browser-content" hx-get="/dashboard/browser/observations" hx-trigger="load" hx-swap="innerHTML" hx-include="${BROWSER_INCLUDE}"><p class="htmx-indicator">Loading...</p></div>
</section>`;
}

const bar = (pg, base, htmxTarget, include) => (pg ? paginationBar(pg, base, { target: htmxTarget, include }) : '');

export function observationsPartial(rows, pg = null, base = '/dashboard/browser/observations') {
  if (rows.length === 0) return emptyState('No Observations', 'No observations match the current project, search text, or type filter.');
  return html`<div class="observation-list">${rows.map((o) => html`<a href="${detailHref('observations', o)}" class="card-link"><article class="card"><header><strong>${o.Title}</strong>${statusBadge(o.Type, typeBadgeVariant(o.Type))}${statusBadge(o.Project, 'muted')}</header><p>${inlinePreview(o.Content, 220)}</p><footer><small>${formatTimestamp(o.CreatedAt)}</small><small>Session ${o.SessionID}</small></footer></article></a>`)}</div>${bar(pg, base, '#browser-content', BROWSER_INCLUDE)}`;
}

export function sessionsPartial(rows, pg = null, base = '/dashboard/browser/sessions') {
  if (rows.length === 0) return emptyState('No Sessions', 'No sessions match the current project or search filter.');
  return html`<div class="table-scroll"><table class="data-table"><thead><tr><th>Project</th><th>Started</th><th>Ended</th><th>Summary</th></tr></thead><tbody>${rows.map((s) => html`<tr><td><a href="${sessionHref(s.Project, s.SessionID)}">${s.Project}</a><div class="muted">session ${s.SessionID}</div></td><td>${formatTimestamp(s.StartedAt)}</td><td>${s.EndedAt !== '' ? formatTimestamp(s.EndedAt) : statusBadge('Active', 'success')}</td><td>${truncate(s.Summary, 100)}</td></tr>`)}</tbody></table></div>${bar(pg, base, '#browser-content', BROWSER_INCLUDE)}`;
}

export function promptsPartial(rows, pg = null, base = '/dashboard/browser/prompts') {
  if (rows.length === 0) return emptyState('No Prompts', 'No prompts match the current project or search filter.');
  return html`<div class="prompt-list">${rows.map((p) => html`<a href="${detailHref('prompts', p)}" class="card-link"><article class="card"><p>${truncate(p.Content, 300)}</p><footer><small>${formatTimestamp(p.CreatedAt)}</small><small>Session ${p.SessionID}</small>${statusBadge(p.Project, 'muted')}</footer></article></a>`)}</div>${bar(pg, base, '#browser-content', BROWSER_INCLUDE)}`;
}

// ─── Proyectos ──────────────────────────────────────────────────────────────

const searchShell = ({ kicker, heading, inputId, placeholder, search, endpoint, contentId, include }) => html`<section class="frame-section">
${sectionHeader(kicker, heading)}
<div class="browser-controls"><input id="${inputId}" type="search" name="q" placeholder="${placeholder}" value="${search}" hx-get="${endpoint}" hx-target="#${contentId}" hx-swap="innerHTML" hx-trigger="keyup changed delay:300ms"/></div>
<div id="${contentId}" hx-get="${endpoint}" hx-trigger="load" hx-swap="innerHTML" hx-include="${include}"><p class="muted">Loading...</p></div>
</section>`;

export const projectsPage = (search) => searchShell({ kicker: 'PROJECT ATLAS', heading: 'Projects', inputId: 'project-search', placeholder: 'Search projects...', search, endpoint: '/dashboard/projects/list', contentId: 'projects-content', include: '#project-search' });
export const contributorsPage = (search) => searchShell({ kicker: 'CONTRIBUTOR SIGNAL', heading: 'Contributors', inputId: 'contributor-search', placeholder: 'Search contributors...', search, endpoint: '/dashboard/contributors/list', contentId: 'contributors-content', include: '#contributor-search' });

export function projectsListPartial(rows, controls, pg) {
  if (rows.length === 0) return emptyState('No Projects', 'No projects match the current search.');
  const control = (project) => controls.get(project) ?? { syncEnabled: true, pausedReason: null };
  return html`<div class="project-grid">${rows.map((s) => html`<a href="/dashboard/projects/${pathEscape(s.Project)}" class="card-link"><article class="card project-card"><header><h3>${s.Project}</h3>${control(s.Project).syncEnabled ? '' : statusBadge('Paused', 'danger')}</header>
<div class="project-stats"><div class="stat"><span class="stat-value">${s.Sessions}</span><span class="stat-label">Sessions</span></div><div class="stat"><span class="stat-value">${s.Observations}</span><span class="stat-label">Observations</span></div><div class="stat"><span class="stat-value">${s.Prompts}</span><span class="stat-label">Prompts</span></div></div>
<footer>${!control(s.Project).syncEnabled && control(s.Project).pausedReason != null ? html`<small>Paused: ${control(s.Project).pausedReason}</small>` : ''}</footer></article></a>`)}</div>${bar(pg, '/dashboard/projects/list', '#projects-content', '#project-search')}`;
}

const statCard = (value, label, cls = '') => html`<div class="stat-card"><span class="stat-value ${cls}">${value}</span><span class="stat-label">${label}</span></div>`;

export function projectDetailPage(project, stats, control) {
  const base = `/dashboard/projects/${pathEscape(project)}`;
  const tab = (name, label, active) => html`<a role="tab" aria-selected="${String(active)}" class="${active ? 'active' : ''}" hx-get="${base}/${name}" hx-target="#project-content" hx-swap="innerHTML" hx-on::after-request="document.querySelectorAll('#project-tabs [role=tab]').forEach(t=>t.classList.remove('active'));this.classList.add('active')">${label}</a>`;
  return html`<section class="frame-section">
${sectionHeader('PROJECT DETAIL', html`<a href="/dashboard/projects">Projects</a> / ${project}`, control ? (control.syncEnabled ? statusBadge('Sync On', 'success') : statusBadge('Sync Paused', 'danger')) : '')}
${control && !control.syncEnabled ? html`<div class="data-frame policy-note danger-note"><p class="section-kicker">ORG POLICY</p><p>This project is paused by organization policy in the cloud control plane.</p>${control.pausedReason != null ? html`<p><strong>Reason:</strong> ${control.pausedReason}</p>` : ''}${control.updatedBy != null ? html`<p><strong>Updated by:</strong> ${control.updatedBy}</p>` : ''}${control.updatedAt ? html`<p><strong>Updated:</strong> ${formatTimestamp(control.updatedAt)}</p>` : ''}</div>` : ''}
${stats ? html`<div class="dashboard-grid">${statCard(stats.Sessions, 'Sessions')}${statCard(stats.Observations, 'Observations')}${statCard(stats.Prompts, 'Prompts')}</div>` : ''}
<div class="browser-subtabs" role="tablist" id="project-tabs">${tab('observations', 'Observations', true)}${tab('sessions', 'Sessions', false)}${tab('prompts', 'Prompts', false)}</div>
<div class="browser-content-frame" id="project-content" hx-get="${base}/observations" hx-trigger="load" hx-swap="innerHTML"><p class="muted">Loading...</p></div>
</section>`;
}

// ─── Contribuidores ─────────────────────────────────────────────────────────

export function contributorsListPartial(rows, pg) {
  if (rows.length === 0) return emptyState('No Contributors Yet', 'Contributor activity will appear once team members start syncing.');
  return html`<table class="data-table"><thead><tr><th>Contributor</th><th>Chunks</th><th>Projects</th><th>Last Chunk</th></tr></thead><tbody>${rows.map((c) => html`<tr><td><a href="/dashboard/contributors/${pathEscape(c.CreatedBy)}">${c.CreatedBy}</a></td><td>${c.Chunks}</td><td>${c.Projects}</td><td>${formatTimestampOrNever(c.LastChunkAt)}</td></tr>`)}</tbody></table>${bar(pg, '/dashboard/contributors/list', '#contributors-content', '')}`;
}

export function contributorDetailPage({ contributor, sessions, observations, prompts }) {
  if (!contributor) return section('CONTRIBUTOR DETAIL', 'Contributor', emptyState('Contributor Not Found', 'This contributor does not exist or is outside your current org view.'));
  return section('CONTRIBUTOR DETAIL', contributor.CreatedBy, html`<div class="dashboard-grid">
<a href="/dashboard/browser?q=${queryEscape(contributor.CreatedBy)}" class="stat-card stat-card-link"><span class="stat-value">${contributor.Chunks}</span><span class="stat-label">Chunks</span></a>
<a href="/dashboard/projects?q=${queryEscape(contributor.CreatedBy)}" class="stat-card stat-card-link"><span class="stat-value">${contributor.Projects}</span><span class="stat-label">Projects</span></a>
<div class="stat-card"><span class="stat-value stat-copy">${formatTimestampOrNever(contributor.LastChunkAt)}</span><span class="stat-label">Last Chunk</span></div></div>
<h3 class="section-block-title">Recent Sessions</h3>${sessionsPartial(sessions)}
<h3 class="section-block-title">Recent Observations</h3>${observationsPartial(observations)}
<h3 class="section-block-title">Recent Prompts</h3>${promptsPartial(prompts)}`);
}

// ─── Detalles ───────────────────────────────────────────────────────────────

const linkedSession = (session, withSummary) => (session && session.SessionID !== ''
  ? html`<div class="data-frame linked-session-panel"><p class="section-kicker">LINKED SESSION</p><h3><a href="${sessionHref(session.Project, session.SessionID)}">${session.Project}</a></h3><p class="muted">Started ${formatTimestamp(session.StartedAt)}</p>${withSummary && session.Summary !== '' ? html`<p>${session.Summary}</p>` : ''}</div>`
  : '');
const sessionRow = (row) => html`<tr><th>Session</th><td><a href="${sessionHref(row.Project, row.SessionID)}">${row.SessionID}</a></td></tr>`;

export function sessionDetailPage({ session, observations, prompts }) {
  if (!session) return section('SESSION TRACE', 'Session', emptyState('Session Not Found', 'This session does not exist or is no longer visible to the current user.'));
  return section('SESSION TRACE', session.Project, html`<div class="dashboard-grid">${statCard(observations.length, 'Observations')}${statCard(prompts.length, 'Prompts')}${statCard(formatTimestamp(session.StartedAt), 'Started', 'stat-copy')}</div>
<div class="data-frame session-meta"><table><tbody>
<tr><th>Session ID</th><td>${session.SessionID}</td></tr>
<tr><th>Project</th><td><a href="/dashboard/projects/${pathEscape(session.Project)}">${session.Project}</a></td></tr>
<tr><th>Directory</th><td>${session.Directory}</td></tr>
<tr><th>Started</th><td>${formatTimestamp(session.StartedAt)}</td></tr>
<tr><th>Ended</th><td>${session.EndedAt !== '' ? formatTimestamp(session.EndedAt) : statusBadge('Active', 'success')}</td></tr>
<tr><th>Summary</th><td>${session.Summary !== '' ? session.Summary : html`<span class="muted">No session summary captured.</span>`}</td></tr>
</tbody></table></div>
<h3 class="section-block-title">Observations in this Session</h3>${observationsPartial(observations)}
<h3 class="section-block-title">Prompts in this Session</h3>${promptsPartial(prompts)}`);
}

export function observationDetailPage({ observation, session, related }) {
  if (!observation) return section('OBSERVATION DETAIL', 'Observation', emptyState('Observation Not Found', 'This observation does not exist or is no longer visible to the current user.'));
  return section('OBSERVATION DETAIL', observation.Title, html`<div class="project-chip-list">${statusBadge(observation.Type, typeBadgeVariant(observation.Type))}${statusBadge(observation.Project, 'muted')}</div>
<div class="data-frame observation-detail-body"><table><tbody>
<tr><th>Chunk ID</th><td>${observation.ChunkID}</td></tr>${sessionRow(observation)}
<tr><th>Created</th><td>${formatTimestamp(observation.CreatedAt)}</td></tr>
<tr><th>Tool</th><td>${observation.ToolName !== '' ? observation.ToolName : html`<span class="muted">Unknown</span>`}</td></tr>
<tr><th>Topic Key</th><td>${observation.TopicKey !== '' ? observation.TopicKey : html`<span class="muted">None</span>`}</td></tr>
</tbody></table><div class="observation-content-block"><p class="section-kicker">CONTENT</p>${raw(renderStructuredContent(observation.Content))}</div></div>
${linkedSession(session, true)}
${related.length > 0 ? html`<h3 class="section-block-title">More from this Session</h3>${observationsPartial(related)}` : ''}`);
}

export function promptDetailPage({ prompt, session, related }) {
  if (!prompt) return section('PROMPT DETAIL', 'Prompt Detail', emptyState('Prompt Not Found', 'This prompt does not exist or is not visible to the current user.'));
  return section('PROMPT DETAIL', 'Prompt Detail', html`<div class="data-frame observation-detail-body"><table class="data-table"><tbody>
<tr><th>Chunk ID</th><td>${prompt.ChunkID}</td></tr>${sessionRow(prompt)}
<tr><th>Project</th><td>${prompt.Project}</td></tr>
<tr><th>Created</th><td>${formatTimestamp(prompt.CreatedAt)}</td></tr>
</tbody></table><div class="observation-content-block"><p class="section-kicker">CONTENT</p>${raw(renderStructuredContent(prompt.Content))}</div></div>
${linkedSession(session, false)}
${related.length > 0 ? html`<h3 class="section-block-title">Other Prompts from this Session</h3>${promptsPartial(related)}` : ''}`);
}

// ─── Administración ─────────────────────────────────────────────────────────

const ADMIN_NAV = [['overview', '/dashboard/admin', 'Overview'], ['projects', '/dashboard/admin/projects', 'Projects'], ['users', '/dashboard/admin/users', 'Managed Users'], ['health', '/dashboard/admin/health', 'System Health'], ['audit-log', '/dashboard/admin/audit-log', 'Audit Log']];
const adminNav = (active) => html`<div class="admin-nav">${ADMIN_NAV.map(([id, href, label]) => html`<a href="${href}" class="${id === active ? 'active' : ''}">${label}</a>`)}</div>`;
const dbBadge = (connected) => (connected ? statusBadge('Connected', 'success') : statusBadge('Disconnected', 'danger'));

export const adminPage = (health, pausedCount) => section('ADMIN SURFACE', 'Admin Overview', html`${adminNav('overview')}${health ? html`<div class="dashboard-grid">
<div class="stat-card"><span class="stat-value">${dbBadge(health.DBConnected)}</span><span class="stat-label">Database</span></div>
${statCard(health.Contributors, 'Contributors')}${statCard(health.Sessions, 'Sessions')}${statCard(health.Observations, 'Observations')}${statCard(health.Prompts, 'Prompts')}${statCard(health.Projects, 'Projects')}${statCard(pausedCount, 'Paused Projects')}</div>` : ''}`);

export const adminHealthPage = (health) => section('ADMIN SURFACE', 'Admin Health', html`${adminNav('health')}<h3 class="section-block-title">System Health</h3>${health ? html`<table class="data-table"><tbody>
<tr><th>Database</th><td>${dbBadge(health.DBConnected)}</td></tr><tr><th>Projects</th><td>${health.Projects}</td></tr><tr><th>Contributors</th><td>${health.Contributors}</td></tr><tr><th>Sessions</th><td>${health.Sessions}</td></tr><tr><th>Observations</th><td>${health.Observations}</td></tr><tr><th>Prompts</th><td>${health.Prompts}</td></tr><tr><th>Total Chunks</th><td>${health.Chunks}</td></tr></tbody></table>` : emptyState('Unavailable', 'Could not retrieve system health information.')}`);

export const syncToggleForm = (control) => html`<form method="post" action="/dashboard/admin/projects/${pathEscape(control.project)}/sync" class="switch-form">
<input type="text" name="reason" class="reason-input" placeholder="Reason when pausing" value="${control.pausedReason ?? ''}"/>
<input type="hidden" name="enabled" value="${control.syncEnabled ? 'false' : 'true'}"/>
<button type="submit" class="switch-button ${control.syncEnabled ? 'is-on' : 'is-off'}" hx-post="/dashboard/admin/projects/${pathEscape(control.project)}/sync" hx-include="closest form">${control.syncEnabled ? 'On' : 'Off'}</button></form>`;

export const adminProjectsPage = (controls) => section('ADMIN SURFACE', 'Project Controls', html`${adminNav('projects')}${controls.length === 0 ? emptyState('No Managed Projects', 'Projects appear here once cloud receives data or policy entries.') : html`<table class="data-table"><thead><tr><th>Project</th><th>Sync</th><th>Reason</th><th>Updated By</th><th>Updated</th><th>Action</th></tr></thead><tbody>${controls.map((c) => html`<tr>
<td><a href="/dashboard/projects/${pathEscape(c.project)}">${c.project}</a></td>
<td>${c.syncEnabled ? statusBadge('On', 'success') : statusBadge('Paused', 'danger')}</td>
<td>${c.syncEnabled ? html`<span class="muted">-</span>` : c.pausedReason != null ? c.pausedReason : html`<span class="muted">No reason provided</span>`}</td>
<td>${c.updatedBy != null ? c.updatedBy : html`<span class="muted">System</span>`}</td>
<td>${c.updatedAt ? formatTimestamp(c.updatedAt) : html`<span class="muted">Default</span>`}</td>
<td>${syncToggleForm(c)}</td></tr>`)}</tbody></table>`}`);

const ADMIN_NOTICE = html`<div class="data-frame policy-note"><p><strong>Managed-user administration requires a managed admin token.</strong> Sign in with a token issued by <code>odin cloud bootstrap admin --issue-token ...</code>. If the sole enabled managed admin has no token, use <code>odin cloud bootstrap recover-token</code>.</p></div>`;
const toggleAction = (enabled) => (enabled ? '/disable' : '/enable');
const fmtDate = (value) => (value ? formatTimestamp(value) : '-');

export function managedUsersPage(canManage) {
  return section('ADMIN SURFACE', 'Managed Users', html`${adminNav('users')}${canManage ? html`<div class="data-frame"><p class="section-kicker">CREATE MANAGED USER</p>
<form method="post" action="/dashboard/admin/users" class="managed-user-form"><input type="text" name="username" placeholder="Username" required autocomplete="off"/><input type="email" name="email" placeholder="Email (optional)" autocomplete="off"/><input type="text" name="display_name" placeholder="Display name (optional)" autocomplete="off"/><select name="role"><option value="member">Member</option><option value="admin">Admin</option></select><button type="submit">Create User</button></form>
<p class="muted">New managed users are deny-by-default: they cannot sync any project until an admin grants one explicitly on the user's detail page.</p></div>` : ADMIN_NOTICE}
<h3 class="section-block-title">Managed Users</h3>
<div id="managed-users-content" hx-get="/dashboard/admin/users/list" hx-trigger="load" hx-swap="innerHTML"><p class="muted">Loading...</p></div>`);
}

export function managedUsersListPartial(users, canManage) {
  if (users.length === 0) return emptyState('No Managed Users Yet', canManage ? 'Create the first managed user above. Every managed user is deny-by-default and cannot sync any project until an admin grants one explicitly.' : 'No managed users are available to review.');
  return html`<table class="data-table"><thead><tr><th>Username</th><th>Display Name</th><th>Role</th><th>Status</th><th>Created</th>${canManage ? html`<th>Action</th>` : ''}</tr></thead><tbody>${users.map((u) => html`<tr>
<td><a href="/dashboard/admin/users/${pathEscape(u.principal_id)}">${u.username}</a></td><td>${u.display_name}</td><td>${u.role}</td><td>${u.enabled ? statusBadge('Enabled', 'success') : statusBadge('Disabled', 'danger')}</td><td>${fmtDate(u.created_at)}</td>
${canManage ? html`<td><form method="post" action="/dashboard/admin/users/${pathEscape(u.principal_id)}${toggleAction(u.enabled)}" class="switch-form"><button type="submit" class="switch-button ${u.enabled ? 'is-on' : 'is-off'}">${u.enabled ? 'Disable' : 'Enable'}</button></form></td>` : ''}</tr>`)}</tbody></table>`;
}

export function managedUserDetailPage({ user, tokens, grants, canManage }) {
  const id = pathEscape(user.principal_id);
  const tokensEmpty = canManage ? (user.enabled ? 'This user has no managed tokens yet. Create one above to let it authenticate sync requests.' : 'This disabled user has no managed tokens. Enable the user before creating one.') : 'This user has no managed tokens to review.';
  return html`<section class="frame-section">
${sectionHeader('MANAGED USER', user.username, user.enabled ? statusBadge('Enabled', 'success') : statusBadge('Disabled', 'danger'))}
${adminNav('users')}${canManage ? '' : ADMIN_NOTICE}
<div class="data-frame"><table><tbody><tr><th>Display Name</th><td>${user.display_name}</td></tr><tr><th>Email</th><td>${emptyDash(user.email)}</td></tr><tr><th>Role</th><td>${user.role}</td></tr><tr><th>Created</th><td>${fmtDate(user.created_at)}</td></tr></tbody></table>
${canManage ? html`<form method="post" action="/dashboard/admin/users/${id}${toggleAction(user.enabled)}" class="switch-form"><button type="submit" class="switch-button ${user.enabled ? 'is-on' : 'is-off'}">${user.enabled ? 'Disable User' : 'Enable User'}</button></form>` : ''}</div>
<h3 class="section-block-title">Tokens</h3>
<div class="data-frame">
${canManage && user.enabled ? html`<form method="post" action="/dashboard/admin/users/${id}/tokens" class="managed-user-form"><input type="text" name="name" placeholder="Token label (optional)" autocomplete="off"/><button type="submit">Create Token</button></form><p class="muted">Tokens are shown only once, immediately after creation. Odin Cloud cannot redisplay a raw token afterward — revoke it and create a new one if it is lost.</p>` : canManage ? html`<div class="policy-note danger-note"><p><strong>Token creation unavailable.</strong> Enable this managed user before creating a managed token.</p></div>` : ''}
${tokens.length === 0 ? emptyState('No Tokens', tokensEmpty) : html`<table class="data-table"><thead><tr><th>Prefix</th><th>Name</th><th>Created</th><th>Last Used</th><th>Status</th>${canManage ? html`<th>Action</th>` : ''}</tr></thead><tbody>${tokens.map((t) => html`<tr><td>${t.tokenPrefix}</td><td>${emptyDash(t.name)}</td><td>${fmtDate(t.createdAt)}</td><td>${t.lastUsedAt ? formatTimestamp(t.lastUsedAt) : 'Never'}</td><td>${t.revokedAt ? statusBadge('Revoked', 'danger') : statusBadge('Active', 'success')}</td>
${canManage ? html`<td>${t.revokedAt ? html`<span class="muted">-</span>` : html`<form method="post" action="/dashboard/admin/tokens/${pathEscape(t.id)}/revoke" class="switch-form"><input type="hidden" name="principal_id" value="${user.principal_id}"/><button type="submit" class="switch-button is-on">Revoke</button></form>`}</td>` : ''}</tr>`)}</tbody></table>`}
</div>
<h3 class="section-block-title">Project Grants</h3>
<div class="data-frame">
${canManage ? html`<form method="post" action="/dashboard/admin/users/${id}/grants" class="managed-user-form"><input type="text" name="project" placeholder="Project name" required autocomplete="off"/><button type="submit">Grant Project</button></form>` : ''}
${grants.length === 0 ? emptyState('No Project Grants', canManage ? 'This user is deny-by-default: it cannot sync any project until an admin grants one explicitly above.' : 'This user has no project grants to review.') : html`<table class="data-table"><thead><tr><th>Project</th><th>Granted</th>${canManage ? html`<th>Action</th>` : ''}</tr></thead><tbody>${grants.map((g) => html`<tr><td>${g.project}</td><td>${fmtDate(g.created_at)}</td>${canManage ? html`<td><form method="post" action="/dashboard/admin/users/${id}/grants/${pathEscape(g.project)}/revoke" class="switch-form"><button type="submit" class="switch-button is-on">Revoke</button></form></td>` : ''}</tr>`)}</tbody></table>`}
</div>
</section>`;
}

export const tokenCreatedPage = (user, rawToken, token) => section('TOKEN CREATED', 'Save this token now', html`<div class="data-frame policy-note danger-note"><p><strong>This raw token is shown only once.</strong> Odin Cloud never stores or displays it again — copy it now and store it securely.</p><pre class="token-reveal">${rawToken}</pre><p class="muted">Prefix ${token.tokenPrefix} — ${emptyDash(token.name)} — created ${fmtDate(token.createdAt)}</p></div><a href="/dashboard/admin/users/${pathEscape(user.principal_id)}">Back to ${user.username}</a>`);

export const bootstrapPage = () => html`<html><body><main><h1>Create first managed admin</h1><form method="post" action="/dashboard/bootstrap"><label>Username <input name="username"></label><label>Email <input name="email"></label><label>Display name <input name="display_name"></label><button type="submit">Create admin</button></form></main></body></html>`;

// ─── Registro de sincronización ─────────────────────────────────────────────

export function auditLogPage(listUrl) {
  return section('ADMIN SURFACE', 'Audit Log', html`${adminNav('audit-log')}<div id="audit-log-content" hx-get="${listUrl}" hx-trigger="load" hx-swap="innerHTML"><p class="muted">Loading audit log...</p></div>`);
}

export function auditLogListPartial(entries, pg, filter) {
  const stamp = (d) => (d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : '');
  return html`<div>
<form class="browser-controls" method="get" action="/dashboard/admin/audit-log/list" hx-get="/dashboard/admin/audit-log/list" hx-target="#audit-log-content" hx-swap="innerHTML" hx-trigger="submit">
<input id="audit-contributor" type="text" name="contributor" placeholder="Contributor" value="${filter.contributor}"/>
<input id="audit-project" type="text" name="project" placeholder="Project" value="${filter.project}"/>
<select id="audit-outcome" name="outcome"><option value="">All Outcomes</option><option value="rejected_project_paused" ${filter.outcome === 'rejected_project_paused' ? raw('selected') : ''}>Rejected (Paused)</option></select>
<input id="audit-from" type="text" name="from" placeholder="From (RFC3339)" value="${stamp(filter.occurredAtFrom)}"/>
<input id="audit-to" type="text" name="to" placeholder="To (RFC3339)" value="${stamp(filter.occurredAtTo)}"/>
<button type="submit">Filter</button></form>
${entries.length === 0 ? emptyState('No Audit Entries', 'No audit log entries match the current filter.') : html`<table class="data-table"><thead><tr><th>Time</th><th>Contributor</th><th>Project</th><th>Action</th><th>Outcome</th><th>Entries</th><th>Reason</th></tr></thead><tbody>${entries.map((e) => html`<tr><td>${formatTimestampOrNever(e.OccurredAt)}</td><td>${e.Contributor}</td><td>${e.Project}</td><td>${e.Action}</td><td>${e.Outcome}</td><td>${e.EntryCount}</td><td>${e.ReasonCode}</td></tr>`)}</tbody></table>${paginationBar(pg, '/dashboard/admin/audit-log/list', { target: '#audit-log-content', include: '#audit-contributor, #audit-project, #audit-outcome, #audit-from, #audit-to' })}`}
</div>`;
}
