import { normalizeProject } from '../../project/canonical.js';
import { goTrim } from '../../store/text.js';
import { decodeMutationPayload } from '../codec.js';
import { normalizeProjectGrant } from './identity.js';

/**
 * Modelo de lectura del panel: se pliega de los chunks (por orden de llegada) y de las mutaciones (por
 * secuencia) y responde todas las consultas en memoria. `DashboardView` aplica el alcance de proyectos.
 */

export class DashboardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DashboardError';
    this.code = code;
  }
}
const fail = (code, message) => new DashboardError(`cloudstore: ${message}`, code);
export const ERR_PROJECT_INVALID = 'dashboard_project_invalid';
export const ERR_PROJECT_FORBIDDEN = 'dashboard_project_forbidden';
export const ERR_PROJECT_NOT_FOUND = 'dashboard_project_not_found';
export const ERR_CONTRIBUTOR_NOT_FOUND = 'dashboard_contributor_not_found';
export const ERR_SESSION_NOT_FOUND = 'dashboard_session_not_found';
export const ERR_OBSERVATION_NOT_FOUND = 'dashboard_observation_not_found';
export const ERR_PROMPT_NOT_FOUND = 'dashboard_prompt_not_found';

const text = (value) => (typeof value === 'string' ? value : '');
const trim = (value) => goTrim(text(value));
const firstNonEmpty = (primary, fallback) => trim(primary) || trim(fallback);
const keyOf = (project, entityKey) => `${trim(project)}\u0000${trim(entityKey)}`;
const sessionKeyOf = (project, sessionId) => `${trim(project)}\u0000${sessionId}`;
const byteCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Orden descendente por una cadena con desempate estable por proyecto y clave. */
const descending = (field, ...ties) => (a, b) => byteCompare(b[field], a[field]) || ties.reduce((order, tie) => order || byteCompare(a[tie], b[tie]), 0);

function upsertSession(map, sessionId, project, startedAt, endedAt, summary, directory) {
  if (trim(sessionId) === '') return;
  const row = { Project: trim(project), SessionID: sessionId, StartedAt: trim(startedAt), EndedAt: trim(endedAt), Summary: trim(summary), Directory: trim(directory) };
  map.set(sessionKeyOf(row.Project, sessionId), row);
}

function upsertObservation(map, syncId, project, sessionId, type, title, content, topicKey, toolName, chunkId, createdAt) {
  const key = trim(syncId);
  if (key === '') return;
  const row = {
    SyncID: key, Project: trim(project), SessionID: text(sessionId), ChunkID: trim(chunkId), Type: trim(type), Title: trim(title), Content: trim(content),
    TopicKey: trim(topicKey), ToolName: trim(toolName), CreatedAt: trim(createdAt),
  };
  map.set(keyOf(row.Project, key), row);
}

function upsertPrompt(map, syncId, project, sessionId, content, chunkId, createdAt) {
  const key = trim(syncId);
  if (key === '') return;
  const row = { SyncID: key, Project: trim(project), SessionID: text(sessionId), ChunkID: trim(chunkId), Content: trim(content), CreatedAt: trim(createdAt) };
  map.set(keyOf(row.Project, key), row);
}

const mutationEntityKey = (entity, key) => (trim(entity) === 'session' ? text(key) : trim(key));

/** Aplica una mutación (de un chunk o del diario) a los tres mapas de entidades. */
function applyMutation(chunkProject, mutation, sessions, observations, prompts) {
  const entity = trim(mutation.entity);
  const op = trim(mutation.op);
  const entityKey = mutationEntityKey(entity, mutation.entity_key);
  if (entity !== 'session' && entity !== 'observation' && entity !== 'prompt') return;
  const body = decodeMutationPayload(typeof mutation.payload === 'string' ? mutation.payload : JSON.stringify(mutation.payload ?? {}));

  if (entity === 'session') {
    let key = entityKey;
    if (trim(key) === '') key = text(body.id);
    else if (trim(body.id) !== '' && key !== body.id) throw new Error(`dashboard: session mutation key ${JSON.stringify(key)} does not match payload id ${JSON.stringify(body.id)}`);
    const project = firstNonEmpty(body.project, chunkProject);
    const mapKey = sessionKeyOf(project, key);
    if (op === 'delete' || body.deleted || body.hard_delete || (typeof body.deleted_at === 'string' && trim(body.deleted_at) !== '')) {
      sessions.delete(mapKey);
      return;
    }
    const existing = sessions.get(mapKey);
    upsertSession(
      sessions, key, project, text(body.started_at) || existing?.StartedAt || '', text(body.ended_at) || existing?.EndedAt || '',
      text(body.summary) || existing?.Summary || '', text(body.directory) || existing?.Directory || '',
    );
    return;
  }

  const key = firstNonEmpty(entityKey, body.sync_id);
  let project = trim(chunkProject);
  if (typeof body.project === 'string') project = firstNonEmpty(body.project, project);
  if (project === '') {
    const session = sessions.get(sessionKeyOf(project, text(body.session_id)));
    if (session) project = trim(session.Project);
  }
  const mapKey = keyOf(project, key);
  if (op === 'delete' || body.deleted || body.hard_delete) {
    (entity === 'observation' ? observations : prompts).delete(mapKey);
    return;
  }
  if (entity === 'observation') {
    const old = observations.get(mapKey);
    upsertObservation(
      observations, key, project, text(body.session_id) || old?.SessionID || '', text(body.type) || old?.Type || '', text(body.title) || old?.Title || '',
      text(body.content) || old?.Content || '', text(body.topic_key) || old?.TopicKey || '', text(body.tool_name) || old?.ToolName || '', old?.ChunkID ?? '',
      text(body.created_at) || old?.CreatedAt || '',
    );
    return;
  }
  const old = prompts.get(mapKey);
  upsertPrompt(prompts, key, project, text(body.session_id) || old?.SessionID || '', text(body.content) || old?.Content || '', old?.ChunkID ?? '', text(body.created_at) || old?.CreatedAt || '');
}

const rfc3339 = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Pliega los chunks y las mutaciones en un modelo inmutable. @param {{ chunks: object[], mutations: object[], controls?: object[] }} input */
export function buildDashboardModel({ chunks, mutations, controls = [] }) {
  const sessions = new Map();
  const observations = new Map();
  const prompts = new Map();
  const projectChunkCounts = new Map();
  const contributors = new Map();
  const contributorProjects = new Map();
  const projectContributors = new Map();
  const mutationKeys = new Map();

  for (const chunk of chunks) {
    const project = trim(chunk.project);
    if (project === '') continue;
    projectChunkCounts.set(project, (projectChunkCounts.get(project) ?? 0) + 1);
    const parsed = chunk.parsed ?? {};
    for (const session of parsed.sessions ?? []) {
      const sessionProject = firstNonEmpty(session.project, project);
      const existing = sessions.get(sessionKeyOf(sessionProject, session.id));
      upsertSession(
        sessions, session.id, sessionProject, text(session.started_at) || existing?.StartedAt || '', text(session.ended_at) || existing?.EndedAt || '',
        text(session.summary) || existing?.Summary || '', text(session.directory) || existing?.Directory || '',
      );
    }
    for (const obs of parsed.observations ?? []) {
      const obsProject = typeof obs.project === 'string' ? firstNonEmpty(obs.project, project) : project;
      if (typeof obs.deleted_at === 'string' && trim(obs.deleted_at) !== '') {
        observations.delete(keyOf(obsProject, obs.sync_id));
        continue;
      }
      upsertObservation(observations, obs.sync_id, obsProject, obs.session_id, obs.type, obs.title, obs.content, obs.topic_key, obs.tool_name, chunk.chunkId, obs.created_at);
    }
    for (const prompt of parsed.prompts ?? []) {
      upsertPrompt(prompts, prompt.sync_id, firstNonEmpty(prompt.project, project), prompt.session_id, prompt.content, chunk.chunkId, prompt.created_at);
    }
    for (const mutation of parsed.mutations ?? []) {
      try {
        applyMutation(project, mutation, sessions, observations, prompts);
      } catch (err) {
        throw new Error(`cloudstore: invalid dashboard mutation payload in chunk ${JSON.stringify(trim(chunk.chunkId))}: ${err.message}`);
      }
    }
    const creator = trim(chunk.createdBy);
    if (creator === '') continue;
    const stamp = rfc3339(chunk.createdAt);
    if (!contributors.has(creator)) contributors.set(creator, { CreatedBy: creator, Chunks: 0, Projects: 0, LastChunkAt: '' });
    const overall = contributors.get(creator);
    overall.Chunks++;
    if (!contributorProjects.has(creator)) contributorProjects.set(creator, new Set());
    contributorProjects.get(creator).add(project);
    if (!projectContributors.has(project)) projectContributors.set(project, new Map());
    if (!projectContributors.get(project).has(creator)) projectContributors.get(project).set(creator, { CreatedBy: creator, Chunks: 0, Projects: 0, LastChunkAt: '' });
    const perProject = projectContributors.get(project).get(creator);
    perProject.Chunks++;
    for (const row of [overall, perProject]) if (row.LastChunkAt === '' || chunk.createdAt > new Date(row.LastChunkAt)) row.LastChunkAt = stamp;
  }

  for (const row of mutations) {
    const mutation = { entity: trim(row.entity), entity_key: mutationEntityKey(row.entity, row.entity_key), op: trim(row.op), payload: trim(row.payload) === '' ? '{}' : row.payload };
    try {
      applyMutation(trim(row.project), mutation, sessions, observations, prompts);
    } catch (err) {
      throw new Error(`cloudstore: invalid dashboard mutation payload in cloud_mutations seq ${row.seq}: ${err.message}`);
    }
    const project = trim(row.project);
    if (mutation.entity !== '' && project !== '' && trim(mutation.entity_key) !== '') {
      if (!mutationKeys.has(mutation.entity)) mutationKeys.set(mutation.entity, new Map());
      const byProject = mutationKeys.get(mutation.entity);
      if (!byProject.has(project)) byProject.set(project, new Set());
      byProject.get(project).add(mutation.entity_key);
    }
  }

  prune(mutationKeys, sessions, observations, prompts);

  const projects = new Map();
  for (const [name, chunksCount] of projectChunkCounts) projects.set(name, { Project: name, Chunks: chunksCount, Sessions: 0, Observations: 0, Prompts: 0 });
  const detail = { sessions: new Map(), observations: new Map(), prompts: new Map() };
  const place = (rows, counter, bucket) => {
    for (const row of rows.values()) {
      if (trim(row.Project) === '') continue;
      if (!projects.has(row.Project)) projects.set(row.Project, { Project: row.Project, Chunks: 0, Sessions: 0, Observations: 0, Prompts: 0 });
      projects.get(row.Project)[counter]++;
      if (!bucket.has(row.Project)) bucket.set(row.Project, []);
      bucket.get(row.Project).push(row);
    }
  };
  place(sessions, 'Sessions', detail.sessions);
  place(observations, 'Observations', detail.observations);
  place(prompts, 'Prompts', detail.prompts);

  const projectDetails = new Map();
  for (const [name, row] of projects) {
    const contributorsHere = [...(projectContributors.get(name)?.values() ?? [])].map((c) => ({ ...c }));
    contributorsHere.sort((a, b) => b.Chunks - a.Chunks || byteCompare(a.CreatedBy, b.CreatedBy));
    projectDetails.set(name, {
      Project: name,
      Stats: { ...row },
      Contributors: contributorsHere,
      Sessions: [...(detail.sessions.get(name) ?? [])].sort(descending('StartedAt', 'SessionID')),
      Observations: [...(detail.observations.get(name) ?? [])].sort(descending('CreatedAt', 'SyncID')),
      Prompts: [...(detail.prompts.get(name) ?? [])].sort(descending('CreatedAt', 'SyncID')),
    });
  }

  const contributorRows = [...contributors.values()].map((c) => ({ ...c, Projects: contributorProjects.get(c.CreatedBy)?.size ?? 0 }));
  contributorRows.sort((a, b) => b.Chunks - a.Chunks || byteCompare(a.CreatedBy, b.CreatedBy));
  const projectRows = [...projects.values()].map((p) => ({ ...p }));

  // Proyectos registrados sin contenido.
  for (const control of controls) {
    const name = trim(control.project);
    if (name === '' || projectDetails.has(name)) continue;
    const row = { Project: name, Chunks: 0, Sessions: 0, Observations: 0, Prompts: 0 };
    projectRows.push(row);
    projectDetails.set(name, { Project: name, Stats: { ...row }, Contributors: [], Sessions: [], Observations: [], Prompts: [] });
  }
  projectRows.sort((a, b) => byteCompare(a.Project, b.Project));
  return {
    projects: projectRows,
    contributors: contributorRows,
    projectDetails,
    admin: { Projects: projectRows.length, Contributors: contributorRows.length, Chunks: projectRows.reduce((sum, p) => sum + p.Chunks, 0) },
  };
}

/** Con filas en el diario de una entidad, solo cuentan las claves que el diario conoce. */
function prune(mutationKeys, sessions, observations, prompts) {
  const drop = (rows, keys, preserve) => {
    for (const [mapKey, row] of [...rows]) {
      const project = trim(row.Project);
      const entityKey = mapKey.slice(mapKey.indexOf('\u0000') + 1);
      if (preserve?.get(project)?.has(entityKey)) continue;
      const known = keys.get(project);
      if (known === undefined) continue;
      if (!known.has(entityKey)) rows.delete(mapKey);
    }
  };
  if (mutationKeys.has('observation')) drop(observations, mutationKeys.get('observation'), null);
  if (mutationKeys.has('prompt')) drop(prompts, mutationKeys.get('prompt'), null);
  const referenced = new Map();
  const reference = (project, sessionId) => {
    if (trim(project) === '' || trim(sessionId) === '') return;
    if (!referenced.has(trim(project))) referenced.set(trim(project), new Set());
    referenced.get(trim(project)).add(sessionId);
  };
  for (const row of observations.values()) reference(row.Project, row.SessionID);
  for (const row of prompts.values()) reference(row.Project, row.SessionID);
  if (mutationKeys.has('session')) drop(sessions, mutationKeys.get('session'), referenced);
}

/** Restringe el modelo a unos proyectos. @param {Set<string>} allowed */
function scopeModel(model, allowed) {
  const projects = [];
  const projectDetails = new Map();
  let chunks = 0;
  for (const row of model.projects) {
    if (!allowed.has(trim(row.Project))) continue;
    projects.push(row);
    chunks += row.Chunks;
    if (model.projectDetails.has(row.Project)) projectDetails.set(row.Project, model.projectDetails.get(row.Project));
  }
  const aggregate = new Map();
  for (const [project, detail] of projectDetails) {
    for (const c of detail.Contributors) {
      const key = trim(c.CreatedBy);
      if (key === '') continue;
      if (!aggregate.has(key)) aggregate.set(key, { chunks: 0, projects: new Set(), last: '' });
      const entry = aggregate.get(key);
      entry.chunks += c.Chunks;
      entry.projects.add(project);
      if (c.LastChunkAt !== '' && (entry.last === '' || new Date(c.LastChunkAt) > new Date(entry.last))) entry.last = c.LastChunkAt;
    }
  }
  const contributors = [...aggregate].map(([name, e]) => ({ CreatedBy: name, Chunks: e.chunks, Projects: e.projects.size, LastChunkAt: e.last }));
  contributors.sort((a, b) => b.Chunks - a.Chunks || byteCompare(a.CreatedBy, b.CreatedBy));
  return { projects, contributors, projectDetails, admin: { Projects: projects.length, Contributors: contributors.length, Chunks: chunks } };
}

const EMPTY_MODEL = () => ({ projects: [], contributors: [], projectDetails: new Map(), admin: { Projects: 0, Contributors: 0, Chunks: 0 } });

/**
 * El modelo visto por una credencial. `allowed` nulo = todos los proyectos; un conjunto (aunque vacío) restringe.
 * @param {ReturnType<typeof buildDashboardModel>} model
 * @param {Set<string>|null} allowed nombres canónicos de proyecto
 */
export class DashboardView {
  constructor(model, allowed = null) {
    this.allowed = allowed;
    this.model = allowed === null ? model : allowed.size === 0 ? EMPTY_MODEL() : scopeModel(model, allowed);
  }

  /** Vista por permisos concedidos: un nombre ambiguo entre proyectos no autoriza ninguno. @param {string[]} grants */
  static forGrants(model, grants) {
    if (grants.some((g) => trim(g) === '*')) return new DashboardView(model, null);
    const canonicalByGrant = new Map();
    for (const row of model.projects) {
      const key = normalizeProjectGrant(row.Project);
      canonicalByGrant.set(key, canonicalByGrant.has(key) ? '' : row.Project);
    }
    const allowed = new Set();
    for (const grant of grants) {
      const key = normalizeProjectGrant(grant);
      const canonical = canonicalByGrant.get(key);
      if (key !== '' && canonical) allowed.add(canonical);
    }
    return new DashboardView(model, allowed);
  }

  #project(project) {
    const name = trim(normalizeProject(project ?? '').normalized);
    if (name === '') throw fail(ERR_PROJECT_INVALID, 'dashboard project is invalid');
    if (this.allowed !== null && !this.allowed.has(name)) throw fail(ERR_PROJECT_FORBIDDEN, 'dashboard project is outside allowed scope');
    return name;
  }

  #projectFilter(project) {
    return trim(project) === '' ? '' : this.#project(project);
  }

  #detail(name) {
    const detail = this.model.projectDetails.get(name);
    if (!detail) throw fail(ERR_PROJECT_NOT_FOUND, `dashboard project not found: ${name}`);
    return detail;
  }

  #all(field, project) {
    const rows = [];
    for (const detail of this.model.projectDetails.values()) if (project === '' || detail.Project === project) rows.push(...detail[field]);
    return rows;
  }

  #filter(field, project, query, haystack, order) {
    const q = trim(query).toLowerCase();
    const rows = this.#all(field, trim(project)).filter((row) => q === '' || haystack(row).toLowerCase().includes(q));
    return rows.sort(order);
  }

  filterObservations(project, query) {
    return this.#filter('Observations', project, query, (r) => `${r.Title} ${r.Type}`, descending('CreatedAt', 'Project', 'SyncID'));
  }

  filterSessions(project, query) {
    return this.#filter('Sessions', project, query, (r) => r.SessionID, descending('StartedAt', 'Project', 'SessionID'));
  }

  filterPrompts(project, query) {
    return this.#filter('Prompts', project, query, (r) => r.Content, descending('CreatedAt', 'Project', 'SyncID'));
  }

  listProjects(query = '') {
    const q = trim(query).toLowerCase();
    return this.model.projects.filter((r) => q === '' || r.Project.toLowerCase().includes(q));
  }

  projectDetail(project) {
    return this.#detail(this.#project(project));
  }

  listContributors(query = '') {
    const q = trim(query).toLowerCase();
    return this.model.contributors.filter((r) => q === '' || r.CreatedBy.toLowerCase().includes(q));
  }

  #recent(field, project, query, limit) {
    const name = this.#projectFilter(project);
    if (name !== '') this.#detail(name);
    const rows = { Sessions: this.filterSessions, Observations: this.filterObservations, Prompts: this.filterPrompts }[field].call(this, name, query);
    return limit > 0 && rows.length > limit ? rows.slice(0, limit) : rows;
  }

  listRecentSessions(project, query, limit) {
    return this.#recent('Sessions', project, query, limit);
  }

  listRecentObservations(project, query, limit) {
    return this.#recent('Observations', project, query, limit);
  }

  listRecentPrompts(project, query, limit) {
    return this.#recent('Prompts', project, query, limit);
  }

  adminOverview() {
    return { ...this.model.admin };
  }

  static #page(rows, limit, offset) {
    const total = rows.length;
    if (offset > total) return { rows: [], total };
    const end = offset + limit > total || limit <= 0 ? total : offset + limit;
    return { rows: rows.slice(offset, end), total };
  }

  listProjectsPaginated(query, limit, offset) {
    return DashboardView.#page(this.listProjects(query), limit, offset);
  }

  listRecentObservationsPaginated(project, query, type, limit, offset) {
    let rows = this.filterObservations(this.#projectFilter(project), query);
    const wanted = trim(type);
    if (wanted !== '') rows = rows.filter((r) => r.Type.toLowerCase() === wanted.toLowerCase());
    return DashboardView.#page(rows, limit, offset);
  }

  listRecentSessionsPaginated(project, query, limit, offset) {
    return DashboardView.#page(this.filterSessions(this.#projectFilter(project), query), limit, offset);
  }

  listRecentPromptsPaginated(project, query, limit, offset) {
    return DashboardView.#page(this.filterPrompts(this.#projectFilter(project), query), limit, offset);
  }

  listContributorsPaginated(query, limit, offset) {
    return DashboardView.#page(this.listContributors(query), limit, offset);
  }

  getSessionDetail(project, sessionId) {
    const detail = this.#detail(this.#project(project));
    const session = detail.Sessions.find((s) => s.SessionID === sessionId);
    if (!session) throw fail(ERR_SESSION_NOT_FOUND, `dashboard session not found: session ${sessionId} in project ${detail.Project}`);
    return { session, observations: detail.Observations.filter((o) => o.SessionID === sessionId), prompts: detail.Prompts.filter((p) => p.SessionID === sessionId) };
  }

  getObservationDetail(project, sessionId, syncId) {
    const detail = this.#detail(this.#project(project));
    const id = trim(syncId);
    const observation = detail.Observations.find((o) => o.SyncID === id && o.SessionID === sessionId);
    if (!observation) throw fail(ERR_OBSERVATION_NOT_FOUND, `dashboard observation not found: observation ${sessionId}/${id} in project ${detail.Project}`);
    const session = detail.Sessions.find((s) => s.SessionID === sessionId) ?? emptySession();
    return { observation, session, related: detail.Observations.filter((o) => o.SessionID === sessionId && o.SyncID !== id) };
  }

  getPromptDetail(project, sessionId, syncId) {
    const detail = this.#detail(this.#project(project));
    const id = trim(syncId);
    const prompt = detail.Prompts.find((p) => p.SyncID === id && p.SessionID === sessionId);
    if (!prompt) throw fail(ERR_PROMPT_NOT_FOUND, `dashboard prompt not found: prompt ${sessionId}/${id} in project ${detail.Project}`);
    const session = detail.Sessions.find((s) => s.SessionID === sessionId) ?? emptySession();
    return { prompt, session, related: detail.Prompts.filter((p) => p.SessionID === sessionId && p.SyncID !== id) };
  }

  getContributorDetail(name) {
    const wanted = trim(name);
    const contributor = this.model.contributors.find((c) => trim(c.CreatedBy).toLowerCase() === wanted.toLowerCase());
    if (!contributor) throw fail(ERR_CONTRIBUTOR_NOT_FOUND, `dashboard contributor not found: contributor ${wanted}`);
    const sessions = [];
    const observations = [];
    const prompts = [];
    for (const detail of this.model.projectDetails.values()) {
      if (!detail.Contributors.some((c) => trim(c.CreatedBy).toLowerCase() === wanted.toLowerCase())) continue;
      sessions.push(...detail.Sessions);
      observations.push(...detail.Observations);
      prompts.push(...detail.Prompts);
    }
    return {
      contributor,
      sessions: sessions.sort(descending('StartedAt', 'Project', 'SessionID')),
      observations: observations.sort(descending('CreatedAt', 'Project', 'SyncID')),
      prompts: prompts.sort(descending('CreatedAt', 'Project', 'SyncID')),
    };
  }

  listDistinctTypes() {
    const seen = new Set();
    for (const detail of this.model.projectDetails.values()) for (const o of detail.Observations) if (trim(o.Type) !== '') seen.add(trim(o.Type));
    return [...seen].sort(byteCompare);
  }

  /** Recuentos del alcance de esta vista (sin el pulso de la base, que añade quien llama). */
  counts() {
    let sessions = 0;
    let observations = 0;
    let prompts = 0;
    for (const detail of this.model.projectDetails.values()) {
      sessions += detail.Sessions.length;
      observations += detail.Observations.length;
      prompts += detail.Prompts.length;
    }
    return { Projects: this.model.projects.length, Contributors: this.model.contributors.length, Sessions: sessions, Observations: observations, Prompts: prompts, Chunks: this.model.admin.Chunks };
  }

  /** ¿Ve esta vista todos los proyectos? */
  canSeeAll() {
    return this.allowed === null;
  }

  /** ¿Está el proyecto dentro del alcance de esta vista? */
  canSee(project) {
    try {
      this.#project(project);
      return true;
    } catch {
      return false;
    }
  }

  scopedProject(project) {
    return this.#project(project);
  }
}

const emptySession = () => ({ Project: '', SessionID: '', StartedAt: '', EndedAt: '', Summary: '', Directory: '' });
