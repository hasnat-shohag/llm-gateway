'use strict'
/**
 * Appearance.
 *
 * The renderer's palette is entirely `prefers-color-scheme` — one `:root` block and
 * one media query, no `[data-theme]` selector and no duplicated rules. That works
 * because Chromium resolves `prefers-color-scheme` from `nativeTheme.themeSource`,
 * which only the main process can set. So the stored preference is applied here,
 * once at startup and again on every change, and the renderer never reads it.
 *
 * The window's own `backgroundColor` has to be kept in step too: it is what paints
 * during the gap between window creation and first paint, and a dark flash on a
 * light desktop is the whole reason that option exists.
 */
const { nativeTheme } = require('electron')
const settingsStore = require('./settings-store.js')

/** Matches --bg-app in renderer/styles.css for each scheme. */
const CHROME = { dark: '#0d0f14', light: '#e9ebf0' }

function backgroundColor() {
  return nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light
}

/**
 * Push the stored preference into Electron. Safe to call before any window exists.
 * @param {'system'|'light'|'dark'} [theme]
 */
function apply(theme = settingsStore.get().theme) {
  nativeTheme.themeSource = theme
  return theme
}

/**
 * Keep a window's backgroundColor in step with the resolved scheme, including when
 * the OS preference changes while `themeSource` is 'system'.
 */
function follow(getWindow) {
  const sync = () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.setBackgroundColor(backgroundColor())
  }
  nativeTheme.on('updated', sync)
  sync()
}

module.exports = { apply, follow, backgroundColor }
