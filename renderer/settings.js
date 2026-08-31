/** Setup view: Claude Code wiring, gateway port/strategy, autostart. */
import { el, replace, modal, fmt } from './dom.js'
import { state, reloadSettings } from './store.js'

let notice = null

function setNotice(text, kind = 'info') {
  notice = text ? { text, kind } : null
}

function changeLines(changes) {
  return changes.map((c) => {
    if (c.to === null) return `- ${c.key}: ${c.from}`
    if (c.from === null || c.from === undefined) return `+ ${c.key}: ${c.to}`
    return `~ ${c.key}: ${c.from} → ${c.to}`
  }).join('\n')
}

async function wiringDialog(route) {
  const planned = await window.gw.claude.plan(route)
  if (!planned.ok) {
    setNotice(planned.error, 'error')
    render()
    return
  }

  if (planned.changes.length === 0) {
    setNotice('Nothing to change — Claude Code is already configured that way.', 'info')
    render()
    return
  }

  const body = [
    el('p', {
      text: route
        ? 'This edits ~/.claude/settings.json so Claude Code sends its requests to the local gateway.'
        : 'This removes the gateway wiring so Claude Code talks to Anthropic directly again.',
    }),
    el('pre', { class: 'block', text: changeLines(planned.changes) }),
    planned.preservedKeys.length
      ? el('div', { class: 'notice info', text: `Untouched top-level keys: ${planned.preservedKeys.join(', ')}` })
      : null,
    ...planned.warnings.map((w) => el('div', { class: 'notice', text: w })),
    el('div', { class: 'notice info', text:
      'Claude Code reads settings.json at startup, so restart any running session for this to take effect. The existing file is backed up first.' }),
  ]

  modal({
    title: route ? 'Route Claude Code through the gateway' : 'Restore direct Anthropic access',
    wide: true,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: route ? 'Write settings.json' : 'Remove wiring',
        primary: true,
        onClick: async () => {
          const res = await window.gw.claude.apply(route)
          if (!res.ok) setNotice(res.error, 'error')
          else if (res.backupPath) setNotice(`Updated. Backup written to ${res.backupPath}. Restart Claude Code to pick it up.`, 'info')
          else setNotice('Updated. Restart Claude Code to pick it up.', 'info')
          await reloadSettings()
          render()
        },
      },
    ],
  })
}

function claudePanel() {
  const claude = state.claude
  if (!claude) return el('div', { class: 'panel' }, [el('h2', { text: 'Claude Code' }), el('p', { class: 'muted', text: 'loading…' })])

  const account = claude.account ?? {}
  const accountLine = account.loggedIn === true
    ? 'A Claude Code login was detected, so your subscription can be used through the gateway with a passthrough provider.'
    : account.loggedIn === null
      ? 'Login state is stored in the macOS Keychain and cannot be checked from here.'
      : 'No Claude Code login detected. The gateway will use your configured provider keys only.'

  const rows = [
    el('div', { class: 'row between' }, [
      el('div', {}, [
        el('h2', { text: 'Claude Code wiring' }),
        el('p', { class: 'muted mono', text: claude.path }),
      ]),
      el('span', {
        class: claude.routed ? 'tag ok' : 'tag',
        text: claude.routed ? 'routed through gateway' : 'direct to Anthropic',
      }),
    ]),
    el('p', { class: 'muted', text: accountLine }),
  ]

  if (claude.parseError) {
    rows.push(el('div', { class: 'notice bad', text: `settings.json is not valid JSON (${claude.parseError}). Fix it before changing the wiring.` }))
  }
  if (claude.routedElsewhere) {
    rows.push(el('div', { class: 'notice', text: `ANTHROPIC_BASE_URL points at ${claude.baseUrl}, a local address that is not this gateway's port.` }))
  }
  if (claude.foreignBaseUrl) {
    rows.push(el('div', { class: 'notice', text: `ANTHROPIC_BASE_URL points at ${claude.baseUrl}, which this app did not set. Routing on will replace it.` }))
  }
  if (claude.routed && (claude.hasAuthToken || claude.hasApiKey) && !claude.authTokenIsOurs) {
    rows.push(el('div', { class: 'notice', text:
      'A gateway credential is set in settings.json, which overrides your Claude subscription. Remove ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY if you want the passthrough provider to use your plan.' }))
  }

  rows.push(el('div', { class: 'row' }, [
    el('button', {
      class: 'btn primary', text: claude.routed ? 'Turn routing off' : 'Turn routing on',
      disabled: Boolean(claude.parseError),
      onClick: () => wiringDialog(!claude.routed),
    }),
    el('span', { class: 'muted', text: `Expected value: ${claude.expectedBaseUrl}` }),
  ]))

  return el('div', { class: 'panel' }, rows)
}

function gatewayPanel() {
  const settings = state.settings
  if (!settings) return el('div', { class: 'panel' }, [el('h2', { text: 'Gateway' })])

  const strategySelect = el('select', {}, settings.strategies.map((s) =>
    el('option', { value: s, text: s, selected: s === settings.strategy })))
  strategySelect.addEventListener('change', async () => {
    const res = await window.gw.settings.update({ strategy: strategySelect.value })
    setNotice(res.ok ? `Strategy set to ${strategySelect.value}; the gateway was restarted to apply it.` : res.error, res.ok ? 'info' : 'error')
    await reloadSettings()
    render()
  })

  const logSelect = el('select', {}, settings.logLevels.map((s) =>
    el('option', { value: s, text: s, selected: s === settings.logLevel })))
  logSelect.addEventListener('change', async () => {
    const res = await window.gw.settings.update({ logLevel: logSelect.value })
    setNotice(res.ok ? `Log level set to ${logSelect.value}; the gateway was restarted.` : res.error, res.ok ? 'info' : 'error')
    await reloadSettings()
    render()
  })

  const portInput = el('input', { type: 'number', min: '1024', max: '65535', value: String(settings.port), class: 'narrow' })

  return el('div', { class: 'panel' }, [
    el('h2', { text: 'Gateway' }),
    el('p', { class: 'muted', text:
      `Bound to 127.0.0.1 only. Providers file: ${settings.providersPath}` }),
    el('div', { class: 'row' }, [
      el('div', {}, [el('div', { class: 'muted', text: 'Port' }), portInput]),
      el('button', {
        class: 'btn', text: 'Apply port',
        onClick: async () => {
          const res = await window.gw.gateway.usePort(Number(portInput.value))
          setNotice(res.ok
            ? `Gateway moved to port ${res.port}. Claude Code's settings.json was updated to match if it was routed here.`
            : res.error, res.ok ? 'info' : 'error')
          await reloadSettings()
          render()
        },
      }),
      el('div', {}, [el('div', { class: 'muted', text: 'Strategy' }), strategySelect]),
      el('div', {}, [el('div', { class: 'muted', text: 'Log level' }), logSelect]),
    ]),
    el('p', { class: 'muted', text:
      'Changing the port rewrites ~/.claude/settings.json when routing is on, because the port is stored there as a literal value.' }),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn', text: 'Restart gateway', onClick: () => window.gw.gateway.restart() }),
      el('button', { class: 'btn', text: 'Open gateway log', onClick: () => window.gw.shell.openLog() }),
      el('span', { class: 'muted mono', text: settings.logPath }),
    ]),
  ])
}

function autostartPanel() {
  const auto = state.settings?.autostart
  if (!auto) return null

  if (!auto.supported) {
    return el('div', { class: 'panel' }, [
      el('h2', { text: 'Start on login' }),
      el('p', { class: 'muted', text: auto.reason ?? 'Not supported on this platform.' }),
    ])
  }

  return el('div', { class: 'panel' }, [
    el('h2', { text: 'Start on login' }),
    el('p', { class: 'muted', text:
      'Writes an XDG autostart entry so the gateway is running before you open a terminal.' }),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'btn', text: auto.enabled ? 'Disable' : 'Enable',
        onClick: async () => {
          await window.gw.settings.setAutostart(!auto.enabled)
          await reloadSettings()
          render()
        },
      }),
      el('span', { class: auto.enabled ? 'tag ok' : 'tag', text: auto.enabled ? 'enabled' : 'disabled' }),
      auto.path ? el('span', { class: 'muted mono', text: auto.path }) : null,
    ]),
  ])
}

function statusPanel() {
  const g = state.gateway
  return el('div', { class: 'panel' }, [
    el('h2', { text: 'Status' }),
    el('div', { class: 'tiles' }, [
      el('div', { class: 'tile' }, [
        el('div', { class: 'k', text: 'Gateway' }),
        el('div', { class: 'v', text: g.status }),
        g.detail ? el('div', { class: 'muted', text: g.detail }) : null,
      ]),
      el('div', { class: 'tile' }, [
        el('div', { class: 'k', text: 'Address' }),
        el('div', { class: 'v', text: `127.0.0.1:${g.port ?? '—'}` }),
      ]),
      el('div', { class: 'tile' }, [
        el('div', { class: 'k', text: 'Uptime pid' }),
        el('div', { class: 'v', text: g.pid ? String(g.pid) : '—' }),
      ]),
      el('div', { class: 'tile' }, [
        el('div', { class: 'k', text: 'Latency p95' }),
        el('div', { class: 'v', text: fmt.ms(state.stats?.latency?.p95) }),
      ]),
    ]),
  ])
}

export function render() {
  const root = document.getElementById('view-settings')
  replace(root, [
    notice ? el('div', { class: `notice ${notice.kind === 'error' ? 'bad' : 'info'}`, text: notice.text }) : null,
    statusPanel(),
    claudePanel(),
    gatewayPanel(),
    autostartPanel(),
  ])
}
