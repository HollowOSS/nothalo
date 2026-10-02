import type {Team} from './map.ts'
import {MOVE} from './constants.ts'

export interface SpawnPoint {x:number;y:number;z:number}
export interface SpawnActor extends SpawnPoint {team:Team;alive:boolean;crouched?:boolean}
export interface SpawnEvent extends SpawnPoint {at:number}
export interface SpawnChoice extends SpawnPoint {yaw:number}
export interface SpawnEvaluation {
  point:SpawnPoint
  occupied:boolean
  danger:number
  score:number
}

const distance=(a:SpawnPoint,b:SpawnPoint)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
const heat=(p:SpawnPoint,events:readonly SpawnEvent[],now:number,radius:number,lifetime:number)=>
  events.reduce((sum,e)=>sum+Math.max(0,1-(now-e.at)/lifetime)*Math.max(0,1-distance(p,e)/radius),0)

/** Rank geometry-vetted anchors. Safety tiers cannot be outweighed by team preference or luck. */
export function evaluateSpawns(points:readonly SpawnPoint[],team:Team,actors:readonly SpawnActor[],
  recent:readonly SpawnEvent[],deaths:readonly SpawnEvent[],now:number,
  blocked:(a:SpawnPoint,b:SpawnPoint)=>boolean,nearEnemy:number,
  unavailable:(p:SpawnPoint)=>boolean=()=>false,bias:(p:SpawnPoint)=>number=()=>0):SpawnEvaluation[] {
  return points.map(point=>{
    let occupied=unavailable(point),nearest=60,enemy=80,exposed=0,ally=Infinity
    const enemies:SpawnActor[]=[]
    for(const other of actors){
      if(!other.alive)continue
      const d=distance(point,other),horizontal=Math.hypot(point.x-other.x,point.z-other.z)
      nearest=Math.min(nearest,d)
      if(Math.abs(point.y-other.y)<2.2&&horizontal<1.2)occupied=true
      if(other.team===team){ally=Math.min(ally,d);continue}
      enemy=Math.min(enemy,d)
      enemies.push(other)
    }
    // Reserve a freshly selected anchor even before its new occupant enters the player list.
    if(recent.some(e=>now-e.at<.75&&Math.abs(e.y-point.y)<2.2&&Math.hypot(e.x-point.x,e.z-point.z)<1.2))occupied=true
    // Occupancy and close-range danger already determine their tiers. For other anchors,
    // one visible enemy is enough to reject cover; do not cast rays to the whole team.
    if(!occupied&&enemy>=nearEnemy){
      enemies.sort((a,b)=>distance(point,a)-distance(point,b))
      for(const other of enemies){
        const eye={x:other.x,y:other.y+MOVE.eyeHeight*(other.crouched?.62:1),z:other.z}
        if(!blocked(eye,{x:point.x,y:point.y+MOVE.eyeHeight,z:point.z})||
           !blocked(eye,{x:point.x,y:point.y+MOVE.playerHeight*.5,z:point.z})){exposed=1;break}
      }
    }
    const deathHeat=heat(point,deaths,now,14,20)
    // Repeated deaths invalidate an otherwise hidden pocket; do not ping-pong between
    // two covered anchors while ignoring evidence that the area is being farmed.
    const danger=enemy<nearEnemy?2:exposed||deathHeat>.35?1:0
    const support=Number.isFinite(ally)?Math.max(0,1-Math.abs(ally-12)/12)*6:0
    const score=Math.min(nearest,14)*1.2+Math.min(enemy,60)*.55-exposed*18+support
      -heat(point,recent,now,10,12)*32-deathHeat*65+bias(point)
    return {point,occupied,danger,score}
  })
}

/** Randomize only among similarly safe choices; if every anchor is occupied, retry later. */
export function selectSpawn(evaluations:readonly SpawnEvaluation[],random:()=>number=Math.random):SpawnPoint|null {
  const free=evaluations.filter(e=>!e.occupied)
  if(!free.length)return null
  const tier=Math.min(...free.map(e=>e.danger)),safe=free.filter(e=>e.danger===tier)
  const best=Math.max(...safe.map(e=>e.score)),shortlist=safe.filter(e=>e.score>=best-6)
  const selected=shortlist[Math.min(shortlist.length-1,Math.max(0,Math.floor(random()*shortlist.length)))]
  return {...selected.point}
}
