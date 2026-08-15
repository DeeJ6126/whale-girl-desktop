// whale-girl desktop renderer: sprite animation driven by /whale-girl/state
// plus session bubbles from /whale-girl/sessions. Loads sheets cross-origin
// as <img> (safe: we only drawImage, never read pixels).
const BASE = 'http://127.0.0.1:3080'
const ASSETS = `${BASE}/whale-girl/assets`

const STAGE_BASE = 110
let SLEEP_AFTER_MS = 60000 // mutable via pet-debug for tests
const WELCOME_MS = 2500
const CLICK_MAX_MOVE = 5 // px; a press that moves less is a click, not a drag

const canvas = document.getElementById('pet')
const gfx = canvas.getContext('2d')
const bubblesEl = document.getElementById('bubbles')

// HiDPI-aware backing store: the canvas is stage CSS px but renders at
// devicePixelRatio resolution, so the sprite stays crisp on 2x/3x displays.
// `stage` follows the main process scale preset (B2) via pet-scale IPC.
const DPR = window.devicePixelRatio || 1
let stage = STAGE_BASE

function applyStage(next) {
  stage = Math.max(8, Math.round(next || STAGE_BASE))
  canvas.style.width = `${stage}px`
  canvas.style.height = `${stage}px`
  canvas.width = Math.round(stage * DPR)
  canvas.height = Math.round(stage * DPR)
  gfx.setTransform(DPR, 0, 0, DPR, 0, 0)
  gfx.imageSmoothingEnabled = true
  gfx.imageSmoothingQuality = 'high'
}
applyStage(STAGE_BASE)

let manifest = null
let sheets = new Map()          // state name -> HTMLImageElement
let payload = { online: false, state: null }
let welcomed = false
let welcomeUntil = 0
let idleSince = Date.now()

// animation state
let animName = 'idle'
let animFrame = 0
let frameAt = 0

// pointer state (B1): manual drag via IPC because a draggable app-region
// swallows clicks; the window follows the mouse deltas, a still press toggles
// the embedded DSH web window.
let pointerDown = null

// The manifest arrives over IPC from the main process (a file:// page cannot
// fetch() the DSH origin; <img> sprite loads below are fine).
window.pet.onManifest((m) => {
  manifest = m
})

window.pet.onScale((metrics) => {
  if (metrics && Number.isFinite(metrics.stage)) applyStage(metrics.stage)
})

// Debug override for tests: shorten SLEEP_AFTER_MS so the idle→sleep
// transition can be captured without waiting 60s.
window.pet.onDebug((debug) => {
  if (debug && Number.isFinite(debug.sleepAfterMs) && debug.sleepAfterMs > 0) {
    SLEEP_AFTER_MS = debug.sleepAfterMs
    console.log(`[renderer] debug sleepAfterMs=${SLEEP_AFTER_MS}`)
  }
})

function characterId() {
  if (!manifest) return null
  return manifest.default || Object.keys(manifest.characters || {})[0] || null
}

function character() {
  if (!manifest) return null
  const id = characterId()
  return id ? manifest.characters[id] : null
}

function sheetFor(name) {
  const ch = character()
  const id = characterId()
  if (!ch || !id || !ch.states[name]) return null
  if (!sheets.has(name)) {
    // Sheets live under assets/characters/<characterId>/<sheet> in the package.
    const img = new Image()
    img.src = `${ASSETS}/characters/${id}/${ch.states[name].sheet}`
    sheets.set(name, img)
  }
  return sheets.get(name)
}

// ---- state selection (mirrors the web client's mood logic) ----
// Wall-clock decisions use Date.now() (absolute Unix ms), matching the
// server's absolute turnCompletedUntil deadline; the rAF timestamp is
// page-relative and would make the celebrate window appear never to expire.
function pickTarget(now) {
  if (!payload.online || !payload.state) return 'idle'
  const act = payload.state.activity || {}
  if (Number.isFinite(act.turnCompletedUntil) && act.turnCompletedUntil > now) return 'celebrate'
  if (act.sessionWait === true) return 'wait'
  if (act.sessionThink === true) return 'think'
  const named = typeof act.name === 'string' && sheetFor(act.name) ? act.name : 'idle'
  if (named === 'idle' && now - idleSince > SLEEP_AFTER_MS) return 'sleep'
  return named
}

function drive(clock) {
  // `clock` is the rAF DOMHighResTimeStamp: page-relative, only good for
  // animation timing. All state decisions need the absolute wall clock.
  const now = Date.now()
  let target = pickTarget(now)

  // dragging overrides mood while the window follows the pointer
  if (pointerDown) target = sheetFor('drag') ? 'drag' : target

  // welcome once, shortly after the first online snapshot (held for WELCOME_MS)
  if (payload.online && !welcomed) {
    welcomed = true
    welcomeUntil = now + WELCOME_MS
  }
  if (now < welcomeUntil) target = 'welcome'
  // wake transition out of sleep
  if (animName === 'sleep' && target !== 'sleep') target = 'wake'
  // stay awake while interacting with anything other than plain idle.
  // `sleep` must NOT reset the clock: pickTarget returns 'sleep' while the
  // condition still holds, and resetting here would flip the pet back to idle
  // the very next frame (the sleep state could never settle in).
  if (target !== 'idle' && target !== 'sleep') idleSince = now

  const want = sheetFor(target)
  if (!want || !want.complete || want.naturalWidth === 0) {
    drawPlaceholder()
    requestAnimationFrame(drive)
    return
  }

  // state change resets the frame clock
  if (target !== animName) {
    animName = target
    animFrame = 0
    frameAt = clock
    // Only wake restarts the idle clock here: entering sleep must preserve the
    // idle age (the sleep condition stays true while the pet sleeps), and
    // waking up means fresh activity from now on.
    if (animName === 'wake') idleSince = now
    console.log(`[renderer] state ${target}`)
  }

  const spec = character().states[animName]
  const frames = Math.max(1, spec.frames || 1)
  const fps = spec.fps || 2
  const play = spec.playback || 'loop'
  const frameW = Math.floor(want.naturalWidth / frames)
  const frameH = want.naturalHeight
  const elapsed = clock - frameAt
  let fi = Math.floor((elapsed / 1000) * fps)

  if (play === 'once') {
    fi = Math.min(fi, frames - 1)
  } else if (play === 'pingpong') {
    const period = Math.max(1, frames * 2 - 2)
    fi = ((fi % period) + period) % period
    if (fi >= frames) fi = period - fi
  } else {
    fi = ((fi % frames) + frames) % frames
  }
  animFrame = fi

  // motion transforms (cheap approximations of the web client's effects)
  gfx.clearRect(0, 0, stage, stage)
  gfx.save()
  const bob = clock / 1000
  if (animName === 'think') gfx.translate(0, Math.sin(bob * 2) * 3)
  if (animName === 'wait') gfx.rotate(Math.sin(bob * 4) * 0.05)
  if (animName === 'error') gfx.translate(Math.sin(bob * 40) * 2, 0)
  if (animName === 'drag') gfx.rotate(Math.sin(bob * 5) * 0.08)
  // Frames are 256x256; scale the whole frame down to fit the stage instead
  // of cropping it (an unscaled draw at a negative offset shows only the
  // character's center).
  const fit = Math.min(stage / frameW, stage / frameH)
  const dw = Math.round(frameW * fit)
  const dh = Math.round(frameH * fit)
  gfx.drawImage(
    want, animFrame * frameW, 0, frameW, frameH,
    Math.round((stage - dw) / 2), Math.round((stage - dh) / 2), dw, dh,
  )
  gfx.restore()

  requestAnimationFrame(drive)
}

function drawPlaceholder() {
  gfx.clearRect(0, 0, stage, stage)
  gfx.fillStyle = 'rgba(80, 120, 220, 0.35)'
  gfx.beginPath()
  gfx.arc(stage / 2, stage / 2, 26, 0, Math.PI * 2)
  gfx.fill()
  gfx.fillStyle = 'rgba(255,255,255,0.8)'
  gfx.font = '10px sans-serif'
  gfx.textAlign = 'center'
  gfx.fillText('whale-girl', stage / 2, stage / 2 + 4)
}

window.pet.onState((p) => {
  payload = p
  // Only active states restart the idle clock; resetting on every poll would
  // make sleep unreachable (the pet stays awake forever).
  if (p.online) {
    const act = p.state?.activity || {}
    const active = act.sessionThink === true || act.sessionWait === true
      || (typeof act.name === 'string' && act.name !== 'idle')
      || (Number.isFinite(act.turnCompletedUntil) && act.turnCompletedUntil > Date.now())
    if (active) idleSince = Date.now()
  }
})

// ---- session bubbles (B3): title + current action above the pet ----
function actionLabel(activity) {
  if (typeof activity !== 'string') return ''
  if (activity === 'thinking') return '深度思考中'
  if (activity === 'waiting') return '等待批准'
  if (activity.startsWith('tool:')) {
    const name = activity.slice('tool:'.length)
    return name === 'bash' || name === 'pwsh' ? '运行命令行中' : `执行 ${name} 工具`
  }
  return ''
}

window.pet.onSessions((sessions) => {
  bubblesEl.replaceChildren()
  for (const s of sessions || []) {
    if (!s || typeof s !== 'object') continue
    if (s.activity === 'done') continue // 会话结束后框消失
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    const title = document.createElement('div')
    title.className = 'bubble-title'
    title.textContent = typeof s.title === 'string' && s.title ? s.title : '会话'
    const action = document.createElement('div')
    action.className = 'bubble-action'
    action.textContent = actionLabel(s.activity) || '空闲'
    bubble.append(title, action)
    bubblesEl.append(bubble)
  }
})

// ---- pointer handling (B1 + drag) ----
// Manual drag: mousedown starts tracking, mousemove reports deltas to the main
// process (which moves the window), a press that never moved toggles the web
// window. Right-click opens the size-preset menu (B2).
canvas.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return
  pointerDown = { x: event.screenX, y: event.screenY }
  window.pet.dragStart({ x: event.screenX, y: event.screenY })
})
window.addEventListener('mousemove', (event) => {
  if (!pointerDown) return
  window.pet.dragMove({ x: event.screenX, y: event.screenY })
})
window.addEventListener('mouseup', (event) => {
  if (!pointerDown) return
  const dx = event.screenX - pointerDown.x
  const dy = event.screenY - pointerDown.y
  const moved = Math.hypot(dx, dy)
  const clicked = moved <= CLICK_MAX_MOVE
  pointerDown = null
  window.pet.dragEnd()
  if (clicked) window.pet.toggleWeb()
})
canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  window.pet.openMenu()
})

requestAnimationFrame(drive)
