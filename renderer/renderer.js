// whale-girl desktop renderer: sprite animation driven by /whale-girl/state
// plus session bubbles from /whale-girl/sessions. Loads sheets cross-origin
// as <img> (safe: we only drawImage, never read pixels).
//
// Behavior parity with the official web client (vlln/whale-girl lib/client):
// the 15-state priority table (drag -> drag-release idle buffer -> server
// activity burst -> eat/play/wake transient -> wait -> celebrate ->
// working interlude -> think -> joy -> sleep -> walk -> idle), blink playback
// for idle (random 3-9s blinks), random facing flips on static states,
// working interludes during think (12-30s apart, 2.5-6s long), feed/play
// interaction (POST /interact via the main process -> reply bubble + eat/play
// + joy).
const BASE = 'http://127.0.0.1:3080'
const ASSETS = `${BASE}/whale-girl/assets`

const STAGE_BASE = 110
let SLEEP_AFTER_MS = 60000 // mutable via pet-debug for tests
const WELCOME_MS = 2500
const CLICK_MAX_MOVE = 5 // px; a press that moves less is a click, not a drag

// ---- behavior constants (parity with official lib/client/logic.mjs) ----
const TRANSIENT_MS = 1500    // eat/play transient duration
const JOY_MS = 1600          // post-interaction joy window
const DRAG_RELEASE_MS = 1500 // idle buffer after dropping a drag
const WALK_MS = 800          // short walk-back after a drag drop
const REPLY_MS = 2500        // interaction reply bubble lifetime
const WORKING_MIN_WAIT_MS = 12000
const WORKING_MAX_WAIT_MS = 30000
const WORKING_MIN_DUR_MS = 2500
const WORKING_MAX_DUR_MS = 6000
const BLINK_MIN_INTERVAL_MS = 3000
const BLINK_MAX_INTERVAL_MS = 9000
const FACING_MIN_INTERVAL_MS = 10000
const FACING_MAX_INTERVAL_MS = 25000

const canvas = document.getElementById('pet')
const gfx = canvas.getContext('2d')
const bubblesEl = document.getElementById('bubbles')
const sessionBubblesEl = document.getElementById('session-bubbles')
const replyEl = document.getElementById('reply')

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

// ---- local behavior state (official client parity) ----
let transient = null           // 'eat' | 'play' | 'wake' | null
let transientUntil = 0
let joyUntil = 0
let dragReleaseUntil = 0
let walking = false
let walkingUntil = 0
let working = { active: false, until: 0 }
let blinkPhase = false
let blinkStartAt = 0
let nextBlinkAt = Date.now() + BLINK_MIN_INTERVAL_MS + Math.random() * (BLINK_MAX_INTERVAL_MS - BLINK_MIN_INTERVAL_MS)
let facing = 1                 // 1 = normal, -1 = mirrored
let nextFacingAt = Date.now() + FACING_MIN_INTERVAL_MS + Math.random() * (FACING_MAX_INTERVAL_MS - FACING_MIN_INTERVAL_MS)
let replyTimer = 0

// pointer state (B1): manual drag via IPC because a draggable app-region
// swallows clicks; the window follows the mouse deltas, a still press toggles
// the embedded DSH web window.
let pointerDown = null

// The manifest arrives over IPC from the main process (a file:// page cannot
// fetch() the DSH origin; <img> sprite loads below are fine).
window.pet.onManifest((m) => {
  manifest = m
  sheets.clear() // a manifest only arrives when it changes; drop stale sprite cache
})

window.pet.onScale((metrics) => {
  if (metrics && Number.isFinite(metrics.stage)) applyStage(metrics.stage)
})

// Debug overrides for tests: shorten SLEEP_AFTER_MS for fast sleep-capture,
// or fire one feed interaction to capture the eat/reply/joy sequence.
window.pet.onDebug((debug) => {
  if (debug && Number.isFinite(debug.sleepAfterMs) && debug.sleepAfterMs > 0) {
    SLEEP_AFTER_MS = debug.sleepAfterMs
    console.log(`[renderer] debug sleepAfterMs=${SLEEP_AFTER_MS}`)
  }
  if (debug && debug.interactTest === true) {
    setTimeout(() => window.pet.interact('feed'), 1200) // let the sprite load first
    console.log('[renderer] debug interactTest')
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

// ---- state selection (parity with the official STATE_TABLE priorities) ----
// Wall-clock decisions use Date.now() (absolute Unix ms), matching the
// server's absolute turnCompletedUntil deadline; the rAF timestamp is
// page-relative and would make the celebrate window appear never to expire.
function pickTarget(now) {
  if (!payload.online || !payload.state) return 'idle'
  const act = payload.state.activity || {}
  // 1. dragging overrides everything
  if (pointerDown) return sheetFor('drag') ? 'drag' : 'idle'
  // 2. brief idle buffer right after a drag drop (no hard switch to think/working)
  if (now < dragReleaseUntil) return 'idle'
  // 3. server activity burst window (welcome/celebrate/error/disappointed/...)
  if (typeof act.name === 'string' && act.name !== 'idle' && act.name !== 'working'
      && Number.isFinite(act.until) && act.until > now && sheetFor(act.name)) return act.name
  // 4. interaction transient (eat/play)
  if (transient && now < transientUntil) return transient
  // 5. waiting for user approval
  if (act.sessionWait === true) return 'wait'
  // 6. local turn-completed celebration (server deadline)
  if (Number.isFinite(act.turnCompletedUntil) && act.turnCompletedUntil > now) return 'celebrate'
  // 7. working interlude (random, think-only rhythm)
  if (working.active) return 'working'
  // 8. thinking is the companionship default while a session runs
  if (act.sessionThink === true) return 'think'
  // 9. post-interaction joy
  if (now < joyUntil) return 'joy'
  // 10. sleep after a long idle
  if ((act.name === 'idle' || typeof act.name !== 'string') && now - idleSince > SLEEP_AFTER_MS) return 'sleep'
  // 11. brief walk-back after a drag drop
  if (walking && now < walkingUntil) return sheetFor('walk') ? 'walk' : 'idle'
  // 12. named state the server pushed (working or others with a sheet)
  return typeof act.name === 'string' && sheetFor(act.name) ? act.name : 'idle'
}

/** Random working-interlude rhythm (parity with official nextWorkingRhythm). */
function updateWorking(now) {
  const think = payload.online && payload.state?.activity?.sessionThink === true
  if (!think) {
    working = { active: false, until: 0 }
    return
  }
  if (working.active) {
    if (now >= working.until) {
      // interlude over -> schedule the next one
      working = { active: false, until: now + WORKING_MIN_WAIT_MS + Math.random() * (WORKING_MAX_WAIT_MS - WORKING_MIN_WAIT_MS) }
    }
  } else if (now >= working.until) {
    working = { active: true, until: now + WORKING_MIN_DUR_MS + Math.random() * (WORKING_MAX_DUR_MS - WORKING_MIN_DUR_MS) }
  }
}

function drive(clock) {
  // `clock` is the rAF DOMHighResTimeStamp: page-relative, only good for
  // animation timing. All state decisions need the absolute wall clock.
  const now = Date.now()
  if (transient && now >= transientUntil) transient = null
  updateWorking(now)
  let target = pickTarget(now)

  // welcome once, shortly after the first online snapshot (held for WELCOME_MS)
  if (payload.online && !welcomed) {
    welcomed = true
    welcomeUntil = now + WELCOME_MS
  }
  if (now < welcomeUntil) target = 'welcome'
  // wake transition out of sleep (not while dragging or mid-interaction)
  if (animName === 'sleep' && target !== 'sleep' && !pointerDown && !transient) target = 'wake'
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
  let fi

  if (play === 'blink') {
    // frame 0 is the resting pose; a random interval triggers one blink pass
    // (frames 1..N-1) back to frame 0 (parity with official blink playback).
    if (blinkPhase) {
      const dur = (frames / fps) * 1000
      if (clock - blinkStartAt >= dur) {
        blinkPhase = false
        nextBlinkAt = now + BLINK_MIN_INTERVAL_MS + Math.random() * (BLINK_MAX_INTERVAL_MS - BLINK_MIN_INTERVAL_MS)
      }
      fi = Math.min(Math.floor(((clock - blinkStartAt) / 1000) * fps), frames - 1)
    } else {
      if (now >= nextBlinkAt) {
        blinkPhase = true
        blinkStartAt = clock
      }
      fi = 0
    }
  } else if (play === 'once') {
    fi = Math.min(Math.floor((elapsed / 1000) * fps), frames - 1)
  } else if (play === 'pingpong') {
    const period = Math.max(1, frames * 2 - 2)
    fi = Math.floor((elapsed / 1000) * fps)
    fi = ((fi % period) + period) % period
    if (fi >= frames) fi = period - fi
  } else {
    fi = Math.floor((elapsed / 1000) * fps)
    fi = ((fi % frames) + frames) % frames
  }
  animFrame = fi

  // random facing flips on static companion states (parity with official)
  if ((animName === 'idle' || animName === 'think' || animName === 'wait') && now >= nextFacingAt) {
    facing *= -1
    nextFacingAt = now + FACING_MIN_INTERVAL_MS + Math.random() * (FACING_MAX_INTERVAL_MS - FACING_MIN_INTERVAL_MS)
  }

  // motion transforms (cheap approximations of the web client's effects)
  gfx.clearRect(0, 0, stage, stage)
  gfx.save()
  if (facing < 0) {
    gfx.translate(stage, 0)
    gfx.scale(-1, 1)
  }
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

// ---- interaction (feed/play parity): eat/play transient + joy + reply bubble ----
window.pet.onInteractResult(({ action, reply }) => {
  transient = action === 'feed' ? 'eat' : 'play'
  transientUntil = Date.now() + TRANSIENT_MS
  joyUntil = Date.now() + TRANSIENT_MS + JOY_MS
  idleSince = Date.now() // interaction means the user is present
  if (typeof reply === 'string' && reply) showReply(reply)
})

function showReply(text) {
  replyEl.textContent = text
  replyEl.classList.add('show')
  clearTimeout(replyTimer)
  replyTimer = setTimeout(() => replyEl.classList.remove('show'), REPLY_MS)
}

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
  sessionBubblesEl.replaceChildren()
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
    sessionBubblesEl.append(bubble)
  }
})

// ---- pointer handling (B1 + drag) ----
// Manual drag: mousedown starts tracking, mousemove reports deltas to the main
// process (which moves the window), a press that never moved toggles the web
// window. Right-click opens the menu (size presets + feed/play + web toggle).
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
  const moved = Math.hypot(dx, dy) > CLICK_MAX_MOVE
  pointerDown = null
  window.pet.dragEnd()
  if (moved) {
    // drag dropped: brief idle buffer + a short walk-back; user presence
    // restarts the idle clock so the pet does not drop straight back to sleep.
    dragReleaseUntil = Date.now() + DRAG_RELEASE_MS
    walking = true
    walkingUntil = Date.now() + WALK_MS
    idleSince = Date.now()
  } else {
    window.pet.toggleWeb()
  }
})
canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  window.pet.openMenu()
})

requestAnimationFrame(drive)
