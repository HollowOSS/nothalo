import { MOVE } from './constants.ts'
import type { Team } from './map.ts'
import type { PlayerState } from './movement.ts'
import { lockoutCollision, LOCKOUT_VOID_FLOOR } from './lockout-collision.ts'
import {LOCKOUT_BOUNDS,LOCKOUT_SPAWN_HASH,lockoutScale} from './lockout-transform.ts'
export {LOCKOUT_IMPORT,LOCKOUT_BOUNDS,LOCKOUT_SPAWN_HASH} from './lockout-transform.ts'

/**
 * Lockout's gameplay collision is a cooked static triangle mesh of the imported architecture
 * (docs/lockout-scale.md). Movement, shots, spawning and the physics floor slabs all query that
 * one mesh, and the renderer places the visible model with the same transform, so what you see
 * is what stops you. The cliff shell is deliberately not in it: nothing can stand on it.
 */
// Lockout's narrow doorways need a 20 cm capsule radius; the remaining 5 cm is the collision
// margin against the visual body and keeps the player from snagging on narrow jamb edges.
export const LOCKOUT_PLAYER_RADIUS = .2
export const LOCKOUT_DEATH_Y = -20
export const LOCKOUT_SPAWN_STORAGE_KEY = 'halo-ce.lockout-spawns.v4'
// Lockout's team starts follow the retail layout: blue starts on the BR tower's top platform and
// red on the Sniper tower's, at opposite ends of the arena. Four starts per team sit on the
// exposed tower decks measured on the imported mesh at its true scale (one source unit is one
// metre), inset from the rails and at least 3 m apart so respawning players never stack. The y
// values are the deck heights lockoutFloor reports; lockoutSpawn re-derives them anyway.
export const LOCKOUT_SPAWNS = [
  {x:-20.0,y:33.18,z:-20.0}, {x:-20.0,y:33.18,z:-16.67}, {x:-24.0,y:33.18,z:-20.0}, {x:-23.0,y:33.18,z:-17.0},   // red · Sniper tower
  {x:21.67,y:28.31,z:-28.0}, {x:18.5,y:28.34,z:-28.0}, {x:15.0,y:28.31,z:-28.0}, {x:16.0,y:28.34,z:-25.0},     // blue · BR tower
] as const
/** Area-weighted centre of the walkable decks (from the collision mesh). Spawns face it,
 * so a player wakes up looking across the arena instead of into the tower wall or the cliff. */
const LOCKOUT_ARENA_CENTRE = {x:-5,z:-17}

type Spawn = {x:number;y:number;z:number}
/** Yaw that faces the arena centre; movement's forward vector is (-sin yaw, -cos yaw). */
export function lockoutSpawnYaw(p:Spawn):number { const k=lockoutScale();return Math.atan2(p.x-LOCKOUT_ARENA_CENTRE.x*k,p.z-LOCKOUT_ARENA_CENTRE.z*k) }
function savedBrowserSpawns(): readonly Spawn[]|undefined {
  const browser=globalThis as typeof globalThis & {localStorage?:{getItem:(key:string)=>string|null};location?:{hash?:string}}
  try {
    const hash=browser.location?.hash??''
    const encoded=hash.startsWith('#'+LOCKOUT_SPAWN_HASH)?hash.slice(LOCKOUT_SPAWN_HASH.length+1):''
    const raw=encoded?decodeURIComponent(encoded):browser.localStorage?.getItem(LOCKOUT_SPAWN_STORAGE_KEY)
    if (!raw) return undefined
    const parsed=JSON.parse(raw)
    if (!Array.isArray(parsed)||parsed.length!==LOCKOUT_SPAWNS.length) return undefined
    if (!parsed.every((p)=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.z))) return undefined
    return parsed as Spawn[]
  } catch { return undefined }
}

function insideSpawnZone(x:number,z:number,y:number):boolean {
  const floor=lockoutFloor(x,z,y+.2,.05)
  return floor>LOCKOUT_VOID_FLOOR*lockoutScale()&&Math.abs(floor-y)<.25
}
export function lockoutFloor(x: number, z: number, y = 100, step: number = MOVE.stepHeight): number {
  return lockoutCollision().supportedFloor(x, z, y, step, LOCKOUT_PLAYER_RADIUS*.8)
}
export function lockoutBlocked(x: number, z: number, y: number, height: number): boolean {
  const k = lockoutScale()
  if (x < LOCKOUT_BOUNDS.x0 * k || x > LOCKOUT_BOUNDS.x1 * k || z < LOCKOUT_BOUNDS.z0 * k || z > LOCKOUT_BOUNDS.z1 * k) return true
  return lockoutCollision().blocked(x, z, y, height, LOCKOUT_PLAYER_RADIUS, MOVE.stepHeight)
}
export function lockoutSolidAt(x: number, y: number, z: number): boolean {
  return y < LOCKOUT_VOID_FLOOR * lockoutScale() || lockoutCollision().solidAt(x, y, z)
}

export function lockoutRay(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const k = lockoutScale()
  if (ay < LOCKOUT_VOID_FLOOR * k || by < LOCKOUT_VOID_FLOOR * k) return true
  return lockoutCollision().ray(ax, ay, az, bx, by, bz)
}

export function lockoutRayDistance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
  // All shots, including authoritative multiplayer hitscan, stop at the first surface.
  // A camera close to a ledge must not grant permission to shoot through its deck.
  return lockoutCollision().mesh.raycast(ox, oy, oz, dx, dy, dz, max)?.t ?? max
}
export function lockoutSpawn(team:Team,index=0):{x:number;y:number;z:number}{
  const half=LOCKOUT_SPAWNS.length/2,wrapped=((index%half)+half)%half
  const side=team==='red'?LOCKOUT_SPAWNS.slice(0,half):LOCKOUT_SPAWNS.slice(half)
  const slot=(team==='red'?0:half)+wrapped
  const saved=savedBrowserSpawns()
  const candidate=saved?.[slot]
  const anchor=candidate&&insideSpawnZone(candidate.x,candidate.z,candidate.y)
    ? candidate
    : side[((index%side.length)+side.length)%side.length]
  // Derive the vertical placement from the same deck table used by movement.
  // This keeps a later art/physics adjustment from reintroducing a floating or
  // buried spawn through a stale y literal.
  const k=lockoutScale(),x=anchor.x*k,z=anchor.z*k
  const floor=lockoutFloor(x,z,anchor.y*k+.2,.05)
  return {x,y:floor>LOCKOUT_VOID_FLOOR*k?floor:anchor.y*k,z}
}
export function lockoutMove(s: PlayerState, dt: number): PlayerState {
  const height = MOVE.playerHeight * (s.crouched ? 0.62 : 1), oldY = s.y
  let x = s.x, z = s.z, y = s.y + s.vy * dt
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(s.vx * dt), Math.abs(s.vz * dt)) / 0.18))
  let supportY=oldY
  const tryAxis=(px:number,pz:number):boolean=>{
    const support=lockoutFloor(px,pz,supportY,MOVE.stepHeight)
    // Test the capsule at the surface it will actually stand on. Testing at the old
    // foot height makes an uphill ramp's surface look like a wall in front of the toes.
    const feet=s.onGround&&s.vy<=0?Math.max(supportY,support):supportY
    if(lockoutBlocked(px,pz,feet,height))return false
    if(s.onGround&&s.vy<=0&&Math.abs(support-supportY)<=MOVE.stepHeight)supportY=support
    return true
  }
  for (let i = 0; i < steps; i++) {
    const nx = x + s.vx * dt / steps, nz = z + s.vz * dt / steps
    if (!tryAxis(nx,z)) s.vx = 0; else x = nx
    if (!tryAxis(x,nz)) s.vz = 0; else z = nz
  }
  const floor = lockoutFloor(x, z, supportY, MOVE.stepHeight)
  if(s.vy>0){
    const ceiling=lockoutCollision().ceiling(x,z,oldY+height-.01,y+height)
    if(ceiling!==null){y=Math.min(y,ceiling-height);s.vy=0}
  }
  // Stay planted while descending a ramp. Without this, each downhill frame starts
  // a little free fall, retaining airborne momentum past narrow landings and corners.
  const followRamp=s.onGround&&s.vy<=0&&oldY-floor<=MOVE.stepHeight
  if ((y <= floor || followRamp) && s.vy <= 0) { y = floor; s.vy = 0; s.onGround = true } else { s.onGround = false }
  s.x = x; s.y = y; s.z = z
  if (y < LOCKOUT_DEATH_Y * lockoutScale()) s.fallDamage = 1000
  return s
}
