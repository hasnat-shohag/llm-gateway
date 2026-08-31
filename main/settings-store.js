'use strict'
/**
 * App settings, persisted as JSON in userData.
 *
 * `strategy` and `logLevel` are passed to the gateway as env vars at fork time,
 * so changing either needs a gateway restart (which the supervisor can do without
 * restarting the whole app). `port` additionally gets written into
 * ~/.claude/settings.json, so it must be stable across launches — never ephemeral.
 */
const { readFileSync, writeFileSync } = require('node:fs')
const { settingsPath } = require('./paths.js')

const DEFAULTS = {
  port: 8080,
  strategy: 'random',
  logLevel: 'info',
  /** Poll interval for the renderer's live panels, in ms. */
  pollMs: 5000,
  /** Whether the first-run wizard has been dismissed. */
  setupCompleted: false,
}

const STRATEGIES = ['random', 'round-robin', 'weighted']
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

let cache = null

function coerce(raw) {
  const out = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object') return out

  const port = Number(raw.port)
  if (Number.isInteger(port) && port > 0 && port < 65536) out.port = port
  if (STRATEGIES.includes(raw.strategy)) out.strategy = raw.strategy
  if (LOG_LEVELS.includes(raw.logLevel)) out.logLevel = raw.logLevel

  const pollMs = Number(raw.pollMs)
  // Floor of 2s: better-sqlite3 is synchronous and shares the gateway's event
  // loop, so an aggressive dashboard poll would stall proxied requests.
  if (Number.isFinite(pollMs) && pollMs >= 2000) out.pollMs = Math.round(pollMs)
  if (typeof raw.setupCompleted === 'boolean') out.setupCompleted = raw.setupCompleted

  return out
}

function get() {
  if (cache) return { ...cache }
  try {
    cache = coerce(JSON.parse(readFileSync(settingsPath(), 'utf-8')))
  } catch {
    // Missing or corrupt — fall back to defaults rather than blocking startup.
    cache = { ...DEFAULTS }
  }
  return { ...cache }
}

function update(patch) {
  const next = coerce({ ...get(), ...patch })
  writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`)
  cache = next
  return { ...next }
}

module.exports = { get, update, DEFAULTS, STRATEGIES, LOG_LEVELS }
