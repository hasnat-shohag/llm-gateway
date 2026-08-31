'use strict'
/**
 * The entire renderer-visible API. Sandboxed preloads run as plain CommonJS with
 * no ESM context, hence `require`.
 *
 * Note what is absent: no fs, no net, no child_process, no full API keys, and no
 * generic `invoke`. Each channel is named explicitly so the renderer cannot reach
 * anything that was not deliberately exposed.
 */
const { contextBridge, ipcRenderer } = require('electron')

const gatewayStateListeners = new Set()

ipcRenderer.on('gateway:state-changed', (_e, state) => {
  for (const fn of gatewayStateListeners) {
    try {
      fn(state)
    } catch {
      // A renderer listener throwing must not break the channel.
    }
  }
})

contextBridge.exposeInMainWorld('gw', {
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    save: (providers, version) => ipcRenderer.invoke('providers:save', { providers, version }),
    probe: (name, model) => ipcRenderer.invoke('providers:probe', { name, model }),
  },
  gateway: {
    state: () => ipcRenderer.invoke('gateway:state'),
    health: () => ipcRenderer.invoke('gateway:health'),
    stats: () => ipcRenderer.invoke('gateway:stats'),
    enabledNames: () => ipcRenderer.invoke('gateway:enabledNames'),
    restart: () => ipcRenderer.invoke('gateway:restart'),
    usePort: (port) => ipcRenderer.invoke('gateway:usePort', { port }),
    suggestPort: () => ipcRenderer.invoke('gateway:suggestPort'),
    onStateChange: (fn) => {
      gatewayStateListeners.add(fn)
      return () => gatewayStateListeners.delete(fn)
    },
  },
  usage: {
    summary: (limit) => ipcRenderer.invoke('usage:summary', { limit }),
    cost: (date) => ipcRenderer.invoke('usage:cost', { date }),
    exportCsv: (date) => ipcRenderer.invoke('usage:export', { date }),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    setAutostart: (enabled) => ipcRenderer.invoke('settings:setAutostart', { enabled }),
  },
  claude: {
    status: () => ipcRenderer.invoke('claude:status'),
    account: () => ipcRenderer.invoke('claude:account'),
    plan: (route) => ipcRenderer.invoke('claude:plan', { route }),
    apply: (route) => ipcRenderer.invoke('claude:apply', { route }),
  },
  shell: {
    openLog: () => ipcRenderer.invoke('shell:openLog'),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
  },
})
