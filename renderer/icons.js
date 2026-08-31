/**
 * Icon set — authored SVG on a 16px grid, 1.5px stroke, round joins, currentColor.
 *
 * One family, one weight, drawn here rather than pulled from a font or a CDN:
 * the CSP forbids remote anything, and a Unicode glyph (↑, ✕, ⟳) is not an icon
 * system — it inherits whatever the platform font decided, at whatever optical
 * weight, and never matches its neighbors.
 *
 * createElementNS only; these are appended, never interpolated into markup.
 */

const NS = 'http://www.w3.org/2000/svg'

/** Each entry is a list of [tag, attrs] children on a 16×16 viewBox. */
const PATHS = {
  // navigation & structure
  logo: [['path', { d: 'M2 8h2.6l1.7-4 2.2 8 1.8-4H14' }]],
  chevronUp: [['path', { d: 'M4 10l4-4 4 4' }]],
  chevronDown: [['path', { d: 'M4 6l4 4 4-4' }]],
  chevronRight: [['path', { d: 'M6 4l4 4-4 4' }]],
  arrowRight: [['path', { d: 'M3 8h10' }], ['path', { d: 'M9 4l4 4-4 4' }]],
  externalLink: [
    ['path', { d: 'M9 3h4v4' }],
    ['path', { d: 'M13 3L7.5 8.5' }],
    ['path', { d: 'M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5' }],
  ],

  // actions
  plus: [['path', { d: 'M8 3.5v9' }], ['path', { d: 'M3.5 8h9' }]],
  minus: [['path', { d: 'M3.5 8h9' }]],
  close: [['path', { d: 'M4 4l8 8' }], ['path', { d: 'M12 4l-8 8' }]],
  maximize: [['rect', { x: 3.5, y: 3.5, width: 9, height: 9, rx: 1.5 }]],
  restore: [
    ['rect', { x: 3.5, y: 5.5, width: 7, height: 7, rx: 1.5 }],
    ['path', { d: 'M5.5 3.5h5a2 2 0 0 1 2 2v5' }],
  ],
  refresh: [
    ['path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }],
    ['path', { d: 'M13 3v2.5h-2.5' }],
  ],
  restart: [
    ['path', { d: 'M3 8a5 5 0 0 1 8.5-3.5' }],
    ['path', { d: 'M13 8a5 5 0 0 1-8.5 3.5' }],
    ['path', { d: 'M11.5 2v2.5H9' }],
    ['path', { d: 'M4.5 14v-2.5H7' }],
  ],
  pencil: [
    ['path', { d: 'M11.2 2.9a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3z' }],
    ['path', { d: 'M10.2 3.9l2 2' }],
  ],
  trash: [
    ['path', { d: 'M3 5h10' }],
    ['path', { d: 'M6.5 5V3.6a.6.6 0 0 1 .6-.6h1.8a.6.6 0 0 1 .6.6V5' }],
    ['path', { d: 'M4.4 5l.5 7.5a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9L11.6 5' }],
  ],
  download: [
    ['path', { d: 'M8 2.5v7' }],
    ['path', { d: 'M5 7l3 2.5L11 7' }],
    ['path', { d: 'M3 12.5h10' }],
  ],
  fileText: [
    ['path', { d: 'M9 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6z' }],
    ['path', { d: 'M9 2.5V6h3.5' }],
    ['path', { d: 'M5.8 9h4.4' }],
    ['path', { d: 'M5.8 11h3' }],
  ],

  // state & feedback
  check: [['path', { d: 'M3.5 8.5l3 3 6-6.5' }]],
  alert: [
    ['path', { d: 'M8 2.8l5.4 9.4a.7.7 0 0 1-.6 1H3.2a.7.7 0 0 1-.6-1z' }],
    ['path', { d: 'M8 6.4v3' }],
    ['path', { d: 'M8 11.4h.01' }],
  ],
  info: [
    ['circle', { cx: 8, cy: 8, r: 5.5 }],
    ['path', { d: 'M8 7.4v3.4' }],
    ['path', { d: 'M8 5.3h.01' }],
  ],
  clock: [
    ['circle', { cx: 8, cy: 8, r: 5.5 }],
    ['path', { d: 'M8 5.2V8l2 1.4' }],
  ],
  activity: [['path', { d: 'M1.8 8.5h2.7L6.2 4l2.6 8 1.6-3.5h3.8' }]],

  // domain
  server: [
    ['rect', { x: 2.5, y: 3, width: 11, height: 4.2, rx: 1.2 }],
    ['rect', { x: 2.5, y: 8.8, width: 11, height: 4.2, rx: 1.2 }],
    ['path', { d: 'M5 5.1h.01' }],
    ['path', { d: 'M5 10.9h.01' }],
  ],
  key: [
    ['circle', { cx: 5.6, cy: 10.4, r: 2.6 }],
    ['path', { d: 'M7.5 8.5L13 3' }],
    ['path', { d: 'M10.6 5.4l1.6 1.6' }],
  ],
  plug: [
    ['path', { d: 'M6 2.5v3' }],
    ['path', { d: 'M10 2.5v3' }],
    ['path', { d: 'M4 5.5h8v2a4 4 0 0 1-4 4 4 4 0 0 1-4-4z' }],
    ['path', { d: 'M8 11.5v2' }],
  ],
  beaker: [
    ['path', { d: 'M5.5 2.5h5' }],
    ['path', { d: 'M6.3 2.5v4L3.6 11a1.2 1.2 0 0 0 1 1.9h6.8a1.2 1.2 0 0 0 1-1.9L9.7 6.5v-4' }],
    ['path', { d: 'M4.9 9.2h6.2' }],
  ],
  shield: [
    ['path', { d: 'M8 2.5l4.5 1.7v3.3c0 2.8-1.8 4.7-4.5 5.6-2.7-.9-4.5-2.8-4.5-5.6V4.2z' }],
    ['path', { d: 'M6.2 8.1l1.4 1.4 2.4-2.7' }],
  ],
  sliders: [
    ['path', { d: 'M2.5 5h6' }], ['path', { d: 'M11 5h2.5' }], ['circle', { cx: 9.8, cy: 5, r: 1.4 }],
    ['path', { d: 'M2.5 11h2' }], ['path', { d: 'M7 11h6.5' }], ['circle', { cx: 5.8, cy: 11, r: 1.4 }],
  ],
  inbox: [
    ['path', { d: 'M2.5 8.5h3l1 2h3l1-2h3' }],
    ['path', { d: 'M4.4 3.5h7.2l1.9 5v4a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1v-4z' }],
  ],

  // theme
  sun: [
    ['circle', { cx: 8, cy: 8, r: 3 }],
    ['path', { d: 'M8 1.6v1.4' }], ['path', { d: 'M8 13v1.4' }],
    ['path', { d: 'M1.6 8H3' }], ['path', { d: 'M13 8h1.4' }],
    ['path', { d: 'M3.5 3.5l1 1' }], ['path', { d: 'M11.5 11.5l1 1' }],
    ['path', { d: 'M12.5 3.5l-1 1' }], ['path', { d: 'M4.5 11.5l-1 1' }],
  ],
  moon: [['path', { d: 'M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6z' }]],
  monitor: [
    ['rect', { x: 2.5, y: 3, width: 11, height: 7.5, rx: 1.2 }],
    ['path', { d: 'M6 13.2h4' }],
    ['path', { d: 'M8 10.5v2.7' }],
  ],
}

/**
 * @param {keyof PATHS} name
 * @param {{ size?: number, stroke?: number, title?: string }} [opts]
 */
export function icon(name, { size = 14, stroke = 1.5, title } = {}) {
  const spec = PATHS[name]
  if (!spec) throw new Error(`unknown icon: ${name}`)

  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(stroke))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  // Decorative by default: the accessible name lives on the control that holds it.
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  if (title) {
    svg.removeAttribute('aria-hidden')
    svg.setAttribute('role', 'img')
    const node = document.createElementNS(NS, 'title')
    node.textContent = title
    svg.append(node)
  }

  for (const [tag, attrs] of spec) {
    const child = document.createElementNS(NS, tag)
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, String(value))
    svg.append(child)
  }
  return svg
}

export const ICON_NAMES = Object.keys(PATHS)
