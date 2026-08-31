'use strict'
/**
 * App entry: window, tray, and the gateway supervisor's lifecycle.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, protocol, net } = require('electron')
const { join, normalize, sep } = require('node:path')
const { pathToFileURL } = require('node:url')
const supervisor = require('./supervisor.js')
const gatewayClient = require('./gateway-client.js')
const claudeSettings = require('./claude-settings.js')
const settingsStore = require('./settings-store.js')
const ipc = require('./ipc.js')
const paths = require('./paths.js')

// Two instances would fight over the port and the SQLite WAL.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  return
}

/**
 * Ozone platform note (Linux).
 *
 * Electron's Wayland backend segfaults on window creation under GNOME/mutter here:
 * `new BrowserWindow()` dies with SIGSEGV before `ready-to-show`, so the app never
 * appears and there is nothing to debug from the UI. Xwayland is stable, and the
 * tray works either way.
 *
 * The fix has to be a real command-line argument — `--ozone-platform=x11` — because
 * Ozone is selected during Electron's own startup, before this file runs:
 * `app.commandLine.appendSwitch('ozone-platform', …)` is silently too late, and
 * neither `--ozone-platform-hint=x11` nor `ELECTRON_OZONE_PLATFORM_HINT=x11` avoids
 * the crash (all three were measured). So the flag lives in two places instead:
 * the `start` script in package.json, and `linux.executableArgs` in
 * electron-builder.yml for packaged builds. Passing `--ozone-platform=wayland`
 * after it opts back into native Wayland.
 */

/**
 * The renderer is served over a custom `app://` scheme rather than `file://`.
 * Chromium gives file:// pages an opaque origin, which blocks ES module imports
 * outright; a privileged standard scheme gives the page a real origin so
 * `<script type="module">` and a `'self'`-based CSP both work.
 * Must be declared before `ready`.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const RENDERER_DIR = join(__dirname, '..', 'renderer')
const APP_INDEX = 'app://bundle/index.html'

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    if (url.host !== 'bundle') return new Response('not found', { status: 404 })

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const resolved = normalize(join(RENDERER_DIR, relative || 'index.html'))
    // Containment check: nothing outside renderer/ can ever be served, so a
    // crafted path cannot read the rest of the app or the user's disk.
    if (resolved !== RENDERER_DIR && !resolved.startsWith(RENDERER_DIR + sep)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(resolved).toString())
  })
}

let mainWindow = null
let tray = null
let quitting = false
let trayTimer = null
let lastTodayCost = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#12141a',
    title: 'LLM Gateway',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      // The renderer needs none of these; it talks to main over IPC only.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  })

  mainWindow.loadURL(APP_INDEX)
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Nothing in this app should ever open a second window or navigate away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://bundle/')) event.preventDefault()
  })

  // Closing the window hides to tray; only an explicit quit exits.
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow.hide()
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

function showWindow() {
  if (!mainWindow) createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function trayIcon() {
  // A tiny generated icon keeps the app dependency-free; electron-builder supplies
  // the real one for packaged builds via build-resources/.
  const size = 16
  const buffer = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = Math.floor(i / size)
    const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1
    const band = y >= 6 && y <= 9
    const on = edge || band
    buffer[i * 4 + 0] = on ? 0x6a : 0x00
    buffer[i * 4 + 1] = on ? 0xd0 : 0x00
    buffer[i * 4 + 2] = on ? 0xa8 : 0x00
    buffer[i * 4 + 3] = on ? 0xff : 0x00
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size })
}

function statusLabel(state) {
  switch (state.status) {
    case 'running':     return `Gateway: running on 127.0.0.1:${state.port}`
    case 'starting':    return 'Gateway: starting…'
    case 'port-in-use': return `Gateway: port ${state.port} in use`
    case 'crashed':     return 'Gateway: restarting after a crash'
    default:            return 'Gateway: stopped'
  }
}

function buildTrayMenu() {
  const state = supervisor.currentState()
  const wiring = claudeSettings.status()

  return Menu.buildFromTemplate([
    { label: statusLabel(state), enabled: false },
    {
      label: lastTodayCost === null ? 'Today: —' : `Today: $${lastTodayCost.toFixed(4)}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Open manager', click: showWindow },
    {
      label: wiring.routed ? 'Claude Code: routed through gateway' : 'Claude Code: direct to Anthropic',
      click: () => {
        claudeSettings.apply(!wiring.routed)
        refreshTray()
        mainWindow?.webContents.send('gateway:state-changed', supervisor.currentState())
      },
    },
    { label: 'Restart gateway', click: () => supervisor.restart() },
    { label: 'Open gateway log', click: () => shell.openPath(paths.gatewayLogPath()) },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
}

function refreshTray() {
  if (!tray) return
  const state = supervisor.currentState()
  // On Linux, mutating an existing MenuItem has no effect — the whole menu has to
  // be set again. setToolTip is also unreliable there (libayatana-appindicator has
  // no tooltip property), so the status lives in the menu labels.
  tray.setContextMenu(buildTrayMenu())
  tray.setToolTip(`LLM Gateway — ${statusLabel(state)}`)
}

async function pollTodayCost() {
  const res = await gatewayClient.dailyCost()
  if (res.ok && typeof res.data?.totalCostUsd === 'number') {
    lastTodayCost = res.data.totalCostUsd
  } else if (!res.ok) {
    lastTodayCost = null
  }
  refreshTray()
}

app.on('second-instance', () => showWindow())

// Subscribing at all is what stops Electron quitting when the window closes.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  registerAppProtocol()
  paths.ensureProvidersFile()
  ipc.register()

  supervisor.onStateChange((state) => {
    refreshTray()
    mainWindow?.webContents.send('gateway:state-changed', state)
  })

  createWindow()

  tray = new Tray(trayIcon())
  refreshTray()
  tray.on('click', showWindow)

  await supervisor.start()

  pollTodayCost()
  trayTimer = setInterval(pollTodayCost, Math.max(settingsStore.get().pollMs, 5000))
})

app.on('before-quit', (event) => {
  if (quitting && !supervisor.currentState().pid) return
  quitting = true
  event.preventDefault()
  if (trayTimer) clearInterval(trayTimer)
  // SIGTERM lets the gateway close SQLite cleanly via its own signal handler.
  supervisor.shutdown().finally(() => app.quit())
})
