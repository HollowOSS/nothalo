import {GRAVITY} from './constants.ts'
import type {PlayerState} from './movement.ts'

// Pad positions come from the four forerunner_grill groups in the imported map.
// Targets are clear terrain, with each arc resolved by the normal player controller.
const arc=(x:number,y:number,z:number,tx:number,ty:number,tz:number,seconds:number)=>({
  x,y,z,vx:(tx-x)/seconds,vy:(ty-y)/seconds+GRAVITY*seconds/2,vz:(tz-z)/seconds,
  target:{x:tx,y:ty,z:tz},
})
export const VALHALLA_CANNONS=[
  arc(3.16,10.024,-109.22,3.16,8.534,-45,3.2),
  arc(3.16,12.534,114.49,3.16,12.193,50,3.2),
  arc(-6.74,9.845,-114.01,-36,13.468,-85,2.8),
  arc(-6.74,12.355,119.28,-40,6.261,85,2.8),
] as const

export function applyValhallaLift(s:PlayerState):void {
  if(s.map!=='valhalla'||(s.liftCooldown??0)>0)return
  const pad=VALHALLA_CANNONS.find(c=>Math.hypot(s.x-c.x,s.z-c.z)<1.25&&s.y>=c.y-.25&&s.y<=c.y+.6)
  if(!pad)return
  s.vx=pad.vx;s.vy=pad.vy;s.vz=pad.vz;s.onGround=false;s.liftCooldown=4
}
