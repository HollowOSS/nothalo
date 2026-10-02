import type {MapId} from './maps.ts'
import type {MeshCollision} from './guardian-collision.ts'
import type {PlayerState} from './movement.ts'
import {MOVE,GRAVITY} from './constants.ts'
import {moveArenaPlayer} from './arena-controller.ts'

type Point={x:number;y:number;z:number}
export function arenaWalkingState(map:MapId,p:Point):PlayerState {
  return {map,x:p.x,y:p.y,z:p.z,vx:0,vy:0,vz:0,onGround:true,crouched:false,fallFrom:p.y,fallDamage:0,teleportYaw:null,liftCooldown:0}
}

/** Execute a bounded straight walk using the same capsule and triggers as players.
 * Callers supply explicit collision so the baker can validate freshly cooked data. */
export function traceArenaWalk(map:MapId,from:Point,to:Point,collision:MeshCollision,bounds:readonly number[],hz=60){
  const state=arenaWalkingState(map,from),dt=1/hz,length=Math.hypot(to.x-from.x,to.z-from.z)
  const ticks=Math.max(Math.ceil(hz*8/60),Math.ceil(length/(MOVE.forwardSpeed*dt)))
  for(let tick=0;tick<ticks;tick++){
    state.vx=(to.x-from.x)/(ticks*dt);state.vz=(to.z-from.z)/(ticks*dt);state.vy-=GRAVITY*dt
    moveArenaPlayer(state,dt,collision,bounds)
    if((state.liftCooldown??0)>0)return {ok:false,reason:'automatic lift',state}
  }
  state.vx=state.vz=0
  for(let tick=0;tick<Math.ceil(hz*.5)&&!state.onGround;tick++){
    state.vy-=GRAVITY*dt;moveArenaPlayer(state,dt,collision,bounds)
    if((state.liftCooldown??0)>0)return {ok:false,reason:'automatic lift',state}
  }
  if(state.fallDamage>0)return {ok:false,reason:'fall',state}
  if(Math.hypot(state.x-to.x,state.z-to.z)>.025||Math.abs(state.y-to.y)>.06||!state.onGround)return {ok:false,reason:'blocked walking edge',state}
  return {ok:true,state}
}
