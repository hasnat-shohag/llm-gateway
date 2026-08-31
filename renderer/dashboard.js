/** Usage dashboard: tiles, daily cost, per-provider split, recent calls. */
import { el, replace, fmt } from './dom.js'
import { state, reloadUsage } from './store.js'
import { barChart, stackedBarChart, SERIES_COLORS } from './charts.js'

const RANGE_DAYS = 14

/** Per-provider-per-day needs one /usage/cost/:date call per day, so cache it. */
const costCache = new Map()
let perProviderRows = []
let loadingRange = false

function tile(key, value, hint) {
  return el('div', { class: 'tile' }, [
    el('div', { class: 'k', text: key }),
    el('div', { class: 'v', text: value }),
    hint ? el('div', { class: 'muted', text: hint }) : null,
  ])
}

function recentDates(days) {
  const out = []
  const cursor = new Date()
  cursor.setUTCHours(0, 0, 0, 0)
  cursor.setUTCDate(cursor.getUTCDate() - (days - 1))
  for (let i = 0; i < days; i++) {
    out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/**
 * Fetch the per-provider breakdown for the visible window.
 *
 * Only days the history already reports data for are queried — the gateway's
 * SQLite calls are synchronous and share its event loop with proxied requests, so
 * there is no reason to ask about empty days.
 */
async function loadPerProvider() {
  if (loadingRange) return
  loadingRange = true
  try {
    const daysWithData = new Set((state.usage?.history ?? []).map((d) => d.date))
    const rows = []
    for (const date of recentDates(RANGE_DAYS)) {
      if (!daysWithData.has(date)) {
        rows.push({ date, parts: {} })
        continue
      }
      if (!costCache.has(date)) {
        const res = await window.gw.usage.cost(date)
        costCache.set(date, res.ok ? res.data : null)
      }
      const data = costCache.get(date)
      const parts = {}
      for (const entry of data?.byProvider ?? []) parts[entry.provider] = entry.costUsd
      rows.push({ date, parts })
    }
    perProviderRows = rows
  } finally {
    loadingRange = false
  }
}

function costChartPanel() {
  const history = (state.usage?.history ?? []).slice()
  const byDate = new Map(history.map((d) => [d.date, d]))
  const rows = recentDates(RANGE_DAYS).map((date) => ({
    date,
    value: byDate.get(date)?.totalCostUsd ?? 0,
  }))

  return el('div', { class: 'panel' }, [
    el('h2', { text: `Cost, last ${RANGE_DAYS} days` }),
    barChart(rows, { format: (v) => fmt.usd(v, 2) }),
    el('p', { class: 'muted', text: 'Dates are UTC days — the gateway rolls the counter over at 00:00 UTC, not local midnight.' }),
  ])
}

function perProviderPanel() {
  const series = [...new Set(perProviderRows.flatMap((r) => Object.keys(r.parts)))]
  return el('div', { class: 'panel' }, [
    el('h2', { text: 'Cost by provider' }),
    stackedBarChart(perProviderRows, series, { format: (v) => fmt.usd(v, 2) }),
    el('div', { class: 'legend' }, series.map((name, i) =>
      el('span', {}, [
        el('i', { style: `background:${SERIES_COLORS[i % SERIES_COLORS.length]}` }),
        el('span', { text: name }),
      ]))),
  ])
}

function callsPanel() {
  const calls = state.usage?.recentCalls ?? []
  if (!calls.length) {
    return el('div', { class: 'panel' }, [
      el('h2', { text: 'Recent calls' }),
      el('div', { class: 'empty', text: 'No recorded calls yet.' }),
    ])
  }

  return el('div', { class: 'panel' }, [
    el('h2', { text: 'Recent calls' }),
    el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'When (UTC)' }),
        el('th', { text: 'Provider' }),
        el('th', { text: 'Model' }),
        el('th', { class: 'num', text: 'In' }),
        el('th', { class: 'num', text: 'Out' }),
        el('th', { class: 'num', text: 'Cache r/w' }),
        el('th', { class: 'num', text: 'Cost' }),
      ])]),
      el('tbody', {}, calls.map((c) => el('tr', {}, [
        el('td', { class: 'mono', text: c.timestamp.replace('T', ' ').slice(0, 19) }),
        el('td', { text: c.provider }),
        el('td', { class: 'mono', text: c.model }),
        el('td', { class: 'num', text: fmt.int(c.inputTokens) }),
        el('td', { class: 'num', text: fmt.int(c.outputTokens) }),
        el('td', { class: 'num', text: `${fmt.int(c.cacheReadTokens)} / ${fmt.int(c.cacheWriteTokens)}` }),
        el('td', { class: 'num', text: fmt.usd(c.costUsd) }),
      ]))),
    ]),
    el('p', { class: 'muted', text:
      'Only successful, fully-streamed calls are recorded — a failed or truncated stream deliberately records no cost, so failures do not appear here.' }),
  ])
}

export async function refresh() {
  await reloadUsage(100)
  costCache.clear()
  await loadPerProvider()
  render()
}

/**
 * Poll-tick refresh: pulls fresh totals but does NOT re-fan-out the per-provider
 * breakdown, which costs one gateway query per day in the window.
 */
export async function tick() {
  await reloadUsage(100)
  render()
}

export function render() {
  const root = document.getElementById('view-dashboard')
  const today = state.usage?.today
  const stats = state.stats
  const todayDate = today?.date ?? new Date().toISOString().slice(0, 10)

  const lifetimeCost = (state.usage?.history ?? []).reduce((sum, d) => sum + (d.totalCostUsd ?? 0), 0)

  replace(root, [
    el('div', { class: 'panel' }, [
      el('div', { class: 'row between' }, [
        el('h2', { text: `Today · ${todayDate} (UTC)` }),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', text: 'Refresh', onClick: refresh }),
          el('button', {
            class: 'btn', text: 'Export CSV',
            onClick: async () => {
              const res = await window.gw.usage.exportCsv(todayDate)
              if (!res.ok && !res.canceled) window.alert(res.error)
            },
          }),
        ]),
      ]),
      el('div', { class: 'tiles' }, [
        tile('Cost today', fmt.usd(today?.totalCostUsd ?? 0)),
        tile('Calls today', fmt.int(today?.totalCalls ?? 0)),
        tile('Input tokens', fmt.int(today?.totalInputTokens ?? 0)),
        tile('Output tokens', fmt.int(today?.totalOutputTokens ?? 0)),
        tile('Cache read', fmt.int(today?.totalCacheReadTokens ?? 0)),
        tile('Cost all time', fmt.usd(lifetimeCost, 2)),
      ]),
    ]),

    el('div', { class: 'panel' }, [
      el('h2', { text: 'Gateway, since it last started' }),
      el('div', { class: 'tiles' }, [
        tile('Requests', fmt.int(stats?.totalRequests ?? 0)),
        tile('Retries', fmt.int(stats?.retries ?? 0)),
        tile('Latency p50', fmt.ms(stats?.latency?.p50)),
        tile('Latency p95', fmt.ms(stats?.latency?.p95)),
        tile('Mean latency', fmt.ms(stats?.latency?.mean), `over the last ${fmt.int(stats?.latency?.count ?? 0)} requests`),
        tile('In cooldown', fmt.int((stats?.unhealthyProviders ?? []).length)),
      ]),
    ]),

    costChartPanel(),
    perProviderPanel(),
    callsPanel(),
  ])
}
