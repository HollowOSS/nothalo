/** A bounded homing projectile simulation used by the authority and the visual predictor. */
export interface NeedleTarget {id:string;x:number;y:number;z:number}
export interface Needle {x:number;y:number;z:number;dx:number;dy:number;dz:number;life:number;target:string|null}
export const NEEDLE = {speed:38,range:48,cone:.94,turn:5,life:1.8,damage:7,combine:7,combineDamage:115,attachLife:1.6} as const
export function launchNeedle(origin:{x:number;y:number;z:number},dir:{x:number;y:number;z:number},targets:NeedleTarget[],blocked:(a:NeedleTarget,b:NeedleTarget)=>boolean):Needle {
  let target:string|null=null,best=NEEDLE.range as number
  for(const t of targets){const x=t.x-origin.x,y=t.y-origin.y,z=t.z-origin.z,d=Math.hypot(x,y,z)
    if(d>0&&d<best&&(x*dir.x+y*dir.y+z*dir.z)/d>NEEDLE.cone&&!blocked({...origin,id:''},t)){target=t.id;best=d}}
  return {...origin,dx:dir.x,dy:dir.y,dz:dir.z,life:NEEDLE.life,target}
}
export function stepNeedle(n:Needle,dt:number,targets:NeedleTarget[],blocked:(a:NeedleTarget,b:NeedleTarget)=>boolean):{done:boolean;hit:string|null}{
  const count=Math.max(1,Math.ceil(dt/(1/120))),slice=dt/count
  for(let i=0;i<count;i++){
    n.life-=slice;if(n.life<=0)return{done:true,hit:null}
    const target=targets.find(t=>t.id===n.target)
    if(target){const x=target.x-n.x,y=target.y-n.y,z=target.z-n.z,d=Math.hypot(x,y,z)||1,k=1-Math.exp(-NEEDLE.turn*slice)
      n.dx+=(x/d-n.dx)*k;n.dy+=(y/d-n.dy)*k;n.dz+=(z/d-n.dz)*k;const len=Math.hypot(n.dx,n.dy,n.dz);n.dx/=len;n.dy/=len;n.dz/=len}
    const old={id:'',x:n.x,y:n.y,z:n.z}
    n.x+=n.dx*NEEDLE.speed*slice;n.y+=n.dy*NEEDLE.speed*slice;n.z+=n.dz*NEEDLE.speed*slice
    if(blocked(old,{id:'',x:n.x,y:n.y,z:n.z}))return{done:true,hit:null}
    for(const t of targets)if(Math.hypot(t.x-n.x,t.y-n.y,t.z-n.z)<.6)return{done:true,hit:t.id}
  }
  return{done:false,hit:null}
}
/** Needle stacks expire per shooter/target; a supercombine consumes the whole stack. */
export class NeedleStacks {
  private readonly stacks=new Map<string,{count:number;until:number}>()
  hit(key:string,now:number):{damage:number;combined:boolean}{
    for(const [k,v] of this.stacks)if(v.until<now)this.stacks.delete(k)
    const old=this.stacks.get(key),count=(old?.count??0)+1,combined=count>=NEEDLE.combine
    if(combined)this.stacks.delete(key);else this.stacks.set(key,{count,until:now+NEEDLE.attachLife})
    return{damage:NEEDLE.damage+(combined?NEEDLE.combineDamage:0),combined}
  }
  clearFor(id:string):void {for(const key of this.stacks.keys())if(key.startsWith(id+':')||key.endsWith(':'+id))this.stacks.delete(key)}
  clear():void{this.stacks.clear()}
}
