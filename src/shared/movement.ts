import {isArena,arenaFloor,arenaMove} from './arena.ts'
import {hasArenaData} from './level-data.ts'
import { guardianFloor, guardianMove, type MapId } from './guardian.ts'
import { lockoutFloor, lockoutMove } from './lockout.ts'
import { MOVE, GRAVITY, JUMP_VELOCITY, FALL_DAMAGE } from './constants.ts'
import { groundHeight, rimFraction } from './field.ts'
import { baseFloorHeight, baseBlocksPlayer, baseCeilingHeight } from './base-collision.ts'
import { coverFloorHeight, coverBlocksPlayer } from './cover.ts'
import { teleportAt } from './teleport.ts'
import { resolveVehicleCollisions, type VehicleCollider } from './vehicle-collision.ts'

/**
 * The Halo CE character controller.
 *
 * Pure: same input and state in, same state out, on the client and on the server. That is the
 * whole reason it is hand-rolled rather than run through a rigid-body solver — the client
 * predicts by replaying its own inputs through this function, and the server replays the same
 * inputs through the same function, so the two agree without anyone sending positions back and
 * forth mid-step.
 *
 * The feel is not invented. Forward speed, jump height and jump distance come from the measured
 * CE tables, and gravity is derived from the three of them rather than assumed — see constants.ts.
 * Halo is fast and floaty: 6.9 m/s and a 2.4 m jump that hangs for well over a second.
 */

export interface PlayerInput {
  /** -1..1, positive is forward. */
  readonly forward: number
  /** -1..1, positive is right. */
  readonly strafe: number
  /** Radians. Yaw is the direction moved in; pitch only aims. */
  readonly yaw: number
  readonly pitch: number
  readonly jump: boolean
  readonly crouch: boolean
  /** Monotonic per client, so the server can tell the client what it has already applied. */
  readonly seq: number
  /** Seconds this input covers. Fixed in normal play; clamped here so a stall cannot teleport. */
  readonly dt: number
  /** Dynamic vehicle hulls, supplied by both the client predictor and the authority. */
  readonly vehicles?: readonly VehicleCollider[]
}

export interface PlayerState {
  map?: MapId
  liftCooldown?: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  onGround: boolean
  crouched: boolean
  /** Metres fallen since leaving the ground, for fall damage on landing. */
  fallFrom: number
  /** Set on the step a landing hurts, so the caller can apply it and clear it. */
  fallDamage: number
  /**
   * Set on the step a teleporter fires: the yaw the receiver faces. Yaw belongs to the input,
   * not the state, so the caller turns the view; the simulation only reports that it should.
   */
  teleportYaw: number | null
}

export const MAX_STEP_DT = 1 / 20

/**
 * How close to the foot of the cliff anyone may get. The rim is a noisy superellipse, not a
 * box — clamping to a rectangle put the corners of that rectangle inside the rock, which is
 * where bots walked in and stopped forever because their goal never became reachable.
 */
const RIM_LIMIT = 0.965

export function spawnState(x: number, z: number, map: MapId = 'blood-gulch'): PlayerState {
  return {
    // Players are created with the default map before the match assigns theirs; only the selected level's data is loaded, so an
    // arena floor is only asked for when it can be answered (the old heightfield stands in for the placeholder).
    map, x, y: isArena(map) ? (hasArenaData(map) ? arenaFloor(map,x,z) : groundHeight(x, z)) : map === 'guardian' ? guardianFloor(x,z,14) : map === 'lockout' ? lockoutFloor(x,z,100) : groundHeight(x, z), z,
    vx: 0, vy: 0, vz: 0,
    onGround: true, crouched: false, fallFrom: 0, fallDamage: 0, teleportYaw: null,
  }
}

export function eyeHeight(s: PlayerState): number {
  return s.y + (s.crouched ? MOVE.eyeHeight * 0.62 : MOVE.eyeHeight)
}

/**
 * Ground acceleration is deliberately near-instant. CE has almost no ramp-up — you are at full
 * speed on the first frame — and adding inertia here is the single fastest way to make it stop
 * feeling like Halo. Air control is real but weak: you can steer a jump, not redirect it.
 */
const GROUND_ACCEL = 60
const AIR_ACCEL = 8
const GROUND_FRICTION = 14

export function step(s: PlayerState, input: PlayerInput): PlayerState {
  const dt = Math.min(Math.max(input.dt, 0), MAX_STEP_DT)
  if (dt === 0) return s

  s.fallDamage = 0
  s.teleportYaw = null
  s.crouched = input.crouch && s.onGround

  // Wish direction in world space. Yaw only — looking up must not slow you down.
  const sin = Math.sin(input.yaw)
  const cos = Math.cos(input.yaw)
  let wishX = input.strafe * cos - input.forward * sin
  let wishZ = -input.strafe * sin - input.forward * cos
  const wishLen = Math.hypot(wishX, wishZ)
  if (wishLen > 1e-6) {
    wishX /= wishLen
    wishZ /= wishLen
  }

  // CE moves slower backward and sideways than forward, and slower again crouched.
  const speedCap = (() => {
    const back = input.forward < -0.01
    const base = back
      ? MOVE.backwardSpeed
      : Math.abs(input.strafe) > Math.abs(input.forward)
        ? MOVE.strafeSpeed
        : MOVE.forwardSpeed
    return s.crouched ? base * 0.45 : base
  })()

  const incomingAirSpeed = Math.hypot(s.vx,s.vz)
  const wishSpeed = Math.min(wishLen, 1) * speedCap
  if (s.onGround) {
    // Approach the complete target velocity. Projection-only acceleration retained
    // sideways momentum on every turn, letting players and strafing bots gain speed.
    const rate = wishSpeed > 1e-4 ? GROUND_ACCEL : GROUND_FRICTION
    const blend = 1 - Math.exp(-rate * dt)
    s.vx += (wishX * wishSpeed - s.vx) * blend
    s.vz += (wishZ * wishSpeed - s.vz) * blend
  } else {
    const along = s.vx * wishX + s.vz * wishZ
    const add = Math.max(0, Math.min(wishSpeed - along, AIR_ACCEL * wishSpeed * dt))
    s.vx += wishX * add
    s.vz += wishZ * add
  }
  // Air steering changes direction, never creates unlimited strafe-jump speed.
  const horizontal = Math.hypot(s.vx, s.vz)
  const limit = s.onGround ? speedCap : Math.max(MOVE.forwardSpeed,incomingAirSpeed)
  if (horizontal > limit) { s.vx *= limit / horizontal; s.vz *= limit / horizontal }

  if (input.jump && s.onGround) {
    s.vy = JUMP_VELOCITY
    s.onGround = false
    s.fallFrom = s.y
  }

  s.vy -= GRAVITY * dt

  if (isArena(s.map)) {
    arenaMove(s,dt)
    return s.map==='blood-gulch'?applyBloodGulchTeleporter(s):s
  }
  if (s.map === 'guardian') return guardianMove(s, dt)
  if (s.map === 'lockout') return lockoutMove(s, dt)

  const previousX = s.x, previousZ = s.z
  const nx = s.x + s.vx * dt
  const nz = s.z + s.vz * dt
  let ny = s.y + s.vy * dt

  if (rimFraction(nx, nz) < RIM_LIMIT) {
    s.x = nx
    s.z = nz
  } else {
    // At the cliff, slide along it rather than stopping dead. The rim normal points outward
    // from the canyon centre, closely enough for a wall this smooth, so removing the outward
    // component of velocity leaves the tangent — which is what keeps anyone walking a wall
    // moving instead of pinning against it.
    const len = Math.hypot(nx, nz) || 1
    const outX = nx / len
    const outZ = nz / len
    const into = s.vx * outX + s.vz * outZ
    if (into > 0) {
      s.vx -= outX * into
      s.vz -= outZ * into
    }
    const sx = s.x + s.vx * dt
    const sz = s.z + s.vz * dt
    // Only take the slid position if it is actually inside; otherwise hold still this step.
    if (rimFraction(sx, sz) < RIM_LIMIT) {
      s.x = sx
      s.z = sz
    }
  }

  const maxStep = s.crouched ? MOVE.crouchStepHeight : MOVE.stepHeight
  const capsuleHeight = MOVE.playerHeight * (s.crouched ? 0.62 : 1)
  if (baseBlocksPlayer(s.x, s.z, s.y, capsuleHeight)) {
    // Keep the free tangent when a doorway jamb or wall blocks the full movement.
    if (!baseBlocksPlayer(s.x, previousZ, s.y, capsuleHeight)) { s.z = previousZ; s.vz = 0 }
    else if (!baseBlocksPlayer(previousX, s.z, s.y, capsuleHeight)) { s.x = previousX; s.vx = 0 }
    else { s.x = previousX; s.z = previousZ; s.vx = 0; s.vz = 0 }
  }
  // Rock is handled the same way as the base wall: a rock you cannot step onto is a wall,
  // and the free tangent is kept so you slide round it rather than sticking to it.
  if (coverBlocksPlayer(s.x, s.z, s.y, maxStep, previousX, previousZ)) {
    if (!coverBlocksPlayer(s.x, previousZ, s.y, maxStep, previousX, previousZ)) { s.z = previousZ; s.vz = 0 }
    else if (!coverBlocksPlayer(previousX, s.z, s.y, maxStep, previousX, previousZ)) { s.x = previousX; s.vx = 0 }
    else { s.x = previousX; s.z = previousZ; s.vx = 0; s.vz = 0 }
  }
  if (input.vehicles?.length) resolveVehicleCollisions(s, input.vehicles)
  const ceiling = baseCeilingHeight(s.x, s.z, s.y)
  if (s.vy > 0 && ny + capsuleHeight > ceiling) {
    ny = Math.max(s.y, ceiling - capsuleHeight)
    s.vy = 0
  }
  const floor = Math.max(baseFloorHeight(s.x, s.z, s.y, maxStep), coverFloorHeight(s.x, s.z, s.y, maxStep))

  // Walking into a rise up to step height is a step up, not a wall. Above that, refuse the move
  // and keep the old position — without this you walk up cliffs.
  if (ny <= floor) {
    const rise = floor - s.y
    if (s.onGround && rise > maxStep) {
      s.x = previousX
      s.z = previousZ
      s.vx = 0
      s.vz = 0
      ny = s.y
    } else {
      if (!s.onGround) {
        const fell = s.fallFrom - floor
        if (fell > FALL_DAMAGE.safeDrop) {
          const t = (fell - FALL_DAMAGE.safeDrop) / (FALL_DAMAGE.fatalDrop - FALL_DAMAGE.safeDrop)
          s.fallDamage = Math.min(t, 1) * 150
        }
      }
      ny = floor
      s.vy = 0
      s.onGround = true
    }
  } else {
    if (s.onGround) s.fallFrom = s.y
    s.onGround = false
  }

  s.y = ny

  return applyBloodGulchTeleporter(s)
}

function applyBloodGulchTeleporter(s:PlayerState):PlayerState {
  // Through a teleporter frame: come out of the receiver facing its way, at the speed you
  // went in. Momentum carries in CE too, which is what makes a running entry feel continuous.
  const trip = teleportAt(s.x, s.z, s.y)
  if (trip) {
    const speed = Math.hypot(s.vx, s.vz)
    s.x = trip.x
    s.z = trip.z
    s.y = trip.y
    s.vx = -Math.sin(trip.yaw) * speed
    s.vz = -Math.cos(trip.yaw) * speed
    s.vy = 0
    s.onGround = true
    s.fallFrom = s.y
    s.teleportYaw = trip.yaw
  }
  return s
}

/** Snapshot for prediction replay. Cheap enough to keep one per buffered input. */
export function cloneState(s: PlayerState): PlayerState {
  return { ...s }
}

/** How far apart two states are, for deciding whether a correction is worth applying. */
export function positionError(a: PlayerState, b: PlayerState): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
