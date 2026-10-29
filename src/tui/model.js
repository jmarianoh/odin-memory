import { validateServerUrl } from '../cloud/config.js';
import { observationState } from '../store/observations.js';
import { goTrim } from '../store/text.js';
import { formatReviewDate, localTime, wrapLines } from './format.js';
import { blur, focus, inputValue, newTextInput, setValue, updateTextInput } from './text-input.js';

/**
 * Máquina de estados de la TUI al estilo Elm: `update(estado, mensaje, deps)` es una función pura que
 * devuelve `{ state, cmds }`. Los comandos son descripciones (`{ type: 'search', query }`…) que ejecuta
 * `commands.js`, cuyo resultado vuelve a `update` como un mensaje.
 */

export const SCREEN = Object.freeze({
  dashboard: 'dashboard',
  search: 'search',
  searchResults: 'search-results',
  recent: 'recent',
  observationDetail: 'observation-detail',
  timeline: 'timeline',
  sessions: 'sessions',
  sessionDetail: 'session-detail',
  setup: 'setup',
  cloudSettings: 'cloud-settings',
  cloudConfig: 'cloud-config',
  cloudStatus: 'cloud-status',
  cloudEnrollment: 'cloud-enrollment',
});

/** Opciones del menú de la nube y elementos del formulario de configuración (en orden de foco). */
export const CLOUD_SETTINGS_MENU = Object.freeze(['Configure server', 'View status', 'Enroll projects', 'Back']);
export const CLOUD_CONFIG_FOCUS = Object.freeze({ input: 0, test: 1, save: 2, cancel: 3 });
export const CLOUD_CONFIG_ACTIONS = Object.freeze(['Test connection', 'Save server', 'Cancel']);

export const DELETE_STATE = Object.freeze({ none: 'none', prompt: 'prompt', deleting: 'deleting' });

export const DASHBOARD_MENU = Object.freeze(['Search memories', 'Recent observations', 'Browse sessions', 'Set up Copilot', 'Cloud sync settings', 'Quit']);

/** Líneas fijas alrededor del contenido en la vista de detalle (ver `detailLayout`). */
const DETAIL_CHROME = 10;

/** @param {{ version?: string }} [options] */
export function initialState({ version = '' } = {}) {
  return {
    version,
    screen: SCREEN.dashboard,
    prevScreen: SCREEN.dashboard,
    width: 0,
    height: 0,
    cursor: 0,
    scroll: 0,
    updateStatus: '',
    updateMsg: '',
    errorMsg: '',
    stats: null,
    searchInput: newTextInput({ placeholder: 'Search memories...', charLimit: 256, width: 60 }),
    searchQuery: '',
    searchResults: [],
    recentObservations: [],
    selectedObservation: null,
    detailScroll: 0,
    timeline: null,
    sessions: [],
    selectedSessionIdx: 0,
    sessionObservations: [],
    sessionDetailScroll: 0,
    sessionDeleteState: DELETE_STATE.none,
    sessionDeleteId: '',
    sessionDeleteProject: '',
    copyFeedback: '',
    setupAgents: [],
    setupResult: null,
    setupError: '',
    setupDone: false,
    setupInstalling: false,
    setupInstallingName: '',
    spinnerFrame: 0,
    cloudGeneration: 0,
    cloudConfigInput: newTextInput({ placeholder: 'https://odin.example.com', charLimit: 512, width: 60 }),
    cloudConfigTokenSource: '',
    cloudConfigError: '',
    cloudConfigFocus: CLOUD_CONFIG_FOCUS.input,
    cloudConfigPingStatus: '',
    cloudConfigSaving: false,
    cloudConfigTest: false,
    cloudStatusServerUrl: '',
    cloudStatusHealth: '',
    cloudStatusLastSync: '',
    cloudStatusPending: 0,
    cloudStatusLastError: '',
    cloudStatusHealthError: '',
    cloudStatusLoading: false,
    cloudEnrollmentItems: [],
    cloudEnrollmentError: '',
    cloudEnrollmentLoading: false,
  };
}

/** Comandos de arranque: estadísticas y comprobación de versión. */
export const initialCommands = () => [{ type: 'load-stats' }, { type: 'check-update' }];

// ─── Detalle de una observación ──────────────────────────────────────────────

/** Pares etiqueta/valor del detalle, en orden; los tres últimos solo si existen. */
export function detailMetadata(obs) {
  const rows = [
    ['Type', obs.type, 'type'],
    ['Title', obs.title, 'title'],
    ['Session', obs.session_id, 'id'],
    ['Created', localTime(obs.created_at), 'time'],
    ['State', observationState(obs.review_after), 'state'],
    ['Pinned', String(Boolean(obs.pinned)), 'plain'],
  ];
  if (obs.review_after != null) rows.push(['Review', formatReviewDate(obs.review_after), 'time']);
  if (obs.tool_name != null && obs.tool_name !== '') rows.push(['Tool', obs.tool_name, 'plain']);
  if (obs.project != null && obs.project !== '') rows.push(['Project', obs.project, 'project']);
  return rows;
}

/** Líneas ya partidas del contenido de la observación seleccionada. */
export function detailContentLines(state) {
  if (!state.selectedObservation) return [];
  const width = state.width <= 0 ? 20 : Math.max(1, state.width - 8);
  return wrapLines(state.selectedObservation.content, width);
}

/**
 * Cuántas líneas de metadatos se muestran y cuántas de contenido caben. En una terminal baja se quitan
 * metadatos del final hasta que quede al menos una línea de contenido.
 */
export function detailLayout(state) {
  const obs = state.selectedObservation;
  if (!obs) return { metadata: 0, viewport: 0 };
  let metadata = detailMetadata(obs).length;
  if (state.height <= 0) return { metadata, viewport: 5 };
  for (;;) {
    const viewport = state.height - (metadata + DETAIL_CHROME);
    if (viewport > 0 || metadata === 0) return { metadata, viewport: Math.max(0, viewport) };
    metadata -= 1;
  }
}

function detailMaxScroll(state) {
  const { viewport } = detailLayout(state);
  if (viewport === 0) return 0;
  return Math.max(0, detailContentLines(state).length - viewport);
}

const clampDetailScroll = (state) => Math.min(Math.max(0, state.detailScroll), detailMaxScroll(state));

// ─── Cronología ──────────────────────────────────────────────────────────────

/**
 * Filas de la cronología, en orden: la sesión, lo anterior, la observación enfocada y lo posterior.
 * La vista las dibuja y el modelo las cuenta para acotar el desplazamiento.
 */
export function timelineRows(tl) {
  if (!tl) return [];
  const rows = [];
  if (tl.session_info) rows.push({ kind: 'session', id: tl.session_info.id, project: tl.session_info.project });
  if (tl.before.length > 0) {
    rows.push({ kind: 'heading', text: 'Before' });
    for (const e of tl.before) rows.push({ kind: 'entry', e });
    rows.push({ kind: 'connector' });
  }
  rows.push({ kind: 'focus-title', e: tl.focus }, { kind: 'focus-content', e: tl.focus });
  if (tl.after.length > 0) {
    rows.push({ kind: 'connector' }, { kind: 'heading', text: 'After' });
    for (const e of tl.after) rows.push({ kind: 'entry', e });
  }
  return rows;
}

/** Filas de la cronología que caben: la altura menos el marco (relleno, cabecera y ayuda). */
export const timelineViewport = (state) => (state.height <= 0 ? 30 : Math.max(3, state.height - 7));

const timelineMaxScroll = (state) => Math.max(0, timelineRows(state.timeline).length - timelineViewport(state));

// ─── Utilidades ──────────────────────────────────────────────────────────────

const result = (state, ...cmds) => ({ state, cmds });
const reset = (state) => ({ ...state, sessionDeleteState: DELETE_STATE.none, sessionDeleteId: '', sessionDeleteProject: '' });

/** Comando que recarga la pantalla a la que se vuelve. */
function refreshScreen(screen) {
  if (screen === SCREEN.dashboard) return [{ type: 'load-stats' }];
  if (screen === SCREEN.recent) return [{ type: 'load-recent' }];
  if (screen === SCREEN.sessions) return [{ type: 'load-sessions' }];
  return [];
}

export function sessionDeleteErrorMessage(sessionId, error) {
  const id = JSON.stringify(sessionId);
  if (error?.code === 'session_has_observations') return `Cannot delete session ${id}: it still has observations. Delete or move observations first.`;
  if (error?.code === 'session_not_found') return `Cannot delete session ${id}: session not found.`;
  return `Failed to delete session ${id}: ${error?.message ?? error}`;
}

/** Cuántos elementos de dos líneas caben en la lista de la pantalla. */
const visibleItems = (state, chrome) => Math.max(3, Math.floor((state.height - chrome) / 2));

// ─── update ──────────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof initialState>} state
 * @param {{ type: string, [k: string]: any }} msg
 * @param {{ agents?: () => object[] }} [deps]
 * @returns {{ state: ReturnType<typeof initialState>, cmds: object[] }}
 */
export function update(state, msg, deps = {}) {
  switch (msg.type) {
    case 'size':
      return result(clampViewport({ ...state, width: msg.width, height: msg.height }));
    case 'key':
      return onKey(state, msg, deps);
    case 'update-check':
      return result({ ...state, updateStatus: msg.result?.status ?? '', updateMsg: msg.result?.message ?? '' });
    case 'stats':
      return msg.error ? result({ ...state, errorMsg: msg.error.message }) : result({ ...state, stats: msg.stats });
    case 'search-results':
      if (msg.error) return result({ ...state, errorMsg: msg.error.message });
      return result({ ...state, searchResults: msg.results, searchQuery: msg.query, screen: SCREEN.searchResults, cursor: 0, scroll: 0 });
    case 'recent-observations':
      return msg.error ? result({ ...state, errorMsg: msg.error.message }) : result({ ...state, recentObservations: msg.observations });
    case 'observation-detail':
      if (msg.error) return result({ ...state, errorMsg: msg.error.message });
      return result({ ...state, selectedObservation: msg.observation, screen: SCREEN.observationDetail, detailScroll: 0 });
    case 'timeline':
      if (msg.error) return result({ ...state, errorMsg: msg.error.message });
      return result({ ...state, timeline: msg.timeline, screen: SCREEN.timeline, scroll: 0 });
    case 'recent-sessions': {
      if (msg.error) return result({ ...state, errorMsg: msg.error.message });
      const next = { ...state, sessions: msg.sessions };
      if (next.screen === SCREEN.sessions) {
        if (next.sessions.length === 0) {
          next.cursor = 0;
          next.scroll = 0;
        } else if (next.cursor >= next.sessions.length) {
          next.cursor = next.sessions.length - 1;
          if (next.scroll > next.cursor) next.scroll = next.cursor;
        }
      }
      return result(next);
    }
    case 'session-observations':
      if (msg.error) return result({ ...state, errorMsg: msg.error.message });
      return result({ ...state, sessionObservations: msg.observations, screen: SCREEN.sessionDetail, cursor: 0, sessionDetailScroll: 0 });
    case 'session-deleted': {
      const next = reset(state);
      if (msg.error) return result({ ...next, errorMsg: sessionDeleteErrorMessage(msg.sessionId, msg.error) });
      return result({ ...next, errorMsg: '' }, { type: 'load-sessions' });
    }
    case 'setup-installed':
      if (msg.error) return result({ ...state, setupInstalling: false, setupDone: true, setupError: msg.error.message });
      return result({ ...state, setupInstalling: false, setupResult: msg.result, setupError: '', setupDone: true });
    case 'cloud-config-loaded': case 'cloud-status-loaded': case 'cloud-enrollment-loaded': case 'cloud-enrollment-toggled':
    case 'cloud-ping': case 'cloud-url-saved':
      return onCloudResult(state, msg);
    case 'clipboard-copied':
      return result({ ...state, copyFeedback: '✓ Copied!' }, { type: 'print', text: msg.sequence }, { type: 'clear-feedback', ms: 2000 });
    case 'clipboard-clear':
      return result({ ...state, copyFeedback: '' });
    case 'spinner-tick':
      return state.setupInstalling ? result({ ...state, spinnerFrame: state.spinnerFrame + 1 }) : result(state);
    default:
      return result(state);
  }
}

function clampViewport(state) {
  if (state.screen === SCREEN.timeline) return { ...state, scroll: Math.min(state.scroll, timelineMaxScroll(state)) };
  return state.screen === SCREEN.observationDetail ? { ...state, detailScroll: clampDetailScroll(state) } : state;
}

function onKey(state, msg, deps) {
  if (msg.key === 'ctrl+c') return result(state, { type: 'quit' });
  if (state.screen === SCREEN.search && state.searchInput.focused) return onSearchInput(state, msg);
  if (state.screen === SCREEN.cloudConfig && state.cloudConfigInput.focused) return onCloudConfigInput(state, msg);
  return onKeyPress({ ...state, errorMsg: '' }, msg.key, deps);
}

function onKeyPress(state, key, deps) {
  switch (state.screen) {
    case SCREEN.dashboard: return onDashboard(state, key, deps);
    case SCREEN.search: return onSearch(state, key);
    case SCREEN.searchResults: return onSearchResults(state, key);
    case SCREEN.recent: return onRecent(state, key);
    case SCREEN.observationDetail: return onObservationDetail(state, key);
    case SCREEN.timeline: return onTimeline(state, key);
    case SCREEN.sessions: return onSessions(state, key);
    case SCREEN.sessionDetail: return onSessionDetail(state, key);
    case SCREEN.setup: return onSetup(state, key);
    case SCREEN.cloudSettings: return onCloudSettings(state, key);
    case SCREEN.cloudConfig: return onCloudConfig(state, key);
    case SCREEN.cloudStatus: return onCloudStatus(state, key);
    case SCREEN.cloudEnrollment: return onCloudEnrollment(state, key);
    default: return result(state);
  }
}

// ─── Panel ───────────────────────────────────────────────────────────────────

function openSearch(state, prev) {
  return { ...state, prevScreen: prev, screen: SCREEN.search, cursor: 0, searchInput: focus(setValue(state.searchInput, '')) };
}

function onDashboard(state, key, deps) {
  switch (key) {
    case 'up': case 'k': return result(state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : state);
    case 'down': case 'j': return result(state.cursor < DASHBOARD_MENU.length - 1 ? { ...state, cursor: state.cursor + 1 } : state);
    case 'enter': case ' ': return selectDashboard(state, deps);
    case 's': case '/': return result(openSearch(state, SCREEN.dashboard));
    case 'q': return result(state, { type: 'quit' });
    default: return result(state);
  }
}

function selectDashboard(state, deps) {
  const go = { ...state, prevScreen: SCREEN.dashboard, cursor: 0, scroll: 0 };
  switch (state.cursor) {
    case 0: return result(openSearch(state, SCREEN.dashboard));
    case 1: return result({ ...go, screen: SCREEN.recent }, { type: 'load-recent' });
    case 2: return result({ ...go, screen: SCREEN.sessions }, { type: 'load-sessions' });
    case 3:
      return result({
        ...go, screen: SCREEN.setup, setupAgents: deps.agents ? deps.agents() : [], setupResult: null, setupError: '', setupDone: false, setupInstalling: false, setupInstallingName: '',
      });
    case 4: return result({ ...go, screen: SCREEN.cloudSettings });
    case 5: return result(state, { type: 'quit' });
    default: return result(state);
  }
}

// ─── Búsqueda ────────────────────────────────────────────────────────────────

function onSearchInput(state, msg) {
  if (msg.key === 'enter') {
    const query = inputValue(state.searchInput);
    if (query === '') return result(state);
    return result({ ...state, searchInput: blur(state.searchInput) }, { type: 'search', query });
  }
  if (msg.key === 'esc') return result({ ...state, searchInput: blur(state.searchInput), screen: SCREEN.dashboard, cursor: 0 });
  return result({ ...state, searchInput: updateTextInput(state.searchInput, msg.key, msg.input ?? '') });
}

function onSearch(state, key) {
  if (key === 'esc' || key === 'q') return result({ ...state, screen: SCREEN.dashboard, cursor: 0 });
  if (key === 'i' || key === '/') return result({ ...state, searchInput: focus(state.searchInput) });
  return result(state);
}

/** Navegación común de las listas de observaciones; devuelve `null` si la tecla no es de lista. */
function listKey(state, key, { items, scrollKey, chrome }) {
  const visible = visibleItems(state, chrome);
  const at = state[scrollKey];
  if (key === 'up' || key === 'k') {
    if (state.cursor <= 0) return state;
    const cursor = state.cursor - 1;
    return { ...state, cursor, [scrollKey]: cursor < at ? cursor : at };
  }
  if (key === 'down' || key === 'j') {
    if (state.cursor >= items.length - 1) return state;
    const cursor = state.cursor + 1;
    return { ...state, cursor, [scrollKey]: cursor >= at + visible ? cursor - visible + 1 : at };
  }
  return null;
}

function itemActions(state, key, items, from) {
  const item = items[state.cursor];
  if (!item) return null;
  if (key === 'enter') return result({ ...state, prevScreen: from }, { type: 'load-detail', id: item.id });
  if (key === 'c') return result(state, { type: 'copy', content: item.content });
  if (key === 't') return result({ ...state, prevScreen: from }, { type: 'load-timeline', id: item.id });
  return null;
}

function onSearchResults(state, key) {
  const moved = listKey(state, key, { items: state.searchResults, scrollKey: 'scroll', chrome: 10 });
  if (moved) return result(moved);
  const acted = itemActions(state, key, state.searchResults, SCREEN.searchResults);
  if (acted) return acted;
  if (key === '/' || key === 's') return result({ ...state, prevScreen: SCREEN.searchResults, screen: SCREEN.search, searchInput: focus(state.searchInput) });
  if (key === 'esc' || key === 'q') {
    return result({ ...state, prevScreen: SCREEN.dashboard, screen: SCREEN.search, cursor: 0, scroll: 0, searchInput: focus(state.searchInput) });
  }
  return result(state);
}

function onRecent(state, key) {
  const moved = listKey(state, key, { items: state.recentObservations, scrollKey: 'scroll', chrome: 8 });
  if (moved) return result(moved);
  const acted = itemActions(state, key, state.recentObservations, SCREEN.recent);
  if (acted) return acted;
  if (key === 'esc' || key === 'q') return result({ ...state, screen: SCREEN.dashboard, cursor: 0, scroll: 0 }, { type: 'load-stats' });
  return result(state);
}

function onObservationDetail(state, key) {
  const base = { ...state, detailScroll: clampDetailScroll(state) };
  switch (key) {
    case 'up': case 'k': return result(base.detailScroll > 0 ? { ...base, detailScroll: base.detailScroll - 1 } : base);
    case 'down': case 'j': return result(base.detailScroll < detailMaxScroll(base) ? { ...base, detailScroll: base.detailScroll + 1 } : base);
    case 'c': return base.selectedObservation ? result(base, { type: 'copy', content: base.selectedObservation.content }) : result(base);
    case 't': return base.selectedObservation ? result(base, { type: 'load-timeline', id: base.selectedObservation.id }) : result(base);
    case 'esc': case 'q': return result({ ...base, screen: base.prevScreen, cursor: 0, detailScroll: 0 }, ...refreshScreen(base.prevScreen));
    default: return result(base);
  }
}

function onTimeline(state, key) {
  switch (key) {
    case 'up': case 'k': return result(state.scroll > 0 ? { ...state, scroll: state.scroll - 1 } : state);
    case 'down': case 'j': return result(state.scroll < timelineMaxScroll(state) ? { ...state, scroll: state.scroll + 1 } : state);
    case 'esc': case 'q': return result({ ...state, screen: state.prevScreen, cursor: 0, scroll: 0 }, ...refreshScreen(state.prevScreen));
    default: return result(state);
  }
}

// ─── Sesiones ────────────────────────────────────────────────────────────────

function onSessions(state, key) {
  if (state.sessionDeleteState === DELETE_STATE.deleting) return result(state);
  if (state.sessionDeleteState === DELETE_STATE.prompt) {
    if (key === 'y' || key === 'Y') {
      if (state.sessionDeleteId === '') return result(reset(state));
      return result({ ...state, sessionDeleteState: DELETE_STATE.deleting }, { type: 'delete-session', id: state.sessionDeleteId });
    }
    if (key === 'n' || key === 'N' || key === 'esc') return result(reset(state));
    return result(state);
  }
  const visible = Math.max(5, state.height - 8);
  if (key === 'up' || key === 'k') {
    if (state.cursor <= 0) return result(state);
    const cursor = state.cursor - 1;
    return result({ ...state, cursor, scroll: cursor < state.scroll ? cursor : state.scroll });
  }
  if (key === 'down' || key === 'j') {
    if (state.cursor >= state.sessions.length - 1) return result(state);
    const cursor = state.cursor + 1;
    return result({ ...state, cursor, scroll: cursor >= state.scroll + visible ? cursor - visible + 1 : state.scroll });
  }
  const session = state.sessions[state.cursor];
  if (key === 'enter' && session) return result({ ...state, selectedSessionIdx: state.cursor, prevScreen: SCREEN.sessions }, { type: 'load-session-observations', id: session.id });
  if ((key === 'd' || key === 'D') && session) return result({ ...state, sessionDeleteState: DELETE_STATE.prompt, sessionDeleteId: session.id, sessionDeleteProject: session.project });
  if (key === 'esc' || key === 'q') return result(reset({ ...state, screen: SCREEN.dashboard, cursor: 0, scroll: 0 }), { type: 'load-stats' });
  return result(state);
}

function onSessionDetail(state, key) {
  const moved = listKey(state, key, { items: state.sessionObservations, scrollKey: 'sessionDetailScroll', chrome: 12 });
  if (moved) return result(moved);
  const acted = itemActions(state, key, state.sessionObservations, SCREEN.sessionDetail);
  if (acted) return acted;
  if (key === 'esc' || key === 'q') return result({ ...state, screen: SCREEN.sessions, cursor: state.selectedSessionIdx, sessionDetailScroll: 0 }, { type: 'load-sessions' });
  return result(state);
}

// ─── Instalación para Copilot ────────────────────────────────────────────────

function onSetup(state, key) {
  if (state.setupInstalling) return result(state);
  if (state.setupDone) {
    if (key === 'esc' || key === 'q' || key === 'enter') {
      return result({ ...state, screen: SCREEN.dashboard, cursor: 0, setupDone: false, setupResult: null, setupError: '' }, { type: 'load-stats' });
    }
    return result(state);
  }
  switch (key) {
    case 'up': case 'k': return result(state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : state);
    case 'down': case 'j': return result(state.cursor < state.setupAgents.length - 1 ? { ...state, cursor: state.cursor + 1 } : state);
    case 'enter': {
      const agent = state.setupAgents[state.cursor];
      if (!agent) return result(state);
      return result({ ...state, setupInstalling: true, setupInstallingName: agent.name, spinnerFrame: 0 }, { type: 'install', agent: agent.name });
    }
    case 'esc': case 'q': return result({ ...state, screen: SCREEN.dashboard, cursor: 0 }, { type: 'load-stats' });
    default: return result(state);
  }
}

// ─── Sincronización con la nube ──────────────────────────────────────────────

const backToDashboard = (state) => result({ ...state, screen: SCREEN.dashboard, cursor: 0 }, { type: 'load-stats' });
const backToCloudSettings = (state, cursor) => result({ ...state, screen: SCREEN.cloudSettings, cursor });
const nextFocus = (focus) => (focus >= CLOUD_CONFIG_FOCUS.cancel ? CLOUD_CONFIG_FOCUS.input : focus + 1);
const previousFocus = (focus) => (focus <= CLOUD_CONFIG_FOCUS.input ? CLOUD_CONFIG_FOCUS.cancel : focus - 1);

function onCloudSettings(state, key) {
  switch (key) {
    case 'up': case 'k': return result(state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : state);
    case 'down': case 'j': return result(state.cursor < CLOUD_SETTINGS_MENU.length - 1 ? { ...state, cursor: state.cursor + 1 } : state);
    case 'enter': case ' ': return selectCloudSettings(state);
    case 'esc': case 'q': return backToDashboard(state);
    default: return result(state);
  }
}

function selectCloudSettings(state) {
  const generation = state.cloudGeneration + 1;
  switch (state.cursor) {
    case 0:
      return result(
        { ...state, screen: SCREEN.cloudConfig, cloudConfigError: '', cloudConfigPingStatus: '', cloudConfigFocus: CLOUD_CONFIG_FOCUS.input, cloudConfigSaving: false, cloudGeneration: generation },
        { type: 'load-cloud-config', generation },
      );
    case 1:
      return result(
        { ...state, screen: SCREEN.cloudStatus, cloudGeneration: generation, cloudStatusLoading: true, cloudStatusLastError: '', cloudStatusHealthError: '' },
        { type: 'load-cloud-status', generation },
      );
    case 2:
      return result({ ...state, screen: SCREEN.cloudEnrollment, cursor: 0, cloudEnrollmentLoading: true, cloudEnrollmentError: '' }, { type: 'load-cloud-enrollment' });
    case 3: return backToDashboard(state);
    default: return result(state);
  }
}

/** Teclas con el campo de la URL enfocado: edita el texto y solo reserva tab, enter y esc. */
function onCloudConfigInput(state, msg) {
  const input = blur(state.cloudConfigInput);
  switch (msg.key) {
    case 'tab': return result({ ...state, cloudConfigInput: input, cloudConfigFocus: nextFocus(state.cloudConfigFocus) });
    case 'shift+tab': {
      const cloudConfigFocus = previousFocus(state.cloudConfigFocus);
      return result({ ...state, cloudConfigInput: cloudConfigFocus === CLOUD_CONFIG_FOCUS.input ? focus(input) : input, cloudConfigFocus });
    }
    case 'enter': return result({ ...state, cloudConfigInput: input, cloudConfigFocus: CLOUD_CONFIG_FOCUS.test });
    case 'esc': return backToCloudSettings({ ...state, cloudConfigInput: input }, 0);
    default: return result({ ...state, cloudConfigInput: updateTextInput(state.cloudConfigInput, msg.key, msg.input ?? '') });
  }
}

function onCloudConfig(state, key) {
  if (state.cloudConfigSaving) return result(state);
  const at = state.cloudConfigFocus;
  switch (key) {
    case 'tab': case 'down': case 'j': return result({ ...state, cloudConfigFocus: nextFocus(at) });
    case 'shift+tab': case 'up': case 'k': return result({ ...state, cloudConfigFocus: previousFocus(at) });
    case 'i': return result({ ...state, cloudConfigFocus: CLOUD_CONFIG_FOCUS.input, cloudConfigInput: focus(state.cloudConfigInput) });
    case 'esc': case 'q': return backToCloudSettings({ ...state, cloudConfigInput: blur(state.cloudConfigInput) }, 0);
    case 'enter': case ' ':
      if (at === CLOUD_CONFIG_FOCUS.input) return result({ ...state, cloudConfigInput: focus(state.cloudConfigInput) });
      if (at === CLOUD_CONFIG_FOCUS.cancel) return backToCloudSettings(state, 0);
      return checkCloudServer(state);
    default: return result(state);
  }
}

/** «Test connection» y «Save server» validan la URL y comprueban el servidor; guardar sigue en `onCloudPing`. */
function checkCloudServer(state) {
  let serverUrl;
  try {
    serverUrl = validateServerUrl(inputValue(state.cloudConfigInput));
  } catch (error) {
    return result({ ...state, cloudConfigError: error.message });
  }
  const generation = state.cloudGeneration + 1;
  return result(
    { ...state, cloudConfigError: '', cloudConfigPingStatus: 'checking', cloudConfigTest: state.cloudConfigFocus === CLOUD_CONFIG_FOCUS.test, cloudConfigSaving: true, cloudGeneration: generation },
    { type: 'ping-cloud', origin: 'config', generation, serverUrl },
  );
}

function onCloudStatus(state, key) {
  switch (key) {
    case 'r': {
      const generation = state.cloudGeneration + 1;
      return result({ ...state, cloudGeneration: generation, cloudStatusLoading: true, cloudStatusHealthError: '' }, { type: 'load-cloud-status', generation });
    }
    case 'esc': case 'q': return backToCloudSettings(state, 1);
    default: return result(state);
  }
}

function onCloudEnrollment(state, key) {
  const items = state.cloudEnrollmentItems;
  switch (key) {
    case 'up': case 'k': return result(state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : state);
    case 'down': case 'j': return result(state.cursor < items.length - 1 ? { ...state, cursor: state.cursor + 1 } : state);
    case 'enter': case ' ':
      if (state.cloudEnrollmentLoading || state.cursor >= items.length) return result(state);
      return result({ ...state, cloudEnrollmentLoading: true }, { type: 'toggle-cloud-enrollment', item: items[state.cursor] });
    case 'r': return result({ ...state, cloudEnrollmentLoading: true }, { type: 'load-cloud-enrollment' });
    case 'esc': case 'q': return backToCloudSettings(state, 2);
    default: return result(state);
  }
}

/** Resultados de las órdenes de la nube; los que llevan `generation` se ignoran si ya hay otra petición más reciente. */
function onCloudResult(state, msg) {
  const stale = msg.generation !== state.cloudGeneration;
  switch (msg.type) {
    case 'cloud-config-loaded':
      if (stale || state.screen !== SCREEN.cloudConfig) return result(state);
      if (msg.error) return result({ ...state, cloudConfigError: msg.error.message });
      return result({ ...state, cloudConfigTokenSource: msg.tokenSource, cloudConfigInput: focus(setValue(state.cloudConfigInput, msg.serverUrl)) });
    case 'cloud-status-loaded': {
      if (stale || state.screen !== SCREEN.cloudStatus) return result(state);
      if (msg.error) return result({ ...state, cloudStatusLoading: false, cloudStatusLastError: msg.error.message, cloudStatusHealthError: '' });
      const next = {
        ...state, cloudStatusLoading: false, cloudStatusServerUrl: msg.serverUrl, cloudStatusLastSync: msg.lastSync, cloudStatusPending: msg.pendingCount,
        cloudStatusLastError: msg.lastError, cloudStatusHealthError: '',
      };
      return msg.serverUrl === '' ? result(next) : result(next, { type: 'ping-cloud', origin: 'status', generation: msg.generation, serverUrl: msg.serverUrl });
    }
    case 'cloud-enrollment-loaded': {
      if (msg.error) return result({ ...state, cloudEnrollmentLoading: false, cloudEnrollmentError: msg.error.message });
      const next = { ...state, cloudEnrollmentLoading: false, cloudEnrollmentItems: msg.items, cloudEnrollmentError: '' };
      if (state.screen === SCREEN.cloudEnrollment) next.cursor = Math.max(0, Math.min(state.cursor, msg.items.length - 1));
      return result(next);
    }
    case 'cloud-enrollment-toggled':
      if (msg.error) return result({ ...state, cloudEnrollmentLoading: false, cloudEnrollmentError: msg.error.message });
      return result({ ...state, cloudEnrollmentLoading: true }, { type: 'load-cloud-enrollment' });
    case 'cloud-ping': return stale ? result(state) : onCloudPing(state, msg);
    default: return onCloudUrlSaved(state, msg);
  }
}

function onCloudPing(state, msg) {
  if (msg.origin === 'status') {
    if (state.screen !== SCREEN.cloudStatus || msg.serverUrl !== state.cloudStatusServerUrl) return result(state);
    return result({ ...state, cloudStatusHealth: msg.status, cloudStatusHealthError: msg.error ? msg.error.message : '' });
  }
  if (state.screen !== SCREEN.cloudConfig || msg.serverUrl !== goTrim(inputValue(state.cloudConfigInput))) return result(state);
  const next = { ...state, cloudConfigSaving: false, cloudConfigPingStatus: msg.status };
  if (msg.error) return result({ ...next, cloudConfigError: msg.error.message });
  if (state.cloudConfigTest) return result(next);
  if (msg.status !== 'reachable' && msg.status !== 'unauthorized') return result({ ...next, cloudConfigError: 'server is unreachable' });
  return result(next, { type: 'save-cloud-url', serverUrl: msg.serverUrl });
}

function onCloudUrlSaved(state, msg) {
  if (state.screen !== SCREEN.cloudConfig) return result(state);
  if (msg.error) return result({ ...state, cloudConfigError: msg.error.message });
  return result({ ...state, cloudConfigFocus: CLOUD_CONFIG_FOCUS.save, cloudConfigInput: blur(state.cloudConfigInput) });
}

export { visibleItems };
