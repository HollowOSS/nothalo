/** Pure radial impulse shared by authoritative and offline explosions. Call after line-of-sight validation. */
export interface BlastPoint { x: number; y: number; z: number }
export function blastImpulse(center: BlastPoint, blast: BlastPoint, radius: number, strength: number): BlastPoint {
  const dx=center.x-blast.x, dy=center.y-blast.y, dz=center.z-blast.z
  const distance=Math.hypot(dx,dy,dz)
  if (!Number.isFinite(distance+radius+strength) || radius<=0 || strength<=0 || distance>=radius) return {x:0,y:0,z:0}
  const falloff=1-distance/radius, force=Math.min(35,strength)*falloff*falloff
  // A blast pushes away from its center. Above-body explosions push down, not up.
  if(distance<1e-6)return {x:0,y:force,z:0}
  return {x:dx/distance*force,y:dy/distance*force,z:dz/distance*force}
}
export function applyPlayerBlast(state: BlastPoint & {vx:number;vy:number;vz:number;onGround:boolean;fallFrom?:number}, blast:BlastPoint, radius:number, strength:number): boolean {
  const impulse=blastImpulse({x:state.x,y:state.y+.9,z:state.z},blast,radius,strength)
  if (!impulse.x&&!impulse.y&&!impulse.z)return false
  state.vx=Math.max(-35,Math.min(35,state.vx+impulse.x));state.vz=Math.max(-35,Math.min(35,state.vz+impulse.z));state.vy=Math.max(-25,Math.min(30,state.vy+impulse.y));state.onGround=state.onGround&&state.vy<=.1
  if (state.fallFrom !== undefined) state.fallFrom=Math.max(state.fallFrom,state.y)
  return true
}

export function blastStrength(kind:string):number {
  return ({chopper:4,rocket:18,frag:12,plasma:15,fuelrod:20} as Record<string,number>)[kind] ?? 0
}
