import * as THREE from 'three'
import {groundHeight} from '../../shared/field.ts'
import type {Player} from './player.ts'
import { bounceGrenade, type GrenadeContact } from './grenade-world.ts'
import { loadFragGrenade } from '../render/models/frag-grenade.ts'
import { GrenadeTrail } from './grenade-trail.ts'
import { createPlasmaGrenade, type PlasmaGrenadeModel } from '../render/models/plasma-grenade.ts'
import type { ExplosionFx } from './explosion-fx.ts'
export type GrenadeKind = 'frag' | 'plasma'
export type GrenadeImpact = (point:THREE.Vector3,kind:GrenadeKind,speed:number,terrain:boolean)=>void
export interface GrenadeVehicleTarget { readonly kind:'warthog'|'ghost'|'banshee'|'mongoose'|'chopper'; readonly object:THREE.Object3D }
// Match the rigid chassis extents and centre offset, in the rendered hull's local axes.
const HULLS = {mongoose:{half:[.85,.35,1.6],center:.8},chopper:{half:[1.2,.8,3],center:1.25},warthog:{half:[1.15,.55,2.6],center:1.10},ghost:{half:[1.85,.35,2.30],center:.35},banshee:{half:[2.8,.4,1.8],center:.6}} as const

/** Swept sphere against the oriented hull, returning segment fraction rather than a ray distance. */
export function grenadeVehicleContact(start:THREE.Vector3,end:THREE.Vector3,target:GrenadeVehicleTarget):number|null {
 target.object.updateWorldMatrix(true,false)
 const inverse=new THREE.Matrix4().copy(target.object.matrixWorld).invert()
 const a=start.clone().applyMatrix4(inverse),b=end.clone().applyMatrix4(inverse),motion=b.sub(a)
 const spec=HULLS[target.kind],radius=.11
 const bounds=new THREE.Box3(new THREE.Vector3(-spec.half[0]-radius,spec.center-spec.half[1]-radius,-spec.half[2]-radius),new THREE.Vector3(spec.half[0]+radius,spec.center+spec.half[1]+radius,spec.half[2]+radius))
 if(bounds.containsPoint(a))return 0
 const length=motion.length();if(length<1e-9)return null
 const hit=new THREE.Ray(a,motion.divideScalar(length)).intersectBox(bounds,new THREE.Vector3())
 if(!hit)return null
 const t=a.distanceTo(hit)/length
 return t<=1?t:null
}
/** Fixed pool; plasma attaches in target-local coordinates, frag arms on first contact. */
export class Grenades {
 readonly inventory={frag:4,plasma:4}
 /** Back to the spawn pouch; called on respawn. */
 refill():void{this.inventory.frag=4;this.inventory.plasma=4}
 selected:GrenadeKind='frag'
 private cooldown=0
 private readonly pool:Array<{mesh:THREE.Mesh;frag:THREE.Object3D|null;plasma:PlasmaGrenadeModel;stuckQuat:THREE.Quaternion;crackle:number;exclude:Player|null;v:THREE.Vector3;life:number;fuse:number;kind:GrenadeKind;target:Player|null;vehicle:THREE.Object3D|null;worldStuck:boolean;offset:THREE.Vector3;impactIn:number;impactNormal:THREE.Vector3;trailDistance:number}>=[]
 private readonly trail: GrenadeTrail
 private readonly trailStart=new THREE.Vector3()
 private readonly trailPoint=new THREE.Vector3()
 private readonly players:()=>Player[]
 private readonly sweep:(a:THREE.Vector3,b:THREE.Vector3)=>THREE.Vector3|null
 /** `stuck`: the player a plasma grenade was stuck to when it went off. */
 private readonly blast:(p:THREE.Vector3,kind:GrenadeKind,stuck:Player|null)=>void
 private readonly vehicles:()=>readonly GrenadeVehicleTarget[]
 private readonly meshContact?: (a:THREE.Vector3,b:THREE.Vector3)=>GrenadeContact|null
 private readonly impact: GrenadeImpact
 /** Where plasma sparks, crackle and flight glow go; null in headless checks. */
 fx:ExplosionFx|null=null
 private clock=0
 private readonly up=new THREE.Vector3(0,1,0)
 private readonly spin=new THREE.Quaternion()
 private readonly parentQuat=new THREE.Quaternion()
 constructor(scene:THREE.Scene,players:()=>Player[],sweep:(a:THREE.Vector3,b:THREE.Vector3)=>THREE.Vector3|null,blast:(p:THREE.Vector3,kind:GrenadeKind,stuck:Player|null)=>void,vehicles:()=>readonly GrenadeVehicleTarget[]=()=>[],meshContact?: (a:THREE.Vector3,b:THREE.Vector3)=>GrenadeContact|null,impact: GrenadeImpact=()=>{}){
  this.players=players;this.sweep=sweep;this.blast=blast;this.vehicles=vehicles;this.meshContact=meshContact
  this.impact=impact
  const geo=new THREE.IcosahedronGeometry(.11,1)
  this.trail=new GrenadeTrail(scene)
  for(let i=0;i<16;i++){const mesh=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:0x68714a}));mesh.visible=false;scene.add(mesh)
   const plasma=createPlasmaGrenade();plasma.object.visible=false;mesh.add(plasma.object)
   this.pool.push({mesh,frag:null,plasma,stuckQuat:new THREE.Quaternion(),crackle:0,exclude:null,v:new THREE.Vector3(),life:0,fuse:-1,kind:'frag',target:null,vehicle:null,worldStuck:false,offset:new THREE.Vector3(),impactIn:0,impactNormal:new THREE.Vector3(),trailDistance:0})}
  if(typeof globalThis.document!=='undefined')void loadFragGrenade().then(source=>{
   for(const p of this.pool){
    p.frag=source.clone(true);p.frag.name='halo3-thrown-frag';p.mesh.add(p.frag)
    p.frag.visible=p.kind==='frag';(p.mesh.material as THREE.Material).visible=false
   }
  }).catch(error=>console.warn('Using the fallback frag grenade model',error))
 }
 get activeCount():number{return this.pool.filter(p=>p.life>0).length}
 get smokeCount():number{return this.trail.activeCount}
 get canThrow():boolean{return this.cooldown<=0&&this.inventory[this.selected]>0&&this.pool.some(p=>p.life<=0)}
 throw(origin:THREE.Vector3,direction:THREE.Vector3):boolean{
  if(!this.canThrow)return false
  this.inventory[this.selected]--;this.cooldown=.8
  return this.spawn(this.selected,origin,direction)
 }
 /** Someone else's grenade, seen over the network: flies and bounces here, costs nothing.
  * A plasma can stick to anyone except `thrower`, who it would otherwise catch leaving the hand. */
 throwVisual(kind:GrenadeKind,origin:THREE.Vector3,direction:THREE.Vector3,thrower:Player|null=null):boolean{
  return this.spawn(kind,origin,direction,thrower)
 }
 /** Put out the grenade nearest a point: the owner's report of where it went off wins. */
 extinguishNear(point:THREE.Vector3):void{
  let best:typeof this.pool[number]|null=null,bestDistance=6
  for(const p of this.pool){if(p.life<=0)continue;const d=p.mesh.position.distanceTo(point);if(d<bestDistance){best=p;bestDistance=d}}
  if(best){best.life=0;best.mesh.visible=false}
 }
 private spawn(kind:GrenadeKind,origin:THREE.Vector3,direction:THREE.Vector3,thrower:Player|null=null):boolean{
  const p=this.pool.find(p=>p.life<=0);if(!p)return false
  p.life=10;p.fuse=-1;p.kind=kind;p.target=null;p.vehicle=null;p.worldStuck=false
  p.impactIn=0;p.impactNormal.set(0,0,0);p.trailDistance=0;p.mesh.rotation.set(0,0,0);p.crackle=0;p.exclude=thrower
  p.mesh.position.copy(origin);p.v.copy(direction).multiplyScalar(17);p.v.y+=4;p.mesh.visible=true
  // The icosahedron only stands in for a frag whose model has not loaded yet.
  const m=p.mesh.material as THREE.MeshStandardMaterial
  if(p.frag)p.frag.visible=kind==='frag'
  p.plasma.object.visible=kind==='plasma'
  m.visible=kind==='frag'&&!p.frag
  return true
 }
 update(dt:number):void{
  this.cooldown=Math.max(0,this.cooldown-dt)
  this.clock+=dt
  for(const p of this.pool){if(p.life<=0)continue;p.life-=dt
   if(p.vehicle){
    if(p.vehicle.parent&&this.vehicles().some(v=>v.object===p.vehicle)){
     p.vehicle.updateWorldMatrix(true,false);p.mesh.position.copy(p.vehicle.localToWorld(p.offset.clone()))
     p.mesh.quaternion.copy(p.vehicle.getWorldQuaternion(this.parentQuat)).multiply(p.stuckQuat)
    }else{p.vehicle=null;p.worldStuck=false;p.v.set(0,0,0)}
   }
   if(p.target){
    p.target.object.updateWorldMatrix(true,false)
    p.mesh.position.copy(p.target.object.localToWorld(p.offset.clone()))
    p.mesh.quaternion.copy(p.target.object.getWorldQuaternion(this.parentQuat)).multiply(p.stuckQuat)
   }
   else if(!p.vehicle&&!p.worldStuck) for(let remaining=dt;remaining>0;){const h=Math.min(remaining,1/60);remaining-=h;p.v.y-=9.8*h
    p.impactIn=Math.max(0,p.impactIn-h)
    this.trailStart.copy(p.mesh.position)
    const end=p.mesh.position.clone().addScaledVector(p.v,h)
    const surface=this.meshContact?.(p.mesh.position,end)
    const hit=this.meshContact ? surface?.point??null : this.sweep(p.mesh.position,end)
    if(p.kind==='plasma'){
     const motion=end.clone().sub(p.mesh.position),lengthSquared=motion.lengthSq()
     let closest=hit?hit.distanceTo(p.mesh.position)/Math.max(motion.length(),.00001):Infinity
     let target:Player|null=null
     let vehicle:THREE.Object3D|null=null
     if(lengthSquared>0)for(const candidate of this.players()){
      if(!candidate.alive||candidate===p.exclude)continue
      const center=new THREE.Vector3(candidate.state.x,candidate.state.y+.9,candidate.state.z)
      for(const y of [.45,1,1.55]){
       const offset=p.mesh.position.clone().sub(new THREE.Vector3(candidate.state.x,candidate.state.y+y,candidate.state.z))
       const c=offset.lengthSq()-.59*.59,b=offset.dot(motion),discriminant=b*b-lengthSquared*c
       if(c>0&&discriminant<0)continue
       const t=c<=0?0:(-b-Math.sqrt(discriminant))/lengthSquared
       // Resolve the earliest body contact before the wall. The additional visibility
       // check rejects broad hit capsules that protrude through thin cover.
       if(t>=0&&t<=1&&t<closest&&!(this.meshContact ? this.meshContact(p.mesh.position,center) : this.sweep(p.mesh.position,center))){
        closest=t;target=candidate
       }
      }
     }
     if(lengthSquared>0)for(const candidate of this.vehicles()){
      if(!candidate.object.parent)continue
      const t=grenadeVehicleContact(p.mesh.position,end,candidate)
      if(t!==null&&t<closest){closest=t;target=null;vehicle=candidate.object}
     }
     if(vehicle){
      p.mesh.position.addScaledVector(motion,closest);p.vehicle=vehicle;p.target=null
      this.impact(p.mesh.position.clone(),p.kind,p.v.length(),false)
      this.stick(p,p.v.clone().negate(),vehicle)
      p.offset.copy(vehicle.worldToLocal(p.mesh.position.clone()));p.v.set(0,0,0);p.fuse=1.5;break
     }
     if(target){
      p.mesh.position.addScaledVector(motion,closest);p.target=target
      this.impact(p.mesh.position.clone(),p.kind,p.v.length(),false)
      // Seat it on the body: outward from the spine, not along the throw.
      const outward=p.mesh.position.clone().sub(new THREE.Vector3(target.state.x,p.mesh.position.y,target.state.z))
      // The hit capsule is wider than the armour; draw the grenade on the armour itself.
      const reach=outward.length();if(reach>.3)p.mesh.position.addScaledVector(outward,(.3-reach)/reach)
      this.stick(p,outward.lengthSq()>1e-6?outward:p.v.clone().negate(),target.object)
      p.offset.copy(target.object.worldToLocal(p.mesh.position.clone()));p.fuse=1.5;break
     }
    }
    const contact=hit??end
    const groundContact=!this.meshContact&&contact.y<groundHeight(contact.x,contact.z)+.12
    if(hit||groundContact){
     let impactSpeed=p.v.length()
     const impactNormal=surface?.normal.clone()??p.v.clone().normalize().negate()
     if(p.fuse<0)p.fuse=1.5
     p.mesh.position.copy(contact)
     if(surface){
      impactSpeed=Math.max(0,-p.v.dot(surface.normal))
      p.mesh.position.addScaledVector(surface.normal,.12)
      bounceGrenade(p.v,surface.normal)
     }else if(groundContact){
      p.mesh.position.y=groundHeight(contact.x,contact.z)+.12
      const e=.1,x=contact.x,z=contact.z
      const normal=new THREE.Vector3(groundHeight(x-e,z)-groundHeight(x+e,z),2*e,groundHeight(x,z-e)-groundHeight(x,z+e)).normalize()
      const speed=p.v.dot(normal)
      impactSpeed=Math.max(0,-speed);impactNormal.copy(normal)
      p.v.addScaledVector(normal,-speed).multiplyScalar(.62).addScaledVector(normal,Math.abs(speed)*.42)
     }else{
      // Keep the grenade radius outside walls so the next sweep cannot start on the face.
      p.mesh.position.addScaledVector(p.v,-.12/Math.max(p.v.length(),.00001));p.v.multiplyScalar(-.42)
     }
     if(impactSpeed>1.8&&(p.impactIn<=0||p.impactNormal.dot(impactNormal)<.8)){
      this.impact(p.mesh.position.clone(),p.kind,impactSpeed,groundContact);p.impactIn=.09;p.impactNormal.copy(impactNormal)
     }
     if(p.kind==='plasma'){this.stick(p,impactNormal,null);p.v.set(0,0,0);p.worldStuck=true;break}
    }else p.mesh.position.copy(end)
    if(p.kind==='plasma'&&this.fx&&p.v.lengthSq()>1){
     const distance=this.trailStart.distanceTo(p.mesh.position),spacing=.12
     for(let along=spacing-p.trailDistance;along<=distance;along+=spacing){
      this.trailPoint.copy(this.trailStart).lerp(p.mesh.position,along/Math.max(distance,1e-8));this.fx.plasmaTrail(this.trailPoint)
     }
     p.trailDistance=(p.trailDistance+distance)%spacing
    }
    if(p.kind==='frag'&&p.v.lengthSq()>1){
     const distance=this.trailStart.distanceTo(p.mesh.position),spacing=.07
     // Emit along each swept segment, including the segments before/after a bounce.
     // Carried distance keeps particle density independent of the render frame rate.
     for(let along=spacing-p.trailDistance;along<=distance;along+=spacing){
      this.trailPoint.copy(this.trailStart).lerp(p.mesh.position,along/Math.max(distance,1e-8));this.trail.emit(this.trailPoint)
     }
     p.trailDistance=(p.trailDistance+distance)%spacing
    }
   }
   if(p.fuse>=0)p.fuse-=dt
   const stuck=p.kind==='plasma'&&(p.worldStuck||!!p.target||!!p.vehicle)
   // Tumble in flight; once stuck, the grenade holds the pose it bit in with.
   if(!stuck&&p.v.lengthSq()>.25){p.mesh.rotation.x+=dt*3;p.mesh.rotation.z+=dt*2}
   if(p.kind==='plasma'){
    const armed=stuck?Math.min(1,Math.max(0,1-p.fuse/1.5)):0
    p.plasma.update(this.clock+p.mesh.id,armed)
    if(stuck&&this.fx){
     // The armed grenade fizzes, faster and harder as the fuse runs down.
     for(p.crackle+=dt*(22+armed*55);p.crackle>=1;p.crackle--)this.fx.plasmaCrackle(p.mesh.position,armed)
    }
   }
   if((p.fuse<0&&p.fuse>-1)||p.life<=0){this.blast(p.mesh.position.clone(),p.kind,p.kind==='plasma'?p.target:null);p.life=0;p.mesh.visible=false}
  }
  this.trail.update(dt)
 }
 /** Seat a plasma grenade with its pod against the surface, remembered relative to `parent`. */
 private stick(p:typeof this.pool[number],normal:THREE.Vector3,parent:THREE.Object3D|null):void{
  const n=normal.clone();if(n.lengthSq()<1e-8)n.set(0,1,0);n.normalize()
  p.mesh.quaternion.setFromUnitVectors(this.up,n).multiply(this.spin.setFromAxisAngle(this.up,Math.random()*Math.PI*2))
  if(parent){parent.updateWorldMatrix(true,false);p.stuckQuat.copy(parent.getWorldQuaternion(this.parentQuat).invert()).multiply(p.mesh.quaternion)}
  this.fx?.plasmaStick(p.mesh.position)
 }
}
