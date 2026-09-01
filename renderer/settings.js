/** Setup view: Claude Code wiring, gateway port/strategy, appearance, autostart. */
import {
  el, replace, panel, button, field, notice, segmented, modal, fmt,
} from './dom.js'
import { icon } from './icons.js'
import { state, reloadSettings, emit } from './store.js'

let feedback = null

function setFeedback(text, kind = 'info') {
  feedback = text ? { text, kind } : null
}

/** Run an async settings write, showing its outcome the same way every time. */
async function apply(work, successText) {
  const res = await work()
  if (res?.ok === false) setFeedback(res.error, 'bad')
  else setFeedback(typeof successText === 'function' ? successText(res) : successText, 'good')
  await reloadSettings()
  render()
  // The wiring state and the port show up in the status bar and the setup guide too.
  emit()
  return res
}

/* ----------------------------------------------------------- Claude wiring */

function changeLines(changes) {
  return changes.map((c) => {
    if (c.to === null) return `- ${c.key}: ${c.from}`
    if (c.from === null || c.from === undefined) return `+ ${c.key}: ${c.to}`
    return `~ ${c.key}: ${c.from} -> ${c.to}`
  }).join('\n')
}

export async function wiringDialog(route) {
  const planned = await window.gw.claude.plan(route)
  if (!planned.ok) {
    setFeedback(planned.error, 'bad')
    render()
    emit()
    return
  }

  if (planned.changes.length === 0) {
    setFeedback('Nothing to change — Claude Code is already configured that way.', 'info')
    render()
    emit()
    return
  }

  modal({
    title: route ? 'Route Claude Code through the gateway' : 'Restore direct Anthropic access',
    wide: true,
    body: [
      el('p', {
        text: route
          ? 'This edits ~/.claude/settings.json so Claude Code sends its requests to the local gateway. Only the two keys shown below are touched.'
          : 'This removes the gateway wiring so Claude Code talks to Anthropic directly again.',
      }),
      el('pre', { class: 'block', text: changeLines(planned.changes) }),
      planned.preservedKeys.length
        ? notice('info', `Left untouched: ${planned.preservedKeys.join(', ')}`)
        : null,
      ...planned.warnings.map((w) => notice('warn', w)),
      notice('info',
        'Claude Code reads settings.json at startup, so restart any running session for this to take effect. The existing file is backed up first.'),
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: route ? 'Write settings.json' : 'Remove wiring',
        primary: true,
        keepOpen: true,
        onClick: async ({ close }) => {
          const res = await window.gw.claude.apply(route)
          if (!res.ok) setFeedback(res.error, 'bad')
          else if (res.backupPath) setFeedback(`Updated. Backup written to ${res.backupPath}. Restart Claude Code to pick it up.`, 'good')
          else setFeedback('Updated. Restart Claude Code to pick it up.', 'good')
          close()
          await reloadSettings()
          render()
          emit()
        },
      },
    ],
  })
}

function claudePanel() {
  const claude = state.claude
  if (!claude) {
    return panel({ title: 'Claude Code wiring', body: [el('p', { class: 'muted', text: 'Reading ~/.claude/settings.json…' })] })
  }

  const account = claude.account ?? {}
  const accountLine = account.loggedIn === true
    ? claude.passthroughEnabled
      ? 'A Claude Code login was detected and a passthrough provider is enabled, so no gateway credential is written — that absence is what keeps your subscription active.'
      : 'A Claude Code login was detected, but no passthrough provider is enabled, so a placeholder credential is written. Enable the passthrough provider to route your subscription through the gateway instead.'
    : account.loggedIn === null
      ? 'Login state is stored in the macOS Keychain and cannot be checked from here.'
      : 'No Claude Code login detected. The gateway will use your configured provider keys only.'

  const body = [
    el('p', { class: 'muted mono', text: claude.path }),
    el('p', { class: 'muted', text: accountLine }),
  ]

  if (claude.parseError) {
    body.push(notice('bad', `settings.json is not valid JSON (${claude.parseError}). Fix it before changing the wiring.`))
  }
  if (claude.routedElsewhere) {
    body.push(notice('warn', `ANTHROPIC_BASE_URL points at ${claude.baseUrl}, a local address that is not this gateway's port.`))
  }
  if (claude.foreignBaseUrl) {
    body.push(notice('warn', `ANTHROPIC_BASE_URL points at ${claude.baseUrl}, which this app did not set. Turning routing on will replace it.`))
  }
  // Only a problem when the subscription is what the gateway relays; otherwise a
  // credential here is exactly what stops Claude Code prompting for a login.
  if (claude.routed && claude.subscriptionInUse && (claude.hasAuthToken || claude.hasApiKey) && !claude.authTokenIsOurs) {
    body.push(notice('warn',
      'A gateway credential is set in settings.json, which overrides your Claude subscription. Remove ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY if you want the passthrough provider to use your plan.'))
  }

  body.push(el('div', { class: 'row' }, [
    button({
      label: claude.routed ? 'Turn routing off' : 'Turn routing on',
      text: claude.routed ? 'Turn routing off' : 'Turn routing on',
      icon: 'plug',
      kind: claude.routed ? '' : 'primary',
      disabled: Boolean(claude.parseError),
      onClick: () => wiringDialog(!claude.routed),
    }),
    el('span', { class: 'muted mono', text: claude.expectedBaseUrl }),
  ]))

  return panel({
    title: 'Claude Code wiring',
    actions: [
      el('span', {
        class: claude.routed ? 'tag ok' : 'tag',
      }, [
        icon(claude.routed ? 'check' : 'externalLink', { size: 11 }),
        el('span', { text: claude.routed ? 'routed through gateway' : 'direct to Anthropic' }),
      ]),
    ],
    body,
  })
}

/* ---------------------------------------------------------------- gateway */

function gatewayPanel() {
  const settings = state.settings
  if (!settings) return panel({ title: 'Gateway', body: [el('p', { class: 'muted', text: 'Loading…' })] })

  const strategySelect = el('select', { 'aria-label': 'Load-balancing strategy' }, settings.strategies.map((s) =>
    el('option', { value: s, text: s, selected: s === settings.strategy })))
  strategySelect.addEventListener('change', () => apply(
    () => window.gw.settings.update({ strategy: strategySelect.value }),
    `Strategy set to ${strategySelect.value}. The gateway was restarted to apply it.`,
  ))

  const logSelect = el('select', { 'aria-label': 'Gateway log level' }, settings.logLevels.map((s) =>
    el('option', { value: s, text: s, selected: s === settings.logLevel })))
  logSelect.addEventListener('change', () => apply(
    () => window.gw.settings.update({ logLevel: logSelect.value }),
    `Log level set to ${logSelect.value}. The gateway was restarted to apply it.`,
  ))

  const portInput = el('input', { type: 'number', min: '1024', max: '65535', value: String(settings.port), class: 'narrow' })
  const applyPort = () => apply(
    () => window.gw.gateway.usePort(Number(portInput.value)),
    (res) => `Gateway moved to port ${res.port}. Claude Code's settings.json was updated to match, since it was routed here.`,
  )
  portInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPort() })

  return panel({
    title: 'Gateway',
    subtitle: 'Bound to 127.0.0.1 only — nothing on your network can reach it.',
    body: [
      el('div', { class: 'field-grid' }, [
        field('Port', el('div', { class: 'row tight' }, [
          portInput,
          button({ label: 'Apply port', text: 'Apply', onClick: applyPort }),
        ]), 'Changing this rewrites ~/.claude/settings.json while routing is on, because the port is stored there as a literal.'),
        field('Strategy', strategySelect, 'How a request picks among the eligible providers. Restarts the gateway.'),
        field('Log level', logSelect, 'Restarts the gateway; it is read from the environment at fork time.'),
      ]),
      el('div', { class: 'row' }, [
        button({ label: 'Restart gateway', text: 'Restart gateway', icon: 'restart', onClick: () => window.gw.gateway.restart() }),
        button({ label: 'Open gateway log', text: 'Open log', icon: 'fileText', onClick: () => window.gw.shell.openLog() }),
      ]),
      el('div', { class: 'subtle mono', text: settings.logPath }),
      el('div', { class: 'subtle mono', text: settings.providersPath }),
    ],
  })
}

/* ------------------------------------------------------------- appearance */

const THEMES = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
]

function appearancePanel() {
  const current = state.settings?.theme ?? 'system'
  return panel({
    title: 'Appearance',
    subtitle: 'System follows your desktop\'s light/dark preference and changes with it.',
    body: [
      segmented(THEMES, current, (value) => {
        if (value === current) return
        // No reload needed: setting nativeTheme.themeSource in main flips what
        // prefers-color-scheme resolves to, and every color is a token.
        apply(() => window.gw.settings.update({ theme: value }), null)
      }, 'Theme'),
    ],
  })
}

/* -------------------------------------------------------------- autostart */

function autostartPanel() {
  const auto = state.settings?.autostart
  if (!auto) return null

  if (!auto.supported) {
    return panel({
      title: 'Start on login',
      body: [el('p', { class: 'muted', text: auto.reason ?? 'Not supported on this platform.' })],
    })
  }

  return panel({
    title: 'Start on login',
    subtitle: 'Writes an XDG autostart entry so the gateway is already running before you open a terminal.',
    actions: [
      el('span', { class: auto.enabled ? 'tag ok' : 'tag' }, [
        auto.enabled ? icon('check', { size: 11 }) : null,
        el('span', { text: auto.enabled ? 'enabled' : 'disabled' }),
      ]),
    ],
    body: [
      el('div', { class: 'row' }, [
        button({
          label: auto.enabled ? 'Disable autostart' : 'Enable autostart',
          text: auto.enabled ? 'Disable' : 'Enable',
          onClick: () => apply(
            () => window.gw.settings.setAutostart(!auto.enabled),
            auto.enabled ? 'Autostart entry removed.' : 'Autostart entry written.',
          ),
        }),
        auto.path ? el('span', { class: 'subtle mono', text: auto.path }) : null,
      ]),
    ],
  })
}

/* ----------------------------------------------------------------- status */

function statusPanel() {
  const g = state.gateway
  const detail = g.status === 'running' ? `pid ${g.pid ?? '—'}` : g.detail || undefined

  return panel({
    title: 'Status',
    body: [
      el('div', { class: 'metrics' }, [
        el('div', { class: 'metric-cell' }, [
          el('div', { class: 'k', text: 'Gateway' }),
          el('div', { class: 'row tight' }, [
            el('span', { class: `dot ${g.status === 'running' ? 'up' : g.status === 'starting' ? 'warn pulse' : 'down'}` }),
            el('span', { class: 'v', text: g.status }),
          ]),
          detail ? el('div', { class: 'h', text: detail }) : null,
        ]),
        el('div', { class: 'metric-cell' }, [
          el('div', { class: 'k', text: 'Address' }),
          el('div', { class: 'v mono addr', text: `127.0.0.1:${g.port ?? '—'}` }),
        ]),
        el('div', { class: 'metric-cell' }, [
          el('div', { class: 'k', text: 'Requests' }),
          el('div', { class: 'v', text: fmt.int(state.stats?.totalRequests ?? 0) }),
        ]),
        el('div', { class: 'metric-cell' }, [
          el('div', { class: 'k', text: 'Latency p95' }),
          el('div', { class: 'v', text: fmt.ms(state.stats?.latency?.p95) }),
        ]),
      ]),
    ],
  })
}

export function render() {
  replace(document.getElementById('view-settings'), [
    feedback ? notice(feedback.kind, feedback.text, button({
      label: 'Dismiss', icon: 'close', kind: 'quiet', size: 'icon',
      onClick: () => { setFeedback(null); render() },
    })) : null,
    statusPanel(),
    claudePanel(),
    gatewayPanel(),
    appearancePanel(),
    autostartPanel(),
  ])
}
