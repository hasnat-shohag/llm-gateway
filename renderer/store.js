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

let timer = null

async function tick() {
  await pollLive()
  emit()
}

export function startPolling(intervalMs) {
  stopPolling()
  timer = setInterval(() => {
    if (document.hidden) return
    tick()
  }, intervalMs)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick()
  })
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
