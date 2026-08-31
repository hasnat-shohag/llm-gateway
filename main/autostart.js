'use strict'
/**
 * Start-on-login for Linux.
 *
 * `app.setLoginItemSettings` is macOS/Windows only, so on Linux the XDG autostart
 * entry has to be written by hand. Two details that matter:
 *  - `Exec` must be a stable path. Under AppImage that is `process.env.APPIMAGE`,
 *    NOT `app.getPath('exe')`, which points into the ephemeral /tmp/.mount_* dir
 *    and breaks on the next update.
 *  - `Hidden=true` is the spec's way to disable an entry, so a toggle-off can keep
 *    the file (and any hand edits) instead of deleting it.
 */
const { app } = require('electron')
const { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const APP_ID = 'com.vivasoft.llm-gateway'
/**
 * Icon theme name, which is NOT the app id: electron-builder installs the icon as
 * /usr/share/icons/hicolor/*\/apps/<executableName>.png, and executableName is
 * `llm-gateway` (see electron-builder.yml). Naming the entry's Icon anything else
 * leaves the autostart entry with a generic placeholder.
 */
const ICON_NAME = 'llm-gateway'

function autostartDir() {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return join(base, 'autostart')
}

function entryPath() {
  return join(autostartDir(), `${APP_ID}.desktop`)
}

function execPath() {
  // AppImage: the mount point changes every launch; APPIMAGE is the real file.
  if (process.env.APPIMAGE) return process.env.APPIMAGE
  // deb/rpm install a /usr/bin symlink via the packaging scripts.
  const linked = '/usr/bin/llm-gateway'
  if (existsSync(linked)) return linked
  return app.getPath('exe')
}

function supported() {
  return process.platform === 'linux'
}

function status() {
  if (!supported()) {
    return { supported: false, enabled: false, path: null, reason: `autostart not implemented for ${process.platform}` }
  }
  const path = entryPath()
  if (!existsSync(path)) return { supported: true, enabled: false, path }
  try {
    const text = readFileSync(path, 'utf-8')
    const hidden = /^Hidden\s*=\s*true\s*$/im.test(text)
    return { supported: true, enabled: !hidden, path }
  } catch {
    return { supported: true, enabled: false, path }
  }
}

function desktopEntry() {
  const exec = execPath()
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=LLM Gateway',
    'Comment=Local LLM gateway and provider manager for Claude Code',
    `Exec=${exec}`,
    `Icon=${ICON_NAME}`,
    'Terminal=false',
    // StartupWMClass is deliberately absent: this entry only launches the app, and
    // window association belongs to the installed llm-gateway.desktop entry that
    // electron-builder generates.
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

function setEnabled(enabled) {
  if (!supported()) return status()
  mkdirSync(autostartDir(), { recursive: true })
  const path = entryPath()
  if (enabled) {
    writeFileSync(path, desktopEntry())
  } else if (existsSync(path)) {
    // Remove outright: the entry is ours and fully generated, so there is nothing
    // to preserve by keeping it with Hidden=true.
    unlinkSync(path)
  }
  return status()
}

module.exports = { status, setEnabled, supported, APP_ID, ICON_NAME }
