// whale-girl desktop companion — Electron main process.
//
// Responsibilities:
//  - transparent, frameless, always-on-top pet window (drag via IPC-managed
//    manual drag: a draggable app-region swallows clicks, so the renderer
//    reports mouse deltas and the window follows)
//  - polls GET /whale-girl/state and GET /whale-girl/sessions, forwards both
//    to the renderer over IPC
//  - presence heartbeat POST /whale-girl/presence (15s renew; farewell on quit)
//  - click-to-toggle embedded DSH web window (second BrowserWindow, hidden
//    until the pet is clicked; never touches the DSH service itself)
//  - size presets 75/100/125/150/200% via right-click menu, persisted
//  - position persistence; `--screenshot=<path>` captures the window for tests
const { app, BrowserWindow, screen, Menu, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const BASE_ARG = process.argv.find((arg) => arg.startsWith('--base-url='))
const BASE = BASE_ARG ? BASE_ARG.slice('--base-url='.length) : 'http://127.0.0.1:3080'
const STATE_URL = `${BASE}/whale-girl/state`
const SESSIONS_URL = `${BASE}/whale-girl/sessions`
const PRESENCE_URL = `${BASE}/whale-girl/presence`
const POLL_MS = 1500
const HEARTBEAT_MS = 15000
const PET_SIZE = 110
const WIN_MARGIN = 20
const SCALE_PRESETS = [0.75, 1, 1.25, 1.5, 2]
const BUBBLE_H = 36
const BUBBLE_GAP = 4
const BUBBLE_MIN_W = 210
const WEB_WIN_W = 1200
const WEB_WIN_H = 800

let win = null
let webWin = null
let scale = 1
let bubbleCount = 0
let dragState = null

const posFile = path.join(app.getPath('userData'), 'position.json')
const scaleFile = path.join(app.getPath('userData'), 'scale.json')

function loadPos() {
  try { return JSON.parse(fs.readFileSync(posFile, 'utf8')) } catch { return null }
}
function savePos(bounds) {
  try { fs.writeFileSync(posFile, JSON.stringify(bounds)) } catch { /* non-fatal */ }
}
function loadScale() {
  try {
    const s = JSON.parse(fs.readFileSync(scaleFile, 'utf8')).scale
    return SCALE_PRESETS.includes(s) ? s : 1
  } catch { return 1 }
}
function saveScale(s) {
  try { fs.writeFileSync(scaleFile, JSON.stringify({ scale: s })) } catch { /* non-fatal */ }
}

function stageSize() { return Math.round(PET_SIZE * scale) }
function marginSize() { return Math.round(WIN_MARGIN * scale) }

/** Window metrics: bubbles sit above the pet, so the window grows upward when sessions are active. */
function windowMetrics() {
  const stage = stageSize()
  const margin = marginSize()
  const bubbleArea = bubbleCount > 0 ? bubbleCount * BUBBLE_H + (bubbleCount - 1) * BUBBLE_GAP : 0
  return {
    stage,
    w: Math.max(stage + margin * 2, bubbleCount > 0 ? BUBBLE_MIN_W : 0),
    h: margin + bubbleArea + stage + margin,
  }
}

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// The renderer is a file:// page, so its own fetch() to the DSH origin would
// be CORS-blocked. The main process (plain Node) has no such restriction:
// it loads the manifest here and ships it over IPC.
async function sendManifest() {
  try {
    const res = await fetch(`${BASE}/whale-girl/assets/manifest.json`, { signal: AbortSignal.timeout(5000) })
    if (res.ok && win && !win.isDestroyed()) win.webContents.send('pet-manifest', await res.json())
  } catch { /* DSH may be starting; retried by the poll loop below */ }
}

async function pokePresence(online) {
  try {
    await fetch(PRESENCE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ online }),
      signal: AbortSignal.timeout(3000),
    })
  } catch { /* DSH may be down; heartbeat resumes on the next interval */ }
}

/** Resize the pet window to the current scale + bubble count, keeping the bottom edge fixed. */
function applyWindowSize() {
  if (!win || win.isDestroyed()) return
  const { stage, w, h } = windowMetrics()
  const bounds = win.getBounds()
  const bottom = bounds.y + bounds.height
  win.setBounds({ x: bounds.x, y: bottom - h, width: w, height: h })
  win.webContents.send('pet-scale', { stage })
}

async function pollLoop() {
  for (;;) {
    try {
      const state = await fetchJSON(STATE_URL)
      if (win && !win.isDestroyed()) win.webContents.send('pet-state', { online: true, state })
      // Sent every round: the first send may race the renderer's listener
      // registration, and the manifest is small enough to resend harmlessly.
      sendManifest()
    } catch {
      if (win && !win.isDestroyed()) win.webContents.send('pet-state', { online: false, state: null })
    }
    pollSessions()
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** Poll /whale-girl/sessions (same cadence as /state); finished sessions drop their bubble. */
async function pollSessions() {
  try {
    const list = await fetchJSON(SESSIONS_URL)
    if (!Array.isArray(list)) return
    const active = list.filter((s) => s && typeof s === 'object' && s.activity !== 'done')
    if (win && !win.isDestroyed()) win.webContents.send('pet-sessions', active)
    if (active.length !== bubbleCount) {
      bubbleCount = active.length
      applyWindowSize()
    }
  } catch { /* /sessions may be absent (pre-A plugin); bubbles stay empty */ }
}

function heartbeatLoop() {
  pokePresence(true)
  setInterval(() => pokePresence(true), HEARTBEAT_MS)
}

// ---- embedded DSH web window (B1): a second BrowserWindow over the same GUI,
// hidden until the pet is clicked; toggling only shows/hides, never stops DSH.
function ensureWebWin() {
  if (webWin && !webWin.isDestroyed()) return webWin
  webWin = new BrowserWindow({
    width: WEB_WIN_W,
    height: WEB_WIN_H,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false, // keep painting while hidden (web-shot capture)
    },
  })
  webWin.loadURL(BASE)
  webWin.on('closed', () => { webWin = null })
  // Open near the pet, clamped to the pet's display work area.
  if (win && !win.isDestroyed()) {
    const [px, py] = win.getPosition()
    const wa = screen.getDisplayMatching(win.getBounds()).workArea
    let x = px + 24
    let y = py + 24
    if (x + WEB_WIN_W > wa.x + wa.width) x = Math.max(wa.x, px - WEB_WIN_W - 24)
    if (y + WEB_WIN_H > wa.y + wa.height) y = Math.max(wa.y, py - WEB_WIN_H - 24)
    webWin.setPosition(Math.round(x), Math.round(y))
  }
  return webWin
}

function toggleWeb() {
  const w = ensureWebWin()
  if (w.isVisible()) w.hide()
  else { w.show(); w.focus() }
}

// ---- size presets (B2): right-click menu with radio items, persisted ----
function setScale(next) {
  scale = next
  saveScale(next)
  applyWindowSize()
}

function showMenu() {
  if (!win || win.isDestroyed()) return
  const template = [
    ...SCALE_PRESETS.map((s) => ({
      label: `${Math.round(s * 100)}%`,
      type: 'radio',
      checked: Math.abs(scale - s) < 1e-9,
      click: () => setScale(s),
    })),
    { type: 'separator' },
    { label: '打开 / 隐藏网页窗口', click: toggleWeb },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]
  Menu.buildFromTemplate(template).popup({ window: win })
}

// ---- IPC (renderer -> main) ----
ipcMain.on('pet-toggle-web', toggleWeb)
ipcMain.on('pet-menu', showMenu)
ipcMain.on('pet-drag-start', (_event, pos) => {
  if (!win || win.isDestroyed()) return
  dragState = { mouseX: pos.x, mouseY: pos.y, winX: win.getPosition()[0], winY: win.getPosition()[1] }
})
ipcMain.on('pet-drag-move', (_event, pos) => {
  if (!dragState || !win || win.isDestroyed()) return
  win.setPosition(
    Math.round(dragState.winX + (pos.x - dragState.mouseX)),
    Math.round(dragState.winY + (pos.y - dragState.mouseY)),
  )
})
ipcMain.on('pet-drag-end', () => { dragState = null })

function createWindow() {
  scale = loadScale()
  const { w, h } = windowMetrics()
  const pos = loadPos()
  let x = pos?.x
  let y = pos?.y
  if (x === undefined || y === undefined) {
    // First run: bottom-right of the primary display.
    const work = screen.getPrimaryDisplay().workArea
    x = work.x + work.width - w - 16
    y = work.y + work.height - h - 16
  }
  win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      // contextIsolation off so the preload can expose `window.pet` in the same
      // world as the renderer (callback crossing through contextBridge proved
      // unreliable here). The app loads only local files; the renderer only
      // talks to loopback DSH.
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  win.setAlwaysOnTop(true, 'floating')
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.on('did-finish-load', () => {
    // The renderer starts at the default stage; resend the persisted scale
    // once the page is up so canvas CSS + backing store match the window.
    win.webContents.send('pet-scale', { stage: stageSize() })
  })
  if (screenshotFlag || process.argv.includes('--dev')) {
    win.webContents.on('console-message', (_event, _level, message) => console.log('[renderer]', message))
  }
  win.on('move', () => {
    try { const [px, py] = win.getPosition(); savePos({ x: px, y: py }) } catch { /* non-fatal */ }
  })
  win.on('closed', () => { win = null })
  return win
}

const screenshotFlag = process.argv.find((arg) => arg.startsWith('--screenshot='))
const screenshotDelayArg = process.argv.find((arg) => arg.startsWith('--screenshot-delay='))
const screenshotDelay = screenshotDelayArg ? Number(screenshotDelayArg.slice('--screenshot-delay='.length)) : 5000
// Debug: shorten the renderer idle→sleep threshold for fast sleep-capture tests
// (e.g. --sleep-after=8000). Forwarded over IPC once the page is up.
const sleepAfterArg = process.argv.find((arg) => arg.startsWith('--sleep-after='))
const sleepAfterMs = sleepAfterArg ? Number(sleepAfterArg.slice('--sleep-after='.length)) : null
// Debug: --web-shot=<path> opens the embedded DSH web window, waits for it to
// load, captures it to <path> and quits — verifies B1 without a manual click.
const webShotFlag = process.argv.find((arg) => arg.startsWith('--web-shot='))

app.whenReady().then(() => {
  createWindow()
  heartbeatLoop()
  pollLoop()
  if (sleepAfterMs !== null && sleepAfterMs > 0 && win) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('pet-debug', { sleepAfterMs })
    })
  }
  if (webShotFlag) {
    setTimeout(async () => {
      try {
        const w = ensureWebWin()
        w.show()
        w.focus()
        await new Promise((resolve) => {
          if (w.webContents.isLoading()) w.webContents.once('did-finish-load', resolve)
          else resolve()
        })
        await new Promise((resolve) => setTimeout(resolve, 6000)) // let the GUI paint a frame
        const image = await w.webContents.capturePage()
        fs.writeFileSync(webShotFlag.slice('--web-shot='.length), image.toPNG())
        console.log('[whale-girl-desktop] web-shot saved')
      } catch (error) {
        console.error('[whale-girl-desktop] web-shot failed:', error.message)
      }
      app.quit()
    }, 4000)
  }
  if (screenshotFlag) {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage()
        fs.writeFileSync(screenshotFlag.slice('--screenshot='.length), image.toPNG())
        console.log('[whale-girl-desktop] screenshot saved')
      } catch (error) {
        console.error('[whale-girl-desktop] screenshot failed:', error.message)
      }
      app.quit()
    }, screenshotDelay)
  }
})

app.on('before-quit', () => { pokePresence(false) })
app.on('window-all-closed', () => { app.quit() })
