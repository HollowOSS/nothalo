import type * as THREE from 'three'
import type { MapId } from '../../shared/maps.ts'
import type { PlayerState } from '../../shared/movement.ts'
import type { CombatEffects } from './combat-fx.ts'
import type { Surface, Vocal } from './combat-audio.ts'
import { SurfaceMap } from './surface-map.ts'
import { isArena, arenaCollision } from '../../shared/arena.ts'
import { lockoutMesh } from '../../shared/lockout-collision.ts'
import { guardianCollision } from '../../shared/guardian-collision.ts'

/** The collision mesh's horizontal extent plus a margin: nobody stands outside it, whatever the scenery spans. */
function playArea(map: MapId): [number, number, number, number] | undefined {
  try {
    const positions = isArena(map) ? arenaCollision(map).mesh.positions : map === 'lockout' ? lockoutMesh().positions : map === 'guardian' ? guardianCollision().mesh.positions : null
    if (!positions?.length) return undefined
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], z = positions[i + 2]
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z
    }
    return [x0 - 2, x1 + 2, z0 - 2, z1 + 2]
  } catch { return undefined }
}
/** Full running speed (MOVE.forwardSpeed), m/s: steps and their level scale against it. */
const RUN = 6.86
/** Beyond these distances another Spartan's steps and grunts are inaudible and not started at all. */
const STEP_RANGE = 30, VOICE_RANGE = 45
/** Downward speed at touch-down that makes a landing audible, and one that also rattles the armour. */
const LAND = 3.5, LAND_HARD = 9

type Walker = { stride: number; grounded: boolean; fall: number; lastVocal: number }
export type FoleyPlayer = { id: number | string; state: PlayerState; alive: boolean }
export type Hurt = { amount: number; health: number; killed: boolean }

/**
 * A Spartan's own sounds: footfalls chosen by the surface underfoot, landings, and the pain and death
 * vocals. Positional for everyone else, centred for you.
 */
export class SpartanFoley {
  private readonly walkers = new WeakMap<object, Walker>()
  private surfaces: SurfaceMap
  /** Counters for debug hooks and browser checks. */
  readonly counts = { steps: 0, lands: 0, vocals: 0, skippedVocals: 0 }
  /** The surface of your own last footfall, for debug hooks. */
  lastSurface: Surface | null = null

  private readonly effects: CombatEffects

  constructor(effects: CombatEffects, map: MapId, scene: THREE.Scene) {
    this.effects = effects
    this.surfaces = new SurfaceMap(map)
    const root = scene.getObjectByName(map)
    // The scenery's materials are only final once the map finishes loading (Valhalla's river is rebuilt then).
    void Promise.resolve(root?.userData.ready).catch(() => {}).then(() => { if (root) this.surfaces = new SurfaceMap(map, root, playArea(map)) })
  }

  get surfaceMap(): SurfaceMap { return this.surfaces }
  surfaceAt(state: PlayerState): Surface { return this.surfaces.at(state.x, state.y, state.z) }

  /**
   * One frame of footfalls for one player. Steps are paced by distance covered, so their rate follows
   * the speed the simulation produced (a crouch-walk steps slowly and softly, a sprint quickly).
   */
  walk(player: FoleyPlayer, you: boolean, seated: boolean, dt: number, camera: THREE.Camera): void {
    // The surface grid builds a slice per frame (once, on your call) until it is done.
    if (you) this.surfaces.step()
    const s = player.state
    let w = this.walkers.get(player)
    if (!w) { w = { stride: 0, grounded: s.onGround, fall: 0, lastVocal: -Infinity }; this.walkers.set(player, w) }
    if (!player.alive || seated) { w.grounded = true; w.fall = 0; w.stride = 0; return }
    const [level, pan] = you ? [1, 0] : this.place(s.x, s.y + .1, s.z, camera, STEP_RANGE, .12)
    if (!s.onGround) { w.fall = Math.max(w.fall, -s.vy); w.grounded = false; return }
    if (!w.grounded) {
      w.grounded = true
      const fall = w.fall; w.fall = 0
      if (fall > LAND && level > 0) {
        const surface = this.surfaces.at(s.x, s.y, s.z), weight = Math.min(1, (fall - 3) / 7)
        this.effects.footstep(surface, 'land', (.3 + .5 * weight) * level, pan)
        if (fall > LAND_HARD) this.effects.footstep(surface, 'land-hard', .5 * weight * level, pan)
        this.counts.lands++
        if (you) this.lastSurface = surface
      }
      // The next footfall comes half a stride after touching down.
      w.stride = .5
      return
    }
    const speed = Math.hypot(s.vx, s.vz)
    if (speed < .7) { w.stride = Math.min(w.stride, .6); return }
    const length = s.crouched ? 1.1 : Math.min(2.6, 1 + speed * .24)
    w.stride += speed * dt / length
    if (w.stride < 1) return
    w.stride -= Math.floor(w.stride)
    if (level <= 0) return
    const surface = this.surfaces.at(s.x, s.y, s.z)
    // Halo's crouch is its sneak: barely audible, and quieter still for someone else's.
    const volume = .42 * Math.min(1, .45 + .55 * speed / RUN) * (s.crouched ? .35 : 1) * level
    this.effects.footstep(surface, 'step', volume, pan)
    this.counts.steps++
    if (you) this.lastSurface = surface
  }

  /**
   * Pain and death vocals for damage `hurt` just dealt to `player` (Player.consumeHurt). Rate-limited per
   * Spartan so automatic fire does not become a grunt per bullet: ordinary hits grunt now and then, a
   * melee or other heavy blow always does, a shield breaking has its own strained cry, and a kill its
   * death vocal (unless the Wilhelm easter egg already took the moment).
   */
  hurt(player: FoleyPlayer, hurt: Hurt, popped: boolean, you: boolean, camera: THREE.Camera, now = performance.now() / 1000): void {
    let w = this.walkers.get(player)
    if (!w) { w = { stride: 0, grounded: true, fall: 0, lastVocal: -Infinity }; this.walkers.set(player, w) }
    const [level, pan] = you ? [.55, 0] : this.place(player.state.x, player.state.y + 1.6, player.state.z, camera, VOICE_RANGE, .07)
    if (level <= 0) return
    let kind: Vocal, gap: number, chance: number
    if (hurt.killed) { kind = 'death'; gap = 0; chance = this.effects.screamedJustNow ? 0 : 1 }
    else if (popped) { kind = 'shield-break'; gap = .35; chance = 1 }
    else if (hurt.amount >= 40) { kind = 'hurt-heavy'; gap = .25; chance = 1 }
    else if (hurt.health > 0) { kind = 'hurt'; gap = .75; chance = .75 }
    else { kind = 'hurt'; gap = 1.5; chance = .3 }
    if (now - w.lastVocal < gap || Math.random() >= chance) { this.counts.skippedVocals++; return }
    w.lastVocal = now
    this.effects.vocal(kind, (you ? 1 : .95) * level, pan, player.id)
    this.counts.vocals++
  }

  /** Distance falloff and stereo pan from the camera, [0, 0] out of range. */
  private place(x: number, y: number, z: number, camera: THREE.Camera, range: number, falloff: number): [number, number] {
    const e = camera.matrixWorld.elements, cx = e[12], cy = e[13], cz = e[14]
    const distance = Math.hypot(x - cx, y - cy, z - cz)
    if (distance > range) return [0, 0]
    const pan = Math.max(-1, Math.min(1, ((x - cx) * e[0] + (z - cz) * e[2]) / Math.max(distance, 1)))
    // Fade to nothing at the range limit so a runner does not cut off mid-stride.
    return [Math.min(1, (range - distance) / (range * .25)) / (1 + distance * falloff), pan]
  }
}
