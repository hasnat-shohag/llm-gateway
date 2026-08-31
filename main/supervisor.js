'use strict'
/**
 * Runs the gateway as an Electron utilityProcess.
 *
 * utilityProcess.fork is Electron's recommended way to host a standalone Node
 * service (the fuses doc names "a SQLite server process" as the example). The
 * isolation matters here specifically: the gateway calls process.exit(1) on a bad
 * providers.json, on a failed listen, and on an unexpected uncaughtException. In
 * the main process that would take the whole app down; as a child it just
 * restarts, and the tray can explain why.
 */
const { app, utilityProcess } = require('electron')
const net = require('node:net')
const { createWriteStream, statSync, renameSync, existsSync } = require('node:fs')
const { gatewayEntry, gatewayLogPath, providersPath, userDataDir, ensureProvidersFile } = require('./paths.js')
const settingsStore = require('./settings-store.js')
const { join } = require('node:path')

const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 30_000
const LOG_MAX_BYTES = 2 * 1024 * 1024

let child = null
let logStream = null
let quitting = false
let backoffMs = BACKOFF_MIN_MS
let restartTimer = null
/** 'stopped' | 'starting' | 'running' | 'port-in-use' | 'crashed' | 'error' */
let status = 'stopped'
let detail = ''
let lastExitCode = null
const listeners = new Set()

function currentState() {
  return {
    status,
    detail,
    port: settingsStore.get().port,
    pid: child?.pid ?? null,
    lastExitCode,
  }
}

function setStatus(next, nextDetail = '') {
  status = next
  detail = nextDetail
  const state = currentState()
  for (const fn of listeners) {
    try {
      fn(state)
    } catch {
      // A listener throwing must not take the supervisor down.
    }
  }
}

function onStateChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function rotateLogIfNeeded(path) {
  try {
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`)
    }
  } catch {
    // Rotation is best-effort; never block startup on it.
  }
}

function openLog() {
  const path = gatewayLogPath()
  rotateLogIfNeeded(path)
  logStream = createWriteStream(path, { flags: 'a' })
  logStream.on('error', () => { logStream = null })
}

function writeLog(chunk) {
  if (!logStream) return
  logStream.write(chunk)
}

/**
 * Is the port free?
 *
 * `exclusive: true` is load-bearing — Node sets SO_REUSEADDR by default, and
 * without exclusive the probe can succeed against a port that is already serving,
 * so we would fork into a restart loop instead of reporting the conflict.
 */
function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => resolve(err.code || 'EADDRINUSE'))
    server.once('listening', () => server.close(() => resolve(null)))
    server.listen({ port, host, exclusive: true })
  })
}

/** Find the next free port at or after `from`, so the UI can offer a one-click fix. */
async function findFreePort(from, attempts = 20) {
  for (let port = from; port < from + attempts && port < 65536; port++) {
    if ((await probePort(port)) === null) return port
  }
  return null
}

function buildEnv() {
  const settings = settingsStore.get()
  return {
    ...process.env,
    NODE_ENV: 'production',
    // Loopback only: the gateway holds plaintext provider keys and proxies
    // anything that reaches it.
    HOST: '127.0.0.1',
    PORT: String(settings.port),
    PROVIDERS_PATH: providersPath(),
    USAGE_DB_PATH: join(userDataDir(), 'usage.db'),
    STRATEGY: settings.strategy,
    LOG_LEVEL: settings.logLevel,
  }
}

async function start() {
  if (child || quitting) return currentState()
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }

  ensureProvidersFile()
  if (!logStream) openLog()

  const { port } = settingsStore.get()
  const portError = await probePort(port)
  if (portError !== null) {
    const message = portError === 'EACCES'
      ? `port ${port} needs elevated privileges — pick a port above 1023`
      : `port ${port} is already in use — another copy of the gateway, or another app`
    writeLog(`[supervisor] ${message}\n`)
    // Deliberately no restart: retrying cannot free the port, and a loop would
    // just spin. The UI offers "use the next free port" instead.
    setStatus('port-in-use', message)
    return currentState()
  }

  setStatus('starting')

  const entry = gatewayEntry()
  child = utilityProcess.fork(entry, [], {
    serviceName: 'LLM Gateway',
    stdio: 'pipe',
    cwd: userDataDir(),
    env: buildEnv(),
  })

  child.stdout?.on('data', (d) => writeLog(d))
  child.stderr?.on('data', (d) => writeLog(d))

  child.once('spawn', () => {
    backoffMs = BACKOFF_MIN_MS
    setStatus('running')
    writeLog(`[supervisor] gateway started on 127.0.0.1:${port}\n`)
  })

  child.once('exit', (code) => {
    child = null
    lastExitCode = code
    if (quitting) {
      setStatus('stopped')
      return
    }
    writeLog(`[supervisor] gateway exited with code ${code}; restarting in ${backoffMs}ms\n`)
    setStatus('crashed', `gateway exited with code ${code} — restarting`)
    restartTimer = setTimeout(() => {
      restartTimer = null
      start()
    }, backoffMs)
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
  })

  return currentState()
}

/** Stop the child and wait for it to actually exit (SIGTERM lets it close SQLite). */
function stop({ timeoutMs = 5000 } = {}) {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (!child) {
    setStatus('stopped')
    return Promise.resolve()
  }
  const current = child
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    current.once('exit', finish)
    current.kill()
    setTimeout(finish, timeoutMs)
  })
}

async function restart() {
  backoffMs = BACKOFF_MIN_MS
  await stop()
  return start()
}

/** Called from before-quit; suppresses the restart-on-exit path. */
async function shutdown() {
  quitting = true
  await stop()
  logStream?.end()
  logStream = null
}

app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'Utility' || details.serviceName !== 'LLM Gateway') return
  writeLog(`[supervisor] child-process-gone: reason=${details.reason} exitCode=${details.exitCode}\n`)
})

module.exports = { start, stop, restart, shutdown, onStateChange, currentState, probePort, findFreePort }
