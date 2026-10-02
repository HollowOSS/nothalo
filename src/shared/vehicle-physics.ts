import {bloodGulchFloor} from './blood-gulch.ts'
import {Body,Box,Vec3,Quaternion,RaycastVehicle,RaycastResult,World,Material,ContactMaterial,type WheelInfo} from 'cannon-es'
import {createPhysicsWorld,GRAVITY,TERRAIN_MATERIAL} from './physics-world.ts'
import {blastImpulse} from './blast-impulse.ts'
import type {VehicleState,VehicleKind,VehicleInput} from './vehicle-sim.ts'

export const VEHICLE_MASS={warthog:1200,ghost:600,banshee:900,mongoose:400,chopper:1100} as const
const VEHICLE_STEP=1/60
// Lift the chassis 15 cm while keeping the wheel contact points at their existing ride height.
const CENTER={warthog:1.10,ghost:.35,banshee:.6,mongoose:.8,chopper:1.25} as const
const SIZE={warthog:[1.15,.55,2.6],ghost:[1.85,.35,2.3],banshee:[2.8,.4,1.8],mongoose:[.85,.35,1.6],chopper:[1.2,.8,3]} as const
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v))
const wrap=(v:number)=>Math.atan2(Math.sin(v),Math.cos(v))
// The tub rides clear of the wheel axles. Its friction against rock and concrete is applied by
// hand from each contact's solved normal force: cannon's own friction budget is μ·g·mass no
// matter how lightly a hull rests, which held a beached Warthog on a boulder against all four
// wheels. Load-proportional friction lets it slide off once the wheels are pushing.
const WARTHOG_HULL=new Material('warthog-hull'),WARTHOG_HULL_FRICTION=.15
const WARTHOG_HULL_HALF=new Vec3(1.15,.45,2.6),WARTHOG_HULL_LIFT=new Vec3(0,.1,0)
// Preload (m/s² per wheel, times chassis mass) keeps a drooping wheel pressed on the ground,
// fading to nothing at full extension: a hull grounded on a rock still has traction under its
// hanging wheels. The shorter rest length puts the loaded ride height back where it was. Travel
// is the droop limit; compression stops shorter, because letting the springs pack down further
// made a fast hop over a crest roll the hull.
const WARTHOG_SUSPENSION={rest:.52,travel:.42,compression:.3,radius:.72,preload:2.5}
let world:World|undefined,active:Body|undefined,car:RaycastVehicle|undefined
const bodies=new Map<VehicleKind,Body>()
const wheeled=(kind:VehicleKind)=>kind==='warthog'||kind==='mongoose'||kind==='chopper'
const runningGear={
 warthog:{radius:.72,rest:.52,points:[[-1.32,0,1.9],[1.32,0,1.9],[-1.32,0,-1.9],[1.32,0,-1.9]],force:3600,max:24},
 mongoose:{radius:.446,rest:.40,points:[[-.784,.02,1.097],[.784,.02,1.097],[-.784,.02,-1.105],[.784,.02,-1.105]],force:1250,max:28},
 // Rear support is an invisible hover pad; only the paired front wheel meshes spin.
 chopper:{radius:1.39,rest:.35,points:[[-.26,.43,1.568],[.26,.43,1.568],[0,.43,-2]],force:4300,max:23},
} as const

function setup(kind:VehicleKind){
  if(!world){
    world=createPhysicsWorld()
    world.addContactMaterial(new ContactMaterial(WARTHOG_HULL,TERRAIN_MATERIAL,{friction:0,restitution:.05,contactEquationStiffness:1e7,contactEquationRelaxation:4}))
  }
  let body=bodies.get(kind)
  if(!body){
    if(wheeled(kind)){body=new Body({mass:VEHICLE_MASS[kind],material:WARTHOG_HULL,linearDamping:.025,angularDamping:.35,allowSleep:false});body.addShape(new Box(kind==='warthog'?WARTHOG_HULL_HALF:new Vec3(...SIZE[kind])),kind==='warthog'?WARTHOG_HULL_LIFT:new Vec3())}
    else body=new Body({mass:VEHICLE_MASS[kind],shape:new Box(new Vec3(...SIZE[kind])),linearDamping:.025,angularDamping:.18,allowSleep:false})
    bodies.set(kind,body)
  }
  if(active!==body){
    if(car){car.removeFromWorld(world);car=undefined}else if(active)world.removeBody(active)
    active=body
    if(wheeled(kind)){
      const gear=runningGear[kind as keyof typeof runningGear]
      car=new RaycastVehicle({chassisBody:body,indexRightAxis:0,indexUpAxis:1,indexForwardAxis:2})
      for(const [x,y,z] of gear.points)car.addWheel({
        radius:gear.radius,chassisConnectionPointLocal:new Vec3(x,y,z),directionLocal:new Vec3(0,-1,0),axleLocal:new Vec3(-1,0,0),
        suspensionRestLength:gear.rest,maxSuspensionTravel:WARTHOG_SUSPENSION.travel,suspensionStiffness:32,dampingCompression:4.4,dampingRelaxation:5.8,
        // Side grip acts near the centre of mass (rollInfluence), so a hard turn leans instead of tripping the hull over.
        // Grip caps near 1.1 g: the tyres let go before the hull can tip, so a hard corner is a drift.
        frictionSlip:1.1,rollInfluence:.08,maxSuspensionForce:VEHICLE_MASS[kind]*GRAVITY*.9,customSlidingRotationalSpeed:-20,useCustomSlidingRotationalSpeed:true,
      })
      const vehicle=car;car.castRay=wheel=>castWheel(vehicle,wheel);car.updateSuspension=()=>updateSprings(vehicle)
      car.addToWorld(world)
    }else world.addBody(body)
  }
  return body
}
const hullPoint=new Vec3(),hullNormal=new Vec3(),hullVelocity=new Vec3(),hullArm=new Vec3()
function hullFriction(b:Body,h:number):void{
  for(const contact of world!.contacts){
    if(contact.bi!==b&&contact.bj!==b)continue
    const load=contact.multiplier;if(load<=0)continue
    if(contact.bi===b){hullArm.copy(contact.ri);hullNormal.copy(contact.ni)}else{hullArm.copy(contact.rj);contact.ni.negate(hullNormal)}
    b.position.vadd(hullArm,hullPoint);b.getVelocityAtWorldPoint(hullPoint,hullVelocity)
    hullVelocity.vsub(hullNormal.scale(hullNormal.dot(hullVelocity),hullNormal),hullVelocity)
    const slip=hullVelocity.length();if(slip<1e-4)continue
    const impulse=Math.min(WARTHOG_HULL_FRICTION*load*h,slip*b.mass*.5)
    b.applyImpulse(hullVelocity.scale(-impulse/slip,hullVelocity),hullArm)
  }
}
function updateSprings(vehicle:RaycastVehicle):void{
  // Preload is for crawling off a rock. At speed a gripping inside wheel low under a tipping
  // hull is a lever that trips it, so the preload fades out as the hull gets moving.
  const preload=WARTHOG_SUSPENSION.preload*clamp(1-vehicle.chassisBody.velocity.length()/6,0,1)
  for(const wheel of vehicle.wheelInfos){
    if(!wheel.isInContact){wheel.suspensionForce=0;continue}
    const compression=wheel.suspensionRestLength-wheel.suspensionLength
    const droop=clamp(-compression/wheel.maxSuspensionTravel,0,1)
    let force=Math.max(compression,0)*wheel.suspensionStiffness*wheel.clippedInvContactDotSuspension+preload*(1-droop)
    force-=(wheel.suspensionRelativeVelocity<0?wheel.dampingCompression:wheel.dampingRelaxation)*wheel.suspensionRelativeVelocity
    wheel.suspensionForce=Math.max(0,force*vehicle.chassisBody.mass)
  }
}
// Tilts, in the wheel's rolling plane, of the rays that stand in for a tyre. A single ray straight
// down never sees the flank of a rock, so the hull hit it first; these find the flank early and
// let the spring lift the wheel over it, the way a big soft tyre rides up an obstacle.
const WHEEL_RAY_TILTS=[0,-.5,.5,-1,1]
const wheelForward=new Vec3(),wheelRay=new Vec3(),wheelTarget=new Vec3(),wheelProbe=new RaycastResult(),wheelVelocity=new Vec3()
function castWheel(vehicle:RaycastVehicle,wheel:WheelInfo):number{
  vehicle.updateWheelTransformWorld(wheel)
  const chassis=vehicle.chassisBody,source=wheel.chassisConnectionPointWorld,result=wheel.raycastResult
  const reach=wheel.suspensionRestLength+wheel.maxSuspensionTravel+wheel.radius
  wheel.axleWorld.cross(wheel.directionWorld,wheelForward)
  result.reset();wheel.isInContact=false
  const oldState=chassis.collisionResponse;chassis.collisionResponse=false
  let depth=Infinity
  for(const tilt of WHEEL_RAY_TILTS){
    const c=Math.cos(tilt),s=Math.sin(tilt)
    wheelRay.set(wheel.directionWorld.x*c+wheelForward.x*s,wheel.directionWorld.y*c+wheelForward.y*s,wheel.directionWorld.z*c+wheelForward.z*s)
    source.vadd(wheelRay.scale(reach,wheelTarget),wheelTarget)
    wheelProbe.reset();vehicle.world!.rayTest(source,wheelTarget,wheelProbe)
    if(!wheelProbe.hasHit)continue
    // Where a tyre-sized sphere sliding down the suspension axis first touches this hit point.
    const lateral=wheelProbe.distance*Math.abs(s)
    if(lateral>=wheel.radius)continue
    const centre=wheelProbe.distance*c-Math.sqrt(wheel.radius*wheel.radius-lateral*lateral)
    if(centre>=depth)continue
    depth=centre
    result.set(wheelProbe.rayFromWorld,wheelProbe.rayToWorld,wheelProbe.hitNormalWorld,wheelProbe.hitPointWorld,wheelProbe.shape!,wheelProbe.body!,centre+wheel.radius)
    result.hasHit=true
  }
  chassis.collisionResponse=oldState
  result.groundObject=0
  if(!result.body){
    wheel.suspensionLength=wheel.suspensionRestLength;wheel.suspensionRelativeVelocity=0
    wheel.directionWorld.scale(-1,result.hitNormalWorld);wheel.clippedInvContactDotSuspension=1
    return -1
  }
  wheel.isInContact=true
  wheel.suspensionLength=clamp(result.distance-wheel.radius,wheel.suspensionRestLength-WARTHOG_SUSPENSION.compression,wheel.suspensionRestLength+wheel.maxSuspensionTravel)
  if(result.distance-wheel.radius>wheel.suspensionRestLength+wheel.maxSuspensionTravel)result.reset()
  const denominator=result.hitNormalWorld.dot(wheel.directionWorld)
  chassis.getVelocityAtWorldPoint(result.hitPointWorld,wheelVelocity)
  const projected=result.hitNormalWorld.dot(wheelVelocity)
  if(denominator>=-.1){wheel.suspensionRelativeVelocity=0;wheel.clippedInvContactDotSuspension=10}
  else{const inv=-1/denominator;wheel.suspensionRelativeVelocity=projected*inv;wheel.clippedInvContactDotSuspension=inv}
  return depth
}
function restore(kind:VehicleKind,s:VehicleState){
  const b=setup(kind)
  if(s.physicsReady){b.quaternion.set(s.qx??0,s.qy??0,s.qz??0,s.qw??1);b.quaternion.normalize();b.velocity.set(s.pvx??0,s.pvy??0,s.pvz??0);b.angularVelocity.set(s.avx??0,s.avy??0,s.avz??0)}
  else{b.quaternion.setFromEuler(-s.pitch,s.yaw+Math.PI,s.roll,'YXZ');b.velocity.set(-Math.sin(s.yaw)*s.speed+s.impulseX,s.vy+s.impulseY,-Math.cos(s.yaw)*s.speed+s.impulseZ);b.angularVelocity.set(s.angularPitch,0,s.angularRoll)}
  const offset=b.quaternion.vmult(new Vec3(0,CENTER[kind],0));b.position.set(s.x+offset.x,s.y+offset.y,s.z+offset.z)
  b.collisionFilterGroup=2
  b.force.setZero();b.torque.setZero();b.aabbNeedsUpdate=true;b.updateInertiaWorld(true);b.wakeUp()
  return b
}
function save(kind:VehicleKind,s:VehicleState,b:Body){
  const q=b.quaternion,offset=q.vmult(new Vec3(0,CENTER[kind],0))
  s.x=b.position.x-offset.x;s.y=b.position.y-offset.y;s.z=b.position.z-offset.z
  s.qx=q.x;s.qy=q.y;s.qz=q.z;s.qw=q.w;s.physicsReady=true
  s.pvx=b.velocity.x;s.pvy=b.velocity.y;s.pvz=b.velocity.z;s.avx=b.angularVelocity.x;s.avy=b.angularVelocity.y;s.avz=b.angularVelocity.z
  const m23=2*(q.y*q.z-q.w*q.x)
  s.pitch=Math.asin(clamp(m23,-1,1));s.yaw=wrap(Math.atan2(2*(q.x*q.z+q.w*q.y),1-2*(q.x*q.x+q.y*q.y))-Math.PI)
  s.roll=Math.atan2(2*(q.x*q.y+q.w*q.z),1-2*(q.x*q.x+q.z*q.z))
  s.speed=-Math.sin(s.yaw)*b.velocity.x-Math.cos(s.yaw)*b.velocity.z;s.vy=b.velocity.y
  s.impulseX=b.velocity.x+Math.sin(s.yaw)*s.speed;s.impulseZ=b.velocity.z+Math.cos(s.yaw)*s.speed;s.impulseY=0
  s.blastPitch=0;s.blastRoll=0;s.angularPitch=0;s.angularRoll=0
  if(wheeled(kind)&&car){s.wheelTravel=car.wheelInfos.map(w=>clamp(w.suspensionRestLength-.07-w.suspensionLength,-WARTHOG_SUSPENSION.travel,.3));s.blastAir=car.wheelInfos.some(w=>w.isInContact)?0:1}
}
function attitude(b:Body,target:Quaternion,rate=5){
  const error=target.mult(b.quaternion.conjugate()),sign=error.w<0?-1:1
  const wanted=new Vec3(error.x*sign*rate,error.y*sign*rate,error.z*sign*rate)
  // Angular acceleration in world coordinates, converted through inertia to torque.
  const acceleration=wanted.vsub(b.angularVelocity);acceleration.scale(5,acceleration)
  const local=b.quaternion.conjugate().vmult(acceleration);local.x*=b.inertia.x;local.y*=b.inertia.y;local.z*=b.inertia.z
  b.torque.vadd(b.quaternion.vmult(local),b.torque)
}
function keepWarthogUpright(b:Body):void {
  const worldUp=new Vec3(0,1,0),up=b.quaternion.vmult(worldUp)
  // Cross product is the shortest rotation back to level. Keep the correction soft enough
  // to let ramps launch the chassis, then damp local pitch/roll so a landing settles upright.
  const error=up.cross(worldUp)
  b.torque.vadd(error.scale(b.mass*GRAVITY*.5),b.torque)
  // On its roof or its side and slowed down, a steady roll the short way round rights it. The
  // torque has to lift the hull's weight over its own edge (mass·g·half width), so it is strong
  // but constant, never an angular velocity kick that would launch the wreck. At exactly
  // upside-down the short way is undefined, so roll about the long axis.
  if(up.y<.3&&b.velocity.length()<6){
    const axis=error.length()>.1?error.unit():b.quaternion.vmult(new Vec3(0,0,1))
    b.torque.vadd(axis.scale(b.mass*GRAVITY*1.5),b.torque)
  }
  const local=b.quaternion.conjugate().vmult(b.angularVelocity)
  const damping=new Vec3(-local.x*b.mass*1.5,0,-local.z*b.mass*1.5)
  b.torque.vadd(b.quaternion.vmult(damping),b.torque)
}
function hover(b:Body,s:VehicleState,input:VehicleInput){
  // Empty Ghosts have no antigravity or attitude motor. Their hull rests through contacts.
  s.maneuverCooldown=Math.max(0,s.maneuverCooldown-VEHICLE_STEP)
  s.maneuver=Math.max(0,s.maneuver-VEHICLE_STEP)
  if(!input.jump){s.maneuverHeld=0;s.maneuver=0}
  if(input.coast)return
  // Space is a short booster, rather than a second throttle. The cooldown makes a held
  // key produce one discrete burst and keeps prediction/server behavior identical.
  if(input.jump&&s.maneuverHeld===0&&s.maneuverCooldown<=0){s.maneuver=.75;s.maneuverCooldown=.95;s.maneuverHeld=1}
  const up=b.quaternion.vmult(new Vec3(0,1,0)),ray=new RaycastResult()
  const forward=b.quaternion.vmult(new Vec3(0,0,1)),right=b.quaternion.vmult(new Vec3(-1,0,0))
  const travel=forward.scale(input.forward).vadd(right.scale(input.strafe))
  if(travel.lengthSquared()>.01)travel.normalize()
  const lookAhead=clamp(Math.hypot(b.velocity.x,b.velocity.z)*.32+1.2,1.2,6)
  let obstacleRise=0, clearanceFloor=-Infinity
  const pads:{offset:Vec3;point:Vec3;floor:number}[]=[]
  for(const [x,z] of [[-1.5,2.1],[1.5,2.1],[-1.5,-2.1],[1.5,-2.1]]){
    const offset=b.quaternion.vmult(new Vec3(x,0,z)),point=b.position.vadd(offset)
    let floor=-Infinity
    // Probe actual collider tops beneath the nose/tail and along the requested travel.
    for(const distance of [0,lookAhead*.5,lookAhead]){
      const probe=point.vadd(travel.scale(distance))
      ray.reset();world!.raycastClosest(probe.vadd(new Vec3(0,distance===0?.35:1.2,0)),probe.vadd(new Vec3(0,-7,0)),{skipBackfaces:true,collisionFilterMask:1},ray)
      if(ray.hasHit&&ray.body!==b)floor=Math.max(floor,ray.hitPointWorld.y)
    }
    pads.push({offset,point,floor});clearanceFloor=Math.max(clearanceFloor,floor)
  }
  for(const {offset,point} of pads){
    if(Number.isFinite(clearanceFloor)){
      const error=clearanceFloor+1.15-point.y,velocity=b.getVelocityAtWorldPoint(point,new Vec3())
      obstacleRise=Math.max(obstacleRise,error)
      const force=clamp(error*b.mass*12-velocity.y*b.mass*2.8+b.mass*GRAVITY/4,0,b.mass*GRAVITY)
      b.applyForce(new Vec3(0,force,0),offset)
    }
  }
  if(up.y>.1){const target=new Quaternion();target.setFromEuler(0,input.yaw+Math.PI,-input.strafe*.08,'YXZ');attitude(b,target,5)}
  // Lift before pushing the nose into an uphill face; resumes forward or reverse smoothly.
  const clearance=clamp(1-obstacleRise/1.8,.08,1)
  const thrustSpeed=s.maneuver>0?36:19
  const boostDirection=input.forward===0?1:input.forward
  const boost=s.maneuver>0?boostDirection*18:0
  const target=forward.scale((input.forward*thrustSpeed+boost)*clearance).vadd(right.scale(input.strafe*8*clearance))
  b.applyForce(new Vec3((target.x-b.velocity.x)*b.mass*1.5,0,(target.z-b.velocity.z)*b.mass*1.5))
}

function flight(b:Body,s:VehicleState,input:VehicleInput,h:number){
  s.maneuverCooldown=Math.max(0,s.maneuverCooldown-h);s.maneuver=Math.max(0,s.maneuver-h)
  const request=input.coast?0:input.jump&&Math.abs(input.forward)>.5?Math.sign(input.forward)*2:input.brake&&Math.abs(input.strafe)>.5?Math.sign(input.strafe):0
  if(request&&request!==s.maneuverHeld&&s.maneuverCooldown===0){s.maneuver=.9;s.maneuverCooldown=1.15;s.maneuverSide=request}
  s.maneuverHeld=request
  if(input.coast)return
  const target=new Quaternion(),turn=wrap(input.yaw-s.yaw)
  target.setFromEuler(-clamp(input.pitch,-1.2,1.2),input.yaw+Math.PI,clamp(turn*.45,-.5,.5),'YXZ')
  if(s.maneuver>0){const axis=b.quaternion.vmult(Math.abs(s.maneuverSide)===2?new Vec3(Math.sign(s.maneuverSide),0,0):new Vec3(0,0,Math.sign(s.maneuverSide)));const wanted=axis.scale(Math.PI*2/.9);const delta=wanted.vsub(b.angularVelocity);const local=b.quaternion.conjugate().vmult(delta.scale(10));local.x*=b.inertia.x;local.y*=b.inertia.y;local.z*=b.inertia.z;b.torque.vadd(b.quaternion.vmult(local),b.torque)}else attitude(b,target)
  const speed=input.brake&&input.forward>0?42:input.forward>0?29:input.forward<0?8:17
  // Lift/thrust are forces: impacts can deflect flight and gravity resumes after exit.
  const desired=new Vec3(-Math.sin(input.yaw)*Math.cos(input.pitch)*speed,Math.sin(input.pitch)*speed,-Math.cos(input.yaw)*Math.cos(input.pitch)*speed)
  b.applyForce(new Vec3((desired.x-b.velocity.x)*b.mass*1.2,((desired.y-b.velocity.y)*1.2+GRAVITY)*b.mass,(desired.z-b.velocity.z)*b.mass*1.2))
}
function restPose(s:VehicleState):number[]{
  return [s.x,s.y,s.z,s.qx??0,s.qy??0,s.qz??0,s.qw??1,s.pvx??0,s.pvy??0,s.pvz??0,s.avx??0,s.avy??0,s.avz??0,s.blastAir,s.yaw,s.pitch,s.roll,s.speed,s.vy,s.impulseX,s.impulseY,s.impulseZ]
}
function consumeRestSteps(s:VehicleState):void{
  while(s.physicsRemainder!+1e-9>=VEHICLE_STEP){
    s.physicsRemainder=Math.max(0,s.physicsRemainder!-VEHICLE_STEP)
    s.impactSpeed*=Math.exp(-8*VEHICLE_STEP)
    s.steering*=Math.exp(-8*VEHICLE_STEP)
  }
}
/** Most wheel lock (radians) the physics allows at this speed; the rendered wheels scale `steering` against it. */
export function steeringLimit(kind:VehicleKind,speed:number):number{return(kind==='chopper'?.42:.5)/(1+Math.abs(speed)*.025)}
export function stepRigidVehicle(kind:VehicleKind,s:VehicleState,input:VehicleInput,dt:number){
  if(!Number.isFinite(dt)||dt<=0)return
  s.physicsRemainder=(s.physicsRemainder??0)+Math.min(dt,.25)
  if(s.physicsRemainder+1e-9<VEHICLE_STEP)return
  if(s.physicsRestPose){
    const pose=restPose(s)
    if(input.coast&&s.physicsReady&&s.physicsRestPose.every((v,i)=>v===pose[i])){
      // Scenery is stationary. A supported, settled hull stays asleep until an input,
      // snapshot correction, blast or vehicle contact changes its serialized state.
      consumeRestSteps(s)
      return
    }
    s.physicsRestPose=undefined;s.physicsQuietSteps=0
  }
  if(!input.coast)s.physicsQuietSteps=0
  const b=restore(kind,s)
  for(;s.physicsRemainder+1e-9>=VEHICLE_STEP;){const h=VEHICLE_STEP;s.physicsRemainder=Math.max(0,s.physicsRemainder-h)
    const before=b.velocity.clone();s.impactSpeed*=Math.exp(-8*h)
    if(wheeled(kind)&&car){
      // Reduce wheel lock at speed, retaining a tighter turning circle while crawling.
      const limit=steeringLimit(kind,s.speed)
      // Halo steers the nose toward the camera in either gear. Backing up turns a real car the
      // other way for the same wheel angle, so reverse flips the wheels; without it the nose
      // swung away from the camera and the hull ended up sideways.
      const reversing=s.speed<-.5?input.forward<=0:input.forward<0&&s.speed<.5
      const delta=wrap(input.yaw-s.yaw)*(reversing?-1:1),target=input.coast?0:clamp(delta,-limit,limit)
      s.steering+=(target-s.steering)*(1-Math.exp(-(kind==='chopper'?5:8)*h))
      // Engage only for a genuinely parked hull. A moving, unoccupied Warthog must still
      // coast through a hill or after an explosion instead of snapping to a stop.
      const parkingBrake=input.coast&&Math.abs(s.speed)<.05&&Math.hypot(b.velocity.x,b.velocity.z)<.05
      const gear=runningGear[kind as keyof typeof runningGear]
      if(kind==='chopper'){
        s.maneuver=Math.max(0,s.maneuver-h);s.maneuverCooldown=Math.max(0,s.maneuverCooldown-h)
        if(input.jump&&!s.maneuverHeld&&!input.coast&&s.maneuverCooldown<=0){s.maneuver=.8;s.maneuverCooldown=2.2}
        s.maneuverHeld=input.jump?1:0
      }
      const boosting=kind==='chopper'&&s.maneuver>0
      for(let i=0;i<car.wheelInfos.length;i++){car.setSteeringValue(i<2?s.steering:0,i);car.applyEngineForce(input.coast?0:-input.forward*gear.force*(boosting?2.4:1)*(Math.abs(s.speed)>(boosting?36:gear.max)?0:1),i);car.setBrake(input.brake?180:parkingBrake?220:0,i)}
      const upY=b.quaternion.vmult(new Vec3(0,1,0)).y
      const nearGround=b.position.y-bloodGulchFloor(b.position.x,b.position.z)<2.5
      // The solver is reused across vehicles/replays; wheel contact flags belong to the
      // last simulated body. Read the serialized support state for this vehicle instead.
      if(s.blastAir===0||(upY<.25&&nearGround))keepWarthogUpright(b)
    }else if(kind==='ghost')hover(b,s,input);else flight(b,s,input,h)
    const parkWarthog=wheeled(kind)&&input.coast&&Math.abs(s.speed)<.05&&Math.hypot(b.velocity.x,b.velocity.z)<.05&&s.blastAir===0
    const parkPosition=parkWarthog?b.position.clone():null
    const parkState=parkWarthog?{x:s.x,z:s.z}:null
    // Dynamic hulls never hit their own downward suspension/hover rays.
    b.collisionFilterGroup=2
    world!.step(h)
    if(wheeled(kind))hullFriction(b,h)
    // Wheel brakes alone cannot hold a zero-input vehicle on a sloped heightfield: the
    // chassis contact can still acquire a small sideways velocity every tick. Lock only a
    // genuinely stationary, non-blasted hull; moving/coasting vehicles retain momentum.
    if(parkWarthog){
      b.position.x=parkPosition!.x;b.position.z=parkPosition!.z
      b.velocity.x=0;b.velocity.z=0;b.angularVelocity.x=0;b.angularVelocity.y=0;b.angularVelocity.z=0
    }
    const impact=b.velocity.vsub(before).length()
    if(world!.contacts.some(c=>c.bi===b||c.bj===b)&&impact>2){s.impactSeq=(s.impactSeq+1)&255;s.impactSpeed=Math.max(s.impactSpeed,impact)}
    save(kind,s,b)
    if(parkState){s.x=parkState.x;s.z=parkState.z;s.speed=0;s.pvx=0;s.pvz=0;s.impulseX=0;s.impulseZ=0}
    const supported=(wheeled(kind)&&car?.wheelInfos.some(w=>w.isInContact))||world!.contacts.some(c=>
      (c.bi===b&&c.ni.y<-.35)||(c.bj===b&&c.ni.y>.35))
    const quiet=input.coast&&supported&&b.velocity.lengthSquared()<.0025&&b.angularVelocity.lengthSquared()<.0025
    s.physicsQuietSteps=quiet?(s.physicsQuietSteps??0)+1:0
    if(s.physicsQuietSteps>=60){
      b.velocity.setZero();b.angularVelocity.setZero();save(kind,s,b)
      s.physicsRestPose=restPose(s)
      // Consume any remaining fixed steps through the same sleeping path.
      consumeRestSteps(s)
      break
    }
  }
}
export function blastRigidVehicle(kind:VehicleKind,s:VehicleState,point:{x:number;y:number;z:number},radius:number,strength:number){
  const b=restore(kind,s),local=b.pointToLocalFrame(new Vec3(point.x,point.y,point.z)),ext=SIZE[kind]
  // Pressure hits the exposed hull surface. Its lever arm produces angular momentum.
  local.x=clamp(local.x,-ext[0],ext[0]);local.y=clamp(local.y,-ext[1],ext[1]);local.z=clamp(local.z,-ext[2],ext[2])
  const hit=b.pointToWorldFrame(local),delta=blastImpulse(hit,point,radius,strength)
  if(!delta.x&&!delta.y&&!delta.z)return false
  b.applyImpulse(new Vec3(delta.x*180,delta.y*180,delta.z*180),hit.vsub(b.position));b.wakeUp();save(kind,s,b);s.blastAir=1;return true
}

/** A close melee strike transfers a short, off-centre impulse to a vehicle hull. */
export function meleeRigidVehicle(kind:VehicleKind,s:VehicleState,point:{x:number;y:number;z:number},direction:{x:number;y:number;z:number},strength=1100):boolean{
  const b=restore(kind,s),local=b.pointToLocalFrame(new Vec3(point.x,point.y,point.z)),ext=SIZE[kind]
  local.x=clamp(local.x,-ext[0],ext[0]);local.y=clamp(local.y,-ext[1],ext[1]);local.z=clamp(local.z,-ext[2],ext[2])
  const hit=b.pointToWorldFrame(local),dir=new Vec3(direction.x,direction.y,direction.z)
  if(dir.lengthSquared()<1e-6)return false
  dir.normalize();b.applyImpulse(dir.scale(strength),hit.vsub(b.position));b.wakeUp();save(kind,s,b);s.blastAir=1;return true
}

/** Inelastic hull/capsule impact, applied before lethal damage so the corpse inherits momentum. */
export function vehicleCharacterImpulse(kind:VehicleKind,s:VehicleState,target:{x:number;y:number;z:number;vx:number;vy:number;vz:number;onGround:boolean}){
  const b=restore(kind,s),point=new Vec3(target.x,target.y+.9,target.z),velocity=b.getVelocityAtWorldPoint(point,new Vec3())
  const relative=velocity.vsub(new Vec3(target.vx,target.vy,target.vz)),speed=relative.length()
  if(speed<.1)return
  // The swept hit establishes contact. Resolve along the closing velocity and exchange J.
  const normal=relative.scale(1/speed),arm=point.vsub(b.position),cross=arm.cross(normal)
  const rotational=b.invInertiaWorld.vmult(cross).cross(arm).dot(normal)
  const magnitude=speed/(1/180+b.invMass+Math.max(0,rotational))
  const impulse=normal.scale(magnitude)
  target.vx+=impulse.x/180;target.vy+=impulse.y/180;target.vz+=impulse.z/180
  if(target.vy>.1)target.onGround=false
  b.applyImpulse(impulse.scale(-1),arm);save(kind,s,b)
}
