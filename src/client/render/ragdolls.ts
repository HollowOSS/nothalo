import type { MapId } from '../../shared/guardian.ts'
import type {BulletImpact} from '../../shared/bullet-impact.ts'
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import * as CANNON from 'cannon-es'
import { createPhysicsWorld } from '../../shared/physics-world.ts'
import { blastImpulse } from '../../shared/blast-impulse.ts'

/** Cosmetic bodies never participate in network prediction or obstruct living players. */
const CAP = 12, LIFE = 35, STEP = 1 / 60
/** Gameplay reference mass shared conceptually with living armoured-character blast transfer. */
export const ARMOURED_SPARTAN_MASS = 180
interface Joint { bone: THREE.Bone; p: THREE.Vector3; rigid: CANNON.Body; offset: CANNON.Vec3; restPosition: THREE.Vector3; root: boolean; radius: number; rest: THREE.Quaternion; child: number }
interface Link { a: number; b: number; length: number; collision?: boolean }
interface Body { object: THREE.Object3D; joints: Joint[]; links: Link[]; constraints: CANNON.Constraint[]; age: number; awake: number; quiet: number; impacts: Map<string | number, number>; materials: THREE.Material[]; skins: THREE.SkinnedMesh[] }
const bodies: Body[] = []
let corpseWorld: CANNON.World | null = null
let physicsAccumulator=0
let corpseMap:MapId='blood-gulch'
/** Dispose the old map's corpses and static physics together before a new match. */
export function configureRagdollMap(map:MapId):void {
  if(map===corpseMap)return
  clearRagdolls();corpseMap=map
}
const getWorld = () => {
  if(!corpseWorld){
    corpseWorld=createPhysicsWorld(corpseMap);(corpseWorld.solver as CANNON.GSSolver).iterations=10
    corpseWorld.defaultContactMaterial.restitution=0
    corpseWorld.defaultContactMaterial.friction=.65
    corpseWorld.defaultContactMaterial.contactEquationStiffness=1e6
    corpseWorld.defaultContactMaterial.contactEquationRelaxation=8
  }
  return corpseWorld
}
const physicalImpulse = new CANNON.Vec3()
const restAngular = new CANNON.Vec3()
const supports = new Set<number>()
function velocityChange(j: Joint, change: THREE.Vector3): void {
  // Public effect strength is a delta-velocity. Cannon takes impulse in kg m/s.
  j.rigid.wakeUp()
  physicalImpulse.set(change.x*j.rigid.mass,change.y*j.rigid.mass,change.z*j.rigid.mass)
  j.rigid.applyImpulse(physicalImpulse)
  const speed=j.rigid.velocity.length()
  if(speed>40)j.rigid.velocity.scale(40/speed,j.rigid.velocity)
}
function impulseChange(j: Joint, impulse: THREE.Vector3): void {
  // Explosion impulses are momentum, not a per-bone velocity override. A lighter limb therefore
  // moves farther than the torso while the whole corpse receives one conserved impulse.
  j.rigid.wakeUp()
  physicalImpulse.set(impulse.x, impulse.y, impulse.z)
  j.rigid.applyImpulse(physicalImpulse)
  const speed=j.rigid.velocity.length()
  if(speed>40)j.rigid.velocity.scale(40/speed,j.rigid.velocity)
}
const delta = new THREE.Vector3(), motion = new THREE.Vector3(), direction = new THREE.Vector3()
const rotation = new THREE.Quaternion(), parentRotation = new THREE.Quaternion()
const names = /^(Hips|Spine|Spine01|Spine02|Neck|Head|LeftArm|LeftForeArm|LeftHand|RightArm|RightForeArm|RightHand|LeftUpLeg|LeftLeg|LeftFoot|RightUpLeg|RightLeg|RightFoot)$/i

function remove(body: Body): void {
  if(corpseWorld) {
    for(const constraint of body.constraints ?? [])corpseWorld.removeConstraint(constraint)
    for(const joint of body.joints ?? [])corpseWorld.removeBody(joint.rigid)
  }
  body.object.removeFromParent()
  for (const material of body.materials) material.dispose()
  for (const mesh of body.skins) mesh.skeleton.dispose()
}

/** Snapshot the actual posed Spartan, sharing its geometry/textures but never its skeleton. */
export function spawnRagdoll(source: THREE.Object3D, parent: THREE.Object3D, velocity: THREE.Vector3, impact?:BulletImpact): THREE.Object3D | undefined {
  source.updateWorldMatrix(true, true)
  const object = cloneSkinned(source)
  source.matrixWorld.decompose(object.position, object.quaternion, object.scale)
  parent.updateWorldMatrix(true, false)
  const local = new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(source.matrixWorld)
  local.decompose(object.position, object.quaternion, object.scale)
  object.visible = true
  const materials: THREE.Material[] = [], skins: THREE.SkinnedMesh[] = []
  object.traverse(o => {
    if (o.name === 'rifle-aim-mount') o.visible = false
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isMesh) return
    const cloneMaterial = (m: THREE.Material) => { const copy = m.clone(); copy.clippingPlanes = null; materials.push(copy); return copy }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMaterial) : cloneMaterial(mesh.material)
    mesh.castShadow = false
    if (mesh.isSkinnedMesh) { skins.push(mesh); mesh.frustumCulled = false }
  })
  parent.add(object)
  object.updateWorldMatrix(true, true)
  const joints: Joint[] = []
  object.traverse(o => {
    if (!(o as THREE.Bone).isBone || !names.test(o.name)) return
    const p = o.getWorldPosition(new THREE.Vector3())
    // A modest backward impulse breaks a perfectly vertical equilibrium.
    const v = velocity.clone().clampLength(0, 30)
    v.x += impact?0:Math.sin(source.rotation.y + 1) * .9
    v.z += impact?0:Math.cos(source.rotation.y + 1) * .9
    const rigid = new CANNON.Body({ mass: 1, position: new CANNON.Vec3(p.x,p.y,p.z),
      linearDamping: .25, angularDamping: .65, allowSleep: false, sleepSpeedLimit: .18, sleepTimeLimit: 1.2,
      collisionFilterGroup: 2, collisionFilterMask: 1 })
    rigid.velocity.set(v.x,v.y,v.z)
    rigid.angularVelocity.set(impact?0:.9,impact?0:.65,impact?0:.25)
    joints.push({ bone: o as THREE.Bone, p, rigid, offset:new CANNON.Vec3(), restPosition:o.position.clone(), root:false, radius: /Head/i.test(o.name) ? .15 : /Hips|Spine/.test(o.name) ? .20 : .085, rest: o.getWorldQuaternion(new THREE.Quaternion()), child: -1 })
  })
  if (joints.length < 5) { remove({ object, materials, skins } as Body); return }
  const index = new Map(joints.map((j, i) => [j.bone, i]))
  const links: Link[] = []
  joints.forEach((j, b) => {
    let ancestor = j.bone.parent
    while (ancestor && !index.has(ancestor as THREE.Bone)) ancestor = ancestor.parent
    if (!ancestor) {j.root=true;return}
    const a = index.get(ancestor as THREE.Bone)!
    links.push({ a, b, length: joints[a].p.distanceTo(j.p), collision: true })
    if (joints[a].child < 0) joints[a].child = b
  })
  // Each rigid link starts in world-aligned coordinates; its rest-pose offset is baked into
  // collider placement. Bone world orientation later becomes physical rotation * rest rotation.
  const world=getWorld(), constraints: CANNON.Constraint[]=[]
  const massWeight=(name:string)=>/Hips|Spine/i.test(name)?4:/UpLeg/i.test(name)?3:/Head/i.test(name)?2:1
  const totalWeight=joints.reduce((sum,j)=>sum+massWeight(j.bone.name),0)
  for(const j of joints) {
    const rigid=j.rigid
    rigid.mass=ARMOURED_SPARTAN_MASS*massWeight(j.bone.name)/totalWeight
    if(j.child>=0) {
      delta.copy(joints[j.child].p).sub(j.p)
      const length=delta.length()
      const radius=Math.min(j.radius,joints[j.child].radius)
      // Put mass/inertia at the link's center, not its end joint. This avoids artificial
      // pendulum leverage and lets the contact solver keep adjacent joints coincident.
      rigid.position.set(j.p.x+delta.x*.5,j.p.y+delta.y*.5,j.p.z+delta.z*.5)
      j.offset.set(-delta.x*.5,-delta.y*.5,-delta.z*.5)
      const q=new CANNON.Quaternion()
      q.setFromVectors(new CANNON.Vec3(0,1,0),new CANNON.Vec3(delta.x/length,delta.y/length,delta.z/length))
      // Armoured limbs use one oriented convex hull rather than three overlapping capsule
      // shapes: fewer terrain contacts, stable inertia, and no loss of articulated joints.
      rigid.addShape(new CANNON.Box(new CANNON.Vec3(radius,Math.max(.05,length*.5),radius)),new CANNON.Vec3(),q)
    }else rigid.addShape(new CANNON.Sphere(j.radius))
    rigid.updateMassProperties()
    world.addBody(rigid)
  }
  for(const link of links) {
    const a=joints[link.a],b=joints[link.b]
    delta.copy(b.p).sub(a.p)
    const axis=new CANNON.Vec3(delta.x,delta.y,delta.z);axis.normalize()
    let constraint: CANNON.Constraint
    if(/^Spine/i.test(b.bone.name)) constraint=new CANNON.LockConstraint(a.rigid,b.rigid,{maxForce:2e5})
    else {
      const angle=/ForeArm/i.test(b.bone.name)?.5:/UpLeg/i.test(b.bone.name)?.42:/Arm/i.test(b.bone.name)?.58:/Leg/i.test(b.bone.name)?.34:.22
      constraint=new CANNON.ConeTwistConstraint(a.rigid,b.rigid,{
        pivotA:new CANNON.Vec3(b.p.x-a.rigid.position.x,b.p.y-a.rigid.position.y,b.p.z-a.rigid.position.z),pivotB:b.offset,axisA:axis,axisB:axis,
        angle,twistAngle:.22,maxForce:2e5,collideConnected:false,
      })
    }
    constraint.collideConnected=false
    for(const equation of constraint.equations)equation.setSpookParams(1e6,8,STEP)
    if(constraint instanceof CANNON.ConeTwistConstraint) {
      for(const equation of [constraint.coneEquation,constraint.twistEquation]) {
        equation.setSpookParams(2e4,12,STEP)
        equation.minForce=-180;equation.maxForce=0
      }
    }
    constraints.push(constraint);world.addConstraint(constraint)

  }
  if (bodies.length >= CAP) remove(bodies.shift()!)
  bodies.push({ object, joints, links, constraints, age: 0, awake: 0, quiet: 0, impacts: new Map(), materials, skins })
  if(impact)applyRagdollBulletImpact(object,impact)
  return object
}

/** Positions are world-space collision centers (about 0.6 m above a Warthog's ground origin). */
export interface RagdollVehicle {
  id: string | number
  kind: 'warthog' | 'ghost' | 'banshee' | 'mongoose' | 'chopper'
  previous: { x: number; y: number; z: number }
  position: { x: number; y: number; z: number }
  velocity: { x: number; y: number; z: number }
}
const hulls = { mongoose:{radius:1,height:.6,mass:.4},chopper:{radius:1.5,height:1,mass:1.2}, warthog: { radius: 1.65, height: .85, mass: 1 }, ghost: { radius: 1.3, height: .5, mass: .7 }, banshee: { radius: 1.65, height: .65, mass: .85 } }

function vehicleImpacts(body: Body, vehicles: readonly RagdollVehicle[], dt: number): void {
  for (const [id, at] of body.impacts) if (body.age - at > 2) body.impacts.delete(id)
  for (const vehicle of vehicles) {
    if (body.age - (body.impacts.get(vehicle.id) ?? -Infinity) < .85) continue
    const { previous: a, position: b, velocity: v } = vehicle
    if (![a.x,a.y,a.z,b.x,b.y,b.z,v.x,v.y,v.z].every(Number.isFinite)) continue
    const speed = Math.hypot(v.x,v.y,v.z)
    if (speed < 2) continue
    const dx = b.x-a.x, dy = b.y-a.y, dz = b.z-a.z
    // A respawn/teleport is not an enormous sweep across the entire map.
    if (Math.hypot(dx,dy,dz) > Math.max(4, speed * Math.min(dt,.1) * 2.5)) continue
    const hull = hulls[vehicle.kind]
    if (!hull) continue
    let contact = false, hitX = b.x, hitY = b.y, hitZ = b.z
    for (const j of body.joints) {
      const radius = hull.radius+j.radius, height = hull.height+j.radius
      const sx=dx/radius, sy=dy/height, sz=dz/radius
      const px=(j.p.x-a.x)/radius, py=(j.p.y-a.y)/height, pz=(j.p.z-a.z)/radius
      const length=sx*sx+sy*sy+sz*sz
      const t=length>1e-8 ? Math.max(0,Math.min(1,(px*sx+py*sy+pz*sz)/length)) : 0
      if ((px-sx*t)**2+(py-sy*t)**2+(pz-sz*t)**2 <= 1) {
        contact=true; hitX=j.p.x; hitY=j.p.y; hitZ=j.p.z; break
      }
    }
    if (!contact) continue
    body.impacts.set(vehicle.id, body.age)
    body.awake=0;body.quiet=0
    const strength=Math.min(speed,40)*(.5+.22*hull.mass)
    const lift=Math.min(9,1.2+speed*.18)*hull.mass
    for (const j of body.joints) {
      // Whole-body transfer keeps the skeleton together; a small off-center component tumbles it.
      const distance=Math.hypot(j.p.x-hitX,j.p.y-hitY,j.p.z-hitZ)
      const transfer=.82+.18*Math.max(0,1-distance/1.8)
      motion.set(0,0,0)
      motion.x+=v.x/speed*strength*transfer
      motion.y+=v.y/speed*strength*transfer+lift+Math.min(distance,.8)*.6
      motion.z+=v.z/speed*strength*transfer
      motion.clampLength(0,40)
      velocityChange(j,motion)
    }
  }
}

const bulletRay = new THREE.Ray(), bulletSphere = new THREE.Sphere()
/** A grounded crouch contacting a nearby fallen body gives a small cosmetic physical shove. */
export function crouchRagdoll(feet: {x:number;y:number;z:number}, yaw:number,
  visible?: (from:THREE.Vector3,to:THREE.Vector3)=>boolean): THREE.Vector3 | null {
  if (![feet.x,feet.y,feet.z,yaw].every(Number.isFinite)) return null
  let nearest: {body:Body;joint:Joint;distance:number} | null = null
  const from = new THREE.Vector3(feet.x,feet.y+.7,feet.z)
  for (const body of bodies) for (const joint of body.joints) {
    const p=joint.p, horizontal=Math.hypot(p.x-feet.x,p.z-feet.z)
    if (p.y < feet.y-.2 || p.y > feet.y+.75 || horizontal > .5+joint.radius) continue
    if ((!nearest || horizontal<nearest.distance) && (!visible || visible(from,p))) nearest={body,joint,distance:horizontal}
  }
  if (!nearest) return null
  const {body,joint}=nearest, point=joint.p.clone()
  direction.set(point.x-feet.x,0,point.z-feet.z)
  if (direction.lengthSq()<.04) direction.set(-Math.sin(yaw),0,-Math.cos(yaw))
  direction.normalize().multiplyScalar(.85); direction.y=.4
  body.awake=0;body.quiet=0
  for (const j of body.joints) velocityChange(j,direction)
  motion.copy(direction).multiplyScalar(.8);velocityChange(joint,motion)
  return point
}
const bulletHit = new THREE.Vector3(), capsuleAxis = new THREE.Vector3(), capsuleOffset = new THREE.Vector3()
/** Segment must already be clipped to world solids/living targets. Returns closest corpse contact. */
export function shootRagdoll(start: THREE.Vector3, end: THREE.Vector3, strength: number): THREE.Vector3 | null {
  if (![...start,...end,strength].every(Number.isFinite) || strength <= 0) return null
  const length = start.distanceTo(end)
  if (length < 1e-6) return null
  bulletRay.set(start, direction.copy(end).sub(start).multiplyScalar(1/length))
  let nearest = length, victim: Body | null = null
  const accept = (distance: number, body: Body) => {
    if (distance >= 0 && distance <= nearest) { nearest=distance; victim=body }
  }
  for(const body of bodies) {
    for(const j of body.joints) {
      bulletSphere.set(j.p,j.radius)
      if(bulletSphere.containsPoint(start)) { accept(0,body); continue }
      if(bulletRay.intersectSphere(bulletSphere,bulletHit)) accept(start.distanceTo(bulletHit),body)
    }
    for(const link of body.links) {
      if(!link.collision)continue
      const a=body.joints[link.a], b=body.joints[link.b]
      const radius=Math.min(a.radius,b.radius)
      capsuleAxis.copy(b.p).sub(a.p); capsuleOffset.copy(start).sub(a.p)
      const ba2=capsuleAxis.lengthSq(), bard=capsuleAxis.dot(bulletRay.direction)
      if(ba2<1e-8)continue
      const baoa=capsuleAxis.dot(capsuleOffset), rdoa=bulletRay.direction.dot(capsuleOffset), oa2=capsuleOffset.lengthSq()
      const along=Math.max(0,Math.min(1,baoa/ba2))
      if(capsuleOffset.lengthSq()-2*along*baoa+along*along*ba2 <= radius*radius) { accept(0,body); continue }
      const qa=ba2-bard*bard, qb=ba2*rdoa-baoa*bard, qc=ba2*oa2-baoa*baoa-radius*radius*ba2
      const discriminant=qb*qb-qa*qc
      if(discriminant<0 || Math.abs(qa)<1e-8)continue
      const distance=(-qb-Math.sqrt(discriminant))/qa
      const y=baoa+distance*bard
      if(y>=0 && y<=ba2)accept(distance,body)
    }
  }
  if(!victim)return null
  const body = victim as Body
  const point = bulletRay.at(nearest,new THREE.Vector3())
  applyRagdollBulletImpact(body.object,{point,direction:bulletRay.direction,strength})
  return point
}

/** Wake nearby existing bodies and impart radial velocity; strength is peak metres/second. */
export function blastRagdolls(point: {x:number;y:number;z:number}, radius: number, strength: number,
  visibility?: (from: THREE.Vector3, to: THREE.Vector3) => boolean): void {
  if (![point.x,point.y,point.z,radius,strength].every(Number.isFinite) || radius <= 0 || strength <= 0) return
  const origin = new THREE.Vector3(point.x,point.y,point.z), center = new THREE.Vector3()
  for (const body of bodies) {
    center.set(0,0,0)
    for(const j of body.joints)center.add(j.p)
    center.multiplyScalar(1/body.joints.length)
    const distance = center.distanceTo(origin)
    if(distance >= radius || (visibility && !visibility(origin,center)))continue
    const impulse=blastImpulse(center,origin,radius,strength)
    direction.set(impulse.x,impulse.y,impulse.z)
    if(direction.lengthSq()<1e-12)continue
    body.awake=0;body.quiet=0
    const impulsePerMass=ARMOURED_SPARTAN_MASS/body.joints.length
    for(const j of body.joints) {
      // Keep total linear momentum tied to the blast while preserving the authored mass split.
      motion.copy(direction).multiplyScalar(impulsePerMass)
      delta.copy(j.p).sub(center)
      // A small off-centre component gives a nearby side blast a believable tumble without
      // overpowering the radial launch.
      motion.x+=direction.z*delta.y*impulsePerMass*.12
      motion.z-=direction.x*delta.y*impulsePerMass*.12
      motion.y+=(direction.x*delta.z-direction.z*delta.x)*impulsePerMass*.12
      impulseChange(j,motion)
    }
  }
}

/** Fixed-step Cannon contacts and cone/twist constraints drive the same generated Spartan skeleton. */
export function updateRagdolls(dt: number, vehicles: readonly RagdollVehicle[] = []): void {
  if (!Number.isFinite(dt) || dt <= 0) return
  for (let i=bodies.length-1;i>=0;i--) {
    const body=bodies[i]
    body.age+=dt
    if(body.age>LIFE){remove(body);bodies.splice(i,1);continue}
    vehicleImpacts(body,vehicles,dt)
    body.awake+=dt
  }
  if(!bodies.length)return
  physicsAccumulator+=Math.min(dt,.1)
  while(physicsAccumulator+1e-9>=STEP){getWorld().step(STEP);physicsAccumulator-=STEP}
  supports.clear()
  for(const contact of getWorld().contacts) {
    if(!contact.enabled)continue
    if(contact.bi.mass===0 && contact.ni.y>.35)supports.add(contact.bj.id)
    else if(contact.bj.mass===0 && contact.ni.y<-.35)supports.add(contact.bi.id)
  }
  for(const body of bodies) {
    // Sleep the constrained island together: sleeping individual bones pins limbs while the
    // torso still moves, which stretches a skin and wastes work fighting the pinned joint.
    let energy=0,maxSpeed=0,grounded=false
    for(const j of body.joints) {
      const rigid=j.rigid, speed=rigid.velocity.lengthSquared()
      rigid.vectorToLocalFrame(rigid.angularVelocity,restAngular)
      energy+=.5*(rigid.mass*speed+rigid.inertia.x*restAngular.x**2+rigid.inertia.y*restAngular.y**2+rigid.inertia.z*restAngular.z**2)
      maxSpeed=Math.max(maxSpeed,speed)
      grounded ||= supports.has(rigid.id)
    }
    // Tiny hands can spin slightly at contact with almost no energy. Requiring every wrist
    // below an angular-speed threshold kept the whole 180kg island awake indefinitely.
    const quiet=grounded && energy<.3 && maxSpeed<.0625
    body.quiet=quiet?body.quiet+dt:0
    if(body.quiet>.65)for(const j of body.joints)j.rigid.sleep()
    for(const j of body.joints) {
      const rigid=j.rigid
      rigid.pointToWorldFrame(j.offset,physicalImpulse)
      j.p.set(physicalImpulse.x,physicalImpulse.y,physicalImpulse.z)
      const parent=j.bone.parent!
      parent.updateWorldMatrix(true,false)
      // Preserve authored bone lengths. Iterative physics joints have millimetre-scale drift;
      // feeding each body's translation into skin bones would visibly stretch the character.
      if(j.root){j.bone.position.copy(j.p);parent.worldToLocal(j.bone.position)}
      else j.bone.position.copy(j.restPosition)
      rotation.set(rigid.quaternion.x,rigid.quaternion.y,rigid.quaternion.z,rigid.quaternion.w).multiply(j.rest)
      parent.getWorldQuaternion(parentRotation).invert()
      j.bone.quaternion.copy(parentRotation.multiply(rotation))
      j.bone.updateWorldMatrix(false,false)
    }
  }
}

export function clearRagdolls(): void { for (const body of bodies) remove(body); bodies.length = 0; corpseWorld=null; physicsAccumulator=0 }
export function ragdollCount(): number { return bodies.length }
export function ragdollPhysicsStats(object?:THREE.Object3D) {
  const active=object?bodies.filter(b=>b.object===object):bodies
  const joints=active.flatMap(b=>b.joints)
  return {energy:joints.reduce((n,j)=>n+.5*j.rigid.mass*j.rigid.velocity.lengthSquared(),0),
    bodies:joints.length,constraints:active.reduce((n,b)=>n+b.constraints.length,0),
    mass:joints.reduce((n,j)=>n+j.rigid.mass,0),sleeping:joints.filter(j=>j.rigid.sleepState===CANNON.Body.SLEEPING).length,
    momentum:joints.reduce((v,j)=>({x:v.x+j.rigid.mass*j.rigid.velocity.x,y:v.y+j.rigid.mass*j.rigid.velocity.y,z:v.z+j.rigid.mass*j.rigid.velocity.z}),{x:0,y:0,z:0}),
    angularSpeed:joints.reduce((n,j)=>n+j.rigid.angularVelocity.length(),0)}
}

/** Apply to this exact corpse, including when death and visual shot events arrive separately. */
export function applyRagdollBulletImpact(object:THREE.Object3D,impact:BulletImpact):boolean {
  const body=bodies.find(b=>b.object===object)
  const {point,direction:dir,strength}=impact
  if(!body||![point.x,point.y,point.z,dir.x,dir.y,dir.z,strength].every(Number.isFinite)||strength<=0)return false
  const length=Math.hypot(dir.x,dir.y,dir.z);if(length<1e-6)return false
  let nearest:Joint|undefined,distance=Infinity
  for(const joint of body.joints){
    const a=joint.p,b=joint.child>=0?body.joints[joint.child].p:a
    const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,l=dx*dx+dy*dy+dz*dz
    const t=l?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy+(point.z-a.z)*dz)/l)):0
    const d=Math.hypot(point.x-a.x-dx*t,point.y-a.y-dy*t,point.z-a.z-dz*t)-joint.radius
    if(d<distance){distance=d;nearest=joint}
  }
  if(!nearest)return false
  body.awake=0;body.quiet=0
  for(const j of body.joints)j.rigid.wakeUp()
  // J in kg*m/s. The impacted link's inertia supplies torque; joints transmit it to the body.
  const force=Math.min(strength,18)*35/length
  physicalImpulse.set(dir.x*force,dir.y*force,dir.z*force)
  const arm=new CANNON.Vec3(point.x-nearest.rigid.position.x,point.y-nearest.rigid.position.y,point.z-nearest.rigid.position.z)
  // Network interpolation can offset the visual body slightly from the authoritative contact.
  if(arm.length()>1)arm.scale(1/arm.length(),arm)
  nearest.rigid.applyImpulse(physicalImpulse,arm)
  return true
}
