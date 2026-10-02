import {Body,Box,Vec3,type Material,type World} from 'cannon-es'
import {guardianNavigationData} from './level-data.ts'

/**
 * Static floors for cosmetic rigid bodies (corpses, dropped props). cannon-es has no
 * box-versus-trimesh narrowphase, so instead of the collision triangles the world receives
 * the walkable-cell rectangles the nav build merged from that same mesh. Open drops remain
 * open: there is no terrain plane, so a body over the void keeps falling.
 */
const SLAB_THICKNESS=.4
export function addGuardianPhysicsSolids(world:World,material:Material):void {
  // Cannon keeps a quadratic body contact matrix, even with a custom broadphase.
  // Nearby slabs share a static body while retaining their exact shapes and holes.
  // Small spatial chunks also keep broadphase bounds local to each part of the map.
  const chunks=new Map<string,Body>(),chunkSize=8
  for(const [x,y,z,w,d] of guardianNavigationData().slabs){
    const cy=y-SLAB_THICKNESS/2
    const origin=[x,cy,z].map(v=>(Math.floor(v/chunkSize)+.5)*chunkSize)
    const key=origin.join(',')
    let body=chunks.get(key)
    if(!body){body=new Body({mass:0,material,position:new Vec3(origin[0],origin[1],origin[2])});chunks.set(key,body)}
    body.addShape(new Box(new Vec3(w/2,SLAB_THICKNESS/2,d/2)),new Vec3(x-origin[0],cy-origin[1],z-origin[2]))
  }
  for(const body of chunks.values())world.addBody(body)
}
