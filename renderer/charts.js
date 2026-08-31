/** Hand-rolled inline SVG charts — no CDN, so the app works offline and the CSP
 *  needs no exceptions. createElementNS only; never innerHTML.
 *
 *  Colors come from CSS tokens rather than literals, so the same chart code renders
 *  correctly in both themes. Structural colors (grid, axis, ticks) are left to the
 *  stylesheet via class names; only the data marks need a resolved value, because
 *  an SVG fill cannot be an unresolved var() when we also need it for a legend
 *  swatch. */
import { token } from './dom.js'

const NS = 'http://www.w3.org/2000/svg'
const SERIES_COUNT = 10

/** Categorical palette, resolved per render so a theme switch repaints correctly. */
export function seriesColor(index) {
  return token(`--series-${(index % SERIES_COUNT) + 1}`) || '#6ad0a8'
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue
    node.setAttribute(k, String(v))
  }
  return node
}

function label(x, y, value, attrs = {}) {
  const node = svgEl('text', { x, y, class: 'tick', ...attrs })
  node.textContent = value
  return node
}

/** SVG <title> is the built-in tooltip; no JS hover handling needed. */
function tooltip(value) {
  const node = svgEl('title')
  node.textContent = value
  return node
}

function chartRoot(width, height, ariaLabel) {
  const svg = svgEl('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': ariaLabel,
  })
  // Set through the CSSOM: an aspect-ratio keeps the fixed viewBox from either
  // letterboxing or stretching the tick text.
  svg.style.setProperty('aspect-ratio', `${width} / ${height}`)
  return svg
}

function emptyChart(width, height, message) {
  const svg = chartRoot(width, height, message)
  const node = svgEl('text', {
    x: width / 2, y: height / 2, class: 'empty-label', 'text-anchor': 'middle',
  })
  node.textContent = message
  svg.append(node)
  return svg
}

/** Round a maximum up to a readable gridline value (0.0123 → 0.02, 1730 → 2000). */
function niceMax(value) {
  if (!(value > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const scaled = value / magnitude
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10
  return step * magnitude
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

const GEOMETRY = { width: 720, height: 184, padL: 58, padR: 10, padT: 14, padB: 24 }

/** Horizontal gridlines with y labels, plus the x axis. */
function scaffold(svg, { max, format, gridlines = 4 }) {
  const { width, padL, padR, padT, padB, height } = GEOMETRY
  const plotH = height - padT - padB
  const right = width - padR

  for (let i = 0; i <= gridlines; i++) {
    const y = padT + (plotH * i) / gridlines
    const value = max * (1 - i / gridlines)
    const isBase = i === gridlines
    svg.append(svgEl('line', { x1: padL, y1: y, x2: right, y2: y, class: isBase ? 'axis' : 'grid' }))
    // Label the top, middle and baseline only — five numbers on a 184px chart is noise.
    if (i === 0 || i === gridlines || i * 2 === gridlines) {
      svg.append(label(padL - 8, y + 3.5, format(value), { 'text-anchor': 'end' }))
    }
  }
}

function xLabels(svg, rows, step) {
  const { padL, height } = GEOMETRY
  const every = rows.length <= 10 ? 1 : Math.ceil(rows.length / 7)
  rows.forEach((row, i) => {
    if (i % every !== 0 && i !== rows.length - 1) return
    const x = padL + i * step + step / 2
    svg.append(label(x, height - 7, row.date.slice(5), { 'text-anchor': 'middle' }))
  })
}

/**
 * Vertical bars over a date axis.
 * `rows` = [{ date, value }]. `format` renders the axis labels and tooltips.
 */
export function barChart(rows, { format = (v) => String(v), color } = {}) {
  const { width, height, padL, padR, padT, padB } = GEOMETRY
  if (!rows.length) return emptyChart(width, height, 'no data yet')

  const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0)
  const svg = chartRoot(width, height,
    `Bar chart over ${rows.length} days, ${format(total)} total, peak ${format(Math.max(...rows.map((r) => r.value)))}`)

  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const max = niceMax(Math.max(...rows.map((r) => r.value), 0))
  const scale = plotH / max
  const step = plotW / rows.length
  const barW = Math.max(2, Math.min(step - 4, 30))
  const fill = color ?? seriesColor(0)

  scaffold(svg, { max, format })

  rows.forEach((row, i) => {
    const h = row.value > 0 ? Math.max(2, row.value * scale) : 0
    const x = padL + i * step + (step - barW) / 2
    if (h > 0) {
      const rect = svgEl('rect', {
        class: 'bar', x, y: padT + plotH - h, width: barW, height: h, fill, rx: 2,
      })
      rect.append(tooltip(`${row.date} · ${format(row.value)}`))
      svg.append(rect)
    }
  })

  xLabels(svg, rows, step, barW)
  return svg
}

/**
 * Stacked bars.
 * `rows` = [{ date, parts: { [seriesName]: number } }], `series` = ordered names.
 */
export function stackedBarChart(rows, series, { format = (v) => String(v) } = {}) {
  const { width, height, padL, padR, padT, padB } = GEOMETRY
  if (!rows.length || !series.length) return emptyChart(width, height, 'no per-provider data yet')

  const totals = rows.map((r) => series.reduce((sum, s) => sum + (r.parts[s] ?? 0), 0))
  const svg = chartRoot(width, height,
    `Stacked bar chart of ${series.length} providers over ${rows.length} days, peak ${format(Math.max(...totals))} in a day`)

  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const max = niceMax(Math.max(...totals, 0))
  const scale = plotH / max
  const step = plotW / rows.length
  const barW = Math.max(2, Math.min(step - 4, 30))

  scaffold(svg, { max, format })

  rows.forEach((row, i) => {
    const x = padL + i * step + (step - barW) / 2
    let cursorY = padT + plotH
    series.forEach((name, si) => {
      const value = row.parts[name] ?? 0
      if (value <= 0) return
      const h = Math.max(2, value * scale)
      cursorY -= h
      const rect = svgEl('rect', {
        class: 'bar', x, y: cursorY, width: barW, height: h, fill: seriesColor(si),
      })
      rect.append(tooltip(`${row.date} · ${name} · ${format(value)}`))
      svg.append(rect)
    })
  })

  xLabels(svg, rows, step, barW)
  return svg
}
