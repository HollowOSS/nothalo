import type { Input } from './input.ts'
import { touchIcon } from './touch-icons.ts'
import { TOUCH_DEFAULTS, TOUCH_LAYOUT_KEY, defaultTouchLayout, parseTouchLayout, placeTouchControl, serializeTouchLayout, type TouchBounds, type TouchControlId, type TouchLayout } from './touch-layout.ts'

const LOOK_SPEED = .0045
const SENSITIVITY_KEY = 'halo-ce.touch-sensitivity'
const MIN_HOLD_MS = 120
/** CSS pixels, independent of sensitivity: tolerate tap jitter before choosing a look swipe. */
const LOOK_DRAG_PX = 8

export function wantsTouchControls(): boolean {
  const forced = new URLSearchParams(location.search).get('touch')
  if (forced === '1') return true
  if (forced === '0') return false
  return matchMedia('(pointer: coarse)').matches
}

export interface TouchContext {
  pickupLeft?:boolean
  /** A weapon is in reach, so Use means pick up (right hand) rather than board or drop. */
  pickup?:boolean
  /** The key the vehicle boosts on while held ('Space' Ghost/Chopper, 'ShiftLeft' Banshee); absent when it cannot. */
  boost?: string
  /** A vehicle is in reach, so Use means board it. */
  board?:boolean
  dualWield?:boolean
  vehicleBrake?: boolean
  passenger?: boolean
  vehicle: boolean
  seated: boolean
  vehicleCanFire: boolean
  jump: boolean
  horn: boolean
  seat: boolean
  zoom: boolean
  /** The game type carries grenades (not SWAT). */
  grenades?: boolean
  aiming?: boolean
}

interface ButtonSpec {
  id: Exclude<TouchControlId, 'move'>
  hold?: string
  tap?: string
  fire?: boolean
  rotates?: boolean
  toggle?: boolean
  needs?: keyof TouchContext
}

const BUTTONS: readonly ButtonSpec[] = [
  { id: 'fire', fire: true, rotates: true },
  { id: 'jump', hold: 'Space', needs: 'jump' },
  { id: 'horn', hold: 'Space', needs: 'horn' },
  { id: 'boost', hold: 'Space', needs: 'boost' },
  { id: 'crouch', hold: 'ShiftLeft', toggle: true },
  { id: 'aim', tap: 'KeyZ', needs: 'zoom' },
  { id: 'reload', tap: 'KeyR' },
  { id: 'swap', tap: 'Digit1' },
  { id: 'melee', tap: 'KeyF' },
  { id: 'grenade', tap: 'KeyG', needs: 'grenades' },
  { id: 'seat', tap: 'KeyT', needs: 'seat' },
  { id: 'pickup-left', tap: 'KeyQ', needs: 'pickupLeft' },
  { id: 'use', tap: 'KeyE', needs: 'vehicle' },
  { id: 'left-fire', fire: true },
]

interface TouchButton {
  spec: ButtonSpec
  el: HTMLButtonElement
  pointers: Set<number>
  pressed: boolean
  downAt: number
  releaseTimer?: ReturnType<typeof setTimeout>
}

type TouchPointer = { kind: 'stick' | 'look' | 'settings'; x: number; y: number }
  | { kind: 'button'; x: number; y: number; button: TouchButton }

const CSS = `
.pad {position:fixed;inset:0;z-index:5;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;font-family:ui-sans-serif,system-ui,sans-serif;}
.pad *, .pad *:before, .pad *:after {box-sizing:border-box;}
.pad button {font:inherit;touch-action:none;-webkit-tap-highlight-color:transparent;}
.pad .surface {position:absolute;inset:0;}
.pad .safe-probe {position:fixed;top:env(safe-area-inset-top,0px);right:env(safe-area-inset-right,0px);bottom:env(safe-area-inset-bottom,0px);left:env(safe-area-inset-left,0px);visibility:hidden;pointer-events:none;}
.pad .control {position:absolute;transform:translate(-50%,-50%);opacity:var(--control-opacity,.8);border:1px solid #ffffff50;border-radius:50%;color:#fff;background:rgba(12,14,15,.48);padding:0;display:grid;place-items:center;touch-action:none;}
.pad .control svg {width:72%;height:72%;pointer-events:none;filter:drop-shadow(0 1px 1px #0006);}
.pad .control.fire:after {content:'';position:absolute;inset:11%;border:1px solid #ffffff48;border-radius:50%;pointer-events:none;}
.pad .control[data-control='left-fire']:after {display:none;}
.pad .control.on {background:#ffffff46;border-color:#fff;}
.pad .control[aria-disabled='true'] {opacity:calc(var(--control-opacity,.8) * .48);}
.pad .control:focus-visible, .pad .settings:focus-visible {outline:2px solid #f8dc6b;outline-offset:4px;}
.pad .control-label {display:none;}
.pad .control.pop {animation:pad-pop .22s cubic-bezier(.3,1.6,.5,1);}
.pad .control[data-control='pickup-left'],.pad .control[data-icon='pickup-right'],.pad .control[data-icon='board'] {border-color:#8fd0ffcc;color:#d6efff;box-shadow:0 0 10px #4aa8ff55;}
@keyframes pad-pop {from {transform:translate(-50%,-50%) scale(.45);opacity:0;} to {transform:translate(-50%,-50%) scale(1);}}
.pad .stick {background:#17191b30;border-color:#ffffff55;}
.pad .stick svg {position:absolute;width:96%;height:96%;opacity:.65;}
.pad .stick i {width:40%;height:40%;border-radius:50%;background:#ffffff70;border:1px solid #ffffffa0;pointer-events:none;}
.pad .settings {position:absolute;right:calc(env(safe-area-inset-right,0px) + 10px);top:calc(env(safe-area-inset-top,0px) + 10px);width:42px;height:42px;padding:8px;border:1px solid #ffffff60;border-radius:50%;color:#fff;background:#17191b80;display:grid;place-items:center;z-index:4;}
.pad .settings svg {width:100%;height:100%;pointer-events:none;}
.pad .layout-panel {display:none;position:absolute;top:calc(env(safe-area-inset-top,0px) + 8px);left:50%;transform:translateX(-50%);width:min(480px,72vw);max-height:calc(100dvh - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px) - 16px);overflow-y:auto;padding:8px 12px;background:#151a20d6;border:1px solid #ffffff30;border-radius:10px;color:#f7f8fa;box-shadow:0 6px 22px #0004;z-index:6;}
.pad.editing .layout-panel {display:block;}
.pad.editing .surface {background-color:#03091270;background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:5vw 5vh;}
.pad.editing .control {border:1.5px dashed #ffe180;cursor:grab;opacity:max(.5,var(--control-opacity));}
.pad.editing .control.selected {border:2px solid #ffe180;box-shadow:0 0 0 4px #ffe18030;z-index:3;}
.pad.editing .control-label {display:block;position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);white-space:nowrap;font-size:11px;font-weight:600;text-shadow:0 1px 3px #000;pointer-events:none;}
.pad.editing .settings {visibility:hidden;}
.pad .layout-heading {display:flex;align-items:center;justify-content:space-between;gap:12px;}
.pad .layout-title {margin:0;font-size:15px;font-weight:700;letter-spacing:.02em;}
.pad .layout-actions {display:flex;gap:6px;}
.pad .layout-actions button {border:1px solid #ffffff30;background:#ffffff0c;color:#e4e8ee;min-height:44px;padding:5px 9px;border-radius:6px;font-size:12px;font-weight:600;}
.pad .layout-actions .save {background:#f5d76c;color:#161a20;border-color:#f5d76c;}
.pad .layout-help {margin:3px 0 5px;color:#d1d7df;font-size:11px;}
.pad .layout-footer {display:flex;align-items:center;justify-content:space-between;gap:10px;}
.pad .layout-footer .layout-help {flex:1;min-width:0;}
.pad .leave {flex:none;border:1px solid #ff8f7a80;background:#ff5a3c1c;color:#ffd4cb;min-height:44px;padding:5px 12px;border-radius:6px;font-size:12px;font-weight:600;}
.pad .leave.confirm {background:#e0482c;border-color:#e0482c;color:#fff;}
.pad .sensitivity {display:flex;align-items:center;gap:10px;font-size:12px;}
.pad .sensitivity input {flex:1;min-width:0;height:32px;margin:0;accent-color:#f5d76c;touch-action:auto;}
.pad .sensitivity output {min-width:3.5em;text-align:right;font-variant-numeric:tabular-nums;}
.pad .layout-inspector {display:flex;gap:14px;align-items:center;border-top:1px solid #ffffff1a;padding-top:10px;}
.pad .selected-name {font-size:12px;font-weight:600;min-width:82px;}
.pad .layout-inspector label {flex:1;min-width:0;font-size:11px;color:#bbc5d0;display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
.pad .layout-inspector output {margin-left:auto;font-variant-numeric:tabular-nums;color:#fff;}
.pad .layout-inspector input {width:100%;margin:0;accent-color:#f5d76c;height:20px;touch-action:auto;}
.pad .layout-notice {position:absolute;bottom:calc(env(safe-area-inset-bottom,0px) + 10px);left:50%;transform:translateX(-50%);max-width:75vw;border-radius:8px;padding:10px 16px;background:#151a20ee;color:#fff;font-size:13px;text-align:center;z-index:7;pointer-events:none;}
.pad .layout-notice:empty {display:none;}
.pad .rotate {position:absolute;inset:0;display:none;place-content:center;text-align:center;background:#040a12ed;color:#fff;font:500 16px ui-sans-serif,system-ui,sans-serif;padding:24px;z-index:10;}
@media (max-height:430px) {.pad .layout-inspector {padding-top:6px;gap:10px;}.pad .layout-title {font-size:13px;}}
@media (orientation:portrait) {.pad .rotate {display:grid;}.pad .control,.pad .settings,.pad.editing .layout-panel {display:none!important;}}
`

/** Production touch input and its editor share the same button elements and hit targets. */
export class TouchControls {
  private readonly root = document.createElement('div')
  private readonly stick = document.createElement('div')
  private readonly knob = document.createElement('i')
  private readonly safeProbe = document.createElement('div')
  private readonly settings = document.createElement('button')
  private readonly panel = document.createElement('div')
  private readonly notice = document.createElement('div')
  private readonly buttons = new Map<TouchControlId, TouchButton>()
  private readonly elements = new Map<TouchControlId, HTMLElement>()
  private readonly pointers = new Map<number, TouchPointer>()
  private settingsDragged = false
  private stickPointer: number | null = null
  private fireHeld = false
  private readonly heldKeys = new Set<string>()
  private layout: TouchLayout = defaultTouchLayout()
  private bounds: TouchBounds = { left: 0, top: 0, width: innerWidth, height: innerHeight }
  private context: TouchContext = { vehicle: false, seated: false, vehicleCanFire: false, jump: true, horn: false, seat: false, zoom: false, grenades: true }
  private editing = false
  private beforeEdit = ''
  private sensitivity = 1
  private beforeSensitivity = 1
  private selected: TouchControlId = 'fire'
  private drag: { pointer: number; id: TouchControlId; dx: number; dy: number } | null = null
  private noticeTimer?: ReturnType<typeof setTimeout>
  private layoutFrame = 0
  private readonly boundsObserver = new ResizeObserver(() => this.scheduleLayout())

  constructor(private readonly input: Input) {
    try {
      const saved = Number(localStorage.getItem(SENSITIVITY_KEY))
      if (Number.isFinite(saved) && saved >= .25 && saved <= 3) this.sensitivity = saved
    } catch { /* Private browsing may disable storage. */ }
    try {
      this.layout = parseTouchLayout(localStorage.getItem(TOUCH_LAYOUT_KEY))
      // Store a normalized layout on first load so a fresh phone has durable defaults and
      // damaged/older storage is repaired without disturbing any valid custom positions.
      this.persistLayout()
    } catch { /* Private browsing may disable storage. */ }
    const style = document.createElement('style')
    style.textContent = CSS
    this.root.className = 'pad'
    this.root.style.display = 'none'
    this.root.append(style)
    this.safeProbe.className = 'safe-probe'
    this.root.append(this.safeProbe)
    const surface = document.createElement('div')
    surface.className = 'surface'
    this.root.append(surface)

    this.stick.className = 'control stick'
    this.stick.dataset.control = 'move'
    this.stick.tabIndex = 0
    this.stick.setAttribute('aria-label', 'Movement stick')
    this.stick.innerHTML = touchIcon('move') + '<span class="control-label">Movement</span>'
    this.stick.append(this.knob)
    this.elements.set('move', this.stick)
    this.root.append(this.stick)
    this.stick.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation()
      if (this.editing) this.startDrag(e, 'move', this.stick)
      else if (this.input.active && innerWidth > innerHeight) this.beginStick(e, this.stick)
    })
    for (const spec of BUTTONS) this.root.append(this.build(spec))

    this.settings.type = 'button'
    this.settings.className = 'settings'
    this.settings.setAttribute('aria-label', 'Customize touch controls')
    this.settings.title = 'Customize controls'
    this.settings.innerHTML = touchIcon('settings')
    this.settings.addEventListener('pointerdown', e => {
      if (!this.input.active || this.editing || innerHeight > innerWidth) return
      e.preventDefault(); e.stopPropagation()
      this.settingsDragged = false
      this.settings.setPointerCapture(e.pointerId)
      this.pointers.set(e.pointerId, { kind: 'settings', x: e.clientX, y: e.clientY })
    })
    this.settings.addEventListener('click', e => {
      if (e.detail === 0 || !this.settingsDragged) this.openEditor()
    })
    this.root.append(this.settings)
    this.buildEditor()
    this.notice.className = 'layout-notice'
    this.notice.setAttribute('role', 'status')
    this.root.append(this.notice)
    const rotate = document.createElement('div')
    rotate.className = 'rotate'
    rotate.textContent = 'Turn your phone sideways to play.'
    this.root.append(rotate)

    surface.addEventListener('pointerdown', this.onDown)
    addEventListener('pointermove', this.onMove, { passive: false })
    addEventListener('pointerup', this.onUp)
    addEventListener('pointercancel', this.onUp)
    this.root.addEventListener('lostpointercapture', this.onUp)
    addEventListener('resize', this.onResize)
    screen.orientation?.addEventListener('change', this.onResize)
    window.visualViewport?.addEventListener('resize', this.onResize)
    addEventListener('blur', this.releaseAll)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    for (const name of ['dblclick', 'gesturestart', 'gesturechange', 'gestureend']) {
      this.root.addEventListener(name, this.preventGesture, { passive: false })
    }
    this.root.addEventListener('keydown', this.onEditorKey, true)
    document.body.append(this.root)
    this.boundsObserver.observe(this.safeProbe)
  }

  setVisible(visible: boolean): void {
    if ((this.root.style.display !== 'none') === visible) return
    if (!visible) {
      if (this.editing) this.closeEditor(true)
      this.releaseAll()
    }
    this.root.style.display = visible ? 'block' : 'none'
    if (visible) this.relayout()
    if (visible) this.scheduleLayout()
  }

  setContext(context: TouchContext): void {
    const seatChanged = context.dualWield !== this.context.dualWield || context.seated !== this.context.seated || context.vehicleCanFire !== this.context.vehicleCanFire
    // Getting in or out swaps what the buttons mean (jump becomes horn), so drop every held
    // action. Fingers stay on the glass: the stick keeps steering and a swipe keeps turning.
    if (seatChanged) this.releaseActions()
    this.context = context
    if (seatChanged) this.relayout()
    this.refreshButtons()
  }

  private refreshButtons(): void {
    for (const button of this.buttons.values()) {
      const { spec, el } = button
      const vehicleAction = (spec.id==='crouch'&&this.context.vehicleBrake) || (spec.id==='reload'&&this.context.passenger) || (spec.id==='jump'&&this.context.jump) || (spec.id==='boost'&&!!this.context.boost) || spec.id === 'use' || spec.id === 'seat' || (spec.id === 'fire' && this.context.vehicleCanFire)
      const allowed = !this.context.seated || vehicleAction
      const available = allowed && (!spec.needs || !!this.context[spec.needs])
      // Aim remains discoverable for every loadout. Vehicle controls appear when useful.
      const visible = this.editing
        ? spec.id === 'horn' ? this.context.horn : spec.id === 'boost' ? !!this.context.boost : spec.id === 'jump' ? !this.context.horn && !this.context.boost : true
        : available || (spec.id === 'aim' && !this.context.seated)
      const display = visible ? 'grid' : 'none'
      if (el.style.display !== display) {
        // Buttons that only exist for something in reach (pickups, a vehicle) pop in so the thumb notices them.
        if (visible && spec.needs && !this.editing) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop') }
        el.style.display = display
      }
      if (spec.id === 'use') {
        const icon = this.context.pickup && !this.context.seated ? 'pickup-right' : this.context.board && !this.context.seated ? 'board' : 'use'
        if (el.dataset.icon !== icon) { el.dataset.icon = icon; el.querySelector('svg')!.outerHTML = touchIcon(icon) }
      }
      const disabled = !this.editing && !available
      const disabledValue = String(disabled)
      if (el.getAttribute('aria-disabled') !== disabledValue) el.setAttribute('aria-disabled', disabledValue)
      if (disabled && button.pressed) this.clearButton(button)
      const active = spec.id === 'aim' ? !!this.context.aiming : button.pressed
      el.classList.toggle('on', !this.editing && active)
      if (spec.toggle || spec.id === 'aim') el.setAttribute('aria-pressed', String(active))
    }
  }

  private build(spec: ButtonSpec): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `control${spec.fire ? ' fire' : ''}`
    el.dataset.control = spec.id
    const label = TOUCH_DEFAULTS[spec.id].label
    el.setAttribute('aria-label', label)
    el.title = label
    el.innerHTML = touchIcon(spec.id) + `<span class="control-label">${label}</span>`
    const button: TouchButton = { spec, el, pointers: new Set(), pressed: false, downAt: 0 }
    this.buttons.set(spec.id, button)
    this.elements.set(spec.id, el)
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation()
      if (this.editing) { this.startDrag(e, spec.id, el); return }
      this.pressButton(e, button)
    })
    return el
  }

  /** Start a button from either its element or its forgiving surface hit area. */
  private pressButton(e: PointerEvent, button: TouchButton): void {
    const { spec, el } = button
    if (!this.input.active || innerHeight > innerWidth) return
    el.setPointerCapture(e.pointerId)
    // Even a visible, unavailable action (such as scope on a weapon without zoom) must not
    // make a dead patch in the look surface.
    if (el.getAttribute('aria-disabled') === 'true') {
      this.pointers.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY })
      return
    }
    if (button.releaseTimer) clearTimeout(button.releaseTimer)
    button.releaseTimer = undefined
    button.pointers.add(e.pointerId)
    button.downAt = performance.now()
    // Fire and held actions remain immediate. Discrete actions wait until release so a
    // swipe can win without first throwing a grenade, changing weapons or toggling crouch.
    if (!spec.tap && !spec.toggle) button.pressed = true
    this.pointers.set(e.pointerId, spec.rotates
      ? { kind: 'look', x: e.clientX, y: e.clientY }
      : { kind: 'button', x: e.clientX, y: e.clientY, button })
    this.syncActions()
    this.refreshButtons()
  }

  /** Aggregate both fire buttons so releasing one finger cannot cancel the other trigger. */
  private syncActions(): void {
    let fire = false, altFire=false
    const keys = new Set<string>()
    for (const { spec, pressed } of this.buttons.values()) {
      if (!pressed) continue
      if (spec.fire) {if(this.context.dualWield&&spec.id==='left-fire')altFire=true;else fire=true}
      const hold = spec.id === 'boost' ? this.context.boost : spec.hold
      if (hold) keys.add(hold)
    }
    this.input.setAltFire(altFire)
    if (this.fireHeld !== fire) { this.input.setFire(fire); this.fireHeld = fire }
    for (const key of this.heldKeys) if (!keys.has(key)) this.input.hold(key, false)
    for (const key of keys) if (!this.heldKeys.has(key)) this.input.hold(key, true)
    this.heldKeys.clear()
    for (const key of keys) this.heldKeys.add(key)
  }

  private clearButton(button: TouchButton): void {
    if (button.releaseTimer) clearTimeout(button.releaseTimer)
    button.releaseTimer = undefined
    button.pressed = false
    button.el.classList.remove('on')
    this.syncActions()
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault()
    if (this.editing || !this.input.active || innerHeight > innerWidth) return
    const leftFire = this.buttons.get('left-fire')
    if (leftFire && this.nearControl('left-fire', e.clientX, e.clientY, 14)) {
      this.pressButton(e, leftFire)
    } else if (this.nearMovementStick(e.clientX, e.clientY)) {
      this.beginStick(e, e.currentTarget as HTMLElement)
    } else {
      const surface = e.currentTarget as HTMLElement
      surface.setPointerCapture(e.pointerId)
      this.pointers.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY })
    }
  }

  private nearControl(id: TouchControlId, clientX: number, clientY: number, slop: number): boolean {
    const { x, y, size } = placeTouchControl(id, this.layout, this.bounds)
    return Math.hypot(clientX - x, clientY - y) <= size / 2 + slop
  }

  private nearMovementStick(clientX: number, clientY: number): boolean {
    const { x, y, size } = placeTouchControl('move', this.layout, this.bounds)
    // Keep a generous thumb margin, but do not let the whole lower-left half of the screen
    // become a hidden movement button when the player is trying to fire.
    return Math.hypot(clientX - x, clientY - y) <= size * .78
  }

  private beginStick(e: PointerEvent, element: HTMLElement): void {
    // The newest thumb on the stick owns it. Only one thumb reaches it in play, so an older
    // owner is a touch whose release the browser never delivered, and it must not lock
    // movement until the page is reloaded.
    if (this.stickPointer !== null) this.pointers.delete(this.stickPointer)
    const { x, y } = placeTouchControl('move', this.layout, this.bounds)
    this.stickPointer = e.pointerId
    element.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, { kind: 'stick', x, y })
    this.onMove(e)
  }

  private onMove = (e: PointerEvent): void => {
    if (this.editing) {
      if (this.drag?.pointer !== e.pointerId) return
      e.preventDefault()
      const { id, dx, dy } = this.drag
      this.layout[id].x = (e.clientX - dx - this.bounds.left) / this.bounds.width
      this.layout[id].y = (e.clientY - dy - this.bounds.top) / this.bounds.height
      this.applyPlacement(id, true)
      return
    }
    let p = this.pointers.get(e.pointerId)
    if (!p) return
    e.preventDefault()
    if (p.kind === 'button' || p.kind === 'settings') {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < LOOK_DRAG_PX) return
      if (p.kind === 'settings') this.settingsDragged = true
      // Keep the original start point for this first delta: crossing the threshold must
      // not discard the beginning of the swipe. Capture stays with its original element.
      p = { kind: 'look', x: p.x, y: p.y }
      this.pointers.set(e.pointerId, p)
    }
    if (p.kind === 'look') {
      this.input.lookBy(-(e.clientX - p.x) * LOOK_SPEED * this.sensitivity, -(e.clientY - p.y) * LOOK_SPEED * this.sensitivity)
      p.x = e.clientX; p.y = e.clientY
      return
    }
    const range = placeTouchControl('move', this.layout, this.bounds).size * .34
    const dx = e.clientX - p.x, dy = e.clientY - p.y
    const length = Math.hypot(dx, dy)
    const scale = length > range ? range / length : 1
    this.knob.style.transform = `translate(${dx * scale}px,${dy * scale}px)`
    this.input.stickX = dx * scale / range
    this.input.stickY = -dy * scale / range
  }

  private onUp = (e: PointerEvent): void => {
    if (this.drag?.pointer === e.pointerId) { this.drag = null; this.persistLayout() }
    if (e.type === 'lostpointercapture' && this.pointers.has(e.pointerId)) { this.onLostCapture(e); return }
    // Some devices coalesce a short flick into down/up without a final move event.
    if (e.type === 'pointerup') this.onMove(e)
    const p = this.pointers.get(e.pointerId)
    if (p?.kind === 'settings' && e.type !== 'pointerup') this.settingsDragged = true
    if (p?.kind === 'button' && e.type === 'pointerup' && p.button.el.getAttribute('aria-disabled') !== 'true') {
      const { spec } = p.button
      if (spec.tap) this.input.tap(spec.tap)
      if (spec.toggle) { p.button.pressed = !p.button.pressed; this.syncActions(); this.refreshButtons() }
    }
    for (const button of this.buttons.values()) {
      if (!button.pointers.delete(e.pointerId) || button.spec.toggle || button.pointers.size) continue
      const delay = e.type !== 'pointerup' || button.spec.tap ? 0 : Math.max(0, MIN_HOLD_MS - (performance.now() - button.downAt))
      if (delay) button.releaseTimer = setTimeout(() => this.clearButton(button), delay)
      else this.clearButton(button)
    }
    this.pointers.delete(e.pointerId)
    if (this.stickPointer !== e.pointerId) return
    this.stickPointer = null
    this.input.stickX = this.input.stickY = 0
    this.knob.style.transform = ''
  }

  /**
   * A button hidden under a finger (Use as the player walks away from a vehicle, Fire on
   * taking the wheel) takes its capture with it. The finger is still down, and the window
   * still hears its moves and its release, so it stops pressing the button and keeps looking.
   */
  private onLostCapture(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId)!
    if (p.kind === 'settings') this.settingsDragged = true
    if (p.kind === 'button' || p.kind === 'settings') this.pointers.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY })
    for (const button of this.buttons.values()) {
      if (button.pointers.delete(e.pointerId) && !button.spec.toggle && !button.pointers.size) this.clearButton(button)
    }
  }

  private relayout(): void {
    const rect = this.safeProbe.getBoundingClientRect()
    const viewportWidth = window.visualViewport?.width || innerWidth
    const viewportHeight = window.visualViewport?.height || innerHeight
    const measured = rect.width > 1 && rect.height > 1
    this.bounds = measured
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : { left: 0, top: 0, width: viewportWidth, height: viewportHeight }
    for (const id of this.elements.keys()) this.applyPlacement(id)
    const stick = this.stickPointer === null ? undefined : this.pointers.get(this.stickPointer)
    if (stick?.kind === 'stick') Object.assign(stick, placeTouchControl('move', this.layout, this.bounds))
  }

  private scheduleLayout(): void {
    cancelAnimationFrame(this.layoutFrame)
    this.layoutFrame = requestAnimationFrame(() => {
      // iOS can deliver orientation/visualViewport resize before env(safe-area-inset-*)
      // settles. Measure once more on the following frame so first-load placement is correct.
      this.layoutFrame = requestAnimationFrame(() => {
        if (this.root.style.display !== 'none') this.relayout()
      })
    })
  }

  private persistLayout(): boolean {
    try { localStorage.setItem(TOUCH_LAYOUT_KEY, serializeTouchLayout(this.layout)); return true }
    catch { return false }
  }

  private applyPlacement(id: TouchControlId, storePosition = false): void {
    const el = this.elements.get(id)!
    // Keep the driving view clear without overwriting the saved on-foot layout.
    const vehicleUtility = this.context.seated && !this.editing && (id === 'use' || id === 'seat')
    const placement = vehicleUtility ? {
      ...this.layout, [id]: { ...this.layout[id], x: id === 'use' ? .08 : .20, y: .30 },
    } : this.layout
    const { x, y, size } = placeTouchControl(id, placement, this.bounds)
    if (storePosition) {
      this.layout[id].x = (x - this.bounds.left) / this.bounds.width
      this.layout[id].y = (y - this.bounds.top) / this.bounds.height
    }
    el.style.left = `${x}px`; el.style.top = `${y}px`
    el.style.width = el.style.height = `${size}px`
    el.style.setProperty('--control-opacity', String(this.layout[id].opacity))
  }

  private buildEditor(): void {
    this.panel.className = 'layout-panel'
    this.panel.innerHTML = `
      <div class="layout-heading"><h2 class="layout-title" id="touch-layout-title">Touch settings</h2>
        <div class="layout-actions"><button type="button" data-action="reset">Reset</button><button type="button" data-action="cancel">Cancel</button><button type="button" class="save" data-action="save">Save</button></div>
      </div>
      <label class="sensitivity">Look sensitivity <input aria-label="Look sensitivity" data-setting="sensitivity" type="range" min="25" max="300" step="5"><output id="touch-sensitivity-output"></output></label>
      <div class="layout-footer"><p class="layout-help">Drag controls to move. Auto-saved here; Cancel undoes edits.</p>
        <button type="button" class="leave" data-action="leave">Main menu</button></div>
      <div class="layout-inspector"><span class="selected-name">Fire</span>
        <label>Size <output id="touch-size-output">100%</output><input aria-label="Selected control size" data-setting="scale" type="range" min="65" max="160" step="5" value="100"></label>
        <label>Opacity <output id="touch-opacity-output">80%</output><input aria-label="Selected control opacity" data-setting="opacity" type="range" min="25" max="100" step="5" value="80"></label>
      </div>`
    this.panel.querySelector('[data-action="save"]')!.addEventListener('click', () => this.closeEditor(true))
    this.panel.querySelector('[data-action="cancel"]')!.addEventListener('click', () => this.closeEditor(false))
    this.panel.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
      this.layout = defaultTouchLayout(); this.relayout(); this.selectControl(this.selected)
      this.sensitivity = 1; this.refreshSensitivity(); this.persistSensitivity()
      this.persistLayout()
    })
    // Phones have no Escape key to reach the pause screen's level list, so the way out lives
    // here. It asks for a second tap, because leaving ends the match.
    const leave = this.panel.querySelector<HTMLButtonElement>('[data-action="leave"]')!
    let leaveTimer: ReturnType<typeof setTimeout> | undefined
    leave.addEventListener('click', () => {
      if (!leave.classList.contains('confirm')) {
        leave.classList.add('confirm'); leave.textContent = 'Tap again to leave'
        clearTimeout(leaveTimer)
        leaveTimer = setTimeout(() => { leave.classList.remove('confirm'); leave.textContent = 'Main menu' }, 3000)
        return
      }
      this.persistLayout(); this.persistSensitivity()
      location.href = '/'
    })
    this.panel.querySelector<HTMLInputElement>('[data-setting="sensitivity"]')!.addEventListener('input', e => {
      this.sensitivity = Number((e.target as HTMLInputElement).value) / 100
      this.refreshSensitivity()
      this.persistSensitivity()
    })
    this.refreshSensitivity()
    this.panel.querySelectorAll<HTMLInputElement>('.layout-inspector input').forEach(slider => {
      slider.addEventListener('input', () => {
        const setting = slider.dataset.setting as 'scale' | 'opacity'
        this.layout[this.selected][setting] = Number(slider.value) / 100
        this.applyPlacement(this.selected, true)
        this.selectControl(this.selected)
        this.persistLayout()
      })
    })
    this.root.append(this.panel)
  }

  private openEditor = (): void => {
    if (this.editing) return
    this.releaseAll()
    this.beforeEdit = serializeTouchLayout(this.layout)
    this.beforeSensitivity = this.sensitivity
    this.editing = true
    this.input.setUIBlocked(true)
    if (document.pointerLockElement) { this.input.fallback = true; document.exitPointerLock() }
    this.root.classList.add('editing')
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-modal', 'true')
    this.root.setAttribute('aria-labelledby', 'touch-layout-title')
    this.refreshButtons()
    this.relayout()
    this.selectControl('fire')
    this.panel.querySelector<HTMLButtonElement>('[data-action="save"]')!.focus()
  }

  private closeEditor(save: boolean): void {
    if (!this.editing) return
    let message = ''
    if (save) {
      const layoutSaved = this.persistLayout(), sensitivitySaved = this.persistSensitivity()
      message = layoutSaved && sensitivitySaved ? 'Touch settings saved' : 'Settings applied for this session. Browser storage is unavailable.'
    } else {
      this.layout = parseTouchLayout(this.beforeEdit); this.persistLayout()
      this.sensitivity = this.beforeSensitivity; this.refreshSensitivity(); this.persistSensitivity()
    }
    this.editing = false
    this.drag = null
    this.root.classList.remove('editing')
    for (const attr of ['role', 'aria-modal', 'aria-labelledby']) this.root.removeAttribute(attr)
    for (const el of this.elements.values()) el.classList.remove('selected')
    this.releaseAll()
    this.input.setUIBlocked(false)
    this.relayout()
    this.refreshButtons()
    this.settings.focus({ preventScroll: true })
    if (message) {
      this.notice.textContent = message
      clearTimeout(this.noticeTimer)
      this.noticeTimer = setTimeout(() => { this.notice.textContent = '' }, 3500)
    }
  }

  private persistSensitivity(): boolean {
    try { localStorage.setItem(SENSITIVITY_KEY, String(this.sensitivity)); return true }
    catch { return false }
  }

  private refreshSensitivity(): void {
    this.panel.querySelector<HTMLInputElement>('[data-setting="sensitivity"]')!.value = String(Math.round(this.sensitivity * 100))
    this.panel.querySelector('#touch-sensitivity-output')!.textContent = `${this.sensitivity.toFixed(2)}×`
  }

  private selectControl(id: TouchControlId): void {
    this.selected = id
    for (const [key, el] of this.elements) el.classList.toggle('selected', key === id)
    this.panel.querySelector('.selected-name')!.textContent = TOUCH_DEFAULTS[id].label
    for (const setting of ['scale', 'opacity'] as const) {
      const value = Math.round(this.layout[id][setting] * 100)
      this.panel.querySelector<HTMLInputElement>(`[data-setting="${setting}"]`)!.value = String(value)
      this.panel.querySelector(`#touch-${setting === 'scale' ? 'size' : setting}-output`)!.textContent = `${value}%`
    }
  }

  private startDrag(e: PointerEvent, id: TouchControlId, el: HTMLElement): void {
    if (this.drag) return
    this.selectControl(id)
    const { x, y } = placeTouchControl(id, this.layout, this.bounds)
    this.drag = { pointer: e.pointerId, id, dx: e.clientX - x, dy: e.clientY - y }
    el.setPointerCapture(e.pointerId)
    el.focus({ preventScroll: true })
  }

  private onEditorKey = (e: KeyboardEvent): void => {
    if (!this.editing) return
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeEditor(false); return }
    const target = e.target as HTMLElement
    if (!target.dataset.control || !e.code.startsWith('Arrow')) return
    e.preventDefault(); e.stopPropagation()
    const id = target.dataset.control as TouchControlId
    this.selectControl(id)
    const delta = e.shiftKey ? .0025 : .01
    if (e.code === 'ArrowLeft') this.layout[id].x -= delta
    if (e.code === 'ArrowRight') this.layout[id].x += delta
    if (e.code === 'ArrowUp') this.layout[id].y -= delta
    if (e.code === 'ArrowDown') this.layout[id].y += delta
    this.applyPlacement(id, true)
    this.persistLayout()
  }

  /**
   * The browser's toolbar showing or hiding resizes the viewport in the middle of play; the
   * fingers on the glass carry on. Only turning to portrait, which hides the pad, ends them.
   */
  private onResize = (): void => {
    if (this.editing) this.persistLayout()
    if (innerHeight > innerWidth) this.releaseAll()
    this.scheduleLayout()
  }
  private preventGesture = (e: Event): void => { if (this.root.style.display !== 'none') e.preventDefault() }
  private onVisibilityChange = (): void => {
    if (document.hidden) { if (this.editing) this.persistLayout(); this.releaseAll() }
    else this.scheduleLayout()
  }

  /** Drop every held or pending action; stick and look fingers keep working. */
  private releaseActions(): void {
    for (const [id, p] of this.pointers) if (p.kind === 'button') this.pointers.set(id, { kind: 'look', x: p.x, y: p.y })
    for (const button of this.buttons.values()) {
      if (button.releaseTimer) clearTimeout(button.releaseTimer)
      button.releaseTimer = undefined
      button.pointers.clear()
      button.pressed = false
      button.el.classList.remove('on')
    }
    this.syncActions()
  }

  private releaseAll = (): void => {
    // A cancelled settings touch must not open the panel if the browser later emits click.
    if ([...this.pointers.values()].some(p => p.kind === 'settings')) this.settingsDragged = true
    this.pointers.clear()
    this.stickPointer = null
    this.drag = null
    this.knob.style.transform = ''
    this.input.stickX = this.input.stickY = 0
    this.releaseActions()
  }
}
