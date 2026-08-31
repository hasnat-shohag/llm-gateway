'use strict'
/**
 * Minimal `electron` stand-in for the main-process modules under test.
 *
 * `main/paths.js` reaches for `app.getPath()` at call time, so anything that
 * requires it transitively (providers-store, schema, settings-store,
 * claude-settings) needs an `app` object present. Installing a fake into
 * `require.cache` before the first `require('electron')` is enough: the real
 * package's entry point only exports the Electron binary's path when it is loaded
 * by plain Node, so `app` would be undefined and every path helper would throw.
 *
 * Each install() gets a fresh mkdtemp root, so a test file never sees another's
 * providers.json or settings.json.
 */
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

/** Repo's desktop/ dir — what `app.getAppPath()` returns in development. */
const DESKTOP_DIR = join(__dirname, '..', '..')

function install({ appPath = DESKTOP_DIR } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'llm-gateway-desktop-test-'))
  const userData = join(root, 'userData')
  const logs = join(root, 'logs')

  const app = {
    getPath(name) {
      if (name === 'userData') return userData
      if (name === 'logs') return logs
      return root
    },
    getAppPath: () => appPath,
    // Called at module load by supervisor.js; a no-op is all that is needed.
    on() {},
    requestSingleInstanceLock: () => true,
  }

  const id = require.resolve('electron')
  require.cache[id] = { id, filename: id, loaded: true, exports: { app } }

  return { root, userData, logs, appPath }
}

module.exports = { install, DESKTOP_DIR }
