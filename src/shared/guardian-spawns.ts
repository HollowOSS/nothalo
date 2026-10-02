import {guardianBlocked, guardianFloor, guardianRay, GUARDIAN_LIFTS} from './guardian.ts'
import {GUARDIAN_NAV_META as GUARDIAN_NAV_DATA} from './guardian-nav-meta.ts'
import {MOVE} from './constants.ts'
import type {Team} from './map.ts'

export interface ArenaPosition {x:number;y:number;z:number}
export interface SpawnOccupant extends ArenaPosition {team:Team;alive:boolean}
/** Standing points sampled by the nav build: roomy cells spread across rooms and floors. */
export const GUARDIAN_SPAWNS:readonly (ArenaPosition & {zone:string})[] = GUARDIAN_NAV_DATA.spawns.map(([x,y,z],i)=>({x,y,z,zone:GUARDIAN_NAV_DATA.spawnZones[i]}))

export function guardianSpawnClear(p:ArenaPosition):boolean {
  if(guardianBlocked(p.x,p.z,p.y,MOVE.playerHeight))return false
  for(const [dx,dz] of [[0,0],[.45,0],[-.45,0],[0,.45],[0,-.45]])
    if(Math.abs(guardianFloor(p.x+dx,p.z+dz,p.y+.05)-p.y)>.25)return false
  return !GUARDIAN_LIFTS.some(l=>Math.hypot(p.x-l.x,p.z-l.z)<2.6 && Math.abs(p.y-l.y)<2)
}

/** Maximize space and cover. Occupancy is floor-aware; a player above is not overlapping. */
export function chooseGuardianSpawn(team:Team,serial:number,occupants:readonly SpawnOccupant[],recent:readonly ArenaPosition[]=[]):ArenaPosition {
  const points=GUARDIAN_SPAWNS.filter(guardianSpawnClear)
  if(!points.length)throw new Error('Guardian has no valid spawn positions')
  let best=points[0],bestScore=-Infinity
  for(let i=0;i<points.length;i++){
    const p=points[i]
    let nearest=30,enemy=50,exposed=0,penalty=0
    for(const other of occupants){
      if(!other.alive)continue
      const horizontal=Math.hypot(p.x-other.x,p.z-other.z),dy=Math.abs(p.y-other.y)
      const distance=Math.hypot(horizontal,dy*2)
      nearest=Math.min(nearest,distance)
      if(dy<2 && horizontal<3)penalty+=1000+(3-horizontal)*100
      if(other.team!==team){
        enemy=Math.min(enemy,distance)
        if(distance<55&&!guardianRay(p.x,p.y+1.4,p.z,other.x,other.y+1.4,other.z))exposed++
      }
    }
    const reuse=recent.reduce((sum,r)=>sum+(Math.hypot(r.x-p.x,r.y-p.y,r.z-p.z)<5?1:0),0)
    // Rotated tie-breaking distributes empty-arena starts without random test instability.
    const rotation=((i-serial*7)%points.length+points.length)%points.length
    const score=nearest*2+enemy*.65-exposed*16-penalty-reuse*22-rotation*.03
    if(score>bestScore){best=p;bestScore=score}
  }
  return {x:best.x,y:best.y,z:best.z}
}
