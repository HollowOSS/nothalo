import {Body,ConvexPolyhedron,Vec3,type World,type Material} from 'cannon-es'
import {arenaCollision} from './arena.ts'

/** Thin convex prisms preserve the imported slopes for both wheel rays and hull contacts.
 * Cannon cannot collide vehicle boxes against a Trimesh. Group nearby prisms to bound
 * broadphase cost, rather than flattening the terrain into navigation-cell stairs. */
export function addBloodGulchPhysics(world:World,material:Material):void {
  const mesh=arenaCollision('blood-gulch').mesh,chunks=new Map<string,Body>()
  for(let i=0;i<mesh.indices.length;i+=3){
    const points=[0,1,2].map(j=>{const k=mesh.indices[i+j]*3;return new Vec3(mesh.positions[k],mesh.positions[k+1],mesh.positions[k+2])})
    let normal=points[1].vsub(points[0]).cross(points[2].vsub(points[0]))
    if(normal.length()<1e-5)continue
    normal.normalize()
    // Upward-facing ground is the unshifted surface, independent of export winding.
    if(normal.y<0){[points[1],points[2]]=[points[2],points[1]];normal.negate(normal)}
    const center=points[0].vadd(points[1]).vadd(points[2]).scale(1/3).vsub(normal.scale(.09))
    const origin=new Vec3(...[center.x,center.y,center.z].map(v=>(Math.floor(v/16)+.5)*16) as [number,number,number])
    const key=`${origin.x},${origin.y},${origin.z}`
    let body=chunks.get(key)
    if(!body){body=new Body({mass:0,material,position:origin});chunks.set(key,body)}
    const vertices=points.map(p=>p.vsub(center))
    vertices.push(...vertices.map(p=>p.vsub(normal.scale(.18))))
    const shape=new ConvexPolyhedron({vertices,faces:[[0,1,2],[5,4,3],[0,3,4,1],[1,4,5,2],[2,5,3,0]]})
    body.addShape(shape,center.vsub(origin))
  }
  for(const body of chunks.values())world.addBody(body)
}
