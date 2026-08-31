/** Provider list: enable/disable, weight, edit, add, delete, reorder, probe. */
import {
  el, replace, panel, button, iconButton, field, toggle, modal, confirmDialog,
  notice, emptyState, skeletonRows, fmt,
} from './dom.js'
import { icon } from './icons.js'
import { state, reloadProviders, emit } from './store.js'

const AUTH_STYLES = [
  { value: 'bearer', label: 'bearer (default)' },
  { value: 'x-api-key', label: 'x-api-key' },
  { value: 'passthrough', label: 'passthrough (official subscription)' },
]

const SANITIZE_OPTIONS = [
  { value: 'auto', label: 'auto-learn' },
  { value: 'on', label: 'pinned on' },
  { value: 'off', label: 'pinned off' },
]

const UNCHANGED = '__UNCHANGED__'

const COLUMNS = [
  { key: 'on', label: 'On' },
  { key: 'provider', label: 'Provider' },
  { key: 'health', label: 'Health' },
  { key: 'sanitize', label: 'Sanitize' },
  { key: 'weight', label: 'Weight', num: true },
  { key: 'key', label: 'Key' },
  { key: 'traffic', label: 'Req / Err', num: true },
  { key: 'actions', label: '', hideLabel: true },
]

let banner = null
/**
 * Name of the provider whose row has an in-flight write. Every write moves
 * providers.json's version, so a second one started before the first lands is
 * refused as a stale-version conflict — this is what gates the controls.
 */
let busyName = null
/**
 * The `enabled` value a row is being saved with. A poll tick's emit() re-renders
 * from `state.providers`, which still holds the pre-write value until the save
 * lands, so without this the switch visibly snaps back and then flips again.
 */
let pendingEnabled = null

function setBanner(text, kind = 'info') {
  banner = text ? { text, kind } : null
}

/** Turn the public shape back into a save payload, preserving the stored key. */
function toPayload(p) {
  const out = {
    name: p.name,
    originalName: p.originalName ?? p.name,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    weight: p.weight,
    authStyle: p.authStyle,
  }
  if (typeof p.sanitize === 'boolean') out.sanitize = p.sanitize
  if (p.authStyle !== 'passthrough') out.apiKey = p.newApiKey ?? UNCHANGED
  return out
}

async function save(providers, { onDone } = {}) {
  const res = await window.gw.providers.save(providers.map(toPayload), state.providersVersion)
  if (res.ok) {
    state.providers = res.providers
    state.providersVersion = res.version
    setBanner('Saved. The running gateway picked it up without a restart.', 'good')
  } else if (res.conflict) {
    setBanner(`${res.error}. Reload to see the current file.`, 'bad')
  } else {
    setBanner(res.error, 'bad')
  }
  onDone?.(res)
  // Every other view derives from the provider list — the onboarding guide's step
  // 2, the status bar's eligible count — so publish rather than only re-render here.
  emit()
  return res
}

/** Health + sanitize for one provider, merged from /stats by name. */
function runtimeFor(name) {
  const stats = state.stats
  if (!stats) return null
  return {
    health: stats.health?.[name] ?? null,
    sanitize: stats.sanitize?.[name] ?? null,
    usage: stats.providerUsage?.[name] ?? null,
    unhealthy: (stats.unhealthyProviders ?? []).includes(name),
  }
}

/** True while the gateway is up but its first /stats reply has not landed yet. */
function statsPending() {
  return state.gateway.status === 'running' && !state.stats && !state.statsError
}

function tag(kind, text, iconName) {
  return el('span', { class: `tag${kind ? ` ${kind}` : ''}` }, [
    iconName ? icon(iconName, { size: 11 }) : null,
    el('span', { text }),
  ])
}

function healthCell(provider) {
  if (!provider.enabled) return tag('', 'disabled')
  if (statsPending()) return el('span', { class: 'skeleton tag', 'aria-hidden': 'true' })

  const rt = runtimeFor(provider.name)
  if (!rt) return tag('', 'gateway offline')
  if (rt.unhealthy) {
    const remaining = rt.health?.cooldownRemainingMs ?? 0
    return tag('bad', `cooldown ${fmt.duration(remaining)}`, 'clock')
  }
  const fails = rt.health?.consecutiveFailures ?? 0
  if (fails > 0) return tag('warn', `${fails} recent ${fails === 1 ? 'failure' : 'failures'}`, 'alert')
  return tag('ok', 'healthy', 'check')
}

function sanitizeCell(provider) {
  if (provider.authStyle === 'passthrough') return tag('official', 'off (forced)')
  if (statsPending()) return el('span', { class: 'skeleton tag', 'aria-hidden': 'true' })

  const rt = runtimeFor(provider.name)
  if (rt?.sanitize) {
    const { mode, source } = rt.sanitize
    return tag(source === 'pinned' ? '' : 'ok', `${mode ? 'on' : 'off'} · ${source}`)
  }
  if (typeof provider.sanitize === 'boolean') {
    return tag('', `${provider.sanitize ? 'on' : 'off'} · pinned`)
  }
  return tag('', 'not yet learned')
}

function trafficCell(provider) {
  if (statsPending()) return el('span', { class: 'skeleton text w-40', 'aria-hidden': 'true' })
  const rt = runtimeFor(provider.name)
  if (!rt?.usage) return el('span', { class: 'muted', text: '—' })
  const { requests, errors } = rt.usage
  return el('span', {}, [
    el('span', { text: fmt.int(requests) }),
    el('span', { class: 'muted', text: ' / ' }),
    el('span', { class: errors > 0 ? undefined : 'muted', text: fmt.int(errors) }),
  ])
}

/* ------------------------------------------------------------------ actions */

function move(index, delta) {
  const next = state.providers.slice()
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  busyName = item.name
  // Paint the gated controls before awaiting, not after.
  render()
  save(next, { onDone: () => { busyName = null; render() } })
}

async function remove(provider) {
  const ok = await confirmDialog({
    title: `Delete “${provider.name}”?`,
    message: `This removes ${provider.name} and its API key from providers.json. The gateway stops routing to it immediately.`,
    detail: 'Historical usage rows for this name stay in the database, so past cost reporting is unaffected.',
    confirmLabel: 'Delete provider',
    danger: true,
  })
  if (!ok) return
  busyName = provider.name
  render()
  save(state.providers.filter((p) => p.name !== provider.name), { onDone: () => { busyName = null; render() } })
}

function setEnabled(provider, enabled) {
  if (busyName !== null) return
  busyName = provider.name
  pendingEnabled = { name: provider.name, enabled }
  // Paint the disabled switch before awaiting: a second click during the write
  // would carry the pre-write version and come back as a stale-version conflict.
  render()
  save(
    state.providers.map((p) => (p.name === provider.name ? { ...p, enabled } : p)),
    { onDone: () => { busyName = null; pendingEnabled = null; render() } },
  )
}

/* ------------------------------------------------------------------ dialogs */

function editDialog(existing, preset = {}) {
  const isNew = !existing
  const draft = existing
    ? { ...existing, originalName: existing.name, newApiKey: undefined }
    : {
      name: '', baseUrl: '', enabled: true, weight: 1,
      authStyle: 'bearer', sanitize: null, apiKeySet: false, ...preset,
    }

  const errorLine = el('div', { class: 'notice bad', hidden: true }, [
    icon('alert'),
    el('span', { class: 'msg' }),
  ])
  const errorText = errorLine.querySelector('.msg')

  const nameInput = el('input', { type: 'text', value: draft.name, placeholder: 'My Provider', autocomplete: 'off' })
  const urlInput = el('input', { type: 'text', value: draft.baseUrl, placeholder: 'https://provider.example.com', autocomplete: 'off' })
  const weightInput = el('input', { type: 'number', min: '1', step: '1', value: String(draft.weight), class: 'narrow' })
  const keyInput = el('input', {
    type: 'password',
    placeholder: draft.apiKeySet ? `unchanged (${draft.apiKeyMasked})` : 'sk-…',
    autocomplete: 'off',
  })

  const authSelect = el('select', {}, AUTH_STYLES.map((o) =>
    el('option', { value: o.value, text: o.label, selected: o.value === draft.authStyle })))

  const sanitizeSelect = el('select', {}, SANITIZE_OPTIONS.map((o) => {
    const current = draft.sanitize === null || draft.sanitize === undefined ? 'auto' : (draft.sanitize ? 'on' : 'off')
    return el('option', { value: o.value, text: o.label, selected: o.value === current })
  }))

  const keyField = field('API key', keyInput,
    draft.apiKeySet ? 'Leave blank to keep the existing key.' : undefined)
  const passthroughNote = notice('info',
    'Passthrough injects no key: it forwards your Claude Code login straight to the upstream. Sanitize is forced off and the gateway will not fail over on 429/401/403.')
  passthroughNote.hidden = true

  const syncAuthStyle = () => {
    const passthrough = authSelect.value === 'passthrough'
    keyField.hidden = passthrough
    passthroughNote.hidden = !passthrough
    sanitizeSelect.disabled = passthrough
    if (passthrough && !urlInput.value.trim()) urlInput.value = 'https://api.anthropic.com'
  }
  authSelect.addEventListener('change', syncAuthStyle)
  syncAuthStyle()

  /** Name the problem on the field that owns it, then move focus there. */
  const fail = (message, input) => {
    errorText.textContent = message
    errorLine.hidden = false
    if (input) {
      input.setAttribute('aria-invalid', 'true')
      input.focus()
    }
  }
  const clearInvalid = () => {
    errorLine.hidden = true
    for (const input of [nameInput, urlInput, weightInput, keyInput]) input.removeAttribute('aria-invalid')
  }

  modal({
    title: isNew ? 'Add provider' : `Edit “${existing.name}”`,
    wide: true,
    body: [
      errorLine,
      field('Name', nameInput, 'Must be unique — health, learned sanitize mode and usage history are all keyed by it.'),
      field('Base URL', urlInput, 'No trailing slash; the request path is appended as-is.'),
      passthroughNote,
      field('Auth style', authSelect),
      keyField,
      el('div', { class: 'field-grid' }, [
        field('Weight', weightInput, 'Used by the weighted strategy.'),
        field('Sanitize', sanitizeSelect, 'Leave on auto unless you know the upstream\'s requirement.'),
      ]),
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: isNew ? 'Add provider' : 'Save changes',
        primary: true,
        keepOpen: true,
        onClick: async ({ close }) => {
          clearInvalid()
          const name = nameInput.value.trim()
          if (!name) return fail('Give the provider a name.', nameInput)

          const weight = Number(weightInput.value)
          if (!Number.isInteger(weight) || weight < 1) {
            return fail('Weight must be a whole number of 1 or more.', weightInput)
          }

          const authStyle = authSelect.value
          const typedKey = keyInput.value.trim()
          if (authStyle !== 'passthrough' && !draft.apiKeySet && !typedKey) {
            return fail('Paste an API key, or switch the auth style to passthrough.', keyInput)
          }

          const sanitize = sanitizeSelect.value === 'auto' ? null
            : sanitizeSelect.value === 'on' ? true : false

          const entry = {
            name,
            originalName: draft.originalName,
            baseUrl: urlInput.value.trim(),
            enabled: draft.enabled ?? true,
            weight,
            authStyle,
            sanitize: authStyle === 'passthrough' ? false : sanitize,
            newApiKey: typedKey ? typedKey : undefined,
          }

          const next = isNew
            ? state.providers.concat([entry])
            : state.providers.map((p) => (p.name === existing.name ? entry : p))

          const renamed = !isNew && name !== existing.name
          const res = await save(next)
          if (!res.ok) return fail(res.error)
          if (renamed) {
            setBanner(`Renamed to “${name}”. Its health state and learned sanitize mode reset, and past usage rows stay under “${existing.name}”.`, 'info')
          }
          close()
          render()
        },
      },
    ],
  })
}

/**
 * The add-provider dialog, for callers outside this view (the onboarding guide).
 * `passthrough` pre-selects the auth style that forwards the user's own Claude
 * Code login instead of asking for a key.
 */
export function addProviderDialog({ passthrough = false } = {}) {
  editDialog(null, passthrough
    ? { name: 'Claude Official', baseUrl: 'https://api.anthropic.com', authStyle: 'passthrough', sanitize: false }
    : {})
}

async function probeDialog(provider) {
  const output = el('pre', { class: 'block', text: 'Sending one request…' })
  modal({
    title: `Test “${provider.name}”`,
    wide: true,
    body: [
      notice('warn',
        'This calls the provider directly, bypassing the gateway — so it does not reflect the learned sanitize mode, and it does not touch health state. It costs a fraction of a cent.'),
      output,
    ],
    actions: [{ label: 'Close' }],
  })

  const res = await window.gw.providers.probe(provider.name)
  if (res.error && res.statusCode === undefined) {
    output.textContent = res.error
    return
  }
  output.textContent = [
    `ok:           ${res.ok}`,
    `status:       ${res.statusCode ?? '—'}`,
    `latency:      ${fmt.ms(res.latencyMs)}`,
    `content-type: ${res.contentType ?? '—'}`,
    res.looksLikeHtml ? 'warning:      HTML body — usually a Cloudflare error page' : null,
    res.error ? `error:        ${res.error}` : null,
    '',
    'body preview (keys redacted):',
    res.bodyPreview ?? '(none)',
  ].filter((l) => l !== null).join('\n')
}

/* --------------------------------------------------------------------- rows */

function providerRow(row, index) {
  // While this row's toggle is in flight, render the value being saved rather than
  // the one still on disk — including in the health cell, which reads `enabled`.
  const provider = pendingEnabled?.name === row.name
    ? { ...row, enabled: pendingEnabled.enabled }
    : row
  const isPassthrough = provider.authStyle === 'passthrough'
  // Any in-flight write invalidates the version every other control would send,
  // so all of them are gated, not just the busy row's.
  const writing = busyName !== null
  const last = index === state.providers.length - 1

  return el('tr', { class: provider.enabled ? undefined : 'off' }, [
    el('td', {}, [toggle(
      provider.enabled,
      (checked) => setEnabled(provider, checked),
      `${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`,
      { disabled: writing },
    )]),
    el('td', {}, [
      el('div', { class: 'primary-cell', text: provider.name }),
      el('div', { class: 'row tight' }, [
        el('span', { class: 'muted mono', text: provider.baseUrl }),
        isPassthrough ? tag('official', 'official subscription', 'shield') : null,
      ]),
    ]),
    el('td', {}, [healthCell(provider)]),
    el('td', {}, [sanitizeCell(provider)]),
    el('td', { class: 'num', text: String(provider.weight) }),
    el('td', { class: 'mono', text: isPassthrough ? 'your Claude login' : provider.apiKeyMasked }),
    el('td', { class: 'num' }, [trafficCell(provider)]),
    el('td', { class: 'actions' }, [
      el('div', { class: 'row-actions' }, [
        iconButton('chevronUp', `Move ${provider.name} up`, () => move(index, -1), { disabled: index === 0 || writing }),
        iconButton('chevronDown', `Move ${provider.name} down`, () => move(index, 1), { disabled: last || writing }),
        iconButton('pencil', `Edit ${provider.name}`, () => editDialog(provider), { disabled: writing }),
        iconButton('beaker', `Test ${provider.name}`, () => probeDialog(provider), { disabled: isPassthrough || writing }),
        iconButton('trash', `Delete ${provider.name}`, () => remove(provider), { kind: 'quiet danger', disabled: writing }),
      ]),
    ]),
  ])
}

function providerTable() {
  const head = el('thead', {}, [el('tr', {}, COLUMNS.map((c) => el('th', {
    class: c.num ? 'num' : undefined,
    scope: 'col',
    text: c.hideLabel ? '' : c.label,
    'aria-label': c.hideLabel ? 'Row actions' : undefined,
  })))])

  const body = state.loaded
    ? state.providers.map((p, i) => providerRow(p, i))
    : skeletonRows(['short', 'text', 'tag', 'tag', 'short', 'text', 'short', 'short'], 3)

  return el('div', { class: 'table-scroll' }, [el('table', {}, [head, el('tbody', {}, body)])])
}

/* ------------------------------------------------------------------ panels */

function subtitle() {
  if (!state.loaded) return 'reading providers.json…'
  const strategy = state.stats?.strategy
  const eligible = `${state.enabledNames.length} eligible in the running gateway`
  return strategy ? `${eligible} · ${strategy} strategy` : eligible
}

function officialPanel() {
  const hasPassthrough = state.providers.some((p) => p.authStyle === 'passthrough')
  if (hasPassthrough) return null
  const account = state.claude?.account
  if (!account || account.loggedIn === false) return null

  return panel({
    title: 'Use your Claude subscription as a provider',
    body: [
      el('p', { class: 'muted', text:
        'A Claude Code login was detected. Adding it as a passthrough provider lets the gateway route to your own plan alongside the third-party keys — the app never reads or stores the credential; Claude Code keeps sending it itself.' }),
      el('div', { class: 'row' }, [
        button({
          label: 'Add Claude Official', text: 'Add “Claude Official”', kind: 'primary', icon: 'shield',
          onClick: () => save(state.providers.concat([{
            name: 'Claude Official',
            baseUrl: 'https://api.anthropic.com',
            enabled: true,
            weight: 1,
            authStyle: 'passthrough',
            sanitize: false,
          }]), { onDone: render }),
        }),
      ]),
    ],
  })
}

export function render() {
  const root = document.getElementById('view-providers')

  replace(root, [
    banner ? notice(banner.kind, banner.text) : null,
    state.providersError ? notice('bad', state.providersError) : null,
    officialPanel(),
    panel({
      title: state.loaded ? `Providers · ${state.providers.length}` : 'Providers',
      subtitle: subtitle(),
      actions: [
        button({
          label: 'Reload from disk', text: 'Reload', icon: 'refresh',
          onClick: async () => { await reloadProviders(); setBanner(null); render() },
        }),
        button({ label: 'Add provider', text: 'Add provider', icon: 'plus', kind: 'primary', onClick: () => editDialog(null) }),
      ],
      flush: true,
      body: state.loaded && !state.providers.length
        ? emptyState({
          icon: 'server',
          title: 'No providers yet',
          body: 'Add an Anthropic-compatible endpoint and its key, and the gateway starts load-balancing across it on the next request — no restart.',
          actions: [button({ label: 'Add the first provider', text: 'Add the first provider', icon: 'plus', kind: 'primary', onClick: () => editDialog(null) })],
        })
        : providerTable(),
      foot: 'Order only affects the round-robin strategy. Request and error counts come from the gateway\'s in-memory stats and reset when it restarts.',
    }),
  ])
}
