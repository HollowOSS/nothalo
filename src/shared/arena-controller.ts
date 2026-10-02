import type {PlayerState} from './movement.ts'
import type {MeshCollision} from './guardian-collision.ts'
import {MOVE,GRAVITY} from './constants.ts'
import {applyArenaLift} from './arena-lifts.ts'
import {applyValhallaLift} from './valhalla-lifts.ts'
/** Source stair trim rises 40.8 cm; a 42 cm step clears it without auto-climbing cover. */
export const ARENA_STEP=.42
const WALKABLE_NORMAL_Y=Math.cos(50*Math.PI/180)
/** The runtime and nav baker both execute this controller against explicit geometry. */
/** Narrows' paired grille pads. Their flight keeps the same horizontal momentum as Guardian. */
export const NARROWS_CANNONS=[
  {x:20.313,y:4.35,z:-46.0,vx:0,vy:GRAVITY*1.6,vz:92/3.2},
  {x:20.313,y:4.35,z:46.0,vx:0,vy:GRAVITY*1.6,vz:-92/3.2},
] as const
export function moveArenaPlayer(s:PlayerState,dt:number,collision:MeshCollision,bounds:readonly number[]):PlayerState {
  const map=s.map,height=MOVE.playerHeight*(s.crouched?.62:1)
  // Launch before moving, so a Valhalla pad's first tick of flight is not lost and its arc
  // lands on target at every tick rate. (The call after moving catches arrivals this tick.)
  applyValhallaLift(s)
  // Sweep all three axes together: a cannon rider rises while crossing its sloped grille.
  const count=Math.max(1,Math.ceil(Math.max(Math.abs(s.vx*dt),Math.abs(s.vy*dt),Math.abs(s.vz*dt))/.12)),tick=dt/count
  // The body's core: a thin column from just above the feet to the head. Horizontal moves test
  // the whole body, but a fall is swept along its centre line alone, and that line can drop
  // between the two faces of a thin wall after sliding off its knife-edge top. A fall that would
  // take the core into geometry is undone, and the body stands where it was.
  const core=(x:number,y:number,z:number)=>collision.blocked(x,z,y,height,.1,.1)
  const coreEnters=(oldX:number,oldY:number,oldZ:number)=>core(s.x,s.y,s.z)&&!core(oldX,oldY,oldZ)
  const stand=(x:number,y:number,z:number)=>{s.x=x;s.y=y;s.z=z;s.vx=0;s.vy=0;s.vz=0;s.onGround=true}
  for(let i=0;i<count;i++){
    const oldX=s.x,oldY=s.y,oldZ=s.z
    let y=oldY+s.vy*tick
    // blocked() leaves a 20 mm skin at the head. A reachable overlap inside that
    // skin must still meet the upward sweep (plus 1 mm numerical margin).
    if(s.vy>0){const ceiling=collision.ceiling(s.x,s.z,oldY+height-.021,y+height);if(ceiling!==null){y=Math.min(y,ceiling-height);s.vy=0}}
    const grounded=s.onGround&&s.vy<=0
    // Depenetrate first. A body left overlapping the mesh (it stepped off an edge beside a rock,
    // or slid down a steep face into it) has every move from inside rejected and hangs there.
    // Push it back out along the contacts, a few centimetres per substep: gentle enough that a
    // body sliding down a steep face drifts off it at a walking pace instead of being thrown.
    const out=collision.contactNormal(s.x,s.z,s.y,height,.25,grounded?ARENA_STEP:0)
    if(out&&grounded){
      const push=Math.min(.04,out[2]+.005),px=s.x+out[0]*push,pz=s.z+out[1]*push
      // Never push out of the arena, or through the far side of a narrow gap.
      if(px>=bounds[0]&&px<=bounds[1]&&pz>=bounds[2]&&pz<=bounds[3]&&
        ![.5,1.1,height-.05].some(h=>collision.ray(s.x,s.y+h,s.z,px,s.y+h,pz))){s.x=px;s.z=pz}
    }
    let supportY=grounded?oldY:y,lastFeet=supportY
    const moveAxis=(x:number,z:number)=>{
      const support=collision.supportedFloor(x,z,supportY,ARENA_STEP,.2)
      // A supported descent follows its floor before testing head clearance. Keeping
      // the old, higher feet wrongly blocked ramps beneath low beams.
      const followsSupport=grounded&&Math.abs(support-supportY)<=ARENA_STEP
      const feet=followsSupport?support:supportY
      lastFeet=feet
      // Step-height exclusion belongs to grounded walking. An airborne capsule
      // must not slide its feet through the raised edge of a ramp or platform.
      // For the first moment of a launch (cooldown is set to 4 s at launch) the rider clears its
      // own recessed pad: the launch arc is computed for an unobstructed flight.
      const launching=!grounded&&(s.liftCooldown??0)>3.8
      // The step-up allowance is for stepping onto a floor. With no standable floor there (a
      // rock face too steep to stand on), the move is tested like a jump: taking the step over
      // it anyway left the feet up to a step below the rock's surface, and they fell through it.
      if(x<bounds[0]||x>bounds[1]||z<bounds[2]||z>bounds[3]||(!launching&&collision.blocked(x,z,feet,height,.25,followsSupport?ARENA_STEP:0)))return false
      if(followsSupport)supportY=support
      return true
    }
    const x=s.x+s.vx*tick,z=s.z+s.vz*tick
    // A rising body that meets a lip keeps its forward speed and carries on once it clears it:
    // a cannon rider starts in a recessed pad and has no input to re-apply that speed.
    const rising=!grounded&&s.vy>0
    // Collide and slide: a blocked move keeps the part of itself that runs along the face it
    // met. Moving each axis alone only slid along walls square to the world axes, so a glancing
    // run into a rock stopped dead. A second pass follows the crease between two faces.
    const slide=(mx:number,mz:number)=>{
      for(let pass=0;pass<2;pass++){
        const normal=collision.contactNormal(s.x+mx,s.z+mz,lastFeet,height,.25,grounded?ARENA_STEP:0,mx,mz)
        if(!normal)return false
        const [nx,nz]=normal,into=mx*nx+mz*nz
        if(into>=0)return false
        mx-=nx*into;mz-=nz*into
        if(mx*mx+mz*mz<1e-10)return false
        if(!rising){const v=s.vx*nx+s.vz*nz;if(v<0){s.vx-=nx*v;s.vz-=nz*v}}
        if(moveAxis(s.x+mx,s.z+mz)){s.x+=mx;s.z+=mz;return true}
      }
      return false
    }
    if(moveAxis(x,z)){s.x=x;s.z=z}
    else if(!slide(x-s.x,z-s.z)){
      if(moveAxis(x,s.z))s.x=x;else if(!rising)s.vx=0
      if(moveAxis(s.x,z))s.z=z;else if(!rising)s.vz=0
    }
    // A downward ray at the new x/z can start UNDER an ascending ramp, even when
    // the feet were above it at the old x/z. Sweep the actual airborne foot motion
    // first. Stop at the contact (without extending its plane past the ramp edge);
    // subsequent substeps continue grounded with the usual step/slope support.
    if(!grounded){
      const dx=s.x-oldX,dy=y-oldY,dz=s.z-oldZ
      // A fall is swept from a little above the feet. Feet can rest a millimetre inside a face
      // (support extends a neighbouring floor's plane across the footprint), and a sweep from
      // there starts under the face and drops straight through it: rock tops are hollow shells
      // over holes in the terrain, so that fall never ends.
      const lift=dy<0?.06:0,ey=dy-lift,length=Math.hypot(dx,ey,dz)
      if(length>1e-7){
        const mesh=collision.mesh,normals=mesh.normals
        // Walkable faces land the feet; steeper faces (slanted walls and roofs) are slid down.
        // Only walkable faces used to count, so a falling player beside a steep face passed
        // straight through it into the building below. Ceilings stay with the upward sweep.
        const hit=mesh.raycast(oldX,oldY+lift,oldZ,dx/length,ey/length,dz/length,length,t=>{
          const nx=normals[t*3],ny=normals[t*3+1],nz=normals[t*3+2]
          // Steep faces only stop a fall: a rider launched up and out of a sloped grille keeps going.
          return (ny>=WALKABLE_NORMAL_Y||(dy<0&&ny>-WALKABLE_NORMAL_Y))&&nx*dx+ny*ey+nz*dz<0
        })
        if(hit){
          const fraction=hit.t/length,t=hit.triangle
          const nx=normals[t*3],ny=normals[t*3+1],nz=normals[t*3+2]
          if(ny>=WALKABLE_NORMAL_Y){
            s.x=oldX+dx*fraction;s.z=oldZ+dz*fraction;s.y=oldY+lift+ey*fraction
            s.vy=0;s.onGround=true
            continue
          }
          // Stop just off the face and keep only the velocity along it: a slide. Never higher
          // than the feet were: the lifted start must not carry the body up a face.
          const back=Math.min(fraction,Math.max(0,(hit.t-.02)/length))
          s.x=oldX+dx*back;s.z=oldZ+dz*back;s.y=Math.min(oldY,oldY+lift+ey*back)
          const into=s.vx*nx+s.vy*ny+s.vz*nz
          if(into<0){s.vx-=nx*into;s.vy-=ny*into;s.vz-=nz*into}
          // Resting in a crevice between steep faces, where nothing is floor: stand on it, so
          // the player can still jump or step out rather than hang there.
          const wedged=dy<0&&oldY-s.y<.005
          if(wedged){s.vy=0;s.onGround=true}else s.onGround=false
          if(dy<0&&coreEnters(oldX,oldY,oldZ))stand(oldX,oldY,oldZ)
          continue
        }
      }
    }
    const floor=collision.supportedFloor(s.x,s.z,grounded?supportY:Math.max(oldY,y),grounded?ARENA_STEP:0,.2)
    // A grounded step down follows stairs and slopes, never down through a face in between
    // (a body standing wedged on a steep rock would otherwise drop through it to the ground).
    const stepsDown=grounded&&oldY-floor<=ARENA_STEP&&!(floor<y-.01&&collision.ray(s.x,y,s.z,s.x,floor+.01,s.z))
    if(s.vy<=0&&(y<=floor||stepsDown)){y=floor;s.vy=0;s.onGround=true}else s.onGround=false
    s.y=y
    if(!grounded&&y<oldY&&coreEnters(oldX,oldY,oldZ))stand(oldX,oldY,oldZ)
  }
  if(s.y < -20)s.fallDamage=1000
  s.liftCooldown=Math.max(0,(s.liftCooldown??0)-dt)
  if(map==='narrows'&&!s.liftCooldown){
    const cannon=NARROWS_CANNONS.find(c=>Math.hypot(s.x-c.x,s.z-c.z)<1.6&&Math.abs(s.y-c.y)<1.5)
    if(cannon){s.vx=cannon.vx;s.vy=cannon.vy;s.vz=cannon.vz;s.onGround=false;s.liftCooldown=4}
  }
  applyArenaLift(s)
  applyValhallaLift(s)
  return s
}
