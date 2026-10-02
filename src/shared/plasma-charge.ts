/** Halo 2-style manual-release charge. Values use metres and seconds. */
export const PLASMA_CHARGE={seconds:.6,cost:75,recovery:2.2,speed:22.86,range:122,turn:80*Math.PI/180,cone:Math.cos(6*Math.PI/180)} as const
export interface ChargeState {held:boolean;time:number}
export const newCharge=():ChargeState=>({held:false,time:0})
export function cancelCharge(c:ChargeState):void {c.held=false;c.time=0}
/** 1 = tap shot, 2 = fully charged release. Holding never emits a shot. */
export function stepCharge(c:ChargeState,held:boolean,pressed:boolean,dt:number,enabled:boolean,ammo:number):0|1|2 {
 if(!enabled){cancelCharge(c);return 0}
 if(held){c.held=true;c.time=Math.min(PLASMA_CHARGE.seconds,c.time+dt);return 0}
 const shot=c.held?(c.time+1e-6>=PLASMA_CHARGE.seconds&&ammo>=PLASMA_CHARGE.cost?2:1):pressed?1:0
 cancelCharge(c);return shot
}
export interface PlasmaTarget {id:string;x:number;y:number;z:number}
export interface ChargedBolt {x:number;y:number;z:number;dx:number;dy:number;dz:number;life:number;target:string|null}
type Point={x:number;y:number;z:number}
export function launchChargedBolt(origin:Point,dir:Point,targets:readonly PlasmaTarget[],blocked:(a:Point,b:Point)=>boolean):ChargedBolt {
 let target:string|null=null,best=PLASMA_CHARGE.range as number
 for(const t of targets){const x=t.x-origin.x,y=t.y-origin.y,z=t.z-origin.z,d=Math.hypot(x,y,z)
  if(d>0&&d<best&&(x*dir.x+y*dir.y+z*dir.z)/d>=PLASMA_CHARGE.cone&&!blocked(origin,t)){target=t.id;best=d}}
 return {...origin,dx:dir.x,dy:dir.y,dz:dir.z,life:PLASMA_CHARGE.range/PLASMA_CHARGE.speed,target}
}
export function stepChargedBolt(b:ChargedBolt,dt:number,targets:readonly PlasmaTarget[],blocked:(a:Point,b:Point)=>boolean):{done:boolean;hit:string|null} {
 const count=Math.max(1,Math.ceil(dt*120)),slice=dt/count
 for(let i=0;i<count;i++){
  b.life-=slice;if(b.life<=0)return{done:true,hit:null}
  const t=targets.find(t=>t.id===b.target)
  if(t){const x=t.x-b.x,y=t.y-b.y,z=t.z-b.z,d=Math.hypot(x,y,z)||1,dot=Math.max(-1,Math.min(1,(x*b.dx+y*b.dy+z*b.dz)/d)),angle=Math.acos(dot),k=angle>1e-6?Math.min(1,PLASMA_CHARGE.turn*slice/angle):1
   b.dx+=(x/d-b.dx)*k;b.dy+=(y/d-b.dy)*k;b.dz+=(z/d-b.dz)*k;const len=Math.hypot(b.dx,b.dy,b.dz)||1;b.dx/=len;b.dy/=len;b.dz/=len}
  const old={x:b.x,y:b.y,z:b.z};b.x+=b.dx*PLASMA_CHARGE.speed*slice;b.y+=b.dy*PLASMA_CHARGE.speed*slice;b.z+=b.dz*PLASMA_CHARGE.speed*slice
  if(blocked(old,b))return{done:true,hit:null}
  for(const t of targets)if(Math.hypot(t.x-b.x,t.z-b.z)<.45&&Math.abs(t.y-b.y)<.9)return{done:true,hit:t.id}
 }
 return{done:false,hit:null}
}
/** The charged bolt removes a shield; it does only one point to bare health. */
export const chargedDamage=(shield:number):number=>shield>0?shield:1
