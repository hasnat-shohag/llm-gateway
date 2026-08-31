/** Entry point: window chrome, tab routing, the status bar, and the alert banner. */
import { el, replace, button, fmt } from './dom.js'
import { icon } from './icons.js'
import {
  state, subscribe, emit, reloadProviders, reloadSettings, startPolling,
  watchGatewayState, watchTheme, needsOnboarding,
} from './store.js'
import * as providersView from './providers.js'
import * as dashboardView from './dashboard.js'
import * as settingsView from './settings.js'
import * as onboardingView from './onboarding.js'

const VIEWS = {
  providers: providersView,
  dashboard: dashboardView,
  settings: settingsView,
}

const TAB_ORDER = ['providers', 'dashboard', 'settings']

let current = 'providers'
/** The dashboard fans out one request per day, so only load it on first visit. */
let dashboardLoaded = false
let onboardingActive = false

/* --------------------------------------------------------------- status bar */

function statusText() {
  const g = state.gateway
  switch (g.status) {
    case 'running':     return `Running on 127.0.0.1:${g.port}`
    case 'starting':    return 'Starting the gateway…'
    case 'port-in-use': return g.detail || `Port ${g.port} is already in use`
    case 'crashed':     return g.detail || 'Gateway crashed — restarting'
    default:            return 'Gateway stopped'
  }
}

function dotClass() {
  switch (state.gateway.status) {
    case 'running': return state.statsError ? 'dot warn' : 'dot up'
    case 'starting': return 'dot warn pulse'
    case 'port-in-use':
    case 'crashed': return 'dot down'
    default: return 'dot'
  }
}

/**
 * Right-hand readouts. Everything here comes from the poll that already runs, so
 * the status bar never costs an extra gateway query.
 */
function statusMetrics() {
  if (state.gateway.status !== 'running') return []
  if (state.statsError) return [el('span', { text: state.statsError })]

  const stats = state.stats
  const parts = [
    el('span', { class: 'metric' }, [
      el('b', { text: String(state.enabledNames.length) }),
      ' eligible',
    ]),
    el('span', { class: 'metric' }, [
      el('b', { text: fmt.compact(stats?.totalRequests ?? 0) }),
      ' requests',
    ]),
    el('span', { class: 'metric' }, [
      'p95 ',
      el('b', { text: fmt.ms(stats?.latency?.p95) }),
    ]),
  ]

  const cooling = (stats?.unhealthyProviders ?? []).length
  if (cooling > 0) {
    parts.push(el('span', { class: 'metric' }, [
      icon('clock', { size: 11 }),
      el('b', { text: String(cooling) }),
      ' in cooldown',
    ]))
  }

  // A separator between each readout, never a leading or trailing one.
  return parts.flatMap((node, i) => (i === 0 ? [node] : [el('span', { class: 'sep', text: '·' }), node]))
}

/* ------------------------------------------------------------------ banner */

async function usePortSuggestion() {
  const { port } = await window.gw.gateway.suggestPort()
  if (!port) return
  await window.gw.gateway.usePort(port)
  await reloadSettings()
  renderChrome()
  renderCurrentView()
}

function bannerContent() {
  const g = state.gateway

  // Onboarding states the same three things as full steps, each with its own
  // control. A banner above it would repeat the message and the button verbatim.
  if (g.status === 'port-in-use' && !onboardingActive) {
    return {
      kind: 'error',
      glyph: 'alert',
      // The detail comes from the supervisor unpunctuated, so terminate it here
      // rather than run the two sentences together.
      message: `${g.detail.replace(/[.\s]+$/, '')}. Nothing was started, so no request has been lost.`,
      action: button({ label: 'Move to the next free port', text: 'Move to the next free port', onClick: usePortSuggestion }),
    }
  }

  if (g.status === 'crashed') {
    return {
      kind: '',
      glyph: 'alert',
      message: 'The gateway exited unexpectedly and is being restarted.',
      action: button({ label: 'Open log', text: 'Open log', onClick: () => window.gw.shell.openLog() }),
    }
  }

  if (state.claude && !state.claude.routed && !onboardingActive) {
    return {
      kind: 'info',
      glyph: 'info',
      message: 'Claude Code still talks to Anthropic directly — nothing is routed through this gateway yet.',
      action: button({ label: 'Finish setup', text: 'Finish setup', onClick: () => switchView('settings') }),
    }
  }

  return null
}

function renderChrome() {
  document.getElementById('status-dot').className = dotClass()
  document.getElementById('status-line').textContent = statusText()
  replace(document.getElementById('status-metrics'), statusMetrics())

  const banner = document.getElementById('banner')
  const content = bannerContent()

  if (!content) {
    banner.hidden = true
    replace(banner, [])
    return
  }

  banner.hidden = false
  banner.className = `banner ${content.kind}`.trim()
  replace(banner, [
    icon(content.glyph),
    el('span', { class: 'msg', text: content.message }),
    content.action,
  ])
}

/* ------------------------------------------------------------------ routing */

function renderCurrentView() {
  if (onboardingActive) {
    onboardingView.render()
    return
  }
  if (current === 'dashboard' && dashboardLoaded) dashboardView.tick()
  else VIEWS[current].render()
}

function applyViewVisibility() {
  document.getElementById('view-onboarding').hidden = !onboardingActive
  for (const key of TAB_ORDER) {
    document.getElementById(`view-${key}`).hidden = onboardingActive || key !== current
  }
  document.getElementById('tabs').hidden = onboardingActive
}

function switchView(name) {
  if (onboardingActive) return
  current = name
  applyViewVisibility()

  for (const tab of document.querySelectorAll('#tabs button')) {
    const selected = tab.dataset.view === name
    tab.setAttribute('aria-selected', String(selected))
    // Roving tabindex: only the selected tab is in the document tab order.
    tab.tabIndex = selected ? 0 : -1
  }

  if (name === 'dashboard' && !dashboardLoaded) {
    dashboardLoaded = true
    dashboardView.refresh()
    return
  }
  VIEWS[name].render()
}

/**
 * Re-evaluate whether onboarding owns the content area. Called on every emit, so
 * finishing setup — from the guide or from the Setup tab — takes effect at once
 * without either module reaching into the other.
 */
function syncOnboarding() {
  const wanted = needsOnboarding()
  if (wanted === onboardingActive) return false
  onboardingActive = wanted
  applyViewVisibility()
  if (wanted) onboardingView.render()
  else switchView(current)
  return true
}

function wireTabs() {
  const tabs = document.getElementById('tabs')

  tabs.addEventListener('click', (event) => {
    const view = event.target.closest('button')?.dataset?.view
    if (view && VIEWS[view]) switchView(view)
  })

  // Arrow-key navigation is what makes role=tablist mean anything.
  tabs.addEventListener('keydown', (event) => {
    const index = TAB_ORDER.indexOf(current)
    let next = null
    if (event.key === 'ArrowRight') next = TAB_ORDER[(index + 1) % TAB_ORDER.length]
    else if (event.key === 'ArrowLeft') next = TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length]
    else if (event.key === 'Home') next = TAB_ORDER[0]
    else if (event.key === 'End') next = TAB_ORDER[TAB_ORDER.length - 1]
    if (!next) return
    event.preventDefault()
    switchView(next)
    document.getElementById(`tab-${next}`).focus()
  })
}

/* ------------------------------------------------------------ window chrome */

function wireWindowControls() {
  const maximizeButton = document.getElementById('win-maximize')

  const paintMaximizeButton = (maximized) => {
    replace(maximizeButton, [icon(maximized ? 'restore' : 'maximize', { size: 13 })])
    maximizeButton.setAttribute('aria-label', maximized ? 'Restore window' : 'Maximize window')
    maximizeButton.title = maximized ? 'Restore' : 'Maximize'
  }

  replace(document.getElementById('win-minimize'), [icon('minus', { size: 13 })])
  replace(document.getElementById('win-close'), [icon('close', { size: 13 })])
  paintMaximizeButton(false)

  document.getElementById('win-minimize').addEventListener('click', () => window.gw.win.minimize())
  maximizeButton.addEventListener('click', () => window.gw.win.toggleMaximize())
  document.getElementById('win-close').addEventListener('click', () => window.gw.win.close())

  // The drag region handles dragging, but not the double-click gesture.
  document.getElementById('titlebar').addEventListener('dblclick', (event) => {
    if (event.target.closest('button, .tabs')) return
    window.gw.win.toggleMaximize()
  })

  window.gw.win.onMaximizeChange(paintMaximizeButton)
  window.gw.win.isMaximized().then(paintMaximizeButton)
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  wireTabs()
  wireWindowControls()
  watchGatewayState()
  watchTheme()

  subscribe(() => {
    renderChrome()
    // Re-render the active view so health countdowns and counters stay live. The
    // dashboard additionally re-reads usage totals; its per-provider fan-out is
    // left to an explicit refresh.
    if (syncOnboarding()) return
    renderCurrentView()
  })

  state.gateway = await window.gw.gateway.state()
  // Paint the shell first: the settings read decides between the guide and the
  // tabs, so there is nothing honest to draw in the content area until it lands.
  renderChrome()

  await reloadSettings()
  onboardingActive = needsOnboarding()
  applyViewVisibility()

  // The providers table renders its skeleton until `loaded` flips, and keeps
  // skeletons in the gateway-derived columns until the first /stats reply.
  if (!onboardingActive) providersView.render()

  await reloadProviders()
  state.loaded = true

  if (onboardingActive) onboardingView.render()
  else switchView('providers')

  renderChrome()
  startPolling(state.settings?.pollMs ?? 5000)
  emit()
}

boot()
