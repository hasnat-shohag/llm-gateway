/** Usage dashboard: metrics, daily cost, per-provider split, recent calls. */
import { el, replace, panel, button, metric, emptyState, skeleton, notice, fmt } from './dom.js'
import { state, reloadUsage } from './store.js'
import { barChart, stackedBarChart, seriesColor } from './charts.js'

const RANGE_DAYS = 14

/** Per-provider-per-day needs one /usage/cost/:date call per day, so cache it. */
const costCache = new Map()
let perProviderRows = []
let loadingRange = false
let refreshing = false
let exporting = false
let error = null

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

/** True until the first usage read lands, so panels can skeleton instead of zero. */
function pending() {
  return state.usage === null && !error
}

function metricSlot(key, value, hint, opts) {
  if (pending()) {
    return el('div', { class: 'metric-cell' }, [
      el('div', { class: 'k', text: key }),
      skeleton('value'),
    ])
  }
  return metric(key, value, hint, opts)
}

/* ------------------------------------------------------------------ panels */

function todayPanel() {
  const today = state.usage?.today
  const todayDate = today?.date ?? new Date().toISOString().slice(0, 10)
  const lifetimeCost = (state.usage?.history ?? []).reduce((sum, d) => sum + (d.totalCostUsd ?? 0), 0)

  return panel({
    title: `Today · ${todayDate}`,
    subtitle: 'Counters roll over at 00:00 UTC, not local midnight.',
    actions: [
      button({
        label: 'Refresh usage', text: 'Refresh', icon: 'refresh', loading: refreshing,
        onClick: refresh,
      }),
      button({
        label: 'Export today as CSV', text: 'Export CSV', icon: 'download', loading: exporting,
        disabled: !today?.totalCalls,
        onClick: async () => {
          exporting = true
          render()
          const res = await window.gw.usage.exportCsv(todayDate)
          exporting = false
          error = !res.ok && !res.canceled ? res.error : null
          render()
        },
      }),
    ],
    body: [
      error ? notice('bad', error) : null,
      el('div', { class: 'metrics' }, [
        metricSlot('Cost today', fmt.usd(today?.totalCostUsd ?? 0), undefined, { lead: true }),
        metricSlot('Calls', fmt.int(today?.totalCalls ?? 0)),
        metricSlot('Input tokens', fmt.int(today?.totalInputTokens ?? 0)),
        metricSlot('Output tokens', fmt.int(today?.totalOutputTokens ?? 0)),
        metricSlot('Cache read', fmt.int(today?.totalCacheReadTokens ?? 0)),
        metricSlot('Cost all time', fmt.usd(lifetimeCost, 2)),
      ]),
    ],
  })
}

function gatewayPanel() {
  const stats = state.stats
  const cooling = (stats?.unhealthyProviders ?? []).length

  return panel({
    title: 'Gateway, since it last started',
    subtitle: state.statsError
      ? state.statsError
      : 'In-memory counters — a restart resets every number here.',
    body: [
      el('div', { class: 'metrics' }, [
        metric('Requests', fmt.int(stats?.totalRequests ?? 0)),
        metric('Retries', fmt.int(stats?.retries ?? 0)),
        metric('Latency p50', fmt.ms(stats?.latency?.p50)),
        metric('Latency p95', fmt.ms(stats?.latency?.p95)),
        metric('Mean latency', fmt.ms(stats?.latency?.mean),
          `over the last ${fmt.int(stats?.latency?.count ?? 0)} requests`),
        metric('In cooldown', fmt.int(cooling), cooling ? 'failing over to the rest' : undefined),
      ]),
    ],
  })
}

function costChartPanel() {
  const history = state.usage?.history ?? []
  const byDate = new Map(history.map((d) => [d.date, d]))
  const rows = recentDates(RANGE_DAYS).map((date) => ({
    date,
    value: byDate.get(date)?.totalCostUsd ?? 0,
  }))
  const spent = rows.reduce((sum, r) => sum + r.value, 0)

  // An all-zero series is not the same as no series: drawing the axis anyway would
  // put a $1.00 gridline on a chart that has never seen a cent, which invents a
  // scale. Say what is missing instead.
  if (!pending() && spent <= 0) {
    return panel({
      title: `Cost, last ${RANGE_DAYS} days`,
      flush: true,
      body: emptyState({
        icon: 'coins',
        title: 'No spend in this window',
        body: 'Daily cost is derived from the tokens each request reports, so this fills in as soon as traffic flows through the gateway.',
      }),
    })
  }

  return panel({
    title: `Cost, last ${RANGE_DAYS} days`,
    subtitle: pending() ? undefined : `${fmt.usd(spent, 2)} across the window`,
    body: [pending() ? skeleton('chart') : barChart(rows, { format: (v) => fmt.usd(v, 2) })],
  })
}

function perProviderPanel() {
  const series = [...new Set(perProviderRows.flatMap((r) => Object.keys(r.parts)))]

  if (!pending() && !loadingRange && !series.length) {
    return panel({
      title: 'Cost by provider',
      flush: true,
      body: emptyState({
        icon: 'layers',
        title: 'Nothing to split yet',
        body: 'This breaks the same window down per provider, which needs at least one billed request to show.',
      }),
    })
  }

  return panel({
    title: 'Cost by provider',
    subtitle: series.length ? `${series.length} ${series.length === 1 ? 'provider' : 'providers'} billed in this window` : undefined,
    body: [
      pending() ? skeleton('chart') : stackedBarChart(perProviderRows, series, { format: (v) => fmt.usd(v, 2) }),
      series.length
        ? el('div', { class: 'legend' }, series.map((name, i) =>
          el('span', {}, [
            el('i', { css: { background: seriesColor(i) } }),
            el('span', { text: name }),
          ])))
        : null,
    ],
  })
}

function callsPanel() {
  const calls = state.usage?.recentCalls ?? []

  if (!pending() && !calls.length) {
    return panel({
      title: 'Recent calls',
      flush: true,
      body: emptyState({
        icon: 'activity',
        title: 'No calls recorded yet',
        body: 'Once Claude Code is routed here, every completed request lands in this table with its token counts and cost.',
      }),
    })
  }

  const rows = pending()
    ? Array.from({ length: 4 }, () => el('tr', { 'aria-hidden': 'true' },
      Array.from({ length: 7 }, () => el('td', {}, [skeleton('text', '60')]))))
    : calls.map((c) => el('tr', {}, [
      el('td', { class: 'mono nowrap', text: c.timestamp.replace('T', ' ').slice(0, 19) }),
      el('td', { text: c.provider }),
      el('td', { class: 'mono', text: c.model }),
      el('td', { class: 'num', text: fmt.int(c.inputTokens) }),
      el('td', { class: 'num', text: fmt.int(c.outputTokens) }),
      el('td', { class: 'num', text: `${fmt.int(c.cacheReadTokens)} / ${fmt.int(c.cacheWriteTokens)}` }),
      el('td', { class: 'num', text: fmt.usd(c.costUsd) }),
    ]))

  return panel({
    title: 'Recent calls',
    subtitle: pending() ? undefined : `${calls.length} most recent`,
    flush: true,
    body: el('div', { class: 'table-scroll', 'data-scroll-key': 'recent-calls' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { scope: 'col', text: 'When (UTC)' }),
          el('th', { scope: 'col', text: 'Provider' }),
          el('th', { scope: 'col', text: 'Model' }),
          el('th', { scope: 'col', class: 'num', text: 'In' }),
          el('th', { scope: 'col', class: 'num', text: 'Out' }),
          el('th', { scope: 'col', class: 'num', text: 'Cache r/w' }),
          el('th', { scope: 'col', class: 'num', text: 'Cost' }),
        ])]),
        el('tbody', {}, rows),
      ]),
    ]),
    foot: 'Only successful, fully-streamed calls are recorded — a failed or truncated stream deliberately records no cost, so failures do not appear here.',
  })
}

/* ----------------------------------------------------------------- lifecycle */

export async function refresh() {
  refreshing = true
  render()
  const res = await reloadUsage(100)
  error = res.ok ? null : res.error
  costCache.clear()
  await loadPerProvider()
  refreshing = false
  render()
}

/**
 * Poll-tick refresh: pulls fresh totals but does NOT re-fan-out the per-provider
 * breakdown, which costs one gateway query per day in the window.
 */
export async function tick() {
  const res = await reloadUsage(100)
  error = res.ok ? null : res.error
  render()
}

export function render() {
  replace(document.getElementById('view-dashboard'), [
    todayPanel(),
    gatewayPanel(),
    costChartPanel(),
    perProviderPanel(),
    callsPanel(),
  ])
}
