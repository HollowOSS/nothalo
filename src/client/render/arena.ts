import {applyBloodGulchSurface} from './blood-gulch-look.ts'
import {TELEPORTERS} from '../../shared/map.ts'
import * as THREE from 'three'
import {loadResource} from './load-resource.ts'
import {arenaMeta,type ArenaId,NARROWS_CANNONS} from '../../shared/arena.ts'
import {preloadLevelData} from '../../shared/level-data.ts'
import {applyValhallaLook,type WaterWader} from './valhalla-look.ts'
import {applyArenaAtmosphere,brightenEmission,finishSurface} from './arena-atmosphere.ts'
import {detailSurface} from './surface-detail.ts'
import {createArenaLightFx} from './arena-light-fx.ts'
import {rendererSettings,withMapSettings} from './renderer-settings.ts'

/** Import transforms match the cooked shared collision data exactly. */
export function createArena(scene:THREE.Scene,renderer:THREE.WebGLRenderer,map:ArenaId,signal?:AbortSignal):THREE.Group {
  const bridge=map==='narrows',meta=arenaMeta(map)
  const atmosphere=applyArenaAtmosphere(scene,renderer,map,meta.bounds,meta.top)
  const settings=rendererSettings(renderer)
  const root=new THREE.Group();root.name=map;scene.add(root)
  if(bridge)for(const c of NARROWS_CANNONS){
    const glow=new THREE.Mesh(new THREE.CylinderGeometry(.7,.4,2.4,12,1,true),new THREE.MeshBasicMaterial({color:0x77cfff,transparent:true,opacity:.2,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending}))
    glow.position.set(c.x,c.y+1.2,c.z);root.add(glow)
  }
  // Valhalla's water reads the shared collision for its depth, so that data must be in too.
  root.userData.ready=Promise.all([loadResource(`/assets/maps/${map}.glb`,signal),map==='valhalla'?preloadLevelData(map):null]).then(([gltf])=>withMapSettings(renderer,settings,()=>{
    signal?.throwIfAborted()
    const model=gltf.scene;model.name=`${map}-imported`;model.position.set(meta.offset[0],meta.offset[1],meta.offset[2]);model.scale.setScalar(meta.scale??1)
    model.traverse(object=>{
      if(!(object as THREE.Mesh).isMesh)return
      const mesh=object as THREE.Mesh,materials=Array.isArray(mesh.material)?mesh.material:[mesh.material]
      for(const material of materials){
        finishSurface(material);brightenEmission(material);detailSurface(material,renderer)
        if(map==='blood-gulch')applyBloodGulchSurface(material)
        // Baked AO atlas on uv1 (tools/lib/arena-ao-bake.mjs): greyscale, so one channel on the GPU, not four.
        const ao=(material as THREE.MeshStandardMaterial).aoMap;if(ao?.channel===1)ao.format=THREE.RedFormat
        // Preserve the export's alpha mode and double-sided glass/fences.
        if('map' in material){const texture=(material as THREE.MeshStandardMaterial).map;if(texture)texture.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy())}
      }
      // The map shades itself: one static shadow map, rendered once below. Alpha-tested cut-outs cast.
      mesh.castShadow=!materials.some(material=>material.transparent);mesh.receiveShadow=true
    })
    root.add(model);root.userData.importedReference=model
    if(map==='blood-gulch')for(const t of TELEPORTERS){
      const pad=new THREE.Mesh(new THREE.CylinderGeometry(1.2,1.4,.12,24),new THREE.MeshStandardMaterial({color:0x57605b,metalness:.5,roughness:.65}))
      pad.position.set(t.exit.x,t.exit.y+.06,t.exit.z);root.add(pad)
      const glow=new THREE.Mesh(new THREE.TorusGeometry(.95,.08,6,24),new THREE.MeshBasicMaterial({color:0x69e879}))
      glow.rotation.x=-Math.PI/2;glow.position.set(t.exit.x,t.exit.y+.14,t.exit.z);root.add(glow)
    }
    // Valhalla's export has no terrain blend or water of its own (valhalla-look.ts).
    const look=map==='valhalla'?applyValhallaLook(renderer,model,scene):null
    // Lamps, glows, light pools, sun shafts and glare, and the bloom's settings (arena-light-fx.ts).
    const lights=createArenaLightFx(scene,renderer,map,model,root)
    root.userData.update=(time:number,focus:THREE.Vector3,_player?:unknown,players?:readonly WaterWader[])=>{atmosphere.update(time,focus);look?.update(time,focus,players);lights.update(time,focus,!!players)}
    atmosphere.sun.shadow.needsUpdate=true
    // Raycasts below need the imported scale/offset now, before its first render. Otherwise
    // probes can land inside floors or walls and bake a dark environment on slower loads.
    scene.updateMatrixWorld(true)
    // Environment from inside the map at head height: over its centre of play and a spread of
    // spawns. Heights are searched from the spot's own level, not the sky: a ray from above would
    // stand The Pit's probe on its roof.
    const spawns=(meta.spawns??[]) as readonly (readonly number[])[],spots=[meta.focus,...[0,.25,.5,.75].map(k=>spawns[Math.floor(spawns.length*k)]).filter(Boolean)]
    const probes=spots.map(([x,y,z])=>{
      const ground=new THREE.Raycaster(new THREE.Vector3(x,y+1,z),new THREE.Vector3(0,-1,0)).intersectObject(model,true)[0]
      return new THREE.Vector3(x,(ground?.point.y??y)+1.6,z)
    })
    atmosphere.captureProbe(probes)
    // MapScenes compiles after the late-arriving lights have been baked and prepared.
  })).catch(error=>{root.userData.importedError=error instanceof Error?error.message:String(error);throw error})
  return root
}
