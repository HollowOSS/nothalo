import { World, Body, Box, Vec3, Quaternion, GSSolver } from 'cannon-es'
import type { VehicleKind, VehicleState } from './vehicle-sim.ts'

const SPECS = {
  mongoose: {mass:400,center:.8,half:[.85,.35,1.6]},
  chopper: {mass:1100,center:1.25,half:[1.2,.8,3]},
  warthog: { mass:1200, center:1.10, half:[1.15,.55,2.6] },
  ghost: { mass:600, center:.35, half:[1.85,.35,2.30] },
  banshee: { mass:900, center:.6, half:[2.8,.4,1.8] },
} as const
let signature='',world:World,bodies:Body[]=[]
function prepare(kinds:readonly VehicleKind[]):void {
  const next=kinds.join(',');if(next===signature&&world)return
  signature=next;world=new World({gravity:new Vec3(0,0,0),allowSleep:false})
  ;(world.solver as GSSolver).iterations=12
  world.defaultContactMaterial.friction=.4;world.defaultContactMaterial.restitution=.12
  bodies=kinds.map(kind=>{const spec=SPECS[kind],body=new Body({mass:spec.mass,shape:new Box(new Vec3(...spec.half)),linearDamping:0,angularDamping:0,allowSleep:false});world.addBody(body);return body})
}
/** Resolve inter-vehicle contacts after normal terrain integration. Noncontact states remain exact. */
export function resolveVehicleContacts(kinds:readonly VehicleKind[],states:readonly VehicleState[],dt:number):void {
  if(states.length<2||kinds.length!==states.length||dt<=0)return
  prepare(kinds);const h=Math.min(dt,1/30)
  const originals=states.map((s,i)=>{
    const body=bodies[i],q=new Quaternion()
    if(s.physicsReady)q.set(s.qx??0,s.qy??0,s.qz??0,s.qw??1)
    else q.setFromEuler(-s.pitch,s.yaw+Math.PI,s.roll,'YXZ')
    q.normalize();body.quaternion.copy(q);body.updateInertiaWorld(true)
    const offset=q.vmult(new Vec3(0,SPECS[kinds[i]].center,0));body.position.set(s.x+offset.x,s.y+offset.y,s.z+offset.z)
    body.velocity.set(s.physicsReady?s.pvx??0:-Math.sin(s.yaw)*s.speed+s.impulseX,s.physicsReady?s.pvy??0:s.vy,s.physicsReady?s.pvz??0:-Math.cos(s.yaw)*s.speed+s.impulseZ)
    body.angularVelocity.set(s.avx??0,s.avy??0,s.avz??0);body.force.setZero();body.torque.setZero();body.aabbNeedsUpdate=true;body.wakeUp()
    return {position:body.position.clone(),velocity:body.velocity.clone(),q:q.clone()}
  })
  world.step(h)
  const contacts=new Map<number,number>()
  for(const contact of world.contacts){
    const closing=Math.abs(contact.getImpactVelocityAlongNormal())
    contacts.set(contact.bi.id,Math.max(contacts.get(contact.bi.id)??0,closing));contacts.set(contact.bj.id,Math.max(contacts.get(contact.bj.id)??0,closing))
  }
  for(let i=0;i<states.length;i++){
    const body=bodies[i],s=states[i],before=originals[i];if(!contacts.has(body.id))continue
    // Terrain step already advanced these bodies. Apply only solver-induced displacement.
    s.x+=body.position.x-before.position.x-before.velocity.x*h;s.y+=body.position.y-before.position.y-before.velocity.y*h;s.z+=body.position.z-before.position.z-before.velocity.z*h
    s.pvx=body.velocity.x;s.pvy=body.velocity.y;s.pvz=body.velocity.z;s.avx=body.angularVelocity.x;s.avy=body.angularVelocity.y;s.avz=body.angularVelocity.z
    s.qx=before.q.x;s.qy=before.q.y;s.qz=before.q.z;s.qw=before.q.w;s.physicsReady=true
    s.vy=s.pvy;s.speed=-Math.sin(s.yaw)*s.pvx-Math.cos(s.yaw)*s.pvz
    s.impulseX=s.pvx+Math.sin(s.yaw)*s.speed;s.impulseZ=s.pvz+Math.cos(s.yaw)*s.speed
    const impact=contacts.get(body.id)??0;if(impact>2){s.impactSeq=(s.impactSeq+1)%65536;s.impactSpeed=Math.min(35,Math.max(s.impactSpeed,impact))}
  }
}
