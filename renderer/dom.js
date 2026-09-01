/**
 * Tiny DOM helpers.
 *
 * Everything goes through createElement/textContent — never innerHTML. Provider
 * names, error strings and upstream response previews are all attacker-influenced
 * (a hostile provider controls its own response body), so there is no safe place
 * to interpolate data into markup.
 *
 * Runtime colors go through `css:` (CSSOM setProperty), not a style="" attribute:
 * the page's CSP has style-src 'self' with no 'unsafe-inline', which blocks the
 * attribute but not the CSSOM.
 */
import { icon } from './icons.js'

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key === 'css') for (const [p, v] of Object.entries(value)) node.style.setProperty(p, v)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key in node) node[key] = value
    else node.setAttribute(key, String(value))
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
  return node
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/**
 * Scroll offsets do not survive a rebuild, and every view rebuilds its whole
 * subtree — on each poll tick and after every write. Two offsets are lost:
 * `#main`'s, because emptying its content collapses the scroll height and the
 * browser clamps scrollTop to 0; and each inner scroll host's, because the
 * element itself is discarded. Hosts are matched by `data-scroll-key` rather
 * than by identity or position, so a row count that changed between renders
 * still lines up.
 */
function scrollSnapshot(node) {
  const hosts = new Map()
  for (const host of node.querySelectorAll('[data-scroll-key]')) {
    hosts.set(host.dataset.scrollKey, { top: host.scrollTop, left: host.scrollLeft })
  }
  const main = node.closest('#main')
  return { hosts, main, mainTop: main ? main.scrollTop : 0 }
}

function scrollRestore(node, snap) {
  if (snap.main && snap.mainTop) snap.main.scrollTop = snap.mainTop
  if (snap.hosts.size === 0) return
  for (const host of node.querySelectorAll('[data-scroll-key]')) {
    const prev = snap.hosts.get(host.dataset.scrollKey)
    if (!prev) continue
    host.scrollTop = prev.top
    host.scrollLeft = prev.left
  }
}

export function replace(node, children) {
  const snap = scrollSnapshot(node)
  clear(node)
  for (const child of [].concat(children)) {
    if (child) node.append(child)
  }
  // Assigning scrollTop forces the layout the restore depends on, so this has to
  // happen here and not in a later frame — a rAF would repaint at 0 first.
  scrollRestore(node, snap)
}

/* -------------------------------------------------------------- primitives */

/**
 * A button. `icon` names an entry in icons.js; when there is no visible text the
 * icon name is not the accessible name, so `label` becomes aria-label + title.
 */
export function button({ label, text, icon: iconName, kind = '', size = '', onClick, disabled, title, loading }) {
  const classes = ['btn', kind, size, loading ? 'loading' : ''].filter(Boolean).join(' ')
  const node = el('button', {
    type: 'button',
    class: classes,
    onClick,
    disabled: disabled || undefined,
    title: title ?? (text ? undefined : label),
    'aria-label': text ? undefined : label,
  }, [
    iconName ? icon(iconName) : null,
    text ? el('span', { text }) : null,
  ])
  return node
}

/** Square icon-only button. `label` is required — it is the accessible name. */
export function iconButton(iconName, label, onClick, { kind = 'quiet', disabled, size = 'icon' } = {}) {
  return button({ icon: iconName, label, kind, size, onClick, disabled })
}

/** Labelled control. The wrapping <label> is the association; no id juggling. */
export function field(labelText, input, hint) {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: labelText }),
    input,
    hint ? el('div', { class: 'field-hint', text: hint }) : null,
  ])
}

/**
 * Checkbox styled as a switch. The wrapper is a <label> so a click anywhere in the
 * box activates the input, and `.track` is pointer-events: none in the stylesheet —
 * it is an absolutely positioned later sibling, so it paints over the input and
 * would otherwise swallow every click.
 */
export function toggle(checked, onChange, label, { disabled = false } = {}) {
  const input = el('input', {
    type: 'checkbox',
    checked,
    disabled: disabled || undefined,
    'aria-label': label,
    onChange: (e) => onChange(e.target.checked),
  })
  return el('label', { class: 'switch' }, [input, el('span', { class: 'track' })])
}

/**
 * Radio-group-as-segmented-control. `options` = [{ value, label, icon }].
 * aria-pressed rather than role=radio: these apply immediately, they are not a
 * pending choice inside a form.
 */
export function segmented(options, current, onPick, groupLabel) {
  return el('div', { class: 'segmented', role: 'group', 'aria-label': groupLabel },
    options.map((o) => el('button', {
      type: 'button',
      'aria-pressed': String(o.value === current),
      onClick: () => onPick(o.value),
    }, [
      o.icon ? icon(o.icon) : null,
      el('span', { text: o.label }),
    ])))
}

const NOTICE_ICON = { info: 'info', bad: 'alert', good: 'check', warn: 'alert' }

/** `action` is a trailing control — a dismiss button, a link out, a retry. */
export function notice(kind, text, action) {
  return el('div', { class: `notice ${kind === 'warn' ? '' : kind}`.trim() }, [
    icon(NOTICE_ICON[kind] ?? 'info'),
    el('div', { class: 'msg', text }),
    action ?? null,
  ])
}

export function emptyState({ icon: iconName = 'inbox', title, body, actions = [] }) {
  return el('div', { class: 'empty' }, [
    icon(iconName, { size: 26, stroke: 1.25 }),
    el('h3', { text: title }),
    body ? el('p', { text: body }) : null,
    actions.length ? el('div', { class: 'empty-actions' }, actions) : null,
  ])
}

export function panel({ title, subtitle, actions = [], body, foot, flush = false }) {
  return el('section', { class: 'panel' }, [
    title
      ? el('div', { class: 'panel-head' }, [
        el('div', {}, [
          el('h2', { text: title }),
          subtitle ? el('p', { class: 'muted', text: subtitle }) : null,
        ]),
        actions.length ? el('div', { class: 'actions' }, actions) : null,
      ])
      : null,
    body ? el('div', { class: `panel-body${flush ? ' flush' : ''}` }, [].concat(body).filter(Boolean)) : null,
    foot ? el('div', { class: 'panel-foot', text: foot }) : null,
  ])
}

export function metric(key, value, hint, { lead = false } = {}) {
  return el('div', { class: 'metric-cell' }, [
    el('div', { class: 'k', text: key }),
    el('div', { class: `v${lead ? ' lead' : ''}`, text: value }),
    hint ? el('div', { class: 'h', text: hint }) : null,
  ])
}

/* --------------------------------------------------------------- skeletons */

/** `aria-hidden` because a shimmering placeholder has no meaning to read out. */
export function skeleton(variant = 'text', width) {
  return el('span', {
    class: `skeleton ${variant}${width ? ` w-${width}` : ''}`,
    'aria-hidden': 'true',
  })
}

export function skeletonRows(columns, rows = 3) {
  return Array.from({ length: rows }, () =>
    el('tr', { 'aria-hidden': 'true' }, columns.map((variant) =>
      el('td', {}, [skeleton(variant === 'tag' ? 'tag' : 'text', variant === 'short' ? '40' : '80')]))))
}

/* ------------------------------------------------------------------ dialog */

/**
 * Modal built on <dialog>.showModal(), which gives the focus trap, the inert
 * background, Escape-to-cancel, and focus restoration natively — all four were
 * hand-rolled and partly missing before.
 */
export function modal({ title, body, actions, wide = false, onClose }) {
  const root = document.getElementById('dialog-root')
  const dialog = el('dialog', {})
  const close = () => { if (dialog.open) dialog.close() }

  const card = el('div', { class: `modal${wide ? ' wide' : ''}` }, [
    el('header', {}, [el('h2', { text: title })]),
    el('div', { class: 'modal-body' }, [].concat(body).filter(Boolean)),
    el('div', { class: 'modal-actions' }, actions.map((a) => {
      const node = button({
        label: a.label,
        text: a.label,
        kind: a.primary ? 'primary' : a.danger ? 'danger' : '',
        disabled: a.disabled,
        onClick: async () => {
          if (!a.keepOpen) {
            close()
            await a.onClick?.({ close })
            return
          }
          // The dialog stays open across an await, so the control that started the
          // work has to say so — otherwise a slow save looks like a dead button.
          node.classList.add('loading')
          try {
            await a.onClick?.({ close })
          } finally {
            node.classList.remove('loading')
          }
        },
      })
      return node
    })),
  ])

  dialog.append(card)
  // Clicks on ::backdrop are dispatched to the dialog element itself.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close() })
  dialog.addEventListener('close', () => { dialog.remove(); onClose?.() })

  root.append(dialog)
  dialog.showModal()
  card.querySelector('input:not([type="hidden"]), select, textarea, .btn.primary')?.focus()

  return close
}

export function confirmDialog({ title, message, detail, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false
    modal({
      title,
      body: [
        el('p', { text: message }),
        detail ? el('p', { class: 'muted', text: detail }) : null,
      ],
      actions: [
        { label: 'Cancel', onClick: () => { answered = true; resolve(false) } },
        { label: confirmLabel, primary: !danger, danger, onClick: () => { answered = true; resolve(true) } },
      ],
      // Escape or a backdrop click is a cancel, not an unresolved promise.
      onClose: () => { if (!answered) resolve(false) },
    })
  })
}

/* ---------------------------------------------------------------- fmt */

export const fmt = {
  usd(n, digits = 4) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
    return `$${n.toFixed(digits)}`
  },
  int(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
    return n.toLocaleString()
  },
  /** Compact for the status bar, where width is scarce. */
  compact(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
    if (n < 1000) return String(n)
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  },
  ms(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n === 0) return '—'
    return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
  },
  duration(ms) {
    if (typeof ms !== 'number' || ms <= 0) return '—'
    const s = Math.ceil(ms / 1000)
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
  },
}

/** Read a design token, so canvas-free SVG can use the same palette as the CSS. */
export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
