/**
 * Tiny DOM helpers.
 *
 * Everything goes through createElement/textContent — never innerHTML. Provider
 * names, error strings and upstream response previews are all attacker-influenced
 * (a hostile provider controls its own response body), so there is no safe place
 * to interpolate data into markup.
 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
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

export function replace(node, children) {
  clear(node)
  for (const child of [].concat(children)) {
    if (child) node.append(child)
  }
}

/** Labelled text input. `onInput` receives the raw string. */
export function field(labelText, input, hint) {
  return el('label', { class: 'field' }, [
    el('span', { text: labelText }),
    input,
    hint ? el('div', { class: 'muted', text: hint }) : null,
  ])
}

export function toggle(checked, onChange) {
  const input = el('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) })
  return el('label', { class: 'switch' }, [input, el('span', {})])
}

export function modal({ title, body, actions, wide = false }) {
  const root = document.getElementById('modal-root')
  const close = () => clear(root)

  const overlay = el('div', { class: 'overlay' }, [
    el('div', { class: `modal${wide ? ' wide' : ''}` }, [
      el('h2', { text: title }),
      ...[].concat(body).filter(Boolean),
      el('div', { class: 'actions' }, actions.map((a) =>
        el('button', {
          class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`,
          text: a.label,
          disabled: a.disabled,
          onClick: async () => {
            if (a.keepOpen) await a.onClick?.({ close })
            else { close(); await a.onClick?.({ close }) }
          },
        })
      )),
    ]),
  ])

  // Click-outside and Escape both cancel; neither commits anything.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey) }
  }
  document.addEventListener('keydown', onKey)

  replace(root, overlay)
  return close
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    modal({
      title,
      body: [el('p', { text: message })],
      actions: [
        { label: 'Cancel', onClick: () => resolve(false) },
        { label: confirmLabel, primary: !danger, danger, onClick: () => resolve(true) },
      ],
    })
  })
}

export const fmt = {
  usd(n, digits = 4) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
    return `$${n.toFixed(digits)}`
  },
  int(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
    return n.toLocaleString()
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
