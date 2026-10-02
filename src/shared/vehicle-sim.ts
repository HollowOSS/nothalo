import {bloodGulchFloor} from './blood-gulch.ts'
import {stepRigidVehicle,blastRigidVehicle,meleeRigidVehicle} from './vehicle-physics.ts'
import { type BlastPoint } from './blast-impulse.ts'
import { RED_BASE, BLUE_BASE, CLIFF_HEIGHT, type Team } from './map.ts'
import { solidAt, solidBetween } from './solid.ts'

/**
 * Vehicle physics, shared.
 *
 * Pure like the character controller and for the same reason: the driver predicts by running
 * this on their own input, the server runs it on the same input, and the two agree without
 * anyone sending positions back and forth mid-step. Nothing here knows about meshes — the
 * canyon is the imported mesh shared by on-foot and rigid-body collision.
 *
 * Cannon rigid-body integration lives in vehicle-physics.ts and restores from this serializable
 * state on every call, including authoritative replay. Vehicle physics uses a fixed 60 Hz accumulator.
 */

export type VehicleKind = 'warthog' | 'ghost' | 'banshee' | 'mongoose' | 'chopper'
export type Seat = 'driver' | 'gunner'

export interface VehicleState {
  /** Serializable rest state keeps parked physics cheap and prediction replay deterministic. */
  physicsQuietSteps?: number
  physicsRestPose?: readonly number[]
  physicsReady?: boolean
  physicsRemainder?: number
  qx?: number; qy?: number; qz?: number; qw?: number
  pvx?: number; pvy?: number; pvz?: number
  avx?: number; avy?: number; avz?: number
  wheelTravel?: number[]
  x: number
  y: number
  z: number
  yaw: number
  /** Nose up is positive. Ground vehicles read it from the slope; the Banshee flies it. */
  pitch: number
  roll: number
  speed: number
  vy: number
  maneuver: number
  maneuverCooldown: number
  maneuverSide: number
  maneuverHeld: number
  flightPitch: number
  impulseX: number
  impulseY: number
  impulseZ: number
  blastAir: number
  angularPitch: number
  angularRoll: number
  blastPitch: number
  blastRoll: number
  impactSpeed: number
  impactSeq: number
  /** -1..1, how far the wheels or the hull are turned into the current turn. */
  steering: number
  /** Warthog turret, hull-local. */
  turretYaw: number
  turretPitch: number
}

export interface VehicleInput {
  /** -1..1 throttle. */
  readonly forward: number
  /** -1..1, Ghost sidestep only. */
  readonly strafe: number
  /** Where the driver is looking; the hull chases it. */
  readonly yaw: number
  readonly pitch: number
  /** Handbrake on the ground, crawl in the air. */
  readonly jump?: boolean
  readonly brake: boolean
  /** Nobody is driving: roll to a stop, settle, level out. */
  readonly coast: boolean
}

export interface VehicleSpawn {
  readonly id: number
  readonly kind: VehicleKind
  readonly team: Team
  readonly x: number
  readonly z: number
  readonly yaw: number
}

/** Every vehicle on the map, in wire order. The id is the index. */
export const VEHICLE_SPAWNS: readonly VehicleSpawn[] = (() => {
  const out: VehicleSpawn[] = []
  for (const [team, base] of [['red', RED_BASE], ['blue', BLUE_BASE]] as const) {
    const toward = team === 'red' ? 1 : -1
    const yaw = team === 'red' ? Math.PI : 0
    out.push({ id: out.length, kind: 'warthog', team, x: base.x + 12, z: base.z + 34 * toward, yaw })
    out.push({ id: out.length, kind: 'ghost', team, x: base.x - 12, z: base.z + 34 * toward, yaw })
    // The Banshee parks out beside the base, off the sand the ground vehicles drive across.
    out.push({ id: out.length, kind: 'banshee', team, x: base.x + 30 * toward, z: base.z - 6 * toward, yaw })
  }
  for (const [team, base] of [['red', RED_BASE], ['blue', BLUE_BASE]] as const) {
    const toward=team==='red'?1:-1, yaw=team==='red'?Math.PI:0
    out.push({id:out.length,kind:'mongoose',team,x:base.x+20,z:base.z+46*toward,yaw})
    out.push({id:out.length,kind:'chopper',team,x:base.x-20,z:base.z+46*toward,yaw})
  }
  return out
})()

export function spawnVehicleState(spawn: VehicleSpawn): VehicleState {
  return {
    physicsReady:false,physicsRemainder:0,qx:0,qy:0,qz:0,qw:1,pvx:0,pvy:0,pvz:0,avx:0,avy:0,avz:0,
    x: spawn.x, y: bloodGulchFloor(spawn.x, spawn.z) + hoverHeight(spawn.kind), z: spawn.z,
    yaw: spawn.yaw, pitch: 0, roll: 0, speed: 0, vy: 0, maneuver: 0, maneuverCooldown: 0, maneuverSide: 0, maneuverHeld: 0, flightPitch: 0, impulseX: 0, impulseY: 0, impulseZ: 0, blastAir: 0, angularPitch: 0, angularRoll: 0, blastPitch: 0, blastRoll: 0, impactSpeed: 0, impactSeq: 0, steering: 0, turretYaw: 0, turretPitch: 0,
  }
}

export function cloneVehicleState(s: VehicleState): VehicleState {
  return { ...s }
}

export const IDLE_VEHICLE_INPUT: VehicleInput = { forward: 0, strafe: 0, yaw: 0, pitch: 0, brake: false, coast: true }

/**
 * Where a seated player's feet are, hull-local, measured from the authored models' seat
 * markers. Hull-local +z is forward. The server puts the occupant's hit capsule here.
 */
export const SEATS: Record<VehicleKind, Partial<Record<Seat, readonly [number, number, number]>>> = {
  warthog: { driver: [0.57365, 0.60, -0.31317], gunner: [0, 1.84, -2.01817] },
  ghost: { driver: [0, 0.2, -1.4] },
  banshee: { driver: [0, 0.25, 0.05] },
  // The existing secondary-seat wire slot carries the Mongoose passenger.
  mongoose: { driver: [0,.55,-.05], gunner: [0,.55,-.9] },
  chopper: { driver: [0,.72,-2.05] },
}

/** Neutral-pose joints measured from the H3 model; yaw and pitch are not concentric. */
export const WARTHOG_TURRET_PIVOT: readonly [number, number, number] = [0, 1.48329555, -1.78719035]
export const WARTHOG_GUN_PIVOT: readonly [number, number, number] = [0, 2.7960812, -0.8576128]
const WARTHOG_MUZZLE: readonly [number, number, number] = [-0.0000198, 3.1179522, 0.71203]

function turretPointWorld(s: VehicleState, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  const [tx, ty, tz] = WARTHOG_TURRET_PIVOT
  const [rx, , rz] = rotateY(x - tx, y - ty, z - tz, s.turretYaw)
  hullToWorld(s, tx + rx, y, tz + rz, out)
}

/** Server hitscan follows the same pitch-then-yaw hierarchy as the visible barrel. */
export function warthogMuzzleWorld(s: VehicleState, out: { x: number; y: number; z: number }): void {
  const [px, py, pz] = WARTHOG_GUN_PIVOT
  const [x, y, z] = rotateX(WARTHOG_MUZZLE[0] - px, WARTHOG_MUZZLE[1] - py, WARTHOG_MUZZLE[2] - pz, s.turretPitch)
  turretPointWorld(s, px + x, py + y, pz + z, out)
}

/** How far from the hull centre a player can be and still climb in. */
export const ENTER_RANGE = 5

const STEP = 1 / 60
const UP = 1

function hoverHeight(kind: VehicleKind): number {
  return kind === 'ghost' ? 0.4 : 0
}

const clamp = (n: number, a: number, b: number): number => (n < a ? a : n > b ? b : n)
const damp = (x: number, y: number, lambda: number, dt: number): number => x + (y - x) * (1 - Math.exp(-lambda * dt))
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))

/** Hull-local offset to world, yaw only. Enough for seats and gun pivots. */
export function hullToWorld(s: VehicleState, lx: number, ly: number, lz: number, out: { x: number; y: number; z: number }): void {
  if(s.physicsReady){
    const qx=s.qx??0,qy=s.qy??0,qz=s.qz??0,qw=s.qw??1
    const tx=2*(qy*lz-qz*ly),ty=2*(qz*lx-qx*lz),tz=2*(qx*ly-qy*lx)
    out.x=s.x+lx+qw*tx+qy*tz-qz*ty
    out.y=s.y+ly+qw*ty+qz*tx-qx*tz
    out.z=s.z+lz+qw*tz+qx*ty-qy*tx
    return
  }
  const sin = Math.sin(s.yaw), cos = Math.cos(s.yaw)
  // Local +z is forward, which in the world is (-sin yaw, -cos yaw); local +x is the right.
  out.x = s.x + cos * lx - sin * lz
  out.y = s.y + ly
  out.z = s.z - sin * lx - cos * lz
}

export function seatWorld(kind: VehicleKind, s: VehicleState, seat: Seat, out: { x: number; y: number; z: number }): boolean {
  const local = SEATS[kind][seat]
  if (!local) return false
  if (kind === 'warthog' && seat === 'gunner') turretPointWorld(s, local[0], local[1], local[2], out)
  else hullToWorld(s, local[0], local[1], local[2], out)
  return true
}

/**
 * Somewhere beside the vehicle to step out to: the first side that is inside the canyon and
 * not through a rock or a wall. Returns false if both sides are blocked. Out of a Banshee in
 * flight the spot is beside the hull in the air, and the fall is the passenger's problem.
 */
export function exitSpot(s: VehicleState, out: { x: number; y: number; z: number }): boolean {
  for (const side of [1, -1]) {
    const x = s.x + Math.cos(s.yaw) * 3.5 * side
    const z = s.z - Math.sin(s.yaw) * 3.5 * side
    if (bloodGulchFloor(x,z) < -100) continue
    const y = Math.max(bloodGulchFloor(x, z), s.y - 0.5)
    if (solidBetween(s.x, s.y + 1, s.z, x, y + 1, z)) continue
    out.x = x; out.y = y; out.z = z
    return true
  }
  return false
}

/**
 * Point the Warthog turret at a world aim, within its stops. Hull-local, so the gunner's aim
 * has the hull's slope and roll taken out of it exactly the way the model is rigged.
 */
export function aimTurret(s: VehicleState, yaw: number, pitch: number): void {
  // World aim direction.
  let dx = -Math.sin(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = -Math.cos(yaw) * Math.cos(pitch)
  // Into hull space: undo the hull's YXZ rotation (yaw + π about Y, -pitch about X, roll about Z).
  ;[dx, dy, dz] = rotateY(dx, dy, dz, -(s.yaw + Math.PI))
  ;[dx, dy, dz] = rotateX(dx, dy, dz, s.pitch)
  ;[dx, dy, dz] = rotateZ(dx, dy, dz, -s.roll)
  s.turretYaw = Math.atan2(dx, dz)
  s.turretPitch = clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -0.65, 0.65)
}

/** World direction the Warthog's barrels point, from the turret angles and the hull attitude. */
export function turretDirection(s: VehicleState, out: { x: number; y: number; z: number }): void {
  // Barrels point along hull-local +z, turned by turret yaw about Y then pitch about X.
  let dx = 0, dy = 0, dz = 1
  ;[dx, dy, dz] = rotateX(dx, dy, dz, s.turretPitch)
  ;[dx, dy, dz] = rotateY(dx, dy, dz, s.turretYaw)
  ;[dx, dy, dz] = rotateZ(dx, dy, dz, s.roll)
  ;[dx, dy, dz] = rotateX(dx, dy, dz, -s.pitch)
  ;[dx, dy, dz] = rotateY(dx, dy, dz, s.yaw + Math.PI)
  const len = Math.hypot(dx, dy, dz) || 1
  out.x = dx / len; out.y = dy / len; out.z = dz / len
}

function rotateX(x: number, y: number, z: number, a: number): [number, number, number] {
  const c = Math.cos(a), s = Math.sin(a)
  return [x, y * c - z * s, y * s + z * c]
}
function rotateY(x: number, y: number, z: number, a: number): [number, number, number] {
  const c = Math.cos(a), s = Math.sin(a)
  return [x * c + z * s, y, -x * s + z * c]
}
function rotateZ(x: number, y: number, z: number, a: number): [number, number, number] {
  const c = Math.cos(a), s = Math.sin(a)
  return [x * c - y * s, x * s + y * c, z]
}

/** Advance a vehicle by `dt` seconds under this input. */
export function stepVehicle(kind: VehicleKind, s: VehicleState, input: VehicleInput, dt: number): void {
  stepRigidVehicle(kind,s,input,dt)
}

/** How far apart two vehicle states are, for reconciliation. */
export function vehicleDisagreement(a: VehicleState, b: VehicleState): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) + Math.abs(wrap(a.yaw - b.yaw)) * 2 + Math.abs(a.speed - b.speed) * 0.1
}

/** Swept hull vs standing capsule. Both offline and server use the same impact rule. */
export function vehicleImpact(kind: VehicleKind, previous: { x: number; y: number; z: number }, s: VehicleState, target: { x: number; y: number; z: number }): number {
  const speed = Math.hypot(-Math.sin(s.yaw) * s.speed + s.impulseX, -Math.cos(s.yaw) * s.speed + s.impulseZ)
  if (speed < 5) return 0
  const dx = s.x - previous.x, dz = s.z - previous.z
  const t = clamp(((target.x - previous.x) * dx + (target.z - previous.z) * dz) / (dx * dx + dz * dz || 1), 0, 1)
  const y = previous.y + (s.y - previous.y) * t
  if (target.y + 1.7 < y || target.y > y + (kind === 'warthog' ? 1.8 : 1.1)) return 0
  const radius = kind === 'warthog' ? 1.55 : 1.35
  if (Math.hypot(target.x - previous.x - dx * t, target.z - previous.z - dz * t) > radius) return 0
  return Math.min(220, (speed - 4) * 18)
}

/** Imported canyon already includes its boulders and base roofs. */
export function ghostHoverFloor(x:number,z:number):number {return bloodGulchFloor(x,z)+.55}

/** External momentum remains independent of throttle, hull yaw, and hover stabilization. */
export function applyVehicleBlast(kind:VehicleKind, state:VehicleState, point:BlastPoint, radius:number, strength:number):boolean {
  return blastRigidVehicle(kind,state,point,radius,strength)
}
export function applyVehicleMelee(kind:VehicleKind,state:VehicleState,point:{x:number;y:number;z:number},direction:{x:number;y:number;z:number},strength=1100):boolean {
  return meleeRigidVehicle(kind,state,point,direction,strength)
}

function collisionPulse(s:VehicleState, speed:number):void {
  if(speed<3)return
  s.impactSpeed=Math.max(s.impactSpeed,Math.min(35,speed))
  s.impactSeq=(s.impactSeq+1)%65536
}

export const WARTHOG_WHEEL_CONTACTS = [[-1.32,1.90],[1.32,1.90],[-1.32,-1.90],[1.32,-1.90]] as const
/** Wheel order front-left, front-right, rear-left, rear-right; offsets are hull-local vertical travel. */
export function warthogSuspensionSamples(s:Pick<VehicleState,'x'|'y'|'z'|'yaw'|'pitch'|'roll'>):{height:number;pitch:number;roll:number;offsets:number[]} {
  const sin=Math.sin(s.yaw),cos=Math.cos(s.yaw)
  const heights=WARTHOG_WHEEL_CONTACTS.map(([x,z])=>{
    const wx=s.x-cos*x-sin*z,wz=s.z+sin*x-cos*z,g=bloodGulchFloor(wx,wz)
    return g
  })
  const height=heights.reduce((a,b)=>a+b,0)/4
  const pitch=Math.atan2((heights[0]+heights[1]-heights[2]-heights[3])*.5,3.8)
  const roll=Math.atan2((heights[1]+heights[3]-heights[0]-heights[2])*.5,2.64)
  const offsets=WARTHOG_WHEEL_CONTACTS.map(([x,z],i)=>clamp(heights[i]-s.y-Math.sin(s.pitch)*z-Math.sin(s.roll)*x,-.4,.34))
  return {height,pitch,roll,offsets}
}
