'use strict'
/**
 * IPC surface. The preload boundary is not a trust boundary, so every payload is
 * re-checked here before it reaches anything that touches the filesystem or the
 * network.
 */
const { ipcMain, dialog, shell, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const providersStore = require('./providers-store.js')
const gatewayClient = require('./gateway-client.js')
const settingsStore = require('./settings-store.js')
const supervisor = require('./supervisor.js')
const claudeSettings = require('./claude-settings.js')
const claudeAccount = require('./claude-account.js')
const probe = require('./provider-probe.js')
const autostart = require('./autostart.js')
const theme = require('./theme.js')
const paths = require('./paths.js')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Shape check only; the real validation is the gateway's zod schema after merge. */
function checkIncomingProviders(input) {
  if (!Array.isArray(input)) return 'expected an array of providers'
  if (input.length > 200) return 'too many providers (limit 200)'
  for (const [i, p] of input.entries()) {
    if (!isPlainObject(p)) return `entry ${i} is not an object`
    if (typeof p.name !== 'string') return `entry ${i}: name must be a string`
    if (typeof p.baseUrl !== 'string') return `entry ${i}: baseUrl must be a string`
    if (typeof p.enabled !== 'boolean') return `entry ${i}: enabled must be a boolean`
    if (!Number.isInteger(p.weight)) return `entry ${i}: weight must be an integer`
    if (p.apiKey !== undefined && typeof p.apiKey !== 'string') return `entry ${i}: apiKey must be a string`
    if (p.authStyle !== undefined && !['x-api-key', 'bearer', 'passthrough'].includes(p.authStyle)) {
      return `entry ${i}: unknown authStyle`
    }
    if (p.sanitize !== undefined && p.sanitize !== null && typeof p.sanitize !== 'boolean') {
      return `entry ${i}: sanitize must be true, false, or null`
    }
    if (p.originalName !== undefined && typeof p.originalName !== 'string') {
      return `entry ${i}: originalName must be a string`
    }
  }
  return null
}

function register() {
  // --- providers ------------------------------------------------------------
  ipcMain.handle('providers:list', async () => providersStore.read())

  ipcMain.handle('providers:save', async (_e, payload) => {
    const providers = payload?.providers
    const shapeError = checkIncomingProviders(providers)
    if (shapeError) return { ok: false, error: shapeError, issues: [] }
    const result = await providersStore.write(providers, { ifMatch: payload?.version })
    if (!result.ok) return result

    gatewayClient.invalidateCache()
    // Enabling or disabling a passthrough provider changes whether the placeholder
    // credential belongs in ~/.claude/settings.json: it has to be there for Claude
    // Code to use the gateway at all, and absent for the subscription to survive.
    // apply() is a no-op when the plan holds no changes, so this only writes when
    // this save actually flipped that.
    let wiring = claudeSettings.status()
    if (wiring.routed) {
      const rewired = claudeSettings.apply(true)
      if (rewired.ok && rewired.changed) {
        return { ...result, rewired: { changes: rewired.changes, backupPath: rewired.backupPath }, wiring: rewired.status }
      }
      if (rewired.ok) wiring = rewired.status
    }
    return { ...result, wiring }
  })

  ipcMain.handle('providers:probe', async (_e, payload) => {
    if (typeof payload?.name !== 'string') return { ok: false, error: 'name is required' }
    const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined
    return probe.run(payload.name, model ? { model } : {})
  })

  // --- gateway (live state) -------------------------------------------------
  ipcMain.handle('gateway:state', async () => supervisor.currentState())
  ipcMain.handle('gateway:health', async () => gatewayClient.health())
  ipcMain.handle('gateway:stats', async () => gatewayClient.stats())
  ipcMain.handle('gateway:enabledNames', async () => gatewayClient.enabledProviders())
  ipcMain.handle('gateway:restart', async () => supervisor.restart())

  ipcMain.handle('gateway:usePort', async (_e, payload) => {
    const port = Number(payload?.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { ok: false, error: 'port must be an integer between 1024 and 65535' }
    }
    const inUse = await supervisor.probePort(port)
    if (inUse !== null) return { ok: false, error: `port ${port} is not available (${inUse})` }
    settingsStore.update({ port })
    gatewayClient.invalidateCache()
    await supervisor.restart()
    // The port is baked into ~/.claude/settings.json, so re-point it if we own it.
    const wiring = claudeSettings.status()
    if (wiring.routedElsewhere || wiring.routed) claudeSettings.apply(true)
    return { ok: true, port, state: supervisor.currentState(), wiring: claudeSettings.status() }
  })

  ipcMain.handle('gateway:suggestPort', async () => {
    const from = settingsStore.get().port + 1
    return { port: await supervisor.findFreePort(from) }
  })

  // --- usage ----------------------------------------------------------------
  ipcMain.handle('usage:summary', async (_e, payload) => {
    const limit = Number(payload?.limit ?? 50)
    return gatewayClient.usage(Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 50)
  })

  ipcMain.handle('usage:cost', async (_e, payload) => {
    const date = payload?.date
    if (date !== undefined && (typeof date !== 'string' || !DATE_RE.test(date))) {
      return { ok: false, error: 'date must be YYYY-MM-DD' }
    }
    return gatewayClient.dailyCost(date)
  })

  ipcMain.handle('usage:export', async (_e, payload) => {
    const date = payload?.date
    if (typeof date !== 'string' || !DATE_RE.test(date)) {
      return { ok: false, error: 'date must be YYYY-MM-DD' }
    }
    const csv = await gatewayClient.exportCsv(date)
    if (!csv.ok) return csv

    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const target = await dialog.showSaveDialog(win, {
      title: 'Export usage CSV',
      defaultPath: `usage-${date}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (target.canceled || !target.filePath) return { ok: false, canceled: true }
    writeFileSync(target.filePath, csv.text)
    return { ok: true, path: target.filePath }
  })

  // --- settings -------------------------------------------------------------
  ipcMain.handle('settings:get', async () => ({
    ...settingsStore.get(),
    strategies: settingsStore.STRATEGIES,
    logLevels: settingsStore.LOG_LEVELS,
    themes: settingsStore.THEMES,
    gatewayUrl: gatewayClient.baseUrl(),
    providersPath: paths.providersPath(),
    logPath: paths.gatewayLogPath(),
    autostart: autostart.status(),
  }))

  ipcMain.handle('settings:update', async (_e, payload) => {
    if (!isPlainObject(payload)) return { ok: false, error: 'expected an object' }
    const patch = {}
    if (payload.strategy !== undefined) {
      if (!settingsStore.STRATEGIES.includes(payload.strategy)) return { ok: false, error: 'unknown strategy' }
      patch.strategy = payload.strategy
    }
    if (payload.logLevel !== undefined) {
      if (!settingsStore.LOG_LEVELS.includes(payload.logLevel)) return { ok: false, error: 'unknown log level' }
      patch.logLevel = payload.logLevel
    }
    if (payload.theme !== undefined) {
      if (!settingsStore.THEMES.includes(payload.theme)) return { ok: false, error: 'unknown theme' }
      patch.theme = payload.theme
    }
    if (payload.pollMs !== undefined) {
      const pollMs = Number(payload.pollMs)
      if (!Number.isFinite(pollMs) || pollMs < 2000) return { ok: false, error: 'pollMs must be at least 2000' }
      patch.pollMs = pollMs
    }
    if (payload.setupCompleted !== undefined) patch.setupCompleted = Boolean(payload.setupCompleted)

    const next = settingsStore.update(patch)
    // A theme change is a main-process concern: it sets nativeTheme.themeSource,
    // which is what the renderer's prefers-color-scheme rules resolve against.
    if (patch.theme !== undefined) theme.apply(next.theme)
    // strategy and logLevel are read from env at fork time, so they only take
    // effect after the gateway process is replaced.
    const needsRestart = patch.strategy !== undefined || patch.logLevel !== undefined
    if (needsRestart) await supervisor.restart()
    return { ok: true, settings: next, restarted: needsRestart }
  })

  ipcMain.handle('settings:setAutostart', async (_e, payload) =>
    ({ ok: true, autostart: autostart.setEnabled(Boolean(payload?.enabled)) }))

  // --- Claude Code wiring ---------------------------------------------------
  ipcMain.handle('claude:status', async () => claudeSettings.status())
  ipcMain.handle('claude:account', async () => claudeAccount.detect())

  ipcMain.handle('claude:plan', async (_e, payload) => claudeSettings.plan(Boolean(payload?.route)))

  ipcMain.handle('claude:apply', async (_e, payload) => claudeSettings.apply(Boolean(payload?.route)))

  // --- window controls ------------------------------------------------------
  // The window is frameless, so the renderer draws the buttons and these are the
  // only way to act on them. `senderFrame` is not consulted: every one of these
  // is scoped to the window that sent it, so a compromised renderer can only ever
  // minimize, maximize or hide its own window.
  const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle('win:minimize', async (event) => {
    senderWindow(event)?.minimize()
    return { ok: true }
  })

  ipcMain.handle('win:toggleMaximize', async (event) => {
    const win = senderWindow(event)
    if (!win) return { ok: false, error: 'no window' }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { ok: true, maximized: win.isMaximized() }
  })

  // Close means hide-to-tray, exactly as the OS button did: the supervisor keeps
  // the gateway running and only an explicit Quit from the tray exits.
  ipcMain.handle('win:close', async (event) => {
    senderWindow(event)?.close()
    return { ok: true }
  })

  ipcMain.handle('win:isMaximized', async (event) => senderWindow(event)?.isMaximized() ?? false)

  // --- misc -----------------------------------------------------------------
  ipcMain.handle('shell:openLog', async () => {
    const err = await shell.openPath(paths.gatewayLogPath())
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle('shell:openExternal', async (_e, payload) => {
    const url = payload?.url
    // Only ever hand https: to the OS browser.
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return { ok: false, error: 'https URLs only' }
    await shell.openExternal(url)
    return { ok: true }
  })
}

module.exports = { register }
