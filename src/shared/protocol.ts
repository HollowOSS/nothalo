import { WIRE_MAPS } from './maps.ts'
import type { BulletImpact } from './bullet-impact.ts'
import { CANYON_LENGTH, CANYON_WIDTH } from './map.ts'
import { CLIFF_HEIGHT } from './map.ts'
import type { PlayerState } from './movement.ts'
import type { VehicleState } from './vehicle-sim.ts'

/**
 * The wire format.
 *
 * Binary from the first line, not JSON. A Durable Object gets 10 ms of CPU per invocation on
 * the free plan, and `JSON.stringify` of world state per player per tick is the thing that
 * blows that budget first as entity count grows. Everything here writes into a preallocated
 * DataView.
 *
 * Positions are quantised to 16 bits over the map bounds — about 3 mm across the canyon, far
 * finer than anyone can perceive at these speeds — and angles to 16 bits, which is a
 * hundredth of a degree. That puts a player snapshot at 15 bytes.
 *
 * The one exception to quantisation is the recipient's own state at the tail of a snapshot,
 * which goes out as float32 with velocity. Prediction replays inputs from that state, and a
 * replay from a rounded position disagrees with the client's own by the rounding every tick,
 * which reads as a permanent jitter. Outbound bytes are free; the extra 34 are worth it.
 */

/** A plain object rather than a TS enum, so node can run the server directly for benchmarks. */
export const Msg = {
  /** server -> client, once on join: your id and team */
  Welcome: 1,
  /** client -> server, a batch of input frames */
  Input: 2,
  /** server -> client, world state */
  Snapshot: 3,
  /** server -> client, someone fired a hitscan weapon */
  Shot: 4,
  /** server -> client, someone died */
  Death: 5,
  /** client -> server / server -> client, liveness and RTT */
  Ping: 6,
  /** server -> shooter, your shot landed */
  Hit: 7,
  /** client -> server, a projectile you own detonated here */
  Splash: 8,
  /** server -> client, a blast happened here, draw it */
  Explosion: 9,
  /** client -> server -> everyone else, a projectile left a muzzle or a hand */
  Launch: 10,
  /** server -> client, the match is full; the socket closes after */
  Full: 11,
  /** client -> server, the name I want to be known by */
  Name: 12,
  /** server -> client, everyone's id and name */
  Roster: 13,
  /** server -> client, authoritative kills and deaths for the scoreboard */
  Scoreboard: 14,
  /** server -> client, game-type state: scores, clock, flags, ball or bomb. Sent on change. */
  Objective: 15,
  /** server -> client, something happened to an objective: taken, captured, won */
  ObjectiveEvent: 16,
  Arsenal: 17,
  /** server -> client, once after Welcome: the wire version and your rejoin token */
  Session: 18,
} as const

/**
 * The wire format's version. Bump it whenever a change means an older client can no longer play
 * against the new server (or the reverse): a client that sees a different number reloads itself
 * to fetch the new build. Additive changes that both sides tolerate (an optional trailing byte, a
 * message type the other side ignores) do not need a bump.
 */
export const PROTOCOL_VERSION = 2

/** A rejoin token: 32 hex characters, secret to the player it was issued to. */
export const SESSION_TOKEN = /^[0-9a-f]{32}$/

export interface Session { protocol: number; token: string }

export function packSession(s: Session): ArrayBuffer {
  const bytes = new Uint8Array(3 + 16)
  bytes[0] = Msg.Session
  new DataView(bytes.buffer).setUint16(1, s.protocol)
  for (let i = 0; i < 16; i++) bytes[3 + i] = parseInt(s.token.slice(i * 2, i * 2 + 2), 16)
  return bytes.buffer
}

export function unpackSession(view: DataView): Session | null {
  if (view.byteLength < 19) return null
  let token = ''
  for (let i = 0; i < 16; i++) token += view.getUint8(3 + i).toString(16).padStart(2, '0')
  return { protocol: view.getUint16(1), token }
}

/**
 * Quantisation bounds, as explicit min/span pairs.
 *
 * They are not all centred on zero — the canyon straddles the origin horizontally but the
 * ground does not, and an earlier version that assumed centring saturated every height above
 * 55 m and produced fifteen metres of error. Bounds are stated, not inferred.
 */
const X_MIN = -(CANYON_WIDTH + 80) / 2
const X_SPAN = CANYON_WIDTH + 80
const Z_MIN = -(CANYON_LENGTH + 100) / 2
const Z_SPAN = CANYON_LENGTH + 100
/** Below the floor datum for the odd dip, well above the cliff for anyone launched off one. */
const Y_MIN = -30
const Y_SPAN = CLIFF_HEIGHT + 110

const q16 = (v: number, min: number, span: number): number => {
  const t = ((v - min) / span) * 65535
  return t < 0 ? 0 : t > 65535 ? 65535 : t | 0
}
const dq16 = (n: number, min: number, span: number): number => (n / 65535) * span + min

const qAngle = (rad: number): number => {
  let t = rad % (Math.PI * 2)
  if (t < 0) t += Math.PI * 2
  return ((t / (Math.PI * 2)) * 65535) | 0
}
const dqAngle = (n: number): number => (n / 65535) * Math.PI * 2

/**
 * Pitch spans half a turn and gets the same 16 bits yaw does. A byte was tried: its step of
 * 0.7 degrees is over a metre of vertical error at 90 m, taller than the target, and every
 * long shot missed by exactly that.
 */
const qPitch = (rad: number): number => {
  const t = Math.round(((rad + Math.PI / 2) / Math.PI) * 65535)
  return t < 0 ? 0 : t > 65535 ? 65535 : t
}
const dqPitch = (n: number): number => (n / 65535) * Math.PI - Math.PI / 2

function writePoint(view: DataView, off: number, x: number, y: number, z: number): number {
  view.setUint16(off, q16(x, X_MIN, X_SPAN))
  view.setUint16(off + 2, q16(y, Y_MIN, Y_SPAN))
  view.setUint16(off + 4, q16(z, Z_MIN, Z_SPAN))
  return off + 6
}

function readPoint(view: DataView, off: number, out: { x: number; y: number; z: number }): number {
  out.x = dq16(view.getUint16(off), X_MIN, X_SPAN)
  out.y = dq16(view.getUint16(off + 2), Y_MIN, Y_SPAN)
  out.z = dq16(view.getUint16(off + 4), Z_MIN, Z_SPAN)
  return off + 6
}

// ---------------------------------------------------------------- players

/** One player as the wire sees them. */
export interface WirePlayer {
  id: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  /** Bit 0 on ground, bit 1 crouched, bit 2 dead, bit 3 blue team. */
  flags: number
  /** 0-255, scaled from the real pool so the client can draw a bar. */
  shield: number
  health: number
  weapon: number
  offhand?: number
  /** Stride phase, 0-255 for 0..1 (shared/gait.ts): where the legs are drawn, and where the hit shapes put them. */
  gait?: number
}

export const PLAYER_BYTES = 16

export function writePlayer(view: DataView, off: number, p: WirePlayer): number {
  view.setUint8(off, p.id)
  view.setUint16(off + 1, q16(p.x, X_MIN, X_SPAN))
  view.setUint16(off + 3, q16(p.y, Y_MIN, Y_SPAN))
  view.setUint16(off + 5, q16(p.z, Z_MIN, Z_SPAN))
  view.setUint16(off + 7, qAngle(p.yaw))
  view.setUint16(off + 9, qPitch(p.pitch))
  view.setUint8(off + 11, p.flags)
  view.setUint8(off + 12, p.shield)
  view.setUint8(off + 13, p.health)
  view.setUint8(off + 14, (p.weapon & 15) | (((p.offhand ?? -1)+1)<<4))
  view.setUint8(off + 15, p.gait ?? 0)
  return off + PLAYER_BYTES
}

export function readPlayer(view: DataView, off: number, out: WirePlayer): number {
  out.id = view.getUint8(off)
  out.x = dq16(view.getUint16(off + 1), X_MIN, X_SPAN)
  out.y = dq16(view.getUint16(off + 3), Y_MIN, Y_SPAN)
  out.z = dq16(view.getUint16(off + 5), Z_MIN, Z_SPAN)
  out.yaw = dqAngle(view.getUint16(off + 7))
  out.pitch = dqPitch(view.getUint16(off + 9))
  out.flags = view.getUint8(off + 11)
  out.shield = view.getUint8(off + 12)
  out.health = view.getUint8(off + 13)
  out.weapon = view.getUint8(off + 14)&15
  out.offhand = (view.getUint8(off + 14)>>4)-1
  out.gait = view.getUint8(off + 15)
  return off + PLAYER_BYTES
}

export const FLAG_ON_GROUND = 1
export const FLAG_CROUCHED = 2
export const FLAG_DEAD = 4
export const FLAG_BLUE = 8
/** Seated in a vehicle: the body is hidden and a rider is posed on the seat instead. */
export const FLAG_IN_VEHICLE = 16

// ---------------------------------------------------------------- vehicles

/** One vehicle as the wire sees it. Occupants are player ids; 0 means the seat is empty. */
export interface WireVehicle {
  id: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
  turretYaw: number
  turretPitch: number
  /** m/s, for wheel spin and engine pitch on the other screens. */
  speed: number
  driver: number
  gunner: number
  /** Bit 0 the gun is firing. */
  impactSeq?: number
  impactSpeed?: number
  flags: number
}

export const VEHICLE_BYTES = 24
export const VEHICLE_FIRING = 1
export const VEHICLE_BOOSTING = 2
/** The horn is active briefly; clients play it on the rising edge. */
export const VEHICLE_HORN = 4

export function writeVehicle(view: DataView, off: number, v: WireVehicle): number {
  view.setUint8(off, v.id)
  writePoint(view, off + 1, v.x, v.y, v.z)
  view.setUint16(off + 7, qAngle(v.yaw))
  view.setUint16(off + 9, qAngle(v.pitch))
  view.setUint16(off + 11, qAngle(v.roll))
  view.setUint16(off + 13, qAngle(v.turretYaw))
  view.setUint16(off + 15, qPitch(v.turretPitch))
  view.setInt8(off + 17, Math.max(-127, Math.min(127, Math.round(v.speed * 4))))
  view.setUint8(off + 18, v.driver)
  view.setUint8(off + 19, v.gunner)
  view.setUint8(off + 20, v.flags)
  view.setUint16(off + 21, v.impactSeq ?? 0)
  view.setUint8(off + 23, Math.max(0,Math.min(255,Math.round((v.impactSpeed ?? 0)*7))))
  return off + VEHICLE_BYTES
}

export function readVehicle(view: DataView, off: number, out: WireVehicle): number {
  out.id = view.getUint8(off)
  readPoint(view, off + 1, out)
  out.yaw = dqAngle(view.getUint16(off + 7))
  // Hull pitch uses a full turn (unlike player/turret aiming pitch).
  out.pitch = dqAngle(view.getUint16(off + 9))
  out.roll = dqAngle(view.getUint16(off + 11))
  out.turretYaw = dqAngle(view.getUint16(off + 13))
  out.turretPitch = dqPitch(view.getUint16(off + 15))
  out.speed = view.getInt8(off + 17) / 4
  out.driver = view.getUint8(off + 18)
  out.gunner = view.getUint8(off + 19)
  out.flags = view.getUint8(off + 20)
  out.impactSeq = view.getUint16(off + 21)
  out.impactSpeed = view.getUint8(off + 23)/7
  return off + VEHICLE_BYTES
}

// ---------------------------------------------------------------- input

/**
 * One input frame. Movement axes are a byte each because a keyboard only ever produces -1, 0
 * or 1 and an analogue stick does not need more than 8 bits of it.
 *
 * Every frame covers exactly one simulation tick. The client samples input on a fixed-step
 * accumulator at `NET.tickRate`, so the server steps each frame by the same `1 / tickRate`
 * the client did and the two simulations agree to the bit. A byte of "how long this frame
 * was" used to travel here; it was rounded to whole milliseconds and made every replay
 * disagree by the rounding.
 */
export interface WireInput {
  seq: number
  forward: number
  strafe: number
  yaw: number
  pitch: number
  /**
   * Bit 0 jump, bit 1 crouch, bit 2 fire, bit 3 reload, bit 4 swap, bit 5 melee, bit 6
   * interact (enter or leave a vehicle), bit 7 change seat, bit 8 alternate fire, bit 9 cancel shell reload, bit 10 sword lunge, bit 11 Warthog horn.
   */
  buttons: number
}

export const INPUT_BYTES = 10

export function writeInput(view: DataView, off: number, i: WireInput): number {
  view.setUint16(off, i.seq & 0xffff)
  view.setInt8(off + 2, Math.round(i.forward * 127))
  view.setInt8(off + 3, Math.round(i.strafe * 127))
  view.setUint16(off + 4, qAngle(i.yaw))
  view.setUint16(off + 6, qPitch(i.pitch))
  view.setUint16(off + 8, i.buttons)
  return off + INPUT_BYTES
}

export function readInput(view: DataView, off: number, out: WireInput): number {
  out.seq = view.getUint16(off)
  out.forward = view.getInt8(off + 2) / 127
  out.strafe = view.getInt8(off + 3) / 127
  out.yaw = dqAngle(view.getUint16(off + 4))
  out.pitch = dqPitch(view.getUint16(off + 6))
  out.buttons = view.getUint16(off + 8)
  return off + INPUT_BYTES
}

export const BTN_JUMP = 1
export const BTN_CROUCH = 2
export const BTN_FIRE = 4
export const BTN_RELOAD = 8
export const BTN_SWAP = 16
export const BTN_MELEE = 32
export const BTN_INTERACT = 64
export const BTN_SEAT = 128
/** On foot, INTERACT + SEAT selects the left pickup hand; seated it remains exit. */
export const BTN_PICKUP_LEFT = BTN_INTERACT | BTN_SEAT
export const BTN_ALT = 256
export const BTN_STOW_LEFT = 4096
export const BTN_CHARGE_RIGHT = 8192
export const BTN_CHARGE_LEFT = 16384
export const BTN_CANCEL_CHARGE = 32768
export const BTN_RELOAD_CANCEL = 512
/** Sword swing start; authority chooses the target and validates the dash. */
export const BTN_LUNGE = 1024
/** Warthog horn; only a seated driver may use it. */
export const BTN_HORN = 2048

/**
 * Quantise an input exactly the way the wire will, so the client predicts with the same yaw
 * and pitch the server will step with. Without this the client turns by the raw mouse angle,
 * the server by the nearest hundredth of a degree, and every reconciliation nudges.
 */
export function quantiseInput(i: WireInput): void {
  i.forward = Math.round(i.forward * 127) / 127
  i.strafe = Math.round(i.strafe * 127) / 127
  i.yaw = dqAngle(qAngle(i.yaw))
  i.pitch = dqPitch(qPitch(i.pitch))
}

/**
 * Client input is batched rather than sent per frame. Inbound messages are the only thing a
 * Durable Object meters — at twenty to one — so packet rate, not payload size, is what decides
 * how many hours a day this runs for nothing. Each packet carries every frame since the last.
 */
export function packInput(frames: readonly WireInput[]): ArrayBuffer {
  const buf = new ArrayBuffer(2 + frames.length * INPUT_BYTES)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Input)
  view.setUint8(1, frames.length)
  let off = 2
  for (const f of frames) off = writeInput(view, off, f)
  return buf
}

// ---------------------------------------------------------------- snapshot

/** The recipient's own state, full precision, for prediction replay. */
export const SELF_BYTES = 34

function writeSelf(view: DataView, off: number, s: PlayerState): number {
  view.setFloat32(off, s.x)
  view.setFloat32(off + 4, s.y)
  view.setFloat32(off + 8, s.z)
  view.setFloat32(off + 12, s.vx)
  view.setFloat32(off + 16, s.vy)
  view.setFloat32(off + 20, s.vz)
  view.setFloat32(off + 24, s.fallFrom)
  view.setUint8(off + 28, (s.onGround ? 1 : 0) | (s.crouched ? 2 : 0))
  view.setUint8(off + 29, Math.max(0, WIRE_MAPS.indexOf(s.map ?? 'blood-gulch')))
  view.setFloat32(off + 30, s.liftCooldown ?? 0)
  return off + SELF_BYTES
}

function readSelf(view: DataView, off: number): PlayerState {
  const flags = view.getUint8(off + 28)
  return {
    x: view.getFloat32(off),
    y: view.getFloat32(off + 4),
    z: view.getFloat32(off + 8),
    vx: view.getFloat32(off + 12),
    vy: view.getFloat32(off + 16),
    vz: view.getFloat32(off + 20),
    map: WIRE_MAPS[view.getUint8(off + 29)] ?? 'blood-gulch',
    liftCooldown: view.getFloat32(off + 30),
    fallFrom: view.getFloat32(off + 24),
    onGround: (flags & 1) !== 0,
    crouched: (flags & 2) !== 0,
    fallDamage: 0,
    teleportYaw: null,
  }
}

/** The vehicle the recipient is driving, full precision, for prediction replay. */
export const SELF_VEHICLE_BYTES = 141

function writeSelfVehicle(view: DataView, off: number, v: VehicleState): number {
  view.setFloat32(off, v.x)
  view.setFloat32(off + 4, v.y)
  view.setFloat32(off + 8, v.z)
  view.setFloat32(off + 12, v.yaw)
  view.setFloat32(off + 16, v.pitch)
  view.setFloat32(off + 20, v.roll)
  view.setFloat32(off + 24, v.speed)
  view.setFloat32(off + 28, v.steering)
  view.setFloat32(off + 32, v.vy)
  view.setFloat32(off + 36, v.maneuver)
  view.setFloat32(off + 40, v.maneuverCooldown)
  view.setFloat32(off + 44, v.maneuverSide)
  view.setFloat32(off + 48, v.maneuverHeld)
  view.setFloat32(off + 52, v.flightPitch)
  view.setFloat32(off + 56, v.impulseX)
  view.setFloat32(off + 60, v.impulseY)
  view.setFloat32(off + 64, v.impulseZ)
  view.setFloat32(off + 68, v.blastAir)
  view.setFloat32(off + 72, v.angularPitch)
  view.setFloat32(off + 76, v.angularRoll)
  view.setFloat32(off + 80, v.blastPitch)
  view.setFloat32(off + 84, v.blastRoll)
  view.setFloat32(off + 88, v.impactSpeed)
  view.setFloat32(off + 92, v.impactSeq)
  view.setFloat32(off + 96, v.qx ?? 0)
  view.setFloat32(off + 100, v.qy ?? 0)
  view.setFloat32(off + 104, v.qz ?? 0)
  view.setFloat32(off + 108, v.qw ?? 1)
  view.setFloat32(off + 112, v.pvx ?? 0)
  view.setFloat32(off + 116, v.pvy ?? 0)
  view.setFloat32(off + 120, v.pvz ?? 0)
  view.setFloat32(off + 124, v.avx ?? 0)
  view.setFloat32(off + 128, v.avy ?? 0)
  view.setFloat32(off + 132, v.avz ?? 0)
  view.setUint8(off + 136, v.physicsReady ? 1 : 0)
  view.setFloat32(off + 137, v.physicsRemainder ?? 0)
  return off + SELF_VEHICLE_BYTES
}

function readSelfVehicle(view: DataView, off: number): VehicleState {
  return {
    x: view.getFloat32(off), y: view.getFloat32(off + 4), z: view.getFloat32(off + 8),
    yaw: view.getFloat32(off + 12), pitch: view.getFloat32(off + 16), roll: view.getFloat32(off + 20),
    speed: view.getFloat32(off + 24), steering: view.getFloat32(off + 28),
    physicsReady: view.getUint8(off + 136) === 1,
    physicsRemainder: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 137) : 0,
    qx: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 96) : 0,
    qy: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 100) : 0,
    qz: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 104) : 0,
    qw: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 108) : 1,
    pvx: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 112) : 0,
    pvy: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 116) : 0,
    pvz: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 120) : 0,
    avx: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 124) : 0,
    avy: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 128) : 0,
    avz: view.getUint8(off + 136) === 1 ? view.getFloat32(off + 132) : 0,
    angularPitch: view.getFloat32(off + 72), angularRoll: view.getFloat32(off + 76), blastPitch: view.getFloat32(off + 80), blastRoll: view.getFloat32(off + 84), impactSpeed: view.getFloat32(off + 88), impactSeq: view.getFloat32(off + 92),
    impulseX: view.getFloat32(off + 56), impulseY: view.getFloat32(off + 60), impulseZ: view.getFloat32(off + 64), blastAir: view.getFloat32(off + 68),
    maneuverHeld: view.getFloat32(off + 48), flightPitch: view.getFloat32(off + 52),
    vy: view.getFloat32(off + 32), maneuver: view.getFloat32(off + 36), maneuverCooldown: view.getFloat32(off + 40), maneuverSide: view.getFloat32(off + 44),
    turretYaw: 0, turretPitch: 0,
  }
}

export const SNAPSHOT_HEADER = 8
const SELF_PLAYER = 1
const SELF_VEHICLE = 2

export function packSnapshot(
  tick: number, ackSeq: number, players: readonly WirePlayer[], vehicles: readonly WireVehicle[],
  self: PlayerState | null, selfVehicle: VehicleState | null,
): ArrayBuffer {
  const buf = new ArrayBuffer(
    SNAPSHOT_HEADER + players.length * PLAYER_BYTES + vehicles.length * VEHICLE_BYTES
    + (self ? SELF_BYTES : 0) + (selfVehicle ? SELF_VEHICLE_BYTES : 0),
  )
  const view = new DataView(buf)
  view.setUint8(0, Msg.Snapshot)
  view.setUint8(1, players.length)
  view.setUint16(2, tick & 0xffff)
  view.setUint16(4, ackSeq & 0xffff)
  view.setUint8(6, (self ? SELF_PLAYER : 0) | (selfVehicle ? SELF_VEHICLE : 0))
  view.setUint8(7, vehicles.length)
  let off = SNAPSHOT_HEADER
  for (const p of players) off = writePlayer(view, off, p)
  for (const v of vehicles) off = writeVehicle(view, off, v)
  if (self) off = writeSelf(view, off, self)
  if (selfVehicle) writeSelfVehicle(view, off, selfVehicle)
  return buf
}

export interface Snapshot {
  tick: number
  /** The last input sequence the server had applied when it sent this. */
  ackSeq: number
  players: WirePlayer[]
  vehicles: WireVehicle[]
  /** Your own simulation state as the server has it, after applying `ackSeq`. */
  self: PlayerState | null
  /** The vehicle you are driving, likewise. */
  selfVehicle: VehicleState | null
}

export function unpackSnapshot(buf: ArrayBuffer): Snapshot {
  const view = new DataView(buf)
  const count = view.getUint8(1)
  const selfFlags = view.getUint8(6)
  const vehicleCount = view.getUint8(7)
  const snap: Snapshot = { tick: view.getUint16(2), ackSeq: view.getUint16(4), players: [], vehicles: [], self: null, selfVehicle: null }
  let off = SNAPSHOT_HEADER
  for (let i = 0; i < count; i++) {
    const p = { id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, shield: 0, health: 0, weapon: 0 }
    off = readPlayer(view, off, p)
    snap.players.push(p)
  }
  for (let i = 0; i < vehicleCount; i++) {
    const v: WireVehicle = { id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, turretYaw: 0, turretPitch: 0, speed: 0, driver: 0, gunner: 0, flags: 0 }
    off = readVehicle(view, off, v)
    snap.vehicles.push(v)
  }
  if (selfFlags & SELF_PLAYER && off + SELF_BYTES <= buf.byteLength) { snap.self = readSelf(view, off); off += SELF_BYTES }
  if (selfFlags & SELF_VEHICLE && off + SELF_VEHICLE_BYTES <= buf.byteLength) snap.selfVehicle = readSelfVehicle(view, off)
  return snap
}

// ---------------------------------------------------------------- events

export interface Welcome { id: number; team: 'red' | 'blue'; maxPlayers: number }

export function packWelcome(w: Welcome): ArrayBuffer {
  const buf = new ArrayBuffer(4)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Welcome)
  view.setUint8(1, w.id)
  view.setUint8(2, w.team === 'blue' ? 1 : 0)
  view.setUint8(3, w.maxPlayers)
  return buf
}

export function unpackWelcome(view: DataView): Welcome {
  return { id: view.getUint8(1), team: view.getUint8(2) ? 'blue' : 'red', maxPlayers: view.getUint8(3) }
}

export const SHOT_CHARGED = 32
export const SHOT_LEFT = 64
export const SHOT_HIT = 1
export const SHOT_SHIELD = 2
/** A swing rather than a round: no tracer, and `end` is the contact point, not where a shot stopped. */
export const SHOT_MELEE = 4

export interface Shot { shooter: number; weapon: number; end: { x: number; y: number; z: number }; flags: number }

/** Someone fired: where the round stopped, so everyone else can draw the tracer. */
export function packShot(s: Shot): ArrayBuffer {
  const buf = new ArrayBuffer(10)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Shot)
  view.setUint8(1, s.shooter)
  view.setUint8(2, s.weapon)
  writePoint(view, 3, s.end.x, s.end.y, s.end.z)
  view.setUint8(9, s.flags)
  return buf
}

export function unpackShot(view: DataView): Shot {
  const s: Shot = { shooter: view.getUint8(1), weapon: view.getUint8(2), end: { x: 0, y: 0, z: 0 }, flags: view.getUint8(9) }
  readPoint(view, 3, s.end)
  return s
}

export const HIT_KILLED = 1
export const HIT_HEADSHOT = 2
export const HIT_SHIELD = 4
/** A melee strike (fist or rifle butt), not a blade or the hammer. */
export const HIT_MELEE = 8
/** The strike came from behind the victim: an assassination. */
export const HIT_BEHIND = 16
/** The victim was mid-lunge with a sword. */
export const HIT_BULLTRUE = 32
/** The victim was on a killing spree. */
export const HIT_KILLJOY = 64

/** `cause` and `context` describe the kill for the medals (kill-info.ts); 255 and 0 when unknown. */
export interface Hit { target: number; flags: number; cause?: number; context?: number }

/** To the shooter only: your round connected. Drives the hit marker, the kill feed and the medals. */
export function packHit(h: Hit): ArrayBuffer {
  const buf = new ArrayBuffer(5)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Hit)
  view.setUint8(1, h.target)
  view.setUint8(2, h.flags)
  view.setUint8(3, h.cause ?? 255)
  view.setUint8(4, h.context ?? 0)
  return buf
}

/** Reads the three-byte form an older server sends, too. */
export function unpackHit(view: DataView): Hit {
  const long = view.byteLength >= 5
  return { target: view.getUint8(1), flags: view.getUint8(2), cause: long ? view.getUint8(3) : 255, context: long ? view.getUint8(4) : 0 }
}

export type DeathImpact = BulletImpact
export interface Death { victim: number; killer: number; impact?: DeathImpact }

/** Killer 0 means the canyon did it: a fall, or a rocket into your own feet. */
export function packDeath(d: Death): ArrayBuffer {
  const buf = new ArrayBuffer(d.impact ? 31 : 3)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Death);view.setUint8(1,d.victim);view.setUint8(2,d.killer)
  if(d.impact){const p=d.impact.point,n=d.impact.direction;[p.x,p.y,p.z,n.x,n.y,n.z,d.impact.strength].forEach((v,i)=>view.setFloat32(3+i*4,v))}
  return buf
}

export function unpackDeath(view: DataView): Death {
  const death:Death={victim:view.getUint8(1),killer:view.getUint8(2)}
  if(view.byteLength>=31){
    const values=Array.from({length:7},(_,i)=>view.getFloat32(3+i*4))
    if(values.every(Number.isFinite))death.impact={point:{x:values[0],y:values[1],z:values[2]},direction:{x:values[3],y:values[4],z:values[5]},strength:Math.max(0,Math.min(20,values[6]))}
  }
  return death
}

export function packPing(time: number): ArrayBuffer {
  const buf = new ArrayBuffer(5)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Ping)
  view.setUint32(1, time >>> 0)
  return buf
}

export function unpackPing(view: DataView): number {
  return view.getUint32(1)
}

/** `stuck`: the player a plasma grenade was stuck to, by id; the server checks the blast was on them. */
export interface Splash { kind: number; x: number; y: number; z: number; stuck?: number }

/** Client to server: the projectile I own went off here. Eight bytes, nine when it was stuck to someone. */
export function packSplash(s: Splash): ArrayBuffer {
  const buf = new ArrayBuffer(s.stuck ? 9 : 8)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Splash)
  view.setUint8(1, s.kind)
  writePoint(view, 2, s.x, s.y, s.z)
  if (s.stuck) view.setUint8(8, s.stuck)
  return buf
}

export function unpackSplash(view: DataView): Splash {
  const s: Splash = { kind: view.getUint8(1), x: 0, y: 0, z: 0 }
  readPoint(view, 2, s)
  if (view.byteLength > 8) s.stuck = view.getUint8(8)
  return s
}

export interface Explosion { kind: number; owner: number; x: number; y: number; z: number }

export function packExplosion(e: Explosion): ArrayBuffer {
  const buf = new ArrayBuffer(9)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Explosion)
  view.setUint8(1, e.kind)
  view.setUint8(2, e.owner)
  writePoint(view, 3, e.x, e.y, e.z)
  return buf
}

export function unpackExplosion(view: DataView): Explosion {
  const e: Explosion = { kind: view.getUint8(1), owner: view.getUint8(2), x: 0, y: 0, z: 0 }
  readPoint(view, 3, e)
  return e
}

export interface Launch {
  owner: number
  kind: number
  x: number
  y: number
  z: number
  /** Direction as yaw/pitch of travel; the speed in m/s, whole numbers up to 255. */
  yaw: number
  pitch: number
  speed: number
}

export const LAUNCH_BYTES = 14

/**
 * A projectile left its owner. The client writes owner 0 and the server stamps the real id on
 * the way through, so a client cannot launch rockets in someone else's name.
 */
export function packLaunch(l: Launch): ArrayBuffer {
  const buf = new ArrayBuffer(LAUNCH_BYTES)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Launch)
  view.setUint8(1, l.owner)
  view.setUint8(2, l.kind)
  writePoint(view, 3, l.x, l.y, l.z)
  view.setUint16(9, qAngle(l.yaw))
  view.setUint16(11, qPitch(l.pitch))
  view.setUint8(13, Math.min(255, Math.max(0, Math.round(l.speed))))
  return buf
}

export function unpackLaunch(view: DataView): Launch {
  const l: Launch = {
    owner: view.getUint8(1), kind: view.getUint8(2), x: 0, y: 0, z: 0,
    yaw: dqAngle(view.getUint16(9)), pitch: dqPitch(view.getUint16(11)), speed: view.getUint8(13),
  }
  readPoint(view, 3, l)
  return l
}

export function packFull(): ArrayBuffer {
  const buf = new ArrayBuffer(1)
  new DataView(buf).setUint8(0, Msg.Full)
  return buf
}

// ---------------------------------------------------------------- names

/** Characters, not bytes: what the player sees in the field and what everyone else reads. */
export const MAX_NAME = 16
/** Sixteen code points can be four bytes each, so the wire allowance is four times the length. */
export const MAX_NAME_BYTES = MAX_NAME * 4

const encoder = new TextEncoder()
// Defaults are what we want: never throw on a malformed byte, keep any leading BOM out of
// the name by way of the sanitiser rather than the decoder.
const decoder = new TextDecoder()

/**
 * Trim a name down to something safe to show other people.
 *
 * Names are the one piece of player-authored content in the game, and they are drawn on
 * everyone else's HUD, so they are cleaned here — once, in shared code — rather than at each
 * display site. Control characters, the zero-width and bidirectional-override ranges, and
 * runs of whitespace all go: they are the characters used to impersonate other players or the
 * HUD's own text. The server re-runs this on receipt and never trusts the client's version.
 */
export function sanitiseName(raw: string): string {
  const kept: string[] = []
  for (const ch of raw.normalize('NFC')) {
    const code = ch.codePointAt(0) as number
    const printable = code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)
    const invisible = (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff
    if (printable && !invisible) kept.push(ch)
  }
  // Sliced by code point, not by UTF-16 unit, so a cap never cuts an emoji in half.
  return [...kept.join('').replace(/\s+/g, ' ').trim()].slice(0, MAX_NAME).join('')
}

/** The name a player has before they have chosen one, and the fallback for an empty choice. */
export function defaultName(id: number): string {
  return `Spartan ${id}`
}

export function packName(name: string): ArrayBuffer {
  const bytes = encoder.encode(sanitiseName(name)).subarray(0, MAX_NAME_BYTES)
  const buf = new ArrayBuffer(2 + bytes.length)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Name)
  view.setUint8(1, bytes.length)
  new Uint8Array(buf, 2).set(bytes)
  return buf
}

export function unpackName(buf: ArrayBuffer): string {
  const view = new DataView(buf)
  const length = Math.min(view.getUint8(1), buf.byteLength - 2)
  return sanitiseName(decoder.decode(new Uint8Array(buf, 2, Math.max(0, length))))
}

export interface RosterEntry { id: number; name: string }

/** Who is in the match, sent whenever that changes. Small and rare; not on the tick path. */
export function packRoster(entries: readonly RosterEntry[]): ArrayBuffer {
  const encoded = entries.map(e => ({ id: e.id, bytes: encoder.encode(e.name).subarray(0, MAX_NAME_BYTES) }))
  const buf = new ArrayBuffer(2 + encoded.reduce((n, e) => n + 2 + e.bytes.length, 0))
  const view = new DataView(buf)
  view.setUint8(0, Msg.Roster)
  view.setUint8(1, encoded.length)
  let off = 2
  for (const e of encoded) {
    view.setUint8(off, e.id)
    view.setUint8(off + 1, e.bytes.length)
    new Uint8Array(buf, off + 2, e.bytes.length).set(e.bytes)
    off += 2 + e.bytes.length
  }
  return buf
}

export function unpackRoster(buf: ArrayBuffer): RosterEntry[] {
  const view = new DataView(buf)
  const count = view.getUint8(1)
  const out: RosterEntry[] = []
  let off = 2
  for (let i = 0; i < count && off + 2 <= buf.byteLength; i++) {
    const id = view.getUint8(off)
    const length = Math.min(view.getUint8(off + 1), buf.byteLength - off - 2)
    out.push({ id, name: sanitiseName(decoder.decode(new Uint8Array(buf, off + 2, length))) || defaultName(id) })
    off += 2 + length
  }
  return out
}

export interface ScoreboardEntry { id: number; team: 'red' | 'blue'; kills: number; deaths: number }

/** Stats are sent only when they change, never on the snapshot tick path. */
export function packScoreboard(entries: readonly ScoreboardEntry[]): ArrayBuffer {
  const buf = new ArrayBuffer(2 + entries.length * 6)
  const view = new DataView(buf)
  view.setUint8(0, Msg.Scoreboard)
  view.setUint8(1, entries.length)
  let off = 2
  for (const e of entries) {
    view.setUint8(off, e.id)
    view.setUint8(off + 1, e.team === 'blue' ? 1 : 0)
    view.setUint16(off + 2, Math.min(65535, Math.max(0, e.kills)))
    view.setUint16(off + 4, Math.min(65535, Math.max(0, e.deaths)))
    off += 6
  }
  return buf
}

export function unpackScoreboard(buf: ArrayBuffer): ScoreboardEntry[] {
  const view = new DataView(buf)
  const count = Math.min(view.getUint8(1), Math.floor((buf.byteLength - 2) / 6))
  const out: ScoreboardEntry[] = []
  let off = 2
  for (let i = 0; i < count; i++, off += 6) {
    out.push({ id: view.getUint8(off), team: view.getUint8(off + 1) ? 'blue' : 'red', kills: view.getUint16(off + 2), deaths: view.getUint16(off + 4) })
  }
  return out
}
