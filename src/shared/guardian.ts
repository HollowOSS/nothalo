import { MOVE } from './constants.ts'
import type { PlayerState } from './movement.ts'
import type { Team } from './map.ts'
import { guardianCollision, GUARDIAN_VOID_FLOOR, GUARDIAN_PLAYER_RADIUS } from './guardian-collision.ts'
import { GUARDIAN_NAV_META as GUARDIAN_NAV_DATA } from './guardian-nav-meta.ts'

export { mapId, MAP_NAMES, type MapId } from './maps.ts'

/**
 * Guardian gameplay collision is the simplified triangle mesh generated from the downloaded
 * Halo Online model (see docs/guardian-collision-pipeline.md). Movement, shots, splash
 * checks, spawning and bot navigation all query that one mesh, and the renderer places the
 * visible model with the same transform, so what you see is what stops you.
 */
const PLAYER_RADIUS = GUARDIAN_PLAYER_RADIUS
/** Falling below this is death; the lowest deck sits well above it. */
export const GUARDIAN_DEATH_Y = GUARDIAN_NAV_DATA.lowestFloor - 6

/** Standable surface at or below `step` above `y`, or the void floor. */
export function guardianFloor(x:number,z:number,y=100,step:number=MOVE.stepHeight):number {
  return guardianCollision().floor(x,z,y,step)
}
/** Is the point on (within a few centimetres of) a surface, or below the void? */
export function guardianSolidAt(x:number,y:number,z:number):boolean {
  return y < GUARDIAN_VOID_FLOOR || guardianCollision().solidAt(x,y,z)
}
/** Does a standing player of `height` at feet (x,y,z) intersect the map? */
export function guardianBlocked(x:number,z:number,y:number,height:number):boolean {
  return guardianCollision().blocked(x,z,y,height,PLAYER_RADIUS,MOVE.stepHeight)
}
/** Does anything solid lie on the segment? */
export function guardianRay(ax:number,ay:number,az:number,bx:number,by:number,bz:number):boolean {
  if(ay < GUARDIAN_VOID_FLOOR || by < GUARDIAN_VOID_FLOOR)return true
  return guardianCollision().ray(ax,ay,az,bx,by,bz)
}
/** Distance to the first surface along a unit direction, or `max` when nothing is hit. */
export function guardianRayDistance(ox:number,oy:number,oz:number,dx:number,dy:number,dz:number,max:number):number {
  const hit=guardianCollision().mesh.raycast(ox,oy,oz,dx,dy,dz,max)
  return hit?hit.t:max
}

/** Halo 3's three launcher kinds: a vertical gravity lift, a man cannon pedestal, a three-disc booster. */
export type GuardianLiftKind = 'lift'|'cannon'|'booster'
/** Lift, man cannon and booster pads at the model's own pad geometry; velocities land on validated decks. */
export const GUARDIAN_LIFTS = GUARDIAN_NAV_DATA.lifts as readonly {x:number;y:number;z:number;vx:number;vy:number;vz:number;name:string;kind:GuardianLiftKind}[]

/** Server-side spawn: teams start on opposite halves of the arena. */
export function guardianSpawn(team:Team,index=0):{x:number;y:number;z:number} {
  const side=GUARDIAN_NAV_DATA.spawns.filter(p=>team==='red'?p[0]<0:p[0]>=0)
  const [x,y,z]=side[((index%side.length)+side.length)%side.length]
  return {x,y,z}
}

/** Shared collision integration after the common acceleration and gravity code. */
export function guardianMove(s:PlayerState,dt:number):PlayerState {
  const collision=guardianCollision()
  const height=MOVE.playerHeight*(s.crouched?.62:1),oldY=s.y
  let x=s.x,z=s.z,y=s.y+s.vy*dt
  // Swept horizontal steps also cover man-cannon speeds and server catch-up frames.
  const steps=Math.max(1,Math.ceil(Math.max(Math.abs(s.vx*dt),Math.abs(s.vz*dt))/.18))
  for(let i=0;i<steps;i++){
    const nx=x+s.vx*dt/steps,nz=z+s.vz*dt/steps
    if(collision.blocked(nx,z,s.y,height,PLAYER_RADIUS,MOVE.stepHeight))s.vx=0;else x=nx
    if(collision.blocked(x,nz,s.y,height,PLAYER_RADIUS,MOVE.stepHeight))s.vz=0;else z=nz
  }
  const floor=collision.floor(x,z,oldY,MOVE.stepHeight)
  if(s.vy>0){
    const ceiling=collision.ceiling(x,z,oldY+height-.01,y+height)
    if(ceiling!==null){y=Math.min(y,ceiling-height-.01);s.vy=0}
  }
  if(y<=floor&&s.vy<=0){y=floor;s.vy=0;s.onGround=true}else{s.onGround=false}
  s.x=x;s.y=y;s.z=z
  if(y < GUARDIAN_DEATH_Y)s.fallDamage=1000
  s.liftCooldown=Math.max(0,(s.liftCooldown??0)-dt)
  if(!s.liftCooldown){
    // The nav builder refuses overlapping triggers, so at most one pad can match. Should two
    // ever overlap, prefer a launcher (man cannon or booster) over a lift, then the closest pad,
    // so a player cannot be launched by a neighbouring pad while merely crossing a doorway.
    const candidates=GUARDIAN_LIFTS.filter(lift=>Math.hypot(x-lift.x,z-lift.z)<1.55&&Math.abs(y-lift.y)<1.05)
    candidates.sort((a,b)=>Number(b.kind!=='lift')-Number(a.kind!=='lift')||Math.hypot(x-a.x,z-a.z)-Math.hypot(x-b.x,z-b.z))
    const lift=candidates[0]
    if(lift){
      // The launch velocity is tuned from the pad's centre, but the trigger is 1.55 m wide. Entered off-centre, the rider
      // starts beside the pedestal: the first swept step blocks the horizontal velocity and they go straight up and fall
      // back (the booster and man cannon by the trees "didn't launch far enough"). Like Halo's launchers pull you into the
      // stream, the rider leaves from the pad's own launch point, so every entry flies the validated trajectory.
      s.x=lift.x;s.z=lift.z;s.y=Math.max(s.y,lift.y)
      s.vx=lift.vx;s.vy=lift.vy;s.vz=lift.vz;s.onGround=false;s.liftCooldown=1.6
    }
  }
  return s
}
