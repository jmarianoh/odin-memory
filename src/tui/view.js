import { Fragment, createElement } from 'react';
import htm from 'htm';
import { Box, Text } from 'ink';
import { observationState } from '../store/observations.js';
import { COLORS, LOGO_GRADIENT } from './palette.js';
import { localTime, truncateStr } from './format.js';
import {
  CLOUD_CONFIG_ACTIONS, CLOUD_CONFIG_FOCUS, CLOUD_SETTINGS_MENU, DASHBOARD_MENU, DELETE_STATE, SCREEN, detailContentLines, detailLayout, detailMetadata, timelineRows, timelineViewport, visibleItems,
} from './model.js';
import { inputView } from './text-input.js';
import { ENV_CLOUD_TOKEN, SOURCE_LABEL } from '../cloud/config.js';

const html = htm.bind(createElement);

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const LOGO = [
  ' ██████  ██████  ██ ███    ██ ',
  '██    ██ ██   ██ ██ ████   ██ ',
  '██    ██ ██   ██ ██ ██ ██  ██ ',
  '██    ██ ██   ██ ██ ██  ██ ██ ',
  ' ██████  ██████  ██ ██   ████ ',
];

// ─── Piezas ──────────────────────────────────────────────────────────────────

const Header = ({ title }) => html`
  <${Box} borderStyle="single" borderColor=${COLORS.overlay} borderTop=${false} borderLeft=${false} borderRight=${false} marginBottom=${1}>
    <${Text} bold color=${COLORS.accent}>${title}<//>
  <//>`;

const Help = ({ text }) => html`<${Box} marginTop=${1}><${Text} color=${COLORS.subtext}>${text}<//><//>`;
const Muted = ({ children, italic = true }) => html`<${Text} color=${COLORS.subtext} italic=${italic}>${children}<//>`;
const Empty = ({ text }) => html`<${Box} paddingLeft=${2}><${Muted}>${text}<//><//>`;

function Menu({ items, cursor }) {
  return html`<${Box} flexDirection="column">${items.map((item, i) => html`
    <${Text} key=${item} bold=${i === cursor} color=${i === cursor ? COLORS.accent : COLORS.text}>${i === cursor ? ' ▸ ' : '   '}${item}<//>`)}<//>`;
}

function Scroller({ from, to, total }) {
  return html`<${Box} paddingLeft=${2}><${Muted}>showing ${from}-${to} of ${total}<//><//>`;
}

/** Dos líneas: identificador, tipo, insignias, título, proyecto y fecha; debajo, un extracto del contenido. */
function ObservationItem({ index, cursor, o }) {
  const selected = index === cursor;
  const needsReview = observationState(o.review_after) === 'needs_review';
  const preview = truncateStr(o.content, 80);
  return html`
    <${Box} flexDirection="column">
      <${Text}>
        <${Text} color=${selected ? COLORS.accent : COLORS.text}>${selected ? '▸ ' : '  '}<//>
        <${Text} color=${COLORS.blue}>${`#${String(o.id).padEnd(5)}`}<//>${' '}
        <${Text} bold color=${COLORS.peach}>${`[${String(o.type).padEnd(12)}]`}<//>
        ${needsReview ? html`<${Text} bold color=${COLORS.yellow}>${' [needs_review]'}<//>` : null}
        ${o.pinned ? html`<${Text}>${' [pinned]'}<//>` : null}${' '}
        <${Text} bold=${selected} color=${selected ? COLORS.accent : COLORS.text}>${truncateStr(o.title, 50)}<//>
        ${o.project ? html`<${Text} color=${COLORS.yellow}>${`  ${o.project}`}<//>` : null}
        <${Text} italic color=${COLORS.subtext}>${`  ${localTime(o.created_at)}`}<//>
      <//>
      ${preview === '' ? null : html`<${Box} paddingLeft=${4}><${Text} color=${COLORS.subtext}>${preview}<//><//>`}
    <//>`;
}

function ObservationList({ items, cursor, scroll, visible }) {
  const end = Math.min(scroll + visible, items.length);
  return html`
    <${Box} flexDirection="column">
      ${items.slice(scroll, end).map((o, i) => html`<${ObservationItem} key=${o.id} index=${scroll + i} cursor=${cursor} o=${o} />`)}
      ${items.length > visible ? html`<${Scroller} from=${scroll + 1} to=${end} total=${items.length} />` : null}
    <//>`;
}

function SearchBox({ input }) {
  const v = inputView(input);
  return html`
    <${Box} borderStyle="single" borderColor=${COLORS.accent} paddingX=${1} marginBottom=${1}>
      <${Text}>> ${v.placeholder && !input.focused ? html`<${Text} color=${COLORS.subtext}>${v.after}<//>` : html`<${Fragment}>${v.before}<${Text} inverse>${v.cursor}<//>${v.after}<//>`}<//>
    <//>`;
}

// ─── Pantallas ───────────────────────────────────────────────────────────────

function Logo({ version }) {
  return html`
    <${Box} flexDirection="column" borderStyle="double" borderColor=${COLORS.overlay} paddingX=${1} marginBottom=${1} alignSelf="flex-start">
      <${Text} bold color=${COLORS.accent}> ● SYSTEM ONLINE<//>
      <${Text}> <//>
      ${LOGO.map((line, i) => html`<${Text} key=${i} bold color=${LOGO_GRADIENT[i]}> ${line}<//>`)}
      <${Text}> <//>
      <${Text} italic color=${COLORS.subtext}> > odin ${version} — persistent memory for Copilot<//>
    <//>`;
}

function Dashboard({ s }) {
  const stats = s.stats;
  const rows = stats ? [[stats.total_sessions, 'sessions'], [stats.total_observations, 'observations'], [stats.total_prompts, 'prompts'], [stats.projects.length, 'projects']] : [];
  return html`
    <${Box} flexDirection="column">
      <${Logo} version=${s.version} />
      ${s.updateMsg ? html`<${Box} marginBottom=${1}><${Text} bold color=${s.updateStatus === 'check_failed' ? COLORS.red : COLORS.yellow}>${s.updateMsg}<//><//>` : null}
      ${stats
    ? html`<${Box} flexDirection="column" borderStyle="single" borderColor=${COLORS.overlay} paddingX=${2} marginBottom=${1} alignSelf="flex-start">
          ${rows.map(([n, label]) => html`<${Text} key=${label}><${Text} bold color=${COLORS.green}>${String(n).padStart(8)}<//>  ${label}<//>`)}
        <//>`
    : html`<${Box} borderStyle="single" borderColor=${COLORS.overlay} paddingX=${2} marginBottom=${1} alignSelf="flex-start"><${Text}>Loading stats...<//><//>`}
      ${stats && stats.projects.length > 0 ? html`
        <${Box} flexDirection="column" marginBottom=${1}>
          <${Text} bold color=${COLORS.mauve}>  Projects<//>
          ${stats.projects.slice(0, 5).map((p) => html`<${Text} key=${p}>  • ${p}<//>`)}
          ${stats.projects.length > 5 ? html`<${Box} paddingLeft=${4}><${Muted}>...and ${stats.projects.length - 5} more projects<//><//>` : null}
        <//>` : null}
      <${Text} bold color=${COLORS.mauve}>  Actions<//>
      <${Menu} items=${DASHBOARD_MENU} cursor=${s.cursor} />
      <${Help} text="  j/k navigate • enter select • s search • q quit" />
    <//>`;
}

function Search({ s }) {
  return html`
    <${Box} flexDirection="column">
      <${Header} title="  Search Memories" />
      <${SearchBox} input=${s.searchInput} />
      <${Help} text="  Type a query and press enter • esc go back" />
    <//>`;
}

function SearchResults({ s }) {
  const count = s.searchResults.length;
  const title = `  Search: ${JSON.stringify(s.searchQuery)} — ${count} result${count === 1 ? '' : 's'}`;
  if (count === 0) {
    return html`<${Box} flexDirection="column"><${Header} title=${title} /><${Empty} text="No memories found. Try a different query." /><${Help} text="  / new search • esc back" /><//>`;
  }
  return html`
    <${Box} flexDirection="column">
      <${Header} title=${title} />
      <${ObservationList} items=${s.searchResults} cursor=${s.cursor} scroll=${s.scroll} visible=${visibleItems(s, 10)} />
      <${Help} text="  j/k navigate • enter detail • c copy • t timeline • / search • esc back" />
    <//>`;
}

function Recent({ s }) {
  const count = s.recentObservations.length;
  const title = `  Recent Observations — ${count} total`;
  if (count === 0) return html`<${Box} flexDirection="column"><${Header} title=${title} /><${Empty} text="No observations yet." /><${Help} text="  esc back" /><//>`;
  return html`
    <${Box} flexDirection="column">
      <${Header} title=${title} />
      <${ObservationList} items=${s.recentObservations} cursor=${s.cursor} scroll=${s.scroll} visible=${visibleItems(s, 8)} />
      <${Help} text="  j/k navigate • enter detail • c copy • t timeline • esc back" />
    <//>`;
}

const KIND_COLOR = { type: COLORS.peach, id: COLORS.blue, time: COLORS.subtext, project: COLORS.yellow, plain: COLORS.text, title: COLORS.text, state: COLORS.text };

function ObservationDetail({ s }) {
  const obs = s.selectedObservation;
  if (!obs) return html`<${Box} flexDirection="column"><${Header} title="  Observation Detail" /><${Empty} text="Loading..." /><//>`;
  const { metadata, viewport } = detailLayout(s);
  const lines = detailContentLines(s);
  const scroll = Math.min(Math.max(0, s.detailScroll), Math.max(0, lines.length - viewport));
  const end = Math.min(scroll + viewport, lines.length);
  const rows = detailMetadata(obs).slice(0, metadata);
  return html`
    <${Box} flexDirection="column">
      <${Header} title=${`  Observation #${obs.id}`} />
      ${rows.map(([label, value, kind]) => html`
        <${Text} key=${label}><${Text} color=${COLORS.subtext}>${`${label}:`.padStart(14)} <//><${Text} bold=${kind === 'title'} color=${kind === 'state' && value === 'needs_review' ? COLORS.yellow : KIND_COLOR[kind]}>${value}<//><//>`)}
      <${Box} marginTop=${1}><${Text} bold color=${COLORS.mauve}>  Content<//><//>
      ${lines.slice(scroll, end).map((line, i) => html`<${Text} key=${i}>  ${line}<//>`)}
      ${viewport > 0 && lines.length > viewport ? html`<${Box} paddingLeft=${2}><${Muted}>line ${scroll + 1}-${end} of ${lines.length}<//><//>` : null}
      <${Help} text="  j/k scroll • c copy • t timeline • esc back" />
    <//>`;
}

function TimelineRow({ row }) {
  switch (row.kind) {
    case 'session':
      return html`<${Text}>  <${Text} color=${COLORS.subtext}>Session:<//> <${Text} color=${COLORS.blue}>${row.id}<//>  <${Text} color=${COLORS.subtext}>Project:<//> <${Text} color=${COLORS.yellow}>${row.project}<//><//>`;
    case 'heading': return html`<${Text} bold color=${COLORS.mauve}>  ${row.text}<//>`;
    case 'connector': return html`<${Text}>  <${Text} color=${COLORS.overlay}>│<//><//>`;
    case 'entry':
      return html`<${Text}>  <${Text} color=${COLORS.overlay}>│<//> <${Text} color=${COLORS.blue}>${`#${String(row.e.id).padEnd(4)}`}<//> <${Text} bold color=${COLORS.peach}>${`[${String(row.e.type).padEnd(12)}]`}<//>  <${Text} color=${COLORS.subtext}>${truncateStr(row.e.title, 60)}<//><//>`;
    case 'focus-title':
      return html`<${Text}><${Text} color=${COLORS.accent}> ▌ <//><${Text} color=${COLORS.blue}>${`#${row.e.id}`}<//> <${Text} bold color=${COLORS.peach}>${`[${row.e.type}]`}<//>  <${Text} bold color=${COLORS.accent}>${row.e.title}<//><//>`;
    default:
      return html`<${Text}><${Text} color=${COLORS.accent}> ▌ <//>${truncateStr(row.e.content, 120)}<//>`;
  }
}

function Timeline({ s }) {
  const tl = s.timeline;
  if (!tl) return html`<${Box} flexDirection="column"><${Header} title="  Timeline" /><${Empty} text="Loading..." /><//>`;
  const all = timelineRows(tl);
  const viewport = timelineViewport(s);
  const scroll = Math.min(s.scroll, Math.max(0, all.length - viewport));
  return html`
    <${Box} flexDirection="column">
      <${Header} title=${`  Timeline — Observation #${tl.focus.id} (${tl.total_in_range} total in session)`} />
      ${all.slice(scroll, scroll + viewport).map((row, i) => html`<${TimelineRow} key=${scroll + i} row=${row} />`)}
      <${Help} text="  j/k scroll • esc back" />
    <//>`;
}

function Sessions({ s }) {
  const count = s.sessions.length;
  const title = `  Sessions — ${count} total`;
  if (s.sessionDeleteState === DELETE_STATE.deleting) {
    return html`<${Box} flexDirection="column"><${Header} title=${title} /><${Text} bold color=${COLORS.mauve}>  Deleting Session<//><${Text}>${`  Deleting session ${JSON.stringify(s.sessionDeleteId)}...`}<//><//>`;
  }
  if (s.sessionDeleteState === DELETE_STATE.prompt) {
    return html`
      <${Box} flexDirection="column">
        <${Header} title=${title} />
        <${Text} bold color=${COLORS.mauve}>  Confirm Session Delete<//>
        <${Box} marginTop=${1}><${Text}>${`  Delete session ${JSON.stringify(s.sessionDeleteId)} from project ${JSON.stringify(s.sessionDeleteProject)}?`}<//><//>
        <${Muted}>  Sessions with observations cannot be deleted; Odin will refuse unsafe deletes.<//>
        <${Help} text="  [y] Delete  [n] Cancel  [esc] Cancel" />
      <//>`;
  }
  if (count === 0) return html`<${Box} flexDirection="column"><${Header} title=${title} /><${Empty} text="No sessions yet." /><${Help} text="  esc back" /><//>`;
  const visible = Math.max(5, s.height - 8);
  const end = Math.min(s.scroll + visible, count);
  return html`
    <${Box} flexDirection="column">
      <${Header} title=${title} />
      ${s.sessions.slice(s.scroll, end).map((session, i) => {
    const index = s.scroll + i;
    const selected = index === s.cursor;
    return html`<${Text} key=${session.id}>
          <${Text} color=${selected ? COLORS.accent : COLORS.text}>${selected ? '▸ ' : '  '}<//><${Text} color=${COLORS.yellow}>${String(session.project).padEnd(20)}<//>  <${Text} italic color=${COLORS.subtext}>${localTime(session.started_at)}<//>  <${Text} bold color=${COLORS.green}>${session.observation_count}<//> obs  <${Text} bold=${selected} color=${selected ? COLORS.accent : COLORS.text}>${session.summary == null ? '' : truncateStr(session.summary, 50)}<//>
        <//>`;
  })}
      ${count > visible ? html`<${Scroller} from=${s.scroll + 1} to=${end} total=${count} />` : null}
      <${Help} text="  j/k navigate • enter view session • d delete • esc back" />
    <//>`;
}

function SessionDetail({ s }) {
  const session = s.sessions[s.selectedSessionIdx];
  if (!session) return html`<${Box} flexDirection="column"><${Header} title="  Session Detail" /><${Empty} text="Session not found." /><//>`;
  const count = s.sessionObservations.length;
  return html`
    <${Box} flexDirection="column">
      <${Header} title=${`  Session: ${session.project} — ${localTime(session.started_at)}`} />
      ${session.summary == null ? null : html`<${Box} marginBottom=${1}><${Text}>  <${Text} color=${COLORS.subtext}>Summary:<//> ${session.summary}<//><//>`}
      <${Text} bold color=${COLORS.mauve}>${`  Observations (${count})`}<//>
      ${count === 0
    ? html`<${Fragment}><${Empty} text="No observations in this session." /><${Help} text="  esc back" /><//>`
    : html`<${Fragment}><${ObservationList} items=${s.sessionObservations} cursor=${s.cursor} scroll=${s.sessionDetailScroll} visible=${visibleItems(s, 12)} />
        <${Help} text="  j/k navigate • enter detail • c copy • t timeline • esc back" /><//>`}
    <//>`;
}

const ACTION_LABEL = { created: 'created', updated: 'updated', unchanged: 'unchanged', removed: 'removed', absent: 'absent' };
const ITEM_LABEL = { mcp: 'MCP server', instructions: 'Instructions', hooks: 'Hooks' };

function Setup({ s }) {
  const title = '  Setup — Register odin for Copilot';
  if (s.setupInstalling) {
    return html`
      <${Box} flexDirection="column">
        <${Header} title=${title} />
        <${Text}>  ${SPINNER[s.spinnerFrame % SPINNER.length]} Installing <${Text} bold color=${COLORS.accent}>${s.setupInstallingName}<//>...<//>
        <${Box} marginTop=${1}><${Muted}>  Writing the MCP server, instructions and hooks<//><//>
      <//>`;
  }
  if (s.setupDone) {
    const next = s.setupResult?.agent === 'vscode-copilot' ? 'Reload VS Code (Developer: Reload Window) to pick up the changes.' : 'Restart the Copilot CLI to pick up the changes.';
    return html`
      <${Box} flexDirection="column">
        <${Header} title=${title} />
        ${s.setupError
    ? html`<${Text} bold color=${COLORS.red}>  ✗ Installation failed: ${s.setupError}<//>`
    : html`<${Fragment}><${Text} bold color=${COLORS.green}>  ✓ Registered ${s.setupResult.agent}<//>
            ${s.setupResult.changes.map((c) => html`<${Text} key=${c.item}>  <${Text} color=${COLORS.subtext}>${(ITEM_LABEL[c.item] ?? c.item).padEnd(13)}<//> ${(ACTION_LABEL[c.action] ?? c.action).padEnd(10)} <${Text} color=${COLORS.yellow}>${c.path}<//><//>`)}
            <${Box} marginTop=${1}><${Text} bold color=${COLORS.mauve}>  Next Steps<//><//>
            <${Text}>  1. ${next}<//><//>`}
        <${Help} text="  enter/esc back to dashboard" />
      <//>`;
  }
  return html`
    <${Box} flexDirection="column">
      <${Header} title=${title} />
      <${Text} bold color=${COLORS.mauve}>  Select where to set up odin<//>
      <${Box} flexDirection="column" marginTop=${1}>
        ${s.setupAgents.map((agent, i) => html`
          <${Box} key=${agent.name} flexDirection="column" marginBottom=${1}>
            <${Text} bold=${i === s.cursor} color=${i === s.cursor ? COLORS.accent : COLORS.text}>${i === s.cursor ? ' ▸ ' : '   '}${agent.description}<//>
            <${Text}>      <${Text} color=${COLORS.subtext}>MCP config:<//> <${Muted}>${agent.installDir}<//><//>
          <//>`)}
      <//>
      <${Help} text="  j/k navigate • enter install • esc back" />
    <//>`;
}

// ─── Nube ────────────────────────────────────────────────────────────────────

const orElse = (value, fallback) => (value === '' ? fallback : value);

function CloudSettings({ s }) {
  return html`
    <${Box} flexDirection="column">
      <${Header} title="  Cloud sync settings" />
      <${Menu} items=${CLOUD_SETTINGS_MENU} cursor=${s.cursor} />
      <${Help} text="  j/k navigate • enter select • esc/q back" />
    <//>`;
}

function CloudConfig({ s }) {
  const v = inputView(s.cloudConfigInput);
  const focused = s.cloudConfigFocus === CLOUD_CONFIG_FOCUS.input;
  return html`
    <${Box} flexDirection="column">
      <${Header} title="  Configure cloud server" />
      <${Box}>
        <${Text} color=${COLORS.subtext}>${'  Server URL: '.padEnd(18)}<//>
        <${Box} borderStyle="single" borderColor=${focused ? COLORS.accent : COLORS.overlay} paddingX=${1}>
          <${Text}>${v.placeholder && !s.cloudConfigInput.focused ? html`<${Text} color=${COLORS.subtext}>${v.after}<//>` : html`<${Fragment}>${v.before}<${Text} inverse=${s.cloudConfigInput.focused}>${v.cursor}<//>${v.after}<//>`}<//>
        <//>
      <//>
      <${Text}><${Text} color=${COLORS.subtext}>${'  Token source: '.padEnd(18)}<//><${Text}>${orElse(s.cloudConfigTokenSource, 'not set')}<//><//>
      ${s.cloudConfigTokenSource === SOURCE_LABEL.env ? null : html`<${Muted}>  Set ${ENV_CLOUD_TOKEN} to override cloud.json.token<//>`}
      <${Box} flexDirection="column" marginTop=${1}>
        ${CLOUD_CONFIG_ACTIONS.map((item, i) => html`
          <${Text} key=${item} bold=${s.cloudConfigFocus === i + 1} color=${s.cloudConfigFocus === i + 1 ? COLORS.accent : COLORS.text}>${s.cloudConfigFocus === i + 1 ? '▸ ' : '  '}${item}<//>`)}
      <//>
      ${s.cloudConfigSaving ? html`<${Muted}>  Checking server...<//>` : null}
      ${s.cloudConfigPingStatus === '' ? null : html`<${Text}><${Text} color=${COLORS.subtext}>  Connection: <//><${Text}>${s.cloudConfigPingStatus}<//><//>`}
      ${s.cloudConfigError === '' ? null : html`<${Text} bold color=${COLORS.red}>  Error: ${s.cloudConfigError}<//>`}
      <${Help} text="  j/k navigate • i edit URL • enter select • esc/q back" />
    <//>`;
}

function CloudStatus({ s }) {
  const rows = [
    ['Server URL', orElse(s.cloudStatusServerUrl, 'not configured')],
    ['Connection health', orElse(s.cloudStatusHealth, 'not checked')],
    ['Last successful sync', orElse(s.cloudStatusLastSync, 'never')],
    ['Pending mutations', String(s.cloudStatusPending)],
    ['Last error', orElse(s.cloudStatusHealthError || s.cloudStatusLastError, 'none')],
  ];
  return html`
    <${Box} flexDirection="column">
      <${Header} title="  Cloud status" />
      ${s.cloudStatusLoading ? html`<${Muted}>  Loading cloud status...<//>` : null}
      ${rows.map(([label, value]) => html`<${Text} key=${label}><${Text} color=${COLORS.subtext}>${`  ${label}: `.padEnd(22)}<//><${Text}>${value}<//><//>`)}
      <${Help} text="  r refresh • esc/q back" />
    <//>`;
}

function CloudEnrollment({ s }) {
  const items = s.cloudEnrollmentItems;
  return html`
    <${Box} flexDirection="column">
      <${Header} title="  Enroll projects for cloud sync" />
      ${s.cloudEnrollmentLoading ? html`<${Muted}>  Loading projects...<//>` : null}
      ${items.length === 0 && !s.cloudEnrollmentLoading ? html`<${Muted}>  No local projects found.<//>` : null}
      ${items.map((item, i) => html`
        <${Text} key=${item.project} bold=${i === s.cursor} color=${i === s.cursor ? COLORS.accent : COLORS.text}>${i === s.cursor ? '▸ ' : '  '}${item.enrolled ? '[x]' : '[ ]'} ${item.project}<//>`)}
      ${s.cloudEnrollmentError === '' ? null : html`<${Text} bold color=${COLORS.red}>  Error: ${s.cloudEnrollmentError}<//>`}
      <${Help} text="  j/k navigate • enter toggle • r refresh • esc/q back" />
    <//>`;
}

const SCREENS = {
  [SCREEN.dashboard]: Dashboard,
  [SCREEN.search]: Search,
  [SCREEN.searchResults]: SearchResults,
  [SCREEN.recent]: Recent,
  [SCREEN.observationDetail]: ObservationDetail,
  [SCREEN.timeline]: Timeline,
  [SCREEN.sessions]: Sessions,
  [SCREEN.sessionDetail]: SessionDetail,
  [SCREEN.setup]: Setup,
  [SCREEN.cloudSettings]: CloudSettings,
  [SCREEN.cloudConfig]: CloudConfig,
  [SCREEN.cloudStatus]: CloudStatus,
  [SCREEN.cloudEnrollment]: CloudEnrollment,
};

/** Árbol de Ink de la pantalla actual, con el error y el aviso de copia debajo. */
export function View({ state }) {
  const Screen = SCREENS[state.screen];
  return html`
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      ${Screen ? html`<${Screen} s=${state} />` : html`<${Text}>Unknown screen<//>`}
      ${state.errorMsg ? html`<${Box} paddingX=${1}><${Text} bold color=${COLORS.red}>Error: ${state.errorMsg}<//><//>` : null}
      ${state.copyFeedback ? html`<${Box} paddingX=${1}><${Text} bold color=${COLORS.green}>${state.copyFeedback}<//><//>` : null}
    <//>`;
}
