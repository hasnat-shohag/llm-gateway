'use strict'
/**
 * Wires Claude Code to the local gateway by editing ~/.claude/settings.json.
 *
 * Rules that shape this file:
 *  - MERGE, never replace. That file also holds permissions, hooks and MCP config.
 *  - Back up before every write.
 *  - Only ever touch the two keys we own, and only remove a key if it still holds
 *    the value we wrote (so a hand-edited value is never silently discarded).
 *  - Do NOT set a gateway credential when the claude.ai subscription is what the
 *    gateway relays — that is, when a login exists AND an enabled `passthrough`
 *    provider can use it. The absence of ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
 *    is exactly what keeps the subscription as the active credential.
 *
 *    A login on its own is not enough to withhold the credential. Claude Code
 *    pointed at a custom ANTHROPIC_BASE_URL with nothing in env falls back to its
 *    OAuth login flow, so with no passthrough provider enabled, withholding the
 *    placeholder buys nothing and costs the user a login prompt on every new
 *    session.
 *
 * Claude Code reads settings at startup, so a change never affects a running
 * session — the UI has to say so.
 */
const { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } = require('node:fs')
const { dirname } = require('node:path')
const { claudeSettingsPath } = require('./paths.js')
const settingsStore = require('./settings-store.js')
const claudeAccount = require('./claude-account.js')
const providersStore = require('./providers-store.js')

const BASE_URL_KEY = 'ANTHROPIC_BASE_URL'
const AUTH_TOKEN_KEY = 'ANTHROPIC_AUTH_TOKEN'
const API_KEY_KEY = 'ANTHROPIC_API_KEY'
/** Recognizably ours, so "route off" knows it is safe to remove. */
const PLACEHOLDER_TOKEN = 'llm-gateway-local'

function gatewayUrl(port = settingsStore.get().port) {
  return `http://127.0.0.1:${port}`
}

function isOurBaseUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const host = new URL(value).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

function read() {
  const path = claudeSettingsPath()
  if (!existsSync(path)) {
    return { exists: false, path, parsed: {}, parseError: null }
  }
  const raw = readFileSync(path, 'utf-8')
  try {
    const parsed = JSON.parse(raw)
    return { exists: true, path, parsed: parsed && typeof parsed === 'object' ? parsed : {}, parseError: null }
  } catch (err) {
    // Refuse to write over something we cannot understand.
    return { exists: true, path, parsed: {}, parseError: err.message }
  }
}

/**
 * Is the claude.ai subscription the credential the gateway relays?
 *
 * Both halves are required: a login to relay, and an enabled `passthrough` provider
 * to relay it through. `loggedIn` is `null` on macOS (Keychain, unreadable), which
 * counts as "maybe" and is treated as a login.
 */
function usesSubscription(account = claudeAccount.detect()) {
  return account.loggedIn !== false && providersStore.hasEnabledPassthrough()
}

/** Current wiring status, for the toggle and the tray label. */
function status() {
  const file = read()
  const env = (file.parsed && file.parsed.env) || {}
  const account = claudeAccount.detect()
  const expected = gatewayUrl()

  const baseUrl = env[BASE_URL_KEY]
  return {
    path: file.path,
    exists: file.exists,
    parseError: file.parseError,
    routed: baseUrl === expected,
    baseUrl: baseUrl ?? null,
    /** Points at a local gateway, but a different port than ours. */
    routedElsewhere: isOurBaseUrl(baseUrl) && baseUrl !== expected,
    /** A base URL we did not write and cannot claim (e.g. a corporate gateway). */
    foreignBaseUrl: typeof baseUrl === 'string' && !isOurBaseUrl(baseUrl),
    hasAuthToken: typeof env[AUTH_TOKEN_KEY] === 'string',
    authTokenIsOurs: env[AUTH_TOKEN_KEY] === PLACEHOLDER_TOKEN,
    hasApiKey: typeof env[API_KEY_KEY] === 'string',
    expectedBaseUrl: expected,
    account,
    passthroughEnabled: providersStore.hasEnabledPassthrough(),
    /** When true, a credential in env would break the passthrough provider. */
    subscriptionInUse: usesSubscription(account),
  }
}

/**
 * Compute the next settings object without writing it.
 *
 * `route: true`  → point Claude Code at the gateway.
 * `route: false` → remove our keys and go back to talking to Anthropic directly.
 */
function plan(route) {
  const file = read()
  if (file.parseError) {
    return { ok: false, error: `~/.claude/settings.json is not valid JSON (${file.parseError}) — fix it first` }
  }

  const next = { ...file.parsed }
  const env = { ...(next.env && typeof next.env === 'object' ? next.env : {}) }
  const before = { ...env }
  const account = claudeAccount.detect()
  const changes = []
  const warnings = []

  if (route) {
    const url = gatewayUrl()
    if (env[BASE_URL_KEY] !== url) {
      if (typeof env[BASE_URL_KEY] === 'string' && !isOurBaseUrl(env[BASE_URL_KEY])) {
        warnings.push(`${BASE_URL_KEY} currently points at ${env[BASE_URL_KEY]} and will be replaced.`)
      }
      changes.push({ key: BASE_URL_KEY, from: env[BASE_URL_KEY] ?? null, to: url })
      env[BASE_URL_KEY] = url
    }

    // Only withhold a credential when the subscription is actually the thing being
    // relayed. Otherwise Claude Code sees a custom base URL with nothing to
    // authenticate with and runs its login flow instead of using the gateway.
    if (usesSubscription(account)) {
      if (env[AUTH_TOKEN_KEY] === PLACEHOLDER_TOKEN) {
        changes.push({ key: AUTH_TOKEN_KEY, from: PLACEHOLDER_TOKEN, to: null })
        delete env[AUTH_TOKEN_KEY]
      }
      if (env[AUTH_TOKEN_KEY] || env[API_KEY_KEY]) {
        warnings.push(`${env[AUTH_TOKEN_KEY] ? AUTH_TOKEN_KEY : API_KEY_KEY} is set, which overrides your Claude subscription. Remove it if you want the "Claude Official" passthrough provider to work.`)
      }
    } else {
      const existing = env[AUTH_TOKEN_KEY] ? AUTH_TOKEN_KEY : env[API_KEY_KEY] ? API_KEY_KEY : null
      if (!existing) {
        changes.push({ key: AUTH_TOKEN_KEY, from: null, to: PLACEHOLDER_TOKEN })
        env[AUTH_TOKEN_KEY] = PLACEHOLDER_TOKEN
      }

      const reason = account.loggedIn === false
        ? 'No Claude Code login was detected'
        : 'No enabled passthrough provider can use your Claude subscription'
      warnings.push(existing
        ? `${reason}, and ${existing} is already set — leaving it as it is. Its value does not matter: the gateway replaces it with the chosen provider's own key.`
        : `${reason}, so a placeholder ${AUTH_TOKEN_KEY} is written. Without a credential here Claude Code prompts for a login instead of using the gateway. The placeholder is never sent upstream; the gateway injects each provider's real key.`)
    }
  } else {
    if (isOurBaseUrl(env[BASE_URL_KEY])) {
      changes.push({ key: BASE_URL_KEY, from: env[BASE_URL_KEY], to: null })
      delete env[BASE_URL_KEY]
    } else if (typeof env[BASE_URL_KEY] === 'string') {
      warnings.push(`${BASE_URL_KEY} is ${env[BASE_URL_KEY]}, which this app did not set — leaving it alone.`)
    }
    if (env[AUTH_TOKEN_KEY] === PLACEHOLDER_TOKEN) {
      changes.push({ key: AUTH_TOKEN_KEY, from: PLACEHOLDER_TOKEN, to: null })
      delete env[AUTH_TOKEN_KEY]
    }
  }

  if (Object.keys(env).length > 0) next.env = env
  else delete next.env

  return {
    ok: true,
    changes,
    warnings,
    before,
    after: env,
    preservedKeys: Object.keys(file.parsed).filter((k) => k !== 'env'),
    text: `${JSON.stringify(next, null, 2)}\n`,
    path: file.path,
    exists: file.exists,
  }
}

/** Write the planned change, backing up any existing file first. */
function apply(route) {
  const planned = plan(route)
  if (!planned.ok) return planned
  if (planned.changes.length === 0) {
    return { ok: true, changed: false, warnings: planned.warnings, status: status() }
  }

  const path = planned.path
  mkdirSync(dirname(path), { recursive: true })

  let backupPath = null
  if (planned.exists) {
    backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(path, backupPath)
  }

  // Unlike providers.json, nothing of ours watches this file's inode, and Claude
  // Code only reads it at startup — so a plain write is fine here.
  writeFileSync(path, planned.text)

  return {
    ok: true,
    changed: true,
    backupPath,
    changes: planned.changes,
    warnings: planned.warnings,
    status: status(),
  }
}

module.exports = {
  status, plan, apply, gatewayUrl, usesSubscription,
  PLACEHOLDER_TOKEN, BASE_URL_KEY, AUTH_TOKEN_KEY, API_KEY_KEY,
}
