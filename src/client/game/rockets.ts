import { shootRagdoll } from '../render/ragdolls.ts'
import * as THREE from 'three'
import { RocketSmoke } from './rocket-smoke.ts'
import { plasmaFx, type PlasmaFx } from '../render/plasma-fx.ts'
/**
 * Swept projectiles. Collision/damage stay with the match; blasts are drawn by ExplosionFx. `glow` > 0 flies them as plasma
 * (the Ghost's and Banshee's bolts, the fuel rod): drawn by PlasmaFx at `glow` times a plasma pistol bolt, instead of a mesh.
 */
export class Rockets {
 private readonly rockets:Array<{mesh:THREE.Mesh;velocity:THREE.Vector3;life:number;trailDistance:number;corpseHit:boolean}>=[]
 private readonly smoke:RocketSmoke|null
 private readonly trailPoint=new THREE.Vector3()
 private readonly glow:PlasmaFx|null
 private readonly color:THREE.Color
 constructor(scene:THREE.Scene,private readonly sweep:(start:THREE.Vector3,end:THREE.Vector3)=>THREE.Vector3|null,private readonly detonate:(point:THREE.Vector3)=>void,color=0xffdb86,smokeTrail=true,private readonly glowSize=0){
  this.smoke=smokeTrail?new RocketSmoke(scene):null
  this.glow=glowSize>0?plasmaFx(scene):null;this.color=new THREE.Color(color)
  const geometry=new THREE.CylinderGeometry(.045,.065,.4,8).rotateX(Math.PI/2)
  const material=new THREE.MeshBasicMaterial({color,toneMapped:false})
  for(let i=0;i<12;i++){const mesh=new THREE.Mesh(geometry,material);mesh.visible=false;scene.add(mesh);this.rockets.push({mesh,velocity:new THREE.Vector3(),life:0,trailDistance:0,corpseHit:false})}
 }
 get smokeCount():number{return this.smoke?.activeCount??0}
 get activeCount():number{return this.rockets.filter(r=>r.life>0).length}
 launch(origin:THREE.Vector3,direction:THREE.Vector3,speed:number):boolean{
  const rocket=this.rockets.find(r=>r.life<=0);if(!rocket)return false
  rocket.mesh.position.copy(origin);rocket.velocity.copy(direction).multiplyScalar(speed);rocket.life=7;rocket.corpseHit=false;rocket.mesh.visible=!this.glow;rocket.trailDistance=0
  this.glow?.tracer(rocket,origin,this.color,this.glowSize)
  this.smoke?.emit(this.trailPoint.copy(origin).addScaledVector(direction,-.22))
  rocket.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),direction);return true
 }
 update(dt:number):void{
  for(const r of this.rockets){if(r.life<=0)continue
   const end=r.mesh.position.clone().addScaledVector(r.velocity,dt),hit=this.sweep(r.mesh.position,end)
   // Corpses are cosmetic: transfer impact once without changing the authoritative path.
   if(!r.corpseHit)r.corpseHit=!!shootRagdoll(r.mesh.position,hit??end,this.smoke?3:1.2)
   if(this.smoke){
    const finish=hit??end,length=r.mesh.position.distanceTo(finish)
    if(length>1e-6){
     const spacing=.32
     for(let distance=spacing-r.trailDistance;distance<=length;distance+=spacing){
      this.trailPoint.lerpVectors(r.mesh.position,finish,distance/length)
      this.smoke.emit(this.trailPoint)
     }
     r.trailDistance=(r.trailDistance+length)%spacing
    }
   }
   r.life-=dt
   if(hit){r.life=0;r.mesh.position.copy(hit);this.detonate(hit)}
   else r.mesh.position.copy(end)
   if(this.glow){if(r.life>0)this.glow.tracer(r,r.mesh.position,this.color,this.glowSize);else this.glow.tracerGone(r,!!hit);r.mesh.visible=false}
   else r.mesh.visible=r.life>0
  }
  this.smoke?.update(dt)
 }
}
