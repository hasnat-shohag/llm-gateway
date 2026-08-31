'use strict'
/**
 * Detects whether a Claude Code login exists — presence only.
 *
 * The contents are never read, parsed, copied, or logged. Anthropic's terms state
 * that developers "may not collect, store, or intermediate Claude.ai credentials
 * or session tokens", and it would not work anyway: refresh tokens are single-use
 * and rotate, so a second refresher racing Claude Code revokes the whole family.
 *
 * The app does not need the token. Pointing Claude Code at the gateway WITHOUT a
 * gateway credential leaves the claude.ai login as the active credential, and
 * Claude Code attaches it to every request itself; a `passthrough` provider then
 * relays it upstream untouched.
 */
const { existsSync } = require('node:fs')
const { claudeCredentialsPath, claudeDir } = require('./paths.js')

function detect() {
  const path = claudeCredentialsPath()
  if (existsSync(path)) {
    return {
      loggedIn: true,
      method: 'credentials-file',
      // Path only, so the UI can tell the user where to look. Contents untouched.
      location: path,
    }
  }

  // macOS keeps the credential in the Keychain rather than on disk, so absence of
  // the file is not proof of absence of a login. Report unknown instead of "no".
  if (process.platform === 'darwin') {
    return { loggedIn: null, method: 'keychain', location: 'macOS Keychain' }
  }

  return { loggedIn: false, method: 'credentials-file', location: claudeDir() }
}

module.exports = { detect }
