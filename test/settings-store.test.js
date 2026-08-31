'use strict'
/**
 * settings-store.js — persisted app settings and their coercion rules.
 */
const stub = require('./helpers/electron-stub.js').install()

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { writeFileSync, readFileSync, rmSync } = require('node:fs')

const paths = require('../main/paths.js')
const SETTINGS_MODULE = require.resolve('../main/settings-store.js')

/** The store caches on first read, so each case needs a fresh module instance. */
function freshStore(fileContents) {
  const path = paths.settingsPath()
  if (fileContents === undefined) rmSync(path, { force: true })
  else writeFileSync(path, typeof fileContents === 'string' ? fileContents : JSON.stringify(fileContents))
  delete require.cache[SETTINGS_MODULE]
  return require('../main/settings-store.js')
}

test('a missing settings file yields the defaults', () => {
  const store = freshStore()
  assert.deepEqual(store.get(), store.DEFAULTS)
  assert.equal(store.DEFAULTS.port, 8080)
  assert.equal(store.DEFAULTS.strategy, 'random')
  assert.equal(store.DEFAULTS.setupCompleted, false)
  assert.equal(store.DEFAULTS.theme, 'system')
})

test('a corrupt settings file falls back to the defaults instead of throwing', () => {
  const store = freshStore('{ not json')
  assert.deepEqual(store.get(), store.DEFAULTS)
})

test('valid stored values are honored', () => {
  const store = freshStore({
    port: 9100, strategy: 'weighted', logLevel: 'debug', pollMs: 4000,
    setupCompleted: true, theme: 'light',
  })
  assert.deepEqual(store.get(), {
    port: 9100,
    strategy: 'weighted',
    logLevel: 'debug',
    pollMs: 4000,
    setupCompleted: true,
    theme: 'light',
  })
})

test('out-of-range and unknown values fall back per field', () => {
  const store = freshStore({
    port: 0, strategy: 'sticky', logLevel: 'loud', pollMs: 500,
    setupCompleted: 'yes', theme: 'sepia',
  })
  const settings = store.get()
  assert.equal(settings.port, store.DEFAULTS.port)
  assert.equal(settings.strategy, store.DEFAULTS.strategy)
  assert.equal(settings.logLevel, store.DEFAULTS.logLevel)
  // 2s floor: better-sqlite3 is synchronous and shares the gateway's event loop.
  assert.equal(settings.pollMs, store.DEFAULTS.pollMs)
  assert.equal(settings.setupCompleted, false)
  assert.equal(settings.theme, store.DEFAULTS.theme)
})

test('every theme in THEMES round-trips', () => {
  for (const theme of ['system', 'light', 'dark']) {
    assert.equal(freshStore({ theme }).get().theme, theme)
  }
})

test('port 65536 is rejected but 65535 is kept', () => {
  assert.equal(freshStore({ port: 65536 }).get().port, 8080)
  assert.equal(freshStore({ port: 65535 }).get().port, 65535)
})

test('a fractional pollMs is rounded', () => {
  assert.equal(freshStore({ pollMs: 2500.6 }).get().pollMs, 2501)
})

test('get returns a copy, so a caller cannot mutate the cache', () => {
  const store = freshStore()
  const first = store.get()
  first.port = 1
  assert.equal(store.get().port, 8080)
})

test('update merges a patch, persists it, and coerces it', () => {
  const store = freshStore()
  const next = store.update({ port: 9200, strategy: 'round-robin' })
  assert.equal(next.port, 9200)
  assert.equal(next.strategy, 'round-robin')
  assert.equal(next.logLevel, 'info')

  const onDisk = JSON.parse(readFileSync(paths.settingsPath(), 'utf-8'))
  assert.equal(onDisk.port, 9200)
  assert.equal(store.get().port, 9200)

  // coerce() is field-wise against DEFAULTS, so an unrecognized patch value resets
  // that field rather than keeping the previous one. Unreachable through the IPC
  // layer, which rejects an unknown strategy before update() is called.
  assert.equal(store.update({ strategy: 'nonsense' }).strategy, 'random')
  assert.equal(store.get().port, 9200)
})

test('the settings file lives in the sandbox userData dir', () => {
  assert.ok(paths.settingsPath().startsWith(stub.userData))
})
