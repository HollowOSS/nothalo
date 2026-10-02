import {Body,Box,Vec3,type Material,type World} from 'cannon-es'
import {LOCKOUT_BOUNDS as B,lockoutScale} from './lockout-transform.ts'
import {LOCKOUT_VOID_FLOOR} from './lockout-collision.ts'
import {lockoutFloor} from './lockout.ts'

/**
 * Static floors for cosmetic rigid bodies (corpses, dropped props) on Lockout. cannon-es has
 * no box-versus-trimesh narrowphase, so the collision mesh movement uses is sampled on a
 * one-metre grid and same-height runs are merged into thin boxes, the way Guardian's nav build
 * does for its slabs. Derived from the same floor data as `lockoutFloor`, so a rescaled or
 * re-exported mesh can never leave the physics proxies behind at stale heights. Open drops stay
 * open: there is no ground plane, so a body over the pit keeps falling.
 */
const CELL=1
const SLAB_THICKNESS=.4
/** Decks closer than this are one surface: trim plates sit a few centimetres above their deck. */
const LEVEL_STEP=.3

let cached:number[][]|undefined
/** [x, y, z, width, depth] per slab; x/z are centres and y is the walking surface. */
export function lockoutPhysicsSlabs():readonly number[][] {
  if(cached)return cached
  const scale=lockoutScale(),LOCKOUT_BOUNDS={x0:B.x0*scale,x1:B.x1*scale,z0:B.z0*scale,z1:B.z1*scale}
  const cols=Math.round((LOCKOUT_BOUNDS.x1-LOCKOUT_BOUNDS.x0)/CELL),rows=Math.round((LOCKOUT_BOUNDS.z1-LOCKOUT_BOUNDS.z0)/CELL)
  // Every distinct floor height under each cell centre, top down, indexed by cell and level so
  // the merge below never has to scan the whole table.
  const levelOf=(y:number)=>Math.round(y/LEVEL_STEP)
  const cell=new Map<number,Map<number,number>>() // cellIndex → level → exact height
  const at=(i:number,k:number)=>cell.get(i*rows+k)
  for(let i=0;i<cols;i++)for(let k=0;k<rows;k++){
    const x=LOCKOUT_BOUNDS.x0+(i+.5)*CELL,z=LOCKOUT_BOUNDS.z0+(k+.5)*CELL
    let ceiling=200,last=Infinity
    // Each step lands at least a centimetre lower, so a column ends after finitely many surfaces.
    for(let guard=0;guard<64;guard++){
      const floor=lockoutFloor(x,z,ceiling,0)
      if(floor<=LOCKOUT_VOID_FLOOR*scale||floor>=ceiling+.006)break
      if(floor<last-LEVEL_STEP){let levels=cell.get(i*rows+k);if(!levels)cell.set(i*rows+k,levels=new Map());levels.set(levelOf(floor),floor);last=floor}
      ceiling=floor-.01
    }
  }
  // Merge along x, then extend each run down z while every cell of the next row matches.
  const used=new Set<string>(),slabs:number[][]=[]
  const has=(i:number,k:number,level:number)=>i<cols&&k<rows&&at(i,k)?.has(level)===true&&!used.has(`${i},${k},${level}`)
  for(let k=0;k<rows;k++)for(let i=0;i<cols;i++)for(const [level] of at(i,k)??[]){
    if(!has(i,k,level))continue
    let w=1;while(has(i+w,k,level))w++
    let d=1;while(k+d<rows){let ok=true;for(let dx=0;dx<w;dx++)if(!has(i+dx,k+d,level)){ok=false;break}if(!ok)break;d++}
    let sum=0,n=0
    for(let dx=0;dx<w;dx++)for(let dz=0;dz<d;dz++){used.add(`${i+dx},${k+dz},${level}`);sum+=at(i+dx,k+dz)!.get(level)!;n++}
    slabs.push([LOCKOUT_BOUNDS.x0+(i+w/2)*CELL,sum/n,LOCKOUT_BOUNDS.z0+(k+d/2)*CELL,w*CELL,d*CELL])
  }
  return cached=slabs
}

export function addLockoutPhysicsSolids(world:World,material:Material):void {
  // Group nearby slabs into static compounds. Giving every trim-height run its own
  // body makes Cannon's body-pair bookkeeping quadratic in thousands of scenery
  // bodies. Spatial chunks retain the exact shapes/holes without one map-sized AABB.
  const chunks=new Map<string,Body>(),chunkSize=8
  for(const [x,y,z,w,d] of lockoutPhysicsSlabs()){
    const cy=y-SLAB_THICKNESS/2
    const origin=[x,cy,z].map(v=>(Math.floor(v/chunkSize)+.5)*chunkSize)
    const key=origin.join(',')
    let body=chunks.get(key)
    if(!body){body=new Body({mass:0,material,position:new Vec3(origin[0],origin[1],origin[2])});chunks.set(key,body)}
    body.addShape(new Box(new Vec3(w/2,SLAB_THICKNESS/2,d/2)),new Vec3(x-origin[0],cy-origin[1],z-origin[2]))
  }
  for(const body of chunks.values())world.addBody(body)
}
