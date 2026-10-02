import type {PlayerState} from './movement.ts'
import {GRAVITY} from './constants.ts'

/** Source light-circle centres in the imported Epitaph coordinate system. */
export const EPITAPH_LIFTS = [
  {name:'South lift',x:0,z:40.956,padY:-2.239,radius:1.1,peakY:13.7,vx:0,vz:-2,exitY:7.8,shaftExitY:null},
  {name:'Middle lift',x:0,z:-31.069,padY:2.305,radius:1.4,peakY:13.4,vx:0,vz:-4,exitY:9.6,shaftExitY:null},
  {name:'North left lift',x:-5.544,z:-43.612,padY:2.533,radius:1,peakY:31.2,vx:0,vz:3,exitY:14,shaftExitY:9.8},
  {name:'North right lift',x:5.544,z:-43.612,padY:2.533,radius:1,peakY:31.2,vx:0,vz:3,exitY:14,shaftExitY:9.8},
] as const

/** Narrow source shafts accelerate riders upward and toward their adjacent walkways. */
export function applyArenaLift(s:PlayerState):void {
  if(s.map!=='epitaph')return
  for(const lift of EPITAPH_LIFTS){
    const distance=Math.hypot(s.x-lift.x,s.z-lift.z)
    if(distance>lift.radius)continue
    if(!s.liftCooldown&&s.vy<=0&&s.y>=-4.5&&s.y<=lift.padY+.25){
      s.vx=lift.shaftExitY!==null?0:lift.vx;s.vz=lift.shaftExitY!==null?0:lift.vz
      s.vy=Math.sqrt(2*GRAVITY*(lift.peakY-s.y))
      s.onGround=false;s.fallFrom=s.y;s.liftCooldown=4
    }else if((s.liftCooldown??0)>0&&s.y>lift.padY+.25&&s.y<lift.exitY){
      // A shaft wall can stop lateral movement before the opening is reached.
      // Keep riders centred in the narrow north shafts until above the balcony,
      // then retain outward airflow until they clear the opening.
      if(lift.shaftExitY!==null&&s.y<lift.shaftExitY){s.vx=(lift.x-s.x)*4;s.vz=(lift.z-s.z)*4}
      else {s.vx=lift.vx;s.vz=lift.vz}
    }
    return
  }
}
