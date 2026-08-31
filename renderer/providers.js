/** Provider list: enable/disable, weight, edit, add, delete, reorder, probe. */
import { el, replace, field, toggle, modal, confirmDialog, fmt } from './dom.js'
import { state, reloadProviders } from './store.js'

const AUTH_STYLES = [
  { value: 'x-api-key', label: 'x-api-key (default)' },
  { value: 'bearer', label: 'bearer' },
  { value: 'passthrough', label: 'passthrough (official subscription)' },
]

const SANITIZE_OPTIONS = [
  { value: 'auto', label: 'auto-learn' },
  { value: 'on', label: 'pinned on' },
  { value: 'off', label: 'pinned off' },
]

const UNCHANGED = '__UNCHANGED__'

let banner = null

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
    setBanner('Saved. The running gateway picked it up without a restart.', 'info')
  } else if (res.conflict) {
    setBanner(`${res.error}. Reload to see the current file.`, 'error')
  } else {
    setBanner(res.error, 'error')
  }
  onDone?.(res)
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

function healthCell(provider) {
  const rt = runtimeFor(provider.name)
  if (!provider.enabled) return el('span', { class: 'tag', text: 'disabled' })
  if (!rt) return el('span', { class: 'tag', text: 'gateway offline' })
  if (rt.unhealthy) {
    const remaining = rt.health?.cooldownRemainingMs ?? 0
    return el('span', { class: 'tag bad', text: `cooldown ${fmt.duration(remaining)}` })
  }
  const fails = rt.health?.consecutiveFailures ?? 0
  if (fails > 0) return el('span', { class: 'tag warn', text: `${fails} recent failures` })
  return el('span', { class: 'tag ok', text: 'healthy' })
}

function sanitizeCell(provider) {
  if (provider.authStyle === 'passthrough') {
    return el('span', { class: 'tag official', text: 'off (forced)' })
  }
  const rt = runtimeFor(provider.name)
  if (rt?.sanitize) {
    const { mode, source } = rt.sanitize
    return el('span', {
      class: source === 'pinned' ? 'tag' : 'tag ok',
      text: `${mode ? 'on' : 'off'} · ${source}`,
    })
  }
  if (typeof provider.sanitize === 'boolean') {
    return el('span', { class: 'tag', text: `${provider.sanitize ? 'on' : 'off'} · pinned` })
  }
  return el('span', { class: 'tag', text: 'not yet learned' })
}

function move(index, delta) {
  const next = state.providers.slice()
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  save(next, { onDone: render })
}

async function remove(provider) {
  const ok = await confirmDialog({
    title: `Delete "${provider.name}"?`,
    message: 'This removes the provider and its API key from providers.json. Historical usage rows for this name stay in the database.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  save(state.providers.filter((p) => p.name !== provider.name), { onDone: render })
}

function editDialog(existing) {
  const isNew = !existing
  const draft = existing
    ? { ...existing, originalName: existing.name, newApiKey: undefined }
    : { name: '', baseUrl: '', enabled: true, weight: 1, authStyle: 'x-api-key', sanitize: null, apiKeySet: false }

  const errorLine = el('div', { class: 'notice bad', hidden: true })

  const nameInput = el('input', { type: 'text', value: draft.name, placeholder: 'My Provider' })
  const urlInput = el('input', { type: 'text', value: draft.baseUrl, placeholder: 'https://provider.example.com' })
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
  const passthroughNote = el('div', { class: 'notice info', hidden: true, text:
    'Passthrough injects no key: it forwards your Claude Code login straight to the upstream. Sanitize is forced off and the gateway will not fail over on 429/401/403.' })

  const syncAuthStyle = () => {
    const passthrough = authSelect.value === 'passthrough'
    keyField.hidden = passthrough
    passthroughNote.hidden = !passthrough
    sanitizeSelect.disabled = passthrough
    if (passthrough && !urlInput.value.trim()) urlInput.value = 'https://api.anthropic.com'
  }
  authSelect.addEventListener('change', syncAuthStyle)
  syncAuthStyle()

  const fail = (message) => {
    errorLine.textContent = message
    errorLine.hidden = false
  }

  modal({
    title: isNew ? 'Add provider' : `Edit "${existing.name}"`,
    wide: true,
    body: [
      errorLine,
      field('Name', nameInput, 'Must be unique — health, learned sanitize mode and usage history are all keyed by it.'),
      field('Base URL', urlInput, 'No trailing slash; the request path is appended as-is.'),
      passthroughNote,
      field('Auth style', authSelect),
      keyField,
      el('div', { class: 'row' }, [
        field('Weight', weightInput, 'Used by the weighted strategy.'),
        field('Sanitize', sanitizeSelect, 'Leave on auto unless you know the upstream\'s requirement.'),
      ]),
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: isNew ? 'Add' : 'Save',
        primary: true,
        keepOpen: true,
        onClick: async ({ close }) => {
          errorLine.hidden = true
          const name = nameInput.value.trim()
          if (!name) return fail('Name is required.')
          const weight = Number(weightInput.value)
          if (!Number.isInteger(weight) || weight < 1) return fail('Weight must be a positive integer.')

          const authStyle = authSelect.value
          const typedKey = keyInput.value.trim()
          if (authStyle !== 'passthrough' && !draft.apiKeySet && !typedKey) {
            return fail('An API key is required unless the auth style is passthrough.')
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
            setBanner(`Renamed to "${name}". Its health state and learned sanitize mode reset, and past usage rows stay under "${existing.name}".`, 'info')
          }
          close()
          render()
        },
      },
    ],
  })
}

async function probeDialog(provider) {
  const output = el('pre', { class: 'block', text: 'probing…' })
  modal({
    title: `Test "${provider.name}"`,
    wide: true,
    body: [
      el('div', { class: 'notice', text:
        'This calls the provider directly, bypassing the gateway — so it does not reflect the learned sanitize mode, and it does not touch health state. It costs a fraction of a cent.' }),
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

function providerRow(provider, index) {
  const rt = runtimeFor(provider.name)
  const isPassthrough = provider.authStyle === 'passthrough'

  return el('tr', {}, [
    el('td', {}, [toggle(provider.enabled, (checked) => {
      save(state.providers.map((p) => (p.name === provider.name ? { ...p, enabled: checked } : p)), { onDone: render })
    })]),
    el('td', {}, [
      el('div', { text: provider.name }),
      el('div', { class: 'muted mono', text: provider.baseUrl }),
      isPassthrough ? el('span', { class: 'tag official', text: 'official subscription' }) : null,
    ]),
    el('td', {}, [healthCell(provider)]),
    el('td', {}, [sanitizeCell(provider)]),
    el('td', { class: 'num', text: String(provider.weight) }),
    el('td', { class: 'mono', text: isPassthrough ? 'your Claude login' : provider.apiKeyMasked }),
    el('td', { class: 'num', text: rt?.usage ? `${rt.usage.requests} / ${rt.usage.errors}` : '—' }),
    el('td', {}, [
      el('div', { class: 'row' }, [
        el('button', { class: 'btn tiny', text: '↑', onClick: () => move(index, -1), disabled: index === 0 }),
        el('button', { class: 'btn tiny', text: '↓', onClick: () => move(index, 1), disabled: index === state.providers.length - 1 }),
        el('button', { class: 'btn tiny', text: 'Edit', onClick: () => editDialog(provider) }),
        el('button', { class: 'btn tiny', text: 'Test', onClick: () => probeDialog(provider), disabled: isPassthrough }),
        el('button', { class: 'btn tiny danger', text: 'Delete', onClick: () => remove(provider) }),
      ]),
    ]),
  ])
}

function officialPrompt() {
  const hasPassthrough = state.providers.some((p) => p.authStyle === 'passthrough')
  if (hasPassthrough) return null
  const account = state.claude?.account
  if (!account || account.loggedIn === false) return null

  return el('div', { class: 'panel' }, [
    el('h3', { text: 'Use your Claude subscription as a provider' }),
    el('p', { class: 'muted', text:
      'A Claude Code login was detected. Adding it as a passthrough provider lets the gateway route to your own plan alongside the third-party keys — the app never reads or stores the credential; Claude Code keeps sending it itself.' }),
    el('button', {
      class: 'btn primary', text: 'Add "Claude Official"',
      onClick: () => {
        const entry = {
          name: 'Claude Official',
          baseUrl: 'https://api.anthropic.com',
          enabled: true,
          weight: 1,
          authStyle: 'passthrough',
          sanitize: false,
        }
        save(state.providers.concat([entry]), { onDone: render })
      },
    }),
  ])
}

export function render() {
  const root = document.getElementById('view-providers')
  const rows = state.providers.map((p, i) => providerRow(p, i))

  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'On' }),
      el('th', { text: 'Provider' }),
      el('th', { text: 'Health' }),
      el('th', { text: 'Sanitize' }),
      el('th', { class: 'num', text: 'Weight' }),
      el('th', { text: 'Key' }),
      el('th', { class: 'num', text: 'Req / Err' }),
      el('th', { text: '' }),
    ])]),
    el('tbody', {}, rows),
  ])

  replace(root, [
    banner ? el('div', { class: `notice ${banner.kind === 'error' ? 'bad' : 'info'}`, text: banner.text }) : null,
    state.providersError ? el('div', { class: 'notice bad', text: state.providersError }) : null,
    officialPrompt(),
    el('div', { class: 'panel' }, [
      el('div', { class: 'row between' }, [
        el('div', {}, [
          el('h2', { text: `Providers (${state.providers.length})` }),
          el('p', { class: 'muted', text:
            `${state.enabledNames.length} enabled and eligible in the running gateway · strategy: ${state.stats?.strategy ?? '—'}` }),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', text: 'Reload', onClick: async () => { await reloadProviders(); setBanner(null); render() } }),
          el('button', { class: 'btn primary', text: 'Add provider', onClick: () => editDialog(null) }),
        ]),
      ]),
      state.providers.length ? table : el('div', { class: 'empty', text: 'No providers yet. Add one to get started.' }),
    ]),
    el('p', { class: 'muted', text:
      'Reordering only affects the round-robin strategy. Request/error counts come from the gateway\'s in-memory stats and reset when it restarts.' }),
  ])
}
