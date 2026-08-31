/** Hand-rolled inline SVG charts — no CDN, so the app works offline and the CSP
 *  needs no exceptions. createElementNS only; never innerHTML. */

const NS = 'http://www.w3.org/2000/svg'

/** Categorical palette; readable on the dark panel background. */
export const SERIES_COLORS = [
  '#6ad0a8', '#9db8ff', '#e0b252', '#e07a7a', '#b79bff',
  '#63c5d6', '#d69ac0', '#a8c86a', '#c98f5e', '#8f9bb3',
]

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue
    node.setAttribute(k, String(v))
  }
  return node
}

function text(x, y, value, attrs = {}) {
  const node = svgEl('text', { x, y, fill: '#949bad', 'font-size': 10, ...attrs })
  node.textContent = value
  return node
}

/** SVG <title> is the built-in tooltip; no JS hover handling needed. */
function tooltip(value) {
  const node = svgEl('title')
  node.textContent = value
  return node
}

function emptyChart(width, height, message) {
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' })
  svg.append(text(width / 2, height / 2, message, { 'text-anchor': 'middle' }))
  return svg
}

/** Pad a date-keyed series so gap days render as gaps — the API only returns days with data. */
export function zeroFillDays(rows, days) {
  const byDate = new Map(rows.map((r) => [r.date, r]))
  const out = []
  const cursor = new Date()
  cursor.setUTCHours(0, 0, 0, 0)
  cursor.setUTCDate(cursor.getUTCDate() - (days - 1))
  for (let i = 0; i < days; i++) {
    const date = cursor.toISOString().slice(0, 10)
    out.push(byDate.get(date) ?? { date, value: 0 })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/**
 * Vertical bars over a date axis.
 * `rows` = [{ date, value }]. `format` renders the y-axis max label.
 */
export function barChart(rows, { height = 180, format = (v) => String(v), color = SERIES_COLORS[0] } = {}) {
  const width = 720
  if (!rows.length) return emptyChart(width, height, 'no data yet')

  const padL = 52
  const padR = 8
  const padT = 12
  const padB = 22
  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const max = Math.max(...rows.map((r) => r.value), 0)
  const scale = max > 0 ? plotH / max : 0
  const step = plotW / rows.length
  const barW = Math.max(1, Math.min(step - 2, 34))

  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}` })

  // Baseline + max gridline, with labels.
  svg.append(svgEl('line', { x1: padL, y1: padT + plotH, x2: width - padR, y2: padT + plotH, stroke: '#2c3140' }))
  svg.append(svgEl('line', { x1: padL, y1: padT, x2: width - padR, y2: padT, stroke: '#21252f' }))
  svg.append(text(padL - 6, padT + 4, format(max), { 'text-anchor': 'end' }))
  svg.append(text(padL - 6, padT + plotH + 3, format(0), { 'text-anchor': 'end' }))

  rows.forEach((row, i) => {
    const h = row.value > 0 ? Math.max(1, row.value * scale) : 0
    const x = padL + i * step + (step - barW) / 2
    if (h > 0) {
      const rect = svgEl('rect', {
        x, y: padT + plotH - h, width: barW, height: h, fill: color, rx: 2,
      })
      rect.append(tooltip(`${row.date} · ${format(row.value)}`))
      svg.append(rect)
    }
    // Label roughly every 5th day so the axis stays legible.
    if (rows.length <= 10 || i % Math.ceil(rows.length / 8) === 0) {
      svg.append(text(x + barW / 2, height - 7, row.date.slice(5), { 'text-anchor': 'middle' }))
    }
  })

  return svg
}

/**
 * Stacked bars.
 * `rows` = [{ date, parts: { [seriesName]: number } }], `series` = ordered names.
 */
export function stackedBarChart(rows, series, { height = 200, format = (v) => String(v) } = {}) {
  const width = 720
  if (!rows.length || !series.length) return emptyChart(width, height, 'no per-provider data yet')

  const padL = 52
  const padR = 8
  const padT = 12
  const padB = 22
  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const totals = rows.map((r) => series.reduce((sum, s) => sum + (r.parts[s] ?? 0), 0))
  const max = Math.max(...totals, 0)
  const scale = max > 0 ? plotH / max : 0
  const step = plotW / rows.length
  const barW = Math.max(1, Math.min(step - 2, 34))

  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}` })
  svg.append(svgEl('line', { x1: padL, y1: padT + plotH, x2: width - padR, y2: padT + plotH, stroke: '#2c3140' }))
  svg.append(text(padL - 6, padT + 4, format(max), { 'text-anchor': 'end' }))

  rows.forEach((row, i) => {
    const x = padL + i * step + (step - barW) / 2
    let cursorY = padT + plotH
    series.forEach((name, si) => {
      const value = row.parts[name] ?? 0
      if (value <= 0) return
      const h = Math.max(1, value * scale)
      cursorY -= h
      const rect = svgEl('rect', {
        x, y: cursorY, width: barW, height: h, fill: SERIES_COLORS[si % SERIES_COLORS.length],
      })
      rect.append(tooltip(`${row.date} · ${name} · ${format(value)}`))
      svg.append(rect)
    })
    if (rows.length <= 10 || i % Math.ceil(rows.length / 8) === 0) {
      svg.append(text(x + barW / 2, height - 7, row.date.slice(5), { 'text-anchor': 'middle' }))
    }
  })

  return svg
}
