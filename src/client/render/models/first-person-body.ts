import * as THREE from 'three'

interface Vertex { p: THREE.Vector3; n: THREE.Vector3; uv: THREE.Vector2; weights: Map<number, number> }
/** Owner-only closed lower body. Filtering skin influences removes elbows even when crouched;
 * clipping triangles in bind space keeps the waist attached to the animated pelvis. */
export function firstPersonBodyGeometry(mesh: THREE.SkinnedMesh, cutFraction = .62): THREE.BufferGeometry {
  const source=mesh.geometry, p=source.getAttribute('position'), n=source.getAttribute('normal'), uv=source.getAttribute('uv')
  const joints=source.getAttribute('skinIndex'), weights=source.getAttribute('skinWeight')
  source.computeBoundingBox()
  const bounds=source.boundingBox!,cut=bounds.min.y+(bounds.max.y-bounds.min.y)*cutFraction
  const upper=new Set(mesh.skeleton.bones.flatMap((bone,i)=>/arm|hand|thumb|index|middle|ring|pinky|neck|head|shoulder/i.test(bone.name)?[i]:[]))
  const read=(i:number):Vertex=>({p:new THREE.Vector3().fromBufferAttribute(p,i),n:new THREE.Vector3().fromBufferAttribute(n,i),uv:new THREE.Vector2(uv.getX(i),uv.getY(i)),weights:new Map([0,1,2,3].filter(k=>weights.getComponent(i,k)>0).map(k=>[joints.getComponent(i,k),weights.getComponent(i,k)]))})
  const blend=(a:Vertex,b:Vertex,t:number):Vertex=>{
    const w=new Map<number,number>();for(const [i,v] of a.weights)w.set(i,v*(1-t));for(const [i,v] of b.weights)w.set(i,(w.get(i)??0)+v*t)
    return {p:a.p.clone().lerp(b.p,t),n:a.n.clone().lerp(b.n,t).normalize(),uv:a.uv.clone().lerp(b.uv,t),weights:w}
  }
  const position:number[]=[],normal:number[]=[],texcoord:number[]=[],skinIndex:number[]=[],skinWeight:number[]=[]
  const emit=(v:Vertex)=>{
    position.push(...v.p.toArray());normal.push(...v.n.toArray());texcoord.push(...v.uv.toArray())
    const sorted=[...v.weights].sort((a,b)=>b[1]-a[1]).slice(0,4),total=sorted.reduce((a,b)=>a+b[1],0)||1
    while(sorted.length<4)sorted.push([0,0]);skinIndex.push(...sorted.map(x=>x[0]));skinWeight.push(...sorted.map(x=>x[1]/total))
  }
  const boundary:Vertex[]=[]
  const count=source.index?.count??p.count,at=(i:number)=>source.index?.getX(i)??i
  for(let i=0;i<count;i+=3){
    const tri=[read(at(i)),read(at(i+1)),read(at(i+2))]
    if(tri.some(v=>[...v.weights].some(([j,w])=>upper.has(j)&&w>.05)))continue
    const polygon:Vertex[]=[]
    for(let k=0;k<3;k++){
      const a=tri[k],b=tri[(k+1)%3],inside=a.p.y<=cut,other=b.p.y<=cut
      if(inside)polygon.push(a)
      if(inside!==other){const edge=blend(a,b,(cut-a.p.y)/(b.p.y-a.p.y));polygon.push(edge);boundary.push(edge)}
    }
    for(let k=1;k<polygon.length-1;k++){emit(polygon[0]);emit(polygon[k]);emit(polygon[k+1])}
  }
  const bodyCount=position.length/3
  // The waist cross-section is convex. Close it with a dark, pelvis-weighted cap,
  // so looking straight down cannot see the terrain through an open clipping cut.
  const ring=[...new Map(boundary.map(v=>[`${v.p.x.toFixed(6)},${v.p.z.toFixed(6)}`,v])).values()]
  if(ring.length>2){
    const center=ring.reduce((a,v)=>a.add(v.p),new THREE.Vector3()).multiplyScalar(1/ring.length)
    ring.sort((a,b)=>Math.atan2(a.p.z-center.z,a.p.x-center.x)-Math.atan2(b.p.z-center.z,b.p.x-center.x))
    const pelvis=mesh.skeleton.bones.findIndex(b=>b.name==='Hips')
    const cap=(point:THREE.Vector3):Vertex=>({p:point,n:new THREE.Vector3(0,1,0),uv:new THREE.Vector2(.5,.5),weights:new Map([[Math.max(0,pelvis),1]])})
    for(let i=0;i<ring.length;i++){emit(cap(center));emit({...ring[(i+1)%ring.length],n:new THREE.Vector3(0,1,0)});emit({...ring[i],n:new THREE.Vector3(0,1,0)})}
  }
  const geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(position,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normal,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(texcoord,2))
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(skinIndex,4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(skinWeight,4))
  geometry.addGroup(0,bodyCount,0);geometry.addGroup(bodyCount,position.length/3-bodyCount,1)
  geometry.userData.firstPersonLowerBody=true;geometry.userData.waistHeight=cut
  geometry.computeBoundingSphere()
  return geometry
}
