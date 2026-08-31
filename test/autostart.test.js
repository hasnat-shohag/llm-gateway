'use strict'
/**
 * autostart.js — the XDG autostart entry (Linux only).
 */
const stub = require('./helpers/electron-stub.js').install()

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

// autostartDir() reads this at call time, so the sandbox applies to every case.
process.env.XDG_CONFIG_HOME = join(stub.root, 'config')

const autostart = require('../main/autostart.js')

const ENTRY = join(stub.root, 'config', 'autostart', `${autostart.APP_ID}.desktop`)

test('the sandbox path is what gets used', () => {
  assert.equal(autostart.status().path, ENTRY)
})

test('status is disabled while no entry exists', () => {
  const status = autostart.status()
  assert.equal(status.supported, process.platform === 'linux')
  assert.equal(status.enabled, false)
})

test('setEnabled(true) writes a desktop entry with a stable Exec path', (t) => {
  if (process.platform !== 'linux') return t.skip('linux-only')

  const status = autostart.setEnabled(true)
  assert.equal(status.enabled, true)
  assert.equal(existsSync(ENTRY), true)

  const text = readFileSync(ENTRY, 'utf-8')
  assert.match(text, /^\[Desktop Entry\]$/m)
  assert.match(text, /^Type=Application$/m)
  assert.match(text, /^Name=LLM Gateway$/m)
  assert.match(text, /^Terminal=false$/m)
  // Must match the installed icon file name (executableName), not the app id.
  assert.match(text, new RegExp(`^Icon=${autostart.ICON_NAME}$`, 'm'))
  assert.equal(autostart.ICON_NAME, 'llm-gateway')

  const exec = text.match(/^Exec=(.+)$/m)?.[1]
  assert.ok(exec && exec.length > 0)
  // Under AppImage the mount point is ephemeral, so APPIMAGE must win.
  assert.equal(exec.includes('/.mount_'), false)
})

test('APPIMAGE, when set, is the Exec path', (t) => {
  if (process.platform !== 'linux') return t.skip('linux-only')

  const previous = process.env.APPIMAGE
  process.env.APPIMAGE = '/home/someone/Applications/LLM Gateway.AppImage'
  try {
    autostart.setEnabled(true)
    assert.match(readFileSync(ENTRY, 'utf-8'), /^Exec=\/home\/someone\/Applications\/LLM Gateway\.AppImage$/m)
  } finally {
    if (previous === undefined) delete process.env.APPIMAGE
    else process.env.APPIMAGE = previous
  }
})

test('setEnabled(false) removes the entry', (t) => {
  if (process.platform !== 'linux') return t.skip('linux-only')

  autostart.setEnabled(true)
  const status = autostart.setEnabled(false)
  assert.equal(status.enabled, false)
  assert.equal(existsSync(ENTRY), false)
})

test('a hand-added Hidden=true reads back as disabled', (t) => {
  if (process.platform !== 'linux') return t.skip('linux-only')

  mkdirSync(join(stub.root, 'config', 'autostart'), { recursive: true })
  writeFileSync(ENTRY, '[Desktop Entry]\nType=Application\nName=LLM Gateway\nHidden=true\n')
  assert.equal(autostart.status().enabled, false)
})

test('setEnabled is a no-op off Linux', (t) => {
  if (process.platform === 'linux') return t.skip('non-linux only')

  const status = autostart.setEnabled(true)
  assert.equal(status.supported, false)
  assert.match(status.reason, /not implemented/)
})
