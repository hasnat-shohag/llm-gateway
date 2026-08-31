'use strict'
/**
 * Where everything lives.
 *
 * The gateway resolves providers.json / usage.db / .env relative to its working
 * directory, which is arbitrary in a packaged app. So the app owns explicit
 * absolute paths under userData and hands them to the gateway as env vars.
 * userData is also the only writable place — an asar archive is read-only.
 */
const { app } = require('electron')
const { existsSync, mkdirSync, copyFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { homedir } = require('node:os')

/** Seed used when no existing providers.json can be found to migrate. */
const EMPTY_PROVIDERS = '[]\n'

function userDataDir() {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

function providersPath() {
  return join(userDataDir(), 'providers.json')
}

function providersBackupPath() {
  return `${providersPath()}.bak`
}

function settingsPath() {
  return join(userDataDir(), 'settings.json')
}

function logsDir() {
  const dir = app.getPath('logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

function gatewayLogPath() {
  return join(logsDir(), 'gateway.log')
}

/**
 * Directory holding the compiled gateway.
 *
 * Packaged builds put build/gateway inside the asar under resourcesPath/app.asar,
 * which `app.getAppPath()` already points at; in development it is next to this
 * file's parent. Resolve from app path in both cases rather than guessing `../`
 * counts, which differ between the two layouts.
 */
function gatewayEntry() {
  return join(app.getAppPath(), 'build', 'gateway', 'index.js')
}

/** `~/.claude`, honoring CLAUDE_CONFIG_DIR the way Claude Code does. */
function claudeDir() {
  const override = process.env.CLAUDE_CONFIG_DIR
  return override && override.trim() ? resolve(override) : join(homedir(), '.claude')
}

function claudeSettingsPath() {
  return join(claudeDir(), 'settings.json')
}

/** Claude Code's OAuth credential store. Presence is checked; contents never read. */
function claudeCredentialsPath() {
  return join(claudeDir(), '.credentials.json')
}

/**
 * Candidate locations to migrate an existing providers.json from, in order.
 * The repo root is the interesting one: someone running the Docker setup already
 * has a curated 16-provider file and should not have to retype it.
 */
function migrationCandidates() {
  const appPath = app.getAppPath()
  return [
    process.env.GATEWAY_PROVIDERS_SEED,
    join(appPath, '..', 'providers.json'),
    join(process.cwd(), 'providers.json'),
  ].filter(Boolean).map((p) => resolve(p))
}

/**
 * Ensure userData/providers.json exists. Returns what happened so the UI can say
 * so on first run rather than silently showing an empty list.
 */
function ensureProvidersFile() {
  const target = providersPath()
  if (existsSync(target)) return { created: false, migratedFrom: null }

  for (const candidate of migrationCandidates()) {
    if (candidate === target) continue
    if (!existsSync(candidate)) continue
    try {
      copyFileSync(candidate, target)
      return { created: true, migratedFrom: candidate }
    } catch {
      // Unreadable candidate — fall through to the next one.
    }
  }

  writeFileSync(target, EMPTY_PROVIDERS)
  return { created: true, migratedFrom: null }
}

module.exports = {
  userDataDir,
  providersPath,
  providersBackupPath,
  settingsPath,
  logsDir,
  gatewayLogPath,
  gatewayEntry,
  claudeDir,
  claudeSettingsPath,
  claudeCredentialsPath,
  ensureProvidersFile,
}
