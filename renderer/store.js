/**
 * Shared app state + the poll loop.
 *
 * One poll drives every view, so switching tabs never triggers a fresh burst of
 * gateway calls. Polling pauses while the window is hidden: better-sqlite3 is
 * synchronous inside the gateway process, so a dashboard query competes with
 * proxied Claude Code requests for the same event loop.
 */

const listeners = new Set()

export const state = {
  gateway: { status: 'stopped', detail: '', port: null, pid: null },
  stats: null,
  statsError: null,
  providers: [],
  providersVersion: null,
  providersError: null,
  enabledNames: [],
  usage: null,
  claude: null,
  settings: null,
  /** False until the first providers + settings read lands, so views can skeleton. */
  loaded: false,
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emit() {
  for (const fn of listeners) fn(state)
}

export async function reloadProviders() {
  const res = await window.gw.providers.list()
  if (res.ok) {
    state.providers = res.providers
    state.providersVersion = res.version
    state.providersError = null
  } else {
    state.providersError = res.error
  }
  return res
}

export async function reloadSettings() {
  state.settings = await window.gw.settings.get()
  state.claude = await window.gw.claude.status()
}

/** Live data only — cheap enough for the 5s tick. */
async function pollLive() {
  const [stats, enabled] = await Promise.all([
    window.gw.gateway.stats(),
    window.gw.gateway.enabledNames(),
  ])

  if (stats.ok) {
    state.stats = stats.data
    state.statsError = null
  } else {
    state.stats = null
    state.statsError = stats.error
  }
  state.enabledNames = enabled.ok ? enabled.data.map((p) => p.name) : []
}

export async function reloadUsage(limit = 50) {
  const res = await window.gw.usage.summary(limit)
  state.usage = res.ok ? res.data : null
  return res
}

/**
 * True while the user has not finished (or dismissed) first-run setup. The
 * onboarding view owns the whole content area in that case, so this must not
 * depend on data that arrives later than the first paint.
 */
export function needsOnboarding() {
  if (!state.settings) return false
  return state.settings.setupCompleted !== true
}

let timer = null

async function tick() {
  await pollLive()
  emit()
}

// Registered once, not per startPolling() call: a pollMs change restarts the timer,
// and re-adding the listener there would stack a duplicate on every save.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick()
})

export function startPolling(intervalMs) {
  stopPolling()
  // Poll immediately. The interval alone would leave every gateway-derived cell
  // showing a skeleton for a full interval after boot, even though the numbers are
  // one IPC round-trip away.
  tick()
  timer = setInterval(() => {
    // An occluded or minimized window still runs its timers; there is nothing to
    // repaint for, and the gateway is the thing being spared the queries.
    if (document.hidden) return
    tick()
  }, intervalMs)
}

export function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
}

export function watchGatewayState() {
  window.gw.gateway.onStateChange((next) => {
    state.gateway = next
    emit()
    // A status change usually means the numbers moved too.
    tick()
  })
}

/**
 * Repaint on an OS theme change. Chart series colors are resolved from CSS tokens
 * at draw time, so an already-rendered SVG keeps the old palette until something
 * re-renders it.
 */
export function watchTheme() {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', emit)
}
