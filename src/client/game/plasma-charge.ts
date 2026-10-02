import * as THREE from 'three'
import {plasmaFx,type PlasmaFx} from '../render/plasma-fx.ts'
import {launchChargedBolt,stepChargedBolt,type ChargedBolt,type PlasmaTarget} from '../../shared/plasma-charge.ts'
/** Fixed pool: geometry and materials exist before gameplay's GPU warm-up. */
export class ChargedPlasma {
 private pool:{mesh:THREE.Mesh;flight:ChargedBolt|null;owner:string}[]=[]
 /** The glow, orbiting wisps, trail and embers around each orb (the mesh is only its solid white-hot heart). */
 private fx:PlasmaFx
 constructor(scene:THREE.Scene,private targets:(owner:string)=>PlasmaTarget[],private blocked:(a:THREE.Vector3,b:THREE.Vector3)=>boolean,private hit:(id:string,owner:string,point:THREE.Vector3)=>void){
  this.fx=plasmaFx(scene)
  const geometry=new THREE.SphereGeometry(.09,10,8),material=new THREE.MeshBasicMaterial({color:new THREE.Color(1.8,3,1.2),toneMapped:false})
  for(let i=0;i<24;i++){const mesh=new THREE.Mesh(geometry,material);mesh.name='charged-plasma';mesh.frustumCulled=false;mesh.scale.setScalar(0);scene.add(mesh);this.pool.push({mesh,flight:null,owner:''})}
 }
 private clear=(a:{x:number;y:number;z:number},b:{x:number;y:number;z:number})=>this.blocked(new THREE.Vector3(a.x,a.y,a.z),new THREE.Vector3(b.x,b.y,b.z))
 launch(origin:THREE.Vector3,dir:THREE.Vector3,owner:string):void {const p=this.pool.find(p=>!p.flight);if(!p)return;p.owner=owner;p.flight=launchChargedBolt(origin,dir,this.targets(owner),this.clear);p.mesh.position.copy(origin);p.mesh.scale.setScalar(1)}
 update(dt:number):void {for(const p of this.pool){if(!p.flight)continue;const r=stepChargedBolt(p.flight,dt,this.targets(p.owner),this.clear);p.mesh.position.set(p.flight.x,p.flight.y,p.flight.z);this.fx.orb(p,p.mesh.position);if(r.hit)this.hit(r.hit,p.owner,p.mesh.position.clone());if(r.done){p.flight=null;p.mesh.scale.setScalar(0);this.fx.orbGone(p)}}}
 get activeCount():number{return this.pool.filter(p=>p.flight).length}
}
