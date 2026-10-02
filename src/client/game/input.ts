import type { PlayerInput } from '../../shared/movement.ts'
import { ScopedAim } from './scoped-aim.ts'

/**
 * Keyboard and mouse, sampled every frame.
 *
 * Look is accumulated from raw mouse deltas rather than read from an element, because pointer
 * lock is the only way an FPS can turn past the edge of the window. Movement keys are read as
 * held state, not events, so a frame never misses a keypress that started mid-frame.
 *
 * Touch drives the same state through `hold`, `tap`, `setFire` and the analogue stick fields,
 * so nothing downstream of here knows or cares which one a player is using.
 */

const KEY_FORWARD = new Set(['KeyW', 'ArrowUp'])
const KEY_BACK = new Set(['KeyS', 'ArrowDown'])
const KEY_LEFT = new Set(['KeyA', 'ArrowLeft'])
const KEY_RIGHT = new Set(['KeyD', 'ArrowRight'])

/** Radians per pixel of mouse movement. Halo's default sensitivity, near enough. */
const LOOK_SPEED = 0.0022
const PITCH_LIMIT = Math.PI / 2 - 0.01

export class Input {
  private readonly held = new Set<string>()
  private seq = 0
  private readonly scopedAim = new ScopedAim()

  /** Call before sampling movement when zoom changes. */
  setAimZoom(zoom: number): void { this.scopedAim.setZoom(zoom) }

  dualWield = false
  altFireHeld = false
  altFirePressed = false
  setAltFire(down:boolean):void {if(down&&(!this.active||this.uiBlocked))return;if(down&&!this.altFireHeld)this.altFirePressed=true;this.altFireHeld=down}
  consumeAltFire():boolean {const value=this.altFirePressed;this.altFirePressed=false;return value}
  yaw = 0
  pitch = 0
  locked = false
  fallback = false
  /** Analogue movement from a touch stick, -1..1, merged with the movement keys. */
  stickX = 0
  stickY = 0
  private dragging = false
  private uiBlocked = false
  get active(): boolean { return this.locked || this.fallback }

  /** Keep the live match connected while an on-screen editor owns input. */
  setUIBlocked(blocked: boolean): void {
    this.uiBlocked = blocked
    this.reset()
  }

  start = (): void => {
    this.canvas.focus()
    if (this.locked) return
    // Drag controls come up first and stay up if capture is refused, which is what makes the
    // game playable in an embedded browser and on a phone, where there is no pointer lock at
    // all. The request is retried on every click rather than only the first: a lock asked for
    // without a fresh user gesture is refused, and the player must be able to ask again.
    this.fallback = true
    try {
      this.canvas.requestPointerLock?.()?.catch(() => { /* Drag controls are already active. */ })
    } catch { /* Drag controls are already active. */ }
  }

  private pause = (): void => {
    this.fallback = false
    this.reset()
    if (this.locked) document.exitPointerLock()
  }

  /** Edge-triggered, consumed by whoever reads it. */
  firePressed = false
  fireHeld = false
  reloadPressed = false
  swapPressed = false
  meleePressed = false
  grenadePressed = false
  zoomPressed = false
  viewPressed = false
  pickupLeftPressed = false
  interactPressed = false
  grenadeSwitchPressed = false
  /** Edge-triggered Space press, used by the Warthog horn while driving. */
  hornPressed = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    addEventListener('keydown', this.onKeyDown)
    addEventListener('keyup', this.onKeyUp)
    canvas.tabIndex = 0
    canvas.style.outline = 'none'
    addEventListener('blur', this.pause)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause()
    })
    canvas.addEventListener('mousedown', this.onMouseDown)
    addEventListener('mouseup', this.onMouseUp)
    addEventListener('mousemove', this.onMouseMove)
    document.addEventListener('pointerlockchange', this.onLockChange)
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    canvas.addEventListener('click', this.start)
  }

  private onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas
    if (this.locked) this.fallback = false
    else this.reset()
  }

  private reset = (): void => {
    this.dragging = false
    this.scopedAim.clear()
    this.stickX = 0
    this.stickY = 0
    this.pickupLeftPressed = false
    this.interactPressed = false
    this.grenadeSwitchPressed = false
    this.zoomPressed = false
    this.viewPressed = false
    this.held.clear()
    this.fireHeld = false
    this.altFireHeld=false;this.altFirePressed=false
    this.leftButtonFiresLeft = this.rightButtonFiresRight = false
    this.firePressed = false
    this.reloadPressed = false
    this.swapPressed = false
    this.meleePressed = false
    this.grenadePressed = false
    this.hornPressed = false
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.uiBlocked) return
    if (e.code === 'Escape') { this.pause(); return }
    if (!this.active || e.repeat) return
    this.held.add(e.code)
    this.press(e.code)
    // Space scrolls the page if the pointer is not locked; it never should here.
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
  }

  /** The edge-triggered half of a key going down, shared by the keyboard and the touch pad. */
  private press(code: string): void {
    if (code === 'Space') this.hornPressed = true
    if (code === 'KeyZ') this.zoomPressed = true
    if (code === 'KeyT') this.viewPressed = true
    if (code === 'KeyR') this.reloadPressed = true
    if (code === 'KeyQ') this.pickupLeftPressed = true
    if (code === 'Digit1' || code === 'Digit2') this.swapPressed = true
    if (code === 'KeyV' || code === 'KeyF') this.meleePressed = true
    if (code === 'KeyE') this.interactPressed = true
    if (code === 'KeyB') this.grenadeSwitchPressed = true
    if (code === 'KeyG') this.grenadePressed = true
  }

  /** A touch button that behaves like a held key: jump, crouch. */
  hold(code: string, down: boolean): void {
    if (down && (!this.active || this.uiBlocked)) return
    if (down) { this.held.add(code); this.press(code) } else this.held.delete(code)
  }

  /** A touch button that behaves like a key press: reload, swap, melee, grenade, vehicle. */
  tap(code: string): void {
    if (!this.active || this.uiBlocked) return
    this.press(code)
  }

  /** The touch trigger. Held for automatic fire, edge-triggered for the first round. */
  setFire(down: boolean): void {
    if (down && (!this.active || this.uiBlocked)) return
    if (down) this.firePressed = true
    this.fireHeld = down
  }

  /** Turn by a delta in radians, with the pitch clamp the mouse path uses. */
  lookBy(dyaw: number, dpitch: number): void {
    if (this.uiBlocked) return
    if (this.scopedAim.zoom > 1) this.scopedAim.add(dyaw, dpitch)
    else this.applyLook(dyaw, dpitch)
  }

  private applyLook(dyaw: number, dpitch: number): void {
    this.yaw += dyaw
    this.pitch = Math.min(Math.max(this.pitch + dpitch, -PITCH_LIMIT), PITCH_LIMIT)
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code)
  }

  /** Dual wield maps the mouse buttons to the hands by side: the left button fires the left-hand gun, the right button the right-hand one.
   * Which one a press went to is kept until its release, so a pickup or a drop while it is held never leaves a gun firing. */
  private leftButtonFiresLeft = false
  private rightButtonFiresRight = false

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.active || this.uiBlocked) return
    if (e.button === 2) {
      if (this.dualWield) { this.rightButtonFiresRight = true; this.firePressed = true; this.fireHeld = true }
      else this.zoomPressed = true
    }
    if (e.button === 0) {
      if (this.dualWield) { this.leftButtonFiresLeft = true; this.setAltFire(true) }
      else { this.firePressed = true; this.fireHeld = true }
    }
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) { this.dragging = false; if (this.rightButtonFiresRight) { this.rightButtonFiresRight = false; this.fireHeld = false } }
    if (e.button === 0) { if (this.leftButtonFiresLeft) { this.leftButtonFiresLeft = false; this.setAltFire(false) } else this.fireHeld = false }
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.active) return
    // Embedded browsers may deny pointer capture; ordinary motion over the canvas still aims.
    if (!this.locked && e.target !== this.canvas) return
    this.lookBy(-e.movementX * LOOK_SPEED, -e.movementY * LOOK_SPEED)
  }

  private axis(neg: Set<string>, pos: Set<string>, stick: number): number {
    let v = stick
    for (const k of this.held) {
      if (pos.has(k)) v += 1
      if (neg.has(k)) v -= 1
    }
    return Math.min(Math.max(v, -1), 1)
  }

  /** Sample the current frame. Consumes the edge-triggered flags. */
  sample(dt: number): PlayerInput {
    const delta = this.scopedAim.advance(dt)
    this.applyLook(delta.yaw, delta.pitch)
    return {
      forward: this.axis(KEY_BACK, KEY_FORWARD, this.stickY),
      strafe: this.axis(KEY_LEFT, KEY_RIGHT, this.stickX),
      yaw: this.yaw,
      pitch: this.pitch,
      jump: this.held.has('Space'),
      crouch: this.held.has('ShiftLeft') || this.held.has('ShiftRight') || this.held.has('ControlLeft') || this.held.has('ControlRight') || this.held.has('KeyC'),
      seq: ++this.seq,
      dt,
    }
  }

  consumeFire(): boolean {
    const f = this.firePressed
    this.firePressed = false
    return f
  }

  consume(name: 'pickupLeftPressed' | 'reloadPressed' | 'swapPressed' | 'meleePressed' | 'grenadePressed' | 'viewPressed' | 'zoomPressed' | 'interactPressed' | 'grenadeSwitchPressed' | 'hornPressed'): boolean {
    const v = this[name]
    this[name] = false
    return v
  }
}
