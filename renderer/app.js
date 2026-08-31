/** Entry point: tab routing, the top status bar, and the offline banner. */
import { el, replace } from './dom.js'
import { state, subscribe, emit, reloadProviders, reloadSettings, startPolling, watchGatewayState } from './store.js'
import * as providersView from './providers.js'
import * as dashboardView from './dashboard.js'
import * as settingsView from './settings.js'

const VIEWS = {
  providers: providersView,
  dashboard: dashboardView,
  settings: settingsView,
}

let current = 'providers'
/** The dashboard fans out one request per day, so only load it on first visit. */
let dashboardLoaded = false

function statusText() {
  const g = state.gateway
  switch (g.status) {
    case 'running':
      return state.statsError
        ? `running on 127.0.0.1:${g.port} · ${state.statsError}`
        : `running on 127.0.0.1:${g.port} · ${state.enabledNames.length} providers eligible`
    case 'starting':    return 'starting the gateway…'
    case 'port-in-use': return g.detail || `port ${g.port} is in use`
    case 'crashed':     return g.detail || 'gateway crashed — restarting'
    default:            return 'gateway stopped'
  }
}

function dotClass() {
  switch (state.gateway.status) {
    case 'running': return state.statsError ? 'dot warn' : 'dot up'
    case 'starting': return 'dot warn'
    case 'port-in-use':
    case 'crashed': return 'dot down'
    default: return 'dot'
  }
}

async function usePortSuggestion() {
  const { port } = await window.gw.gateway.suggestPort()
  if (!port) return
  await window.gw.gateway.usePort(port)
  await reloadSettings()
  renderChrome()
  VIEWS[current].render()
}

function renderChrome() {
  document.getElementById('status-dot').className = dotClass()
  document.getElementById('status-line').textContent = statusText()

  const banner = document.getElementById('banner')
  const g = state.gateway

  if (g.status === 'port-in-use') {
    banner.hidden = false
    banner.className = 'banner error'
    replace(banner, [
      el('span', { text: `${g.detail} ` }),
      el('button', { text: 'Use the next free port', onClick: usePortSuggestion }),
    ])
    return
  }

  if (g.status === 'crashed') {
    banner.hidden = false
    banner.className = 'banner'
    replace(banner, [
      el('span', { text: 'The gateway exited unexpectedly and is being restarted. ' }),
      el('button', { text: 'Open log', onClick: () => window.gw.shell.openLog() }),
    ])
    return
  }

  if (state.claude && !state.claude.routed) {
    banner.hidden = false
    banner.className = 'banner info'
    replace(banner, [
      el('span', { text: 'Claude Code is not routed through this gateway yet. ' }),
      el('button', { text: 'Open setup', onClick: () => switchView('settings') }),
    ])
    return
  }

  banner.hidden = true
  replace(banner, [])
}

function switchView(name) {
  current = name
  for (const [key] of Object.entries(VIEWS)) {
    document.getElementById(`view-${key}`).hidden = key !== name
  }
  for (const button of document.querySelectorAll('#tabs button')) {
    button.classList.toggle('active', button.dataset.view === name)
  }
  if (name === 'dashboard' && !dashboardLoaded) {
    dashboardLoaded = true
    dashboardView.refresh()
    return
  }
  VIEWS[name].render()
}

function wireTabs() {
  document.getElementById('tabs').addEventListener('click', (event) => {
    const view = event.target?.dataset?.view
    if (view && VIEWS[view]) switchView(view)
  })
}

async function boot() {
  wireTabs()
  watchGatewayState()

  subscribe(() => {
    renderChrome()
    // Re-render the active view so health countdowns and counters stay live. The
    // dashboard additionally re-reads usage totals; its per-provider fan-out is
    // left to an explicit refresh.
    if (current === 'dashboard' && dashboardLoaded) dashboardView.tick()
    else VIEWS[current].render()
  })

  state.gateway = await window.gw.gateway.state()
  await reloadSettings()
  await reloadProviders()

  state.loaded = true
  renderChrome()
  switchView('providers')

  startPolling(state.settings?.pollMs ?? 5000)
  emit()
}

boot()
