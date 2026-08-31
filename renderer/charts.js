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

const GEOMETRY = { height: 200, padL: 58, padR: 12, padT: 14, padB: 24 }
/** Below this the day labels collide no matter how few we draw. */
const MIN_WIDTH = 320

/**
 * Charts draw at 1:1 with their container instead of scaling a fixed viewBox.
 *
 * A viewBox that gets scaled up also scales the tick text — a 10px label becomes
 * 15px on a wide window and 7px on a narrow one, and the bar gaps drift with it.
 * So each chart is returned as a host element that measures itself once it is in
 * the document and draws at that exact pixel width, then redraws on resize. One
 * shared ResizeObserver handles every chart on the page.
 */
const redraws = new WeakMap()
const observer = new ResizeObserver((entries) => {
  for (const entry of entries) {
    // The dashboard rebuilds its charts on every poll tick, and observe() holds a
    // strong reference — so a discarded host would never be collected. Detaching
    // an element fires an observation, which is where we drop it.
    if (!entry.target.isConnected) {
      observer.unobserve(entry.target)
      redraws.delete(entry.target)
      continue
    }
    const draw = redraws.get(entry.target)
    if (draw) draw(Math.round(entry.contentRect.width))
  }
})

function chartHost(draw) {
  const host = document.createElement('div')
  host.className = 'chart-host'

  let lastWidth = 0
  const paint = (width) => {
    const w = Math.max(MIN_WIDTH, width)
    if (w === lastWidth) return
    lastWidth = w
    while (host.firstChild) host.removeChild(host.firstChild)
    host.append(draw(w))
  }

  redraws.set(host, paint)
  observer.observe(host)
  return host
}

function svgRoot(width, ariaLabel) {
  const { height } = GEOMETRY
  const svg = svgEl('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': ariaLabel,
  })
  return svg
}

function emptyChart(width, message) {
  const svg = svgRoot(width, message)
  const node = svgEl('text', {
    x: width / 2, y: GEOMETRY.height / 2, class: 'empty-label', 'text-anchor': 'middle',
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

/** Horizontal gridlines with y labels, plus the x axis. */
function scaffold(svg, width, { max, format, gridlines = 4 }) {
  const { padL, padR, padT, padB, height } = GEOMETRY
  const plotH = height - padT - padB
  const right = width - padR

  for (let i = 0; i <= gridlines; i++) {
    const y = padT + (plotH * i) / gridlines
    const value = max * (1 - i / gridlines)
    const isBase = i === gridlines
    svg.append(svgEl('line', { x1: padL, y1: y, x2: right, y2: y, class: isBase ? 'axis' : 'grid' }))
    // Label the top, middle and baseline only — five numbers on a 200px chart is noise.
    if (i === 0 || i === gridlines || i * 2 === gridlines) {
      svg.append(label(padL - 8, y + 3.5, format(value), { 'text-anchor': 'end' }))
    }
  }
}

/** Thin the day labels to whatever the available width actually fits. */
function xLabels(svg, rows, step) {
  const { padL, height } = GEOMETRY
  const perLabel = 46
  const every = Math.max(1, Math.ceil(perLabel / step))
  rows.forEach((row, i) => {
    // Always keep the newest day: it is the one the reader is looking for.
    const isLast = i === rows.length - 1
    if (!isLast && (rows.length - 1 - i) % every !== 0) return
    const x = padL + i * step + step / 2
    svg.append(label(x, height - 7, row.date.slice(5), { 'text-anchor': 'middle' }))
  })
}

/**
 * Vertical bars over a date axis.
 * `rows` = [{ date, value }]. `format` renders the axis labels and tooltips.
 */
export function barChart(rows, { format = (v) => String(v), color } = {}) {
  return chartHost((width) => {
    const { height, padL, padR, padT, padB } = GEOMETRY
    if (!rows.length) return emptyChart(width, 'no data yet')

    const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0)
    const peak = Math.max(...rows.map((r) => r.value))
    const svg = svgRoot(width,
      `Bar chart over ${rows.length} days. ${format(total)} in total, ${format(peak)} on the busiest day.`)

    const plotW = width - padL - padR
    const plotH = height - padT - padB
    const max = niceMax(peak)
    const scale = plotH / max
    const step = plotW / rows.length
    const barW = Math.max(2, Math.min(step - 5, 34))
    const fill = color ?? seriesColor(0)

    scaffold(svg, width, { max, format })

    rows.forEach((row, i) => {
      if (!(row.value > 0)) return
      const h = Math.max(2, row.value * scale)
      const x = padL + i * step + (step - barW) / 2
      const rect = svgEl('rect', {
        class: 'bar', x, y: padT + plotH - h, width: barW, height: h, fill, rx: 2,
      })
      rect.append(tooltip(`${row.date} · ${format(row.value)}`))
      svg.append(rect)
    })

    xLabels(svg, rows, step)
    return svg
  })
}

/**
 * Stacked bars.
 * `rows` = [{ date, parts: { [seriesName]: number } }], `series` = ordered names.
 */
export function stackedBarChart(rows, series, { format = (v) => String(v) } = {}) {
  return chartHost((width) => {
    const { height, padL, padR, padT, padB } = GEOMETRY
    if (!rows.length || !series.length) return emptyChart(width, 'no per-provider data yet')

    const totals = rows.map((r) => series.reduce((sum, s) => sum + (r.parts[s] ?? 0), 0))
    const svg = svgRoot(width,
      `Stacked bar chart of ${series.length} providers over ${rows.length} days, peak ${format(Math.max(...totals))} in a day.`)

    const plotW = width - padL - padR
    const plotH = height - padT - padB
    const max = niceMax(Math.max(...totals, 0))
    const scale = plotH / max
    const step = plotW / rows.length
    const barW = Math.max(2, Math.min(step - 5, 34))

    scaffold(svg, width, { max, format })

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

    xLabels(svg, rows, step)
    return svg
  })
}
