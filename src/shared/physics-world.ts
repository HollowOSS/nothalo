import {addBloodGulchPhysics} from './blood-gulch-physics.ts'
import {isArena} from './arena.ts'
import {addArenaPhysicsSolids} from './arena-physics.ts'
import { addGuardianPhysicsSolids } from './guardian-physics.ts'
import {addLockoutPhysicsSolids} from './lockout-physics.ts'
import type { MapId } from './guardian.ts'
import {World,Body,Vec3,Box,ConvexPolyhedron,Heightfield,GSSolver,Material,ContactMaterial} from 'cannon-es'
import { DynamicBroadphase } from './dynamic-broadphase.ts'
import {groundHeight,rimFraction,FLOOR_HALF_X,FLOOR_HALF_Z} from './field.ts'
import {FORMATIONS,scatterBoulders} from './cover.ts'
import {BASE_GEOMETRY as B} from './base-collision.ts'
import {RED_BASE,BLUE_BASE,BASE_RADIUS,BASE_DECK_HEIGHT} from './map.ts'

export const PHYSICS_STEP=1/120
export const GRAVITY=16
/** Every static collider carries this, so vehicle hulls can pair a slippery contact with it. */
export const TERRAIN_MATERIAL=new Material('terrain')
// A rock is a squashed blob in the renderer and a flat-topped circle for the on-foot capsule.
// Vehicles and corpses get the blob: a convex solid of revolution with a rounded flank, so a
// wheel meeting it is lifted and a hull resting on it slides off, instead of the vertical
// cylinder wall that beached the Warthog. Profile is (radius, height) fractions of the rock's
// plan radius and height above the ground it stands on, bottom ring buried.
const ROCK_PROFILE:readonly (readonly [number,number])[]=[[.55,-.3],[1,.3],[.9,.65],[.62,.88],[.28,1]]
const ROCK_SEGMENTS=8
function rockShape(r:number,h:number):ConvexPolyhedron{
  const vertices:Vec3[]=[],faces:number[][]=[],rings=ROCK_PROFILE.length,n=ROCK_SEGMENTS
  for(const [fr,fy] of ROCK_PROFILE)for(let i=0;i<n;i++){
    const theta=Math.PI*2/n*(i+1)
    vertices.push(new Vec3(-r*fr*Math.sin(theta),h*(fy-.5),r*fr*Math.cos(theta)))
  }
  // Same winding as cannon's Cylinder: side quads between rings, bottom cap, reversed top cap.
  for(let k=0;k<rings-1;k++)for(let i=0;i<n;i++){
    const j=(i+1)%n,lower=k*n,upper=(k+1)*n
    faces.push([lower+i,upper+i,upper+j,lower+j])
  }
  faces.push(Array.from({length:n},(_,i)=>i))
  faces.push(Array.from({length:n},(_,i)=>rings*n-1-i))
  return new ConvexPolyhedron({vertices,faces})
}
// Collision geometry is shared by browser prediction, authority and cosmetic bodies.
// Two metre terrain cells bound solver cost; rocks and concrete remain separate colliders.
const CELL=2
let terrain:number[][]|undefined
function terrainData(){
  if(!terrain){terrain=[];for(let i=0;i<=Math.ceil(2*FLOOR_HALF_Z/CELL);i++){
    const row:number[]=[];for(let j=0;j<=Math.ceil(2*FLOOR_HALF_X/CELL);j++){
      const x=-FLOOR_HALF_X+j*CELL,z=-FLOOR_HALF_Z+i*CELL
      row.push(groundHeight(x,z)+Math.max(0,Math.min(1,(rimFraction(x,z)-.97)/.09))*65)
    }terrain.push(row)
  }}return terrain
}
export function createPhysicsWorld(map:MapId='blood-gulch'):World{
  const world=new World({gravity:new Vec3(0,-GRAVITY,0),allowSleep:true})
  world.broadphase=new DynamicBroadphase(world)
  world.broadphase.useBoundingBoxes=true
  ;(world.solver as GSSolver).iterations=12
  ;(world.solver as GSSolver).tolerance=.001
  world.defaultContactMaterial.friction=.55
  world.defaultContactMaterial.restitution=.08
  world.defaultContactMaterial.contactEquationStiffness=1e7
  world.defaultContactMaterial.contactEquationRelaxation=4
  const surface=TERRAIN_MATERIAL
  world.addContactMaterial(new ContactMaterial(surface,surface,{friction:.6,restitution:.08}))
  if(map==='blood-gulch'){addBloodGulchPhysics(world,surface);return world}
  if(isArena(map)){addArenaPhysicsSolids(world,surface,map);return world}
  if(map==='guardian'){addGuardianPhysicsSolids(world,surface);return world}
  if(map==='lockout'){addLockoutPhysicsSolids(world,surface);return world}
  const floor=new Body({mass:0,material:surface,shape:new Heightfield(terrainData(),{elementSize:CELL})})
  // Local heightfield X maps to world Z; local Y maps to world X. This preserves
  // the rendered a-c-b / b-c-d triangle diagonal instead of mirroring it along Z.
  floor.position.set(-FLOOR_HALF_X,0,-FLOOR_HALF_Z)
  floor.quaternion.setFromAxisAngle(new Vec3(1,1,1).unit(),-Math.PI*2/3)
  world.addBody(floor)
  function rock(x:number,z:number,r:number,h:number,y=groundHeight(x,z)){
    if(h<.5)return
    const body=new Body({mass:0,material:surface,shape:rockShape(r,h),position:new Vec3(x,y+h/2,z)})
    world.addBody(body)
  }
  for(const f of FORMATIONS)rock(f.x,f.z,f.r,f.h)
  for(const group of scatterBoulders())for(const b of group)rock(b.x,b.z,b.sc*.82,b.sc*(.28+.62*b.sy),b.y)
  function box(x:number,y:number,z:number,hx:number,hy:number,hz:number,yaw=0,pitch=0){
    const b=new Body({mass:0,material:surface,shape:new Box(new Vec3(hx,hy,hz)),position:new Vec3(x,y,z)})
    b.quaternion.setFromEuler(pitch,yaw,0,'YXZ');world.addBody(b)
  }
  for(const site of [RED_BASE,BLUE_BASE]){
    // Faceted outer shell; door gaps stay open. Roof strips leave the centre hatch open.
    for(let i=0;i<B.facets;i++){
      const a=i*Math.PI*2/B.facets+(site===BLUE_BASE?Math.PI:0),r=BASE_RADIUS-1
      const half=BASE_RADIUS*Math.tan(Math.PI/B.facets),sa=Math.sin(a),ca=Math.cos(a)
      if(B.doorFacets.includes(i)){
        const side=(half-B.doorWidth/2)/2
        for(const sign of [-1,1])box(site.x+sa*r+ca*sign*(B.doorWidth/2+side),2,site.z+ca*r-sa*sign*(B.doorWidth/2+side),side,2,.4,a)
        box(site.x+sa*r,(B.doorTop+BASE_DECK_HEIGHT)/2,site.z+ca*r,half,(BASE_DECK_HEIGHT-B.doorTop)/2,.4,a)
      }else box(site.x+sa*r,2,site.z+ca*r,half,2,.4,a)
      box(site.x+sa*9,BASE_DECK_HEIGHT-.15,site.z+ca*9,half,.15,3.5,a)
    }
    for(const facet of B.rampFacets){
      const a=facet*Math.PI*2/B.facets+(site===BLUE_BASE?Math.PI:0),r=B.rampNear+B.rampRun/2
      box(site.x+Math.sin(a)*r,BASE_DECK_HEIGHT/2-.15,site.z+Math.cos(a)*r,B.rampHalfWidth,.18,Math.hypot(B.rampRun,BASE_DECK_HEIGHT)/2,a,Math.atan2(BASE_DECK_HEIGHT,B.rampRun))
    }
  }
  return world
}
