import {isArena,arenaSpawnYaw,arenaMeta,arenaFloor,arenaBlocked} from './arena.ts'
import {MOVE} from './constants.ts'
import type {MapId} from './maps.ts'
import type {Team} from './map.ts'
import {groundHeight,rimFraction} from './field.ts'
import {baseBlocksPlayer} from './base-collision.ts'
import {coverBlocksPlayer} from './cover.ts'
import {solidBetween} from './solid.ts'
import {GUARDIAN_SPAWNS,guardianSpawnClear} from './guardian-spawns.ts'
import {LOCKOUT_RESPAWNS} from './lockout-spawn-data.ts'
import {lockoutBlocked,lockoutSpawnYaw} from './lockout.ts'
import {lockoutCollision} from './lockout-collision.ts'
import {lockoutScale} from './lockout-transform.ts'
import {evaluateSpawns,selectSpawn,type SpawnPoint,type SpawnActor,type SpawnEvent,type SpawnChoice} from './spawn-selection.ts'
export type {SpawnPoint,SpawnActor,SpawnChoice} from './spawn-selection.ts'

function spawnSightBlocked(map:MapId,a:SpawnPoint,b:SpawnPoint):boolean {
  return solidBetween(a.x,a.y,a.z,b.x,b.y,b.z,map)
}

export function spawnClear(map:MapId,p:SpawnPoint):boolean {
  if(isArena(map)){
    if(arenaBlocked(map,p.x,p.z,p.y,MOVE.playerHeight))return false
    for(let a=0;a<8;a++){const x=p.x+.6*Math.cos(a*Math.PI/4),z=p.z+.6*Math.sin(a*Math.PI/4);if(Math.abs(arenaFloor(map,x,z,p.y,.1)-p.y)>.2||arenaBlocked(map,x,z,p.y,MOVE.playerHeight))return false}
    return true
  }
  if(map==='guardian')return guardianSpawnClear(p)
  if(map==='lockout'){
    if(lockoutBlocked(p.x,p.z,p.y,MOVE.playerHeight))return false
    for(let a=0;a<8;a++){
      const x=p.x+.6*Math.cos(a*Math.PI/4),z=p.z+.6*Math.sin(a*Math.PI/4)
      if(Math.abs(lockoutCollision().floor(x,z,p.y,.1)-p.y)>.2||lockoutBlocked(x,z,p.y,MOVE.playerHeight))return false
    }
    return true
  }
  if(rimFraction(p.x,p.z)>.8||baseBlocksPlayer(p.x,p.z,p.y,MOVE.playerHeight)||
    coverBlocksPlayer(p.x,p.z,p.y,MOVE.stepHeight,10000,10000))return false
  for(let a=0;a<8;a++)if(Math.abs(groundHeight(p.x+Math.cos(a*Math.PI/4),p.z+Math.sin(a*Math.PI/4))-p.y)>.3)return false
  return true
}

const candidateCache=new Map<string,readonly SpawnPoint[]>()
/** Small prevalidated set, shared by the browser and Worker; never scan the nav grid per respawn. */
export function spawnCandidates(map:MapId):readonly SpawnPoint[] {
  const key=map==='lockout'?`${map}:${lockoutScale()}`:map,old=candidateCache.get(key)
  if(old)return old
  let points:SpawnPoint[]
  if(isArena(map))points=arenaMeta(map).spawns.map(([x,y,z])=>({x,y,z}))
  else if(map==='guardian')points=[...GUARDIAN_SPAWNS]
  else if(map==='lockout')points=LOCKOUT_RESPAWNS.map(p=>({x:p.x*lockoutScale(),y:p.y*lockoutScale(),z:p.z*lockoutScale()}))
  else {
    points=[]
    // Flanks, midfield and both base approaches. Neither team owns respawn territory.
    for(const z of [-120,-90,-60,-30,0,30,60,90,120])for(const x of [-48,-24,0,24,48])
      points.push({x,y:groundHeight(x,z),z})
  }
  const valid=points.filter(p=>spawnClear(map,p))
  if(!valid.length)throw new Error(`${map} has no valid respawn anchors`)
  candidateCache.set(key,valid)
  return valid
}

/** Match-local transient state. Online, only the Room owns this director. All times are seconds. */
export class SpawnDirector {
  private recent:SpawnEvent[]=[]
  private deaths:SpawnEvent[]=[]
  recordDeath(point:SpawnPoint,now:number):void {
    this.deaths.push({x:point.x,y:point.y,z:point.z,at:now})
    this.deaths=this.deaths.filter(e=>now-e.at<20).slice(-64)
  }
  choose(map:MapId,team:Team,actors:readonly SpawnActor[],now:number,
    unavailable:(p:SpawnPoint)=>boolean=()=>false,random:()=>number=Math.random,
    /** Extra score per anchor: objective modes pull a team toward its own base. Never beats safety. */
    bias:(p:SpawnPoint)=>number=()=>0):SpawnChoice|null {
    this.recent=this.recent.filter(e=>now-e.at<12)
    this.deaths=this.deaths.filter(e=>now-e.at<20)
    const evaluations=evaluateSpawns(spawnCandidates(map),team,actors,this.recent,this.deaths,now,
      (a,b)=>spawnSightBlocked(map,a,b),map==='blood-gulch'?22:9,unavailable,bias)
    const p=selectSpawn(evaluations,random)
    if(!p)return null
    this.recent.push({...p,at:now})
    this.recent=this.recent.slice(-64)
    return {...p,yaw:isArena(map)?arenaSpawnYaw(map,p):map==='lockout'?lockoutSpawnYaw(p):Math.atan2(p.x,p.z)}
  }
}
