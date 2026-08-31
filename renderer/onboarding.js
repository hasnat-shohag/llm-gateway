/**
 * First-run guide.
 *
 * Owns the whole content area while `settings.setupCompleted` is false, because
 * the app is useless until Claude Code actually points at the gateway — three
 * facts the user has to establish, in an order where each one's outcome changes
 * the next. A wizard would hide the state; this shows all three at once and
 * marks off the ones already true.
 *
 * Every step is derived from live state, never from a stored cursor: install the
 * app with a provider already in providers.json and step 2 is done on arrival.
 */
import { el, replace, button, notice, fmt } from './dom.js'
import { icon } from './icons.js'
import { state, reloadSettings, emit } from './store.js'
import { addProviderDialog } from './providers.js'
import { wiringDialog } from './settings.js'

async function finish() {
  await window.gw.settings.update({ setupCompleted: true })
  await reloadSettings()
  // app.js's subscriber notices setupCompleted and hands the content area back to
  // the tabs — no cross-import between the two views.
  emit()
}

function stepNode({ index, title, body, done, active, actions = [] }) {
  return el('div', { class: `step${done ? ' done' : ''}${active ? ' active' : ''}` }, [
    el('div', { class: 'marker' }, [done ? icon('check', { size: 11, stroke: 2 }) : el('span', { text: String(index) })]),
    el('div', { class: 'body' }, [
      el('h3', { text: title }),
      el('p', { text: body }),
      actions.length ? el('div', { class: 'row' }, actions) : null,
    ]),
  ])
}

function gatewayStep() {
  const g = state.gateway
  const running = g.status === 'running'

  if (g.status === 'port-in-use') {
    return stepNode({
      index: 1,
      title: `Port ${g.port} is taken`,
      body: 'Another process is already listening there — often a gateway you started from a terminal. Move this one to a free port, or stop the other and restart.',
      active: true,
      actions: [
        button({
          label: 'Move to the next free port', text: 'Move to the next free port', kind: 'primary',
          onClick: async () => {
            const { port } = await window.gw.gateway.suggestPort()
            if (port) await window.gw.gateway.usePort(port)
            await reloadSettings()
            emit()
          },
        }),
      ],
    })
  }

  return stepNode({
    index: 1,
    title: running ? `Gateway running on 127.0.0.1:${g.port}` : 'Starting the gateway',
    body: running
      ? 'Bound to loopback only, and supervised — if it exits, it is restarted with backoff.'
      : 'The supervisor is forking the gateway process. This takes a moment on first launch.',
    done: running,
    active: !running,
    actions: running ? [] : [
      button({ label: 'Open gateway log', text: 'Open log', icon: 'fileText', onClick: () => window.gw.shell.openLog() }),
    ],
  })
}

function providerStep() {
  const count = state.providers.length
  const eligible = state.enabledNames.length
  const loggedIn = state.claude?.account?.loggedIn === true
  const hasPassthrough = state.providers.some((p) => p.authStyle === 'passthrough')

  const actions = [
    button({
      label: 'Add a provider', text: count ? 'Add another' : 'Add a provider', icon: 'plus',
      kind: count ? '' : 'primary',
      onClick: () => addProviderDialog(),
    }),
  ]

  if (loggedIn && !hasPassthrough) {
    actions.push(button({
      label: 'Add your Claude subscription', text: 'Use my Claude subscription', icon: 'shield',
      onClick: () => addProviderDialog({ passthrough: true }),
    }))
  }

  return stepNode({
    index: 2,
    title: count
      ? `${count} ${count === 1 ? 'provider' : 'providers'} configured · ${eligible} eligible`
      : 'Add at least one provider',
    body: count
      ? 'The gateway watches providers.json, so edits apply to the next request without a restart.'
      : 'A provider is an Anthropic-compatible base URL plus its key. The gateway load-balances across the enabled ones and fails over when one starts erroring.',
    done: count > 0,
    active: count === 0 && state.gateway.status === 'running',
    actions,
  })
}

function wiringStep() {
  const claude = state.claude
  const routed = Boolean(claude?.routed)
  const ready = state.providers.length > 0

  return stepNode({
    index: 3,
    title: routed ? 'Claude Code routed through the gateway' : 'Point Claude Code at the gateway',
    body: routed
      ? 'Two keys in ~/.claude/settings.json now point at this gateway. Restart any running Claude Code session to pick it up.'
      : 'This sets ANTHROPIC_BASE_URL in ~/.claude/settings.json and leaves every other key — permissions, hooks, MCP — untouched. You see the exact diff before anything is written, and the old file is backed up.',
    done: routed,
    active: !routed && ready,
    actions: routed ? [
      button({ label: 'Turn routing off', text: 'Turn routing off', onClick: () => wiringDialog(false) }),
    ] : [
      button({
        label: 'Review the change', text: 'Review the change', icon: 'plug',
        kind: 'primary', disabled: !ready || Boolean(claude?.parseError),
        onClick: () => wiringDialog(true),
      }),
    ],
  })
}

export function render() {
  const root = document.getElementById('view-onboarding')
  const claude = state.claude
  const allDone = state.gateway.status === 'running' && state.providers.length > 0 && Boolean(claude?.routed)
  const today = state.usage?.today

  replace(root, [
    el('div', { class: 'onboarding' }, [
      el('div', { class: 'onboarding-head' }, [
        el('h2', { text: allDone ? 'Everything is wired up' : 'Three things to set up' }),
        el('p', {
          text: allDone
            ? 'Claude Code is talking to the local gateway, which is load-balancing across your providers and recording what each request costs.'
            : 'This app supervises a local proxy that spreads Claude Code\'s requests across several providers and records what they cost. It needs a provider and one line in your Claude Code config.',
        }),
      ]),

      claude?.parseError
        ? notice('bad', `~/.claude/settings.json is not valid JSON (${claude.parseError}). Fix that file before step 3 — the app will not overwrite a file it cannot parse.`)
        : null,

      el('div', { class: 'steps' }, [gatewayStep(), providerStep(), wiringStep()]),

      allDone && today
        ? notice('good', `Recording usage already — ${fmt.int(today.totalCalls ?? 0)} calls and ${fmt.usd(today.totalCostUsd ?? 0)} so far today.`)
        : null,

      el('div', { class: 'row between' }, [
        button({
          label: allDone ? 'Open the manager' : 'Skip for now',
          text: allDone ? 'Open the manager' : 'Skip for now',
          icon: allDone ? 'arrowRight' : undefined,
          kind: allDone ? 'primary' : 'quiet',
          size: 'big',
          onClick: finish,
        }),
        el('span', { class: 'subtle', text: 'You can come back to all of this in Setup.' }),
      ]),
    ]),
  ])
}
