import {LOADOUT} from './loadout.ts'
import {spawnCandidates} from './spawns.ts'
import type {MapId} from './maps.ts'
export const DUAL_MODELS = ['magnum','smg','plasma-pistol','plasma-rifle','needler'] as const
export const dualSlot = (slot:number):boolean => DUAL_MODELS.some(id=>LOADOUT[slot]?.model===id)
export interface WeaponPickup {id:number;slot:number;x:number;y:number;z:number;availableAt:number}
/** Two of each weapon on geometry-vetted spawn floors, distributed through every map. */
export function createWeaponPickups(map:MapId,allowed:readonly number[]):WeaponPickup[] {
 const points=spawnCandidates(map),slots=DUAL_MODELS.map(id=>LOADOUT.findIndex(s=>s.model===id)).filter(i=>allowed.includes(i))
 return Array.from({length:slots.length*2},(_,i)=>{
  const p=points[Math.floor(i*points.length/(slots.length*2))%points.length]
  return {id:i,slot:slots[i%slots.length],x:p.x,y:p.y,z:p.z,availableAt:0}
 })
}
export function nearestWeaponPickup(pickups:readonly WeaponPickup[],position:{x:number;y:number;z:number},now:number,clear:(p:WeaponPickup)=>boolean=()=>true):WeaponPickup|undefined {
 return pickups.filter(p=>p.availableAt<=now&&Math.abs(p.y-position.y)<1.8&&Math.hypot(p.x-position.x,p.z-position.z)<2.3&&clear(p)).sort((a,b)=>Math.hypot(a.x-position.x,a.z-position.z)-Math.hypot(b.x-position.x,b.z-position.z))[0]
}
/** Explicit hand selection, falling back to the right when the primary cannot dual wield. */
export function pickupHands(primary:number,picked:number,hand:'left'|'right'='left',offhand=-1):{primary:number;offhand:number} {
 if(!dualSlot(picked))throw Error('Not a dual-wield pickup')
 if(hand==='right')return {primary:picked,offhand:dualSlot(offhand)?offhand:dualSlot(primary)?primary:-1}
 return dualSlot(primary)?{primary,offhand:picked}:{primary:picked,offhand:-1}
}
export interface ArsenalMessage {leftAmmo?:number;pickedHand?:'left'|'right';player:number;primary:number;offhand:number;pickups:WeaponPickup[]}
export function packArsenal(state:ArsenalMessage):ArrayBuffer {
 const bytes=new TextEncoder().encode(JSON.stringify(state)),out=new Uint8Array(bytes.length+1);out[0]=17;out.set(bytes,1);return out.buffer
}
export function unpackArsenal(data:ArrayBuffer):ArsenalMessage {return JSON.parse(new TextDecoder().decode(new Uint8Array(data,1)))}
