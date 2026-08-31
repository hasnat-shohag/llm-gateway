'use strict'
/**
 * HTTP client for the gateway's existing read-only endpoints.
 *
 * Lives in the main process so the renderer never makes a network request — that
 * is what lets the renderer CSP be `connect-src 'none'` and keeps CORS entirely
 * out of the picture.
 */
const settingsStore = require('./settings-store.js')

const DEFAULT_TIMEOUT_MS = 4000
/** Range/history queries are memoized briefly: the gateway's SQLite calls are
 *  synchronous and share its event loop with proxied Claude Code requests. */
const CACHE_TTL_MS = 2000

const cache = new Map()

function baseUrl() {
  return `http://127.0.0.1:${settingsStore.get().port}`
}

async function getJson(path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      return { ok: false, status: res.status, error: `gateway returned HTTP ${res.status}` }
    }
    return { ok: true, status: res.status, data: await res.json() }
  } catch (err) {
    // ECONNREFUSED while the gateway is starting or down is the common case, so
    // this is an expected result rather than an exceptional one.
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'gateway timed out' : 'gateway unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

async function getText(path, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl()}${path}`, { signal: controller.signal })
    if (!res.ok) return { ok: false, error: `gateway returned HTTP ${res.status}` }
    return { ok: true, text: await res.text() }
  } catch {
    return { ok: false, error: 'gateway unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

async function cached(key, fn) {
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value
  const value = await fn()
  cache.set(key, { at: now, value })
  return value
}

const health = () => getJson('/health', { timeoutMs: 1500 })
const stats = () => getJson('/stats')
const enabledProviders = () => getJson('/providers')
const usage = (limit = 50) => cached(`usage:${limit}`, () => getJson(`/usage?limit=${encodeURIComponent(limit)}`))
const dailyCost = (date) => cached(`cost:${date ?? 'today'}`, () =>
  getJson(date ? `/usage/cost/${encodeURIComponent(date)}` : '/usage/cost'))
const exportCsv = (date) => getText(`/usage/export?date=${encodeURIComponent(date)}`)

function invalidateCache() {
  cache.clear()
}

module.exports = { baseUrl, health, stats, enabledProviders, usage, dailyCost, exportCsv, invalidateCache }
