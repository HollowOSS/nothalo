import {decodeDelta} from './packed-integers.ts'
import type {MapId} from './maps.ts'
import type {PlayerState} from './movement.ts'
import {TriangleMesh,MeshCollision} from './guardian-collision.ts'
import {arenaData} from './level-data.ts'
import bloodGulch from './blood-gulch-meta.ts'
import pit from './the-pit-meta.ts'
import narrows from './narrows-meta.ts'
import sandtrap from './sandtrap-meta.ts'
import valhalla from './valhalla-meta.ts'
import epitaph from './epitaph-meta.ts'
import ratsNest from './rats-nest-meta.ts'
import {ARENA_STEP,moveArenaPlayer} from './arena-controller.ts'
export {ARENA_STEP,NARROWS_CANNONS} from './arena-controller.ts'
const META={'blood-gulch':bloodGulch,'the-pit':{scale:1,...pit},narrows:{scale:1,...narrows},sandtrap,valhalla,epitaph,'rats-nest':ratsNest}
export type ArenaId=keyof typeof META
export const ARENA_IDS=Object.keys(META) as ArenaId[]
export function isArena(map:MapId|undefined):map is ArenaId {return !!map&&Object.hasOwn(META,map)}
export function arenaMeta(map:ArenaId){return META[map]}
const collisions=new Map<ArenaId,MeshCollision>()
function bytes(base64:string):Uint8Array {const raw=atob(base64),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out}
/** One transform and one architectural BVH for movement, shots, splash, bots and server authority. */
export function arenaCollision(map:ArenaId):MeshCollision {
  const cached=collisions.get(map);if(cached)return cached
  const data=arenaData(map).collision,packed=data.encoding==='delta-varint'?decodeDelta(bytes(data.positions),data.positionCount!,3):new Uint16Array(bytes(data.positions).buffer)
  const positions=new Float32Array(packed.length)
  for(let i=0;i<packed.length;i++)positions[i]=data.bounds.min[i%3]+packed[i]*data.quantum
  const buffer=bytes(data.indices).buffer,indices=data.encoding==='delta-varint'?new Uint32Array(decodeDelta(new Uint8Array(buffer),data.indexCount!,1)):data.indexBytes===4?new Uint32Array(buffer):new Uint32Array(new Uint16Array(buffer))
  const collision=new MeshCollision(new TriangleMesh(positions,indices),-500,true)
  collisions.set(map,collision);return collision
}
export function arenaFloor(map:ArenaId,x:number,z:number,y:number=arenaMeta(map).top,step:number=ARENA_STEP):number {
  return arenaCollision(map).supportedFloor(x,z,y,step,.2)
}
export function arenaBlocked(map:ArenaId,x:number,z:number,y:number,height:number):boolean {
  const [x0,x1,z0,z1]=arenaMeta(map).bounds
  return x<x0||x>x1||z<z0||z>z1||arenaCollision(map).blocked(x,z,y,height,.25,ARENA_STEP)
}
export function arenaRayDistance(map:ArenaId,ox:number,oy:number,oz:number,dx:number,dy:number,dz:number,max:number):number {
  return arenaCollision(map).mesh.raycast(ox,oy,oz,dx,dy,dz,max)?.t??max
}
/** Face a clear lane on respawn, including rooms whose centre is behind a wall. */
export function arenaSpawnYaw(map:ArenaId,p:{x:number;y:number;z:number}):number {
  const centre=Math.atan2(p.x,p.z);let best=centre,score=-Infinity
  for(let i=0;i<24;i++){
    const yaw=i*Math.PI/12,dx=-Math.sin(yaw),dz=-Math.cos(yaw)
    const distance=arenaRayDistance(map,p.x,p.y+1.5,p.z,dx,0,dz,40)
    const floor=arenaFloor(map,p.x+dx*3,p.z+dz*3,p.y)
    const value=distance+Math.cos(yaw-centre)*5-(Math.abs(floor-p.y)>1?20:0)
    if(value>score){score=value;best=yaw}
  }
  return best
}
export function arenaMove(s:PlayerState,dt:number):PlayerState {
  if(!isArena(s.map))throw new Error('Expected an arena player')
  return moveArenaPlayer(s,dt,arenaCollision(s.map),arenaMeta(s.map).bounds)
}
