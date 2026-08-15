// Preload (contextIsolation: false): expose `window.pet` in the same world as
// the renderer, so callbacks cross no bridge. Loads only local files; the
// renderer only talks to loopback DSH.
const { ipcRenderer } = require('electron')

window.pet = {
  onState: (callback) => ipcRenderer.on('pet-state', (_event, payload) => callback(payload)),
  onManifest: (callback) => ipcRenderer.on('pet-manifest', (_event, manifest) => callback(manifest)),
  onScale: (callback) => ipcRenderer.on('pet-scale', (_event, metrics) => callback(metrics)),
  onSessions: (callback) => ipcRenderer.on('pet-sessions', (_event, sessions) => callback(sessions)),
  onDebug: (callback) => ipcRenderer.on('pet-debug', (_event, debug) => callback(debug)),
  toggleWeb: () => ipcRenderer.send('pet-toggle-web'),
  openMenu: () => ipcRenderer.send('pet-menu'),
  dragStart: (pos) => ipcRenderer.send('pet-drag-start', pos),
  dragMove: (pos) => ipcRenderer.send('pet-drag-move', pos),
  dragEnd: () => ipcRenderer.send('pet-drag-end'),
}
