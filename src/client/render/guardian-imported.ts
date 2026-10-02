import * as THREE from 'three'
import { loadResource } from './load-resource.ts'
import { GUARDIAN_IMPORT } from '../../shared/guardian-import.ts'
import { guardianMesh } from '../../shared/guardian-collision.ts'
import { MOVE } from '../../shared/constants.ts'
import { bakeGuardianLight, dressGuardianMaterials, GUARDIAN_SKY } from './guardian-lighting.ts'

/** The downloaded Halo Online Guardian (CC BY 4.0) is the visible architecture. It is placed
 * with the shared import transform, the same one baked into the generated collision data and
 * navigation grid, so the surfaces a player sees are the surfaces that stop them. */
const MODEL_URL = '/assets/guardian/guardian-reference.glb'

/** Every Guardian material is exported with metalness 0 and KHR_materials_specular at factor 0, so
 * it has no specular response at all: the physical BRDF three builds for it spends most of each
 * fragment computing reflections that multiply out to zero. Lambert evaluates the same diffuse
 * term, with the same normal, emissive and fog handling, for a fraction of the cost. */
function diffuseOnly(material:THREE.Material):THREE.Material {
  const source=material as THREE.MeshPhysicalMaterial
  if(!source.isMeshStandardMaterial||source.metalness!==0||(source.isMeshPhysicalMaterial?source.specularIntensity:1)!==0)return material
  const lambert=new THREE.MeshLambertMaterial({
    name:source.name,color:source.color,map:source.map,normalMap:source.normalMap,normalMapType:source.normalMapType,normalScale:source.normalScale,
    emissive:source.emissive,emissiveMap:source.emissiveMap,emissiveIntensity:source.emissiveIntensity,
    aoMap:source.aoMap,aoMapIntensity:source.aoMapIntensity,alphaMap:source.alphaMap,
    transparent:source.transparent,opacity:source.opacity,alphaTest:source.alphaTest,vertexColors:source.vertexColors,fog:source.fog,
    side:THREE.FrontSide,
  })
  source.dispose()
  return lambert
}

/** `light_circle_lift` is the static glyph disc of every launcher pad: the two man cannon
 * pedestals and a disc sunk into the floor at the Gold lift's base. In Halo 3 the Gold lift has
 * no visible pad at all, so that disc is collapsed away (the channel glow in guardian-lift-fx.ts
 * marks the lift instead), and the man cannon glyphs, which are the whole pad now that no effect
 * is drawn over them, are brightened to Halo 3's white-cyan so they read without bloom. */
/** The Gold lift sits alone at the far -X end of the map; nothing else of these materials does. */
const inGoldLift=(centroid:THREE.Vector3)=>centroid.x<-35&&Math.abs(centroid.z)<3
/** Remove the mesh's triangles whose world-space centroid passes `select`, returning them as a
 * separate non-indexed geometry (same attributes, same local space). The removed triangles are
 * degenerated onto their first vertex: zero area, nothing rasterised, no index rebuild. */
function takeTriangles(mesh:THREE.Mesh,select:(centroid:THREE.Vector3)=>boolean):THREE.BufferGeometry|null {
  const geometry=mesh.geometry,position=geometry.getAttribute('position') as THREE.BufferAttribute
  const index=geometry.index,count=index?index.count:position.count
  const vertexAt=(i:number)=>index?index.getX(i):i
  const centroid=new THREE.Vector3(),corner=new THREE.Vector3()
  const picked:number[]=[]
  for(let t=0;t<count;t+=3){
    centroid.set(0,0,0)
    for(let k=0;k<3;k++)centroid.addScaledVector(corner.fromBufferAttribute(position,vertexAt(t+k)).applyMatrix4(mesh.matrixWorld),1/3)
    if(select(centroid))picked.push(t)
  }
  if(!picked.length)return null
  const taken=new THREE.BufferGeometry()
  for(const [name,attribute] of Object.entries(geometry.attributes) as [string,THREE.BufferAttribute][]){
    const size=attribute.itemSize,array=new Float32Array(picked.length*3*size)
    picked.forEach((t,n)=>{for(let k=0;k<3;k++)for(let c=0;c<size;c++)array[(n*3+k)*size+c]=attribute.getComponent(vertexAt(t+k),c)})
    taken.setAttribute(name,new THREE.BufferAttribute(array,size,attribute.normalized))
  }
  for(const t of picked){
    const first=vertexAt(t)
    for(let k=1;k<3;k++)position.setXYZ(vertexAt(t+k),position.getX(first),position.getY(first),position.getZ(first))
  }
  position.needsUpdate=true
  geometry.computeBoundingSphere()
  return taken
}
function fixLiftGlyphs(mesh:THREE.Mesh):void {
  const material=mesh.material as THREE.MeshLambertMaterial
  if(Array.isArray(mesh.material)||material.name!=='light_circle_lift')return
  material.emissive.set(0xc9fbff)
  material.emissiveIntensity=1.6
  takeTriangles(mesh,inGoldLift)?.dispose()
}

/** Halo 3 marks the Gold lift with its channel alone: the herringbone emblem column on the
 * shaft's back wall glows a steady warm gold, flanked by two thin light strips. The export lost
 * that self-illumination. `trim_trim_sm` is only those two strips, so it is lit directly;
 * `waste_panel_wall` is the emblem column here but also plain wall in the Blue room, so the
 * lift's triangles move to their own mesh (one extra draw) with a gold, self-lit copy of the
 * material that uses its own texture as the glow mask, keeping the relief readable. The same
 * split re-tints the lift's share of the Top Mid fin material (one more small draw). */
function lightGoldLiftChannel(mesh:THREE.Mesh):void {
  const material=mesh.material as THREE.MeshLambertMaterial
  if(Array.isArray(mesh.material))return
  if(material.name==='trim_trim_sm'){material.emissive.set(0xffd894);material.emissiveMap=material.map;material.emissiveIntensity=.8;return}
  // The emblem column glows; the round recess at the lift's base (fin material shared with Top
  // Mid) is dimmed to a faint gold, since Halo 3 shows no glowing pad there.
  const glow=material.name==='waste_panel_wall'?{name:'emblem',color:0xffc766,intensity:1.25}
    :material.name==='guardian_centerplatform_metalunderglass'?{name:'recess',color:0x8a6a34,intensity:.4}:null
  if(!glow)return
  const taken=takeTriangles(mesh,inGoldLift)
  if(!taken)return
  const gold=material.clone()
  gold.name=`${material.name}:gold-lift`
  gold.emissive.set(glow.color)
  gold.emissiveMap=material.emissiveMap??material.map
  gold.emissiveIntensity=glow.intensity
  const channel=new THREE.Mesh(taken,gold)
  channel.name=`guardian-gold-lift-${glow.name}`
  mesh.add(channel)
  channel.updateMatrixWorld(true)
}

/** Free the GPU resources of a detached subtree, skipping anything the surviving scene still
 * uses. Detaching alone does not release a geometry or a texture: the renderer keeps them
 * uploaded for the rest of the session, which for Guardian's placeholder art is roughly 90
 * geometries and their materials sitting in video memory behind the real model, permanently
 * invisible. Materials and maps are frequently shared, so nothing is disposed until the whole
 * live scene has been checked for a remaining reference to it. */
function disposeDetached(detached:THREE.Object3D[],liveRoot:THREE.Object3D):void {
  const liveGeometries=new Set<string>(),liveMaterials=new Set<string>(),liveTextures=new Set<string>()
  const materialsOf=(o:THREE.Object3D)=>{
    const material=(o as THREE.Mesh).material
    return material?(Array.isArray(material)?material:[material]):[]
  }
  const texturesOf=(material:THREE.Material)=>Object.values(material as unknown as Record<string,unknown>)
    .filter((value):value is THREE.Texture=>!!value&&(value as THREE.Texture).isTexture===true)
  liveRoot.traverse(o=>{
    const geometry=(o as THREE.Mesh).geometry
    if(geometry)liveGeometries.add(geometry.uuid)
    for(const material of materialsOf(o)){
      liveMaterials.add(material.uuid)
      for(const texture of texturesOf(material))liveTextures.add(texture.uuid)
    }
  })
  for(const subtree of detached)subtree.traverse(o=>{
    const geometry=(o as THREE.Mesh).geometry
    if(geometry&&!liveGeometries.has(geometry.uuid))geometry.dispose()
    for(const material of materialsOf(o)){
      if(liveMaterials.has(material.uuid))continue
      for(const texture of texturesOf(material))if(!liveTextures.has(texture.uuid))texture.dispose()
      material.dispose()
    }
  })
}

function hideProceduralArchitecture(root:THREE.Group):void {
  // Once the downloaded mesh is ready, every procedural placeholder surface is dead weight:
  // Match raycasts Guardian against the shared collision mesh, never against these, so they
  // can be detached and their GPU resources handed back rather than left uploaded.
  const detached:THREE.Object3D[]=[]
  for(const child of [...root.children]){
    if(child.name==='guardian-imported-reference'||child.name==='guardian-collision-debug'||child.name==='guardian-lift-fx'||((child as THREE.Light).isLight&&child.name!=='guardian-placeholder-light'))continue
    child.visible=false
    root.remove(child)
    detached.push(child)
  }
  disposeDetached(detached,root.parent??root)
}

/** Debug view of the shipped collision mesh: a see-through wireframe coloured by surface
 * type (green standable, orange wall or steep), plus the triangles currently inside the
 * player's standing capsule in red, so a snag shows exactly which surface caused it. */
export interface GuardianCollisionDebug { group:THREE.Group; update(feet:{x:number;y:number;z:number},height:number):void }
export function createGuardianCollisionDebug():GuardianCollisionDebug {
  const mesh=guardianMesh(),count=mesh.triangleCount
  const positions=new Float32Array(count*9),colours=new Float32Array(count*9)
  const floor=new THREE.Color(0x4cffb0),wall=new THREE.Color(0xffa64c)
  for(let t=0;t<count;t++){
    const tint=Math.abs(mesh.normals[t*3+1])>=Math.cos(50*Math.PI/180)?floor:wall
    for(let k=0;k<3;k++){
      const v=mesh.indices[t*3+k]*3,o=t*9+k*3
      positions[o]=mesh.positions[v];positions[o+1]=mesh.positions[v+1];positions[o+2]=mesh.positions[v+2]
      colours[o]=tint.r;colours[o+1]=tint.g;colours[o+2]=tint.b
    }
  }
  const geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.BufferAttribute(positions,3))
  geometry.setAttribute('color',new THREE.BufferAttribute(colours,3))
  const wire=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({vertexColors:true,wireframe:true,transparent:true,opacity:.42,depthTest:false,depthWrite:false}))
  wire.renderOrder=20
  const MAX_HITS=96
  const hitGeometry=new THREE.BufferGeometry()
  const hitPositions=new Float32Array(MAX_HITS*9)
  hitGeometry.setAttribute('position',new THREE.BufferAttribute(hitPositions,3))
  hitGeometry.setDrawRange(0,0)
  const hits=new THREE.Mesh(hitGeometry,new THREE.MeshBasicMaterial({color:0xff3b3b,transparent:true,opacity:.55,side:THREE.DoubleSide,depthTest:false,depthWrite:false}))
  hits.renderOrder=21
  const group=new THREE.Group();group.name='guardian-collision-debug';group.visible=false;group.add(wire,hits)
  for(const object of [group,wire,hits])object.frustumCulled=false
  const radius=.28+.06
  return {group,update(feet,height){
    if(!group.visible)return
    const y0=feet.y+MOVE.stepHeight+.001,y1=feet.y+height-.02
    let n=0
    mesh.forEachInBox(feet.x-radius,y0,feet.z-radius,feet.x+radius,y1,feet.z+radius,t=>{
      if(!mesh.triangleHitsCylinder(t,feet.x,feet.z,y0,y1,radius))return false
      for(let k=0;k<3;k++){const v=mesh.indices[t*3+k]*3,o=n*9+k*3;hitPositions[o]=mesh.positions[v];hitPositions[o+1]=mesh.positions[v+1];hitPositions[o+2]=mesh.positions[v+2]}
      return ++n>=MAX_HITS
    })
    hitGeometry.setDrawRange(0,n*3)
    hitGeometry.attributes.position.needsUpdate=true
  }}
}

/** Attach the downloaded Guardian model. Procedural placeholder art shows until it is ready.
 * The returned promise lets startup move the GLB decode and texture upload out of gameplay. */
export function attachImportedGuardian(root:THREE.Group,signal?:AbortSignal):Promise<void> {
  return loadResource(MODEL_URL,signal).then(gltf=>{
    const model=gltf.scene
    model.name='guardian-imported-reference'
    model.scale.setScalar(GUARDIAN_IMPORT.scale)
    model.position.set(GUARDIAN_IMPORT.offset.x,GUARDIAN_IMPORT.offset.y,GUARDIAN_IMPORT.offset.z)
    model.traverse(object=>{
      if(!(object as THREE.Mesh).isMesh)return
      const mesh=object as THREE.Mesh
      // Guardian's imported architecture is static and already carries its authored
      // material definition. Sampling a dynamic shadow map for every one of its large
      // interior surfaces is a major GPU cost, while making the whole mesh a shadow caster
      // gives no gameplay value. Keep the moving Spartan/vehicle shadows on the authored
      // proxy geometry and let this high-detail reference mesh use its baked textures.
      // It does cast into the sun's static shadow map (rendered once, not per frame) so the god
      // rays (volumetric-light.ts) fall only through real gaps in the canopy and architecture,
      // and characters and vehicles are shaded under roofs. Glass is excluded in guardian-lighting.ts.
      mesh.castShadow=true
      mesh.receiveShadow=false
      mesh.material=Array.isArray(mesh.material)?mesh.material.map(diffuseOnly):diffuseOnly(mesh.material)
      for(const material of (Array.isArray(mesh.material)?mesh.material:[mesh.material]))material.side=THREE.FrontSide
    })
    root.add(model)
    root.updateMatrixWorld(true)
    const meshes:THREE.Mesh[]=[]
    model.traverse(object=>{if((object as THREE.Mesh).isMesh)meshes.push(object as THREE.Mesh)})
    for(const mesh of meshes){fixLiftGlyphs(mesh);lightGoldLiftChannel(mesh)}
    // Room colour, launcher light, restored glows and see-through glass (guardian-lighting.ts).
    // World matrices first: the compact (phone) model is meshopt-quantized, with its metre scale on the nodes.
    model.updateWorldMatrix(true,true)
    bakeGuardianLight(model)
    dressGuardianMaterials(model,GUARDIAN_SKY)
    // The imported architecture is immutable. Keep its baked matrices, avoiding a full
    // hierarchy transform walk for every camera and shadow pass.
    model.traverse(object=>{object.matrixAutoUpdate=false;object.matrixWorldAutoUpdate=false})
    root.userData.importedReference=model
    root.userData.importedSource=MODEL_URL
    hideProceduralArchitecture(root)
    // Re-render the static sun shadow map now that the real architecture is in place.
    root.userData.bakeShadows?.()
  }).catch(error=>{
    if(signal?.aborted)throw error
    root.userData.importedError=error instanceof Error?error.message:String(error)
    console.warn('Guardian imported mesh failed to load; keeping placeholder art (collision is unaffected)',error)
  })
}
