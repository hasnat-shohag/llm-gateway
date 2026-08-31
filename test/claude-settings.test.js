'use strict'
/**
 * claude-settings.js — the ~/.claude/settings.json merge.
 *
 * CLAUDE_CONFIG_DIR points at the sandbox, which is the same override Claude Code
 * itself honors, so the developer's real settings file is never read or written.
 */
const stub = require('./helpers/electron-stub.js').install()

const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const CLAUDE_DIR = join(stub.root, 'claude')
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR

const paths = require('../main/paths.js')
const claudeSettings = require('../main/claude-settings.js')

const SETTINGS = () => paths.claudeSettingsPath()
const CREDENTIALS = () => paths.claudeCredentialsPath()
const GATEWAY_URL = 'http://127.0.0.1:8080'

function writeSettings(value) {
  mkdirSync(CLAUDE_DIR, { recursive: true })
  writeFileSync(SETTINGS(), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
}

function login(exists) {
  mkdirSync(CLAUDE_DIR, { recursive: true })
  if (exists) writeFileSync(CREDENTIALS(), '{"do":"not read this"}\n')
  else rmSync(CREDENTIALS(), { force: true })
}

beforeEach(() => {
  rmSync(CLAUDE_DIR, { recursive: true, force: true })
  mkdirSync(CLAUDE_DIR, { recursive: true })
})

test('paths resolve inside the sandbox, not the real ~/.claude', () => {
  assert.ok(SETTINGS().startsWith(CLAUDE_DIR))
  assert.equal(claudeSettings.gatewayUrl(), GATEWAY_URL)
})

test('status on a missing settings file reports not-routed', () => {
  login(false)
  const s = claudeSettings.status()
  assert.equal(s.exists, false)
  assert.equal(s.routed, false)
  assert.equal(s.baseUrl, null)
  assert.equal(s.expectedBaseUrl, GATEWAY_URL)
  assert.equal(s.account.loggedIn, false)
})

test('status distinguishes our port, another local port, and a foreign host', () => {
  login(false)

  writeSettings({ env: { ANTHROPIC_BASE_URL: GATEWAY_URL } })
  let s = claudeSettings.status()
  assert.equal(s.routed, true)
  assert.equal(s.routedElsewhere, false)
  assert.equal(s.foreignBaseUrl, false)

  writeSettings({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' } })
  s = claudeSettings.status()
  assert.equal(s.routed, false)
  assert.equal(s.routedElsewhere, true)

  writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://corp-gateway.internal' } })
  s = claudeSettings.status()
  assert.equal(s.routedElsewhere, false)
  assert.equal(s.foreignBaseUrl, true)
})

test('plan(true) with no login adds the base URL and a placeholder token', () => {
  login(false)
  const planned = claudeSettings.plan(true)
  assert.equal(planned.ok, true)
  assert.equal(planned.after.ANTHROPIC_BASE_URL, GATEWAY_URL)
  assert.equal(planned.after.ANTHROPIC_AUTH_TOKEN, claudeSettings.PLACEHOLDER_TOKEN)
  assert.ok(planned.warnings.some((w) => /placeholder/i.test(w)))
})

test('plan(true) with a login never writes a credential', () => {
  login(true)
  const planned = claudeSettings.plan(true)
  assert.equal(planned.ok, true)
  assert.equal(planned.after.ANTHROPIC_BASE_URL, GATEWAY_URL)
  // Setting either key would override the subscription and break passthrough.
  assert.equal('ANTHROPIC_AUTH_TOKEN' in planned.after, false)
  assert.equal('ANTHROPIC_API_KEY' in planned.after, false)
})

test('plan(true) with a login removes a placeholder we previously wrote', () => {
  login(true)
  writeSettings({ env: { ANTHROPIC_BASE_URL: GATEWAY_URL, ANTHROPIC_AUTH_TOKEN: claudeSettings.PLACEHOLDER_TOKEN } })

  const planned = claudeSettings.plan(true)
  assert.equal('ANTHROPIC_AUTH_TOKEN' in planned.after, false)
  assert.deepEqual(planned.changes, [
    { key: 'ANTHROPIC_AUTH_TOKEN', from: claudeSettings.PLACEHOLDER_TOKEN, to: null },
  ])
})

test('plan(true) with a login warns about a hand-set token but keeps it', () => {
  login(true)
  writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-user-supplied' } })

  const planned = claudeSettings.plan(true)
  assert.equal(planned.after.ANTHROPIC_AUTH_TOKEN, 'sk-ant-user-supplied')
  assert.ok(planned.warnings.some((w) => /overrides your Claude subscription/.test(w)))
})

test('plan(true) warns before replacing a foreign base URL', () => {
  login(false)
  writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://corp-gateway.internal' } })

  const planned = claudeSettings.plan(true)
  assert.equal(planned.after.ANTHROPIC_BASE_URL, GATEWAY_URL)
  assert.ok(planned.warnings.some((w) => /corp-gateway\.internal.*will be replaced/.test(w)))
})

test('plan preserves every key it does not own', () => {
  login(false)
  writeSettings({
    permissions: { allow: ['Bash(ls)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    env: { SOME_OTHER_VAR: 'keep me' },
  })

  const planned = claudeSettings.plan(true)
  const next = JSON.parse(planned.text)
  assert.deepEqual(next.permissions, { allow: ['Bash(ls)'] })
  assert.ok(next.hooks.SessionStart)
  assert.equal(next.env.SOME_OTHER_VAR, 'keep me')
  assert.deepEqual(planned.preservedKeys.sort(), ['hooks', 'permissions'])
})

test('plan(false) removes our keys only', () => {
  login(false)
  writeSettings({
    env: {
      ANTHROPIC_BASE_URL: GATEWAY_URL,
      ANTHROPIC_AUTH_TOKEN: claudeSettings.PLACEHOLDER_TOKEN,
      SOME_OTHER_VAR: 'keep me',
    },
  })

  const planned = claudeSettings.plan(false)
  assert.equal('ANTHROPIC_BASE_URL' in planned.after, false)
  assert.equal('ANTHROPIC_AUTH_TOKEN' in planned.after, false)
  assert.equal(planned.after.SOME_OTHER_VAR, 'keep me')
})

test('plan(false) leaves a base URL this app did not set', () => {
  login(false)
  writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://corp-gateway.internal' } })

  const planned = claudeSettings.plan(false)
  assert.equal(planned.after.ANTHROPIC_BASE_URL, 'https://corp-gateway.internal')
  assert.deepEqual(planned.changes, [])
  assert.ok(planned.warnings.some((w) => /leaving it alone/.test(w)))
})

test('plan(false) removes a local base URL on another port', () => {
  login(false)
  writeSettings({ env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' } })

  const planned = claudeSettings.plan(false)
  assert.equal('ANTHROPIC_BASE_URL' in planned.after, false)
})

test('plan drops an env object left empty rather than writing "env": {}', () => {
  login(false)
  writeSettings({ env: { ANTHROPIC_BASE_URL: GATEWAY_URL } })

  const planned = claudeSettings.plan(false)
  assert.equal('env' in JSON.parse(planned.text), false)
})

test('plan refuses to touch a settings file that is not valid JSON', () => {
  login(false)
  writeSettings('{ broken')

  const planned = claudeSettings.plan(true)
  assert.equal(planned.ok, false)
  assert.match(planned.error, /not valid JSON/)

  const applied = claudeSettings.apply(true)
  assert.equal(applied.ok, false)
  assert.equal(readFileSync(SETTINGS(), 'utf-8'), '{ broken')
})

test('apply writes the plan, backs up the old file, and is idempotent', () => {
  login(false)
  writeSettings({ permissions: { allow: [] }, env: { SOME_OTHER_VAR: 'keep me' } })

  const first = claudeSettings.apply(true)
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  assert.ok(first.backupPath && existsSync(first.backupPath))
  assert.equal(first.status.routed, true)

  const onDisk = JSON.parse(readFileSync(SETTINGS(), 'utf-8'))
  assert.equal(onDisk.env.ANTHROPIC_BASE_URL, GATEWAY_URL)
  assert.equal(onDisk.env.SOME_OTHER_VAR, 'keep me')
  assert.deepEqual(onDisk.permissions, { allow: [] })

  // Nothing left to change, so no second write and no second backup.
  const backupsAfterFirst = readdirSync(CLAUDE_DIR).filter((f) => f.includes('.bak-')).length
  const second = claudeSettings.apply(true)
  assert.equal(second.changed, false)
  assert.equal(readdirSync(CLAUDE_DIR).filter((f) => f.includes('.bak-')).length, backupsAfterFirst)
})

test('apply(true) then apply(false) returns the file to its original shape', () => {
  login(false)
  const original = { permissions: { allow: ['Bash(ls)'] }, env: { SOME_OTHER_VAR: 'keep me' } }
  writeSettings(original)

  claudeSettings.apply(true)
  const off = claudeSettings.apply(false)
  assert.equal(off.ok, true)
  assert.equal(off.status.routed, false)
  assert.deepEqual(JSON.parse(readFileSync(SETTINGS(), 'utf-8')), original)
})

test('apply creates ~/.claude and its settings file when neither exists', () => {
  rmSync(CLAUDE_DIR, { recursive: true, force: true })
  const result = claudeSettings.apply(true)
  assert.equal(result.ok, true)
  assert.equal(result.backupPath, null)
  assert.equal(JSON.parse(readFileSync(SETTINGS(), 'utf-8')).env.ANTHROPIC_BASE_URL, GATEWAY_URL)
})
