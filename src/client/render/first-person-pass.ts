import * as THREE from 'three'
import { PRESENTATION } from '../../shared/presentation.ts'
import { applyViewmodelLook, viewmodelEnvironment } from './models/viewmodel-look.ts'

/** Post-processing around the frame (bloom.ts): `begin` redirects the world into its own target and returns false when it
 * is off; `overlay` (optional) runs whatever must see the world alone and rebinds that target for the viewmodel; `end`
 * blooms the finished frame, viewmodel included, and puts it on the screen. */
export interface WorldPost { begin(scene: THREE.Scene, camera: THREE.Camera): boolean; overlay?(): void; end(): void }

/** The camera rig keeps its own depth buffer: knees and nearby walls must not cut
 * through hands, but the gun and fingers must still depth-test against each other.
 * It also gets its own near plane: a shouldered rifle's stock runs back past the eye, and the
 * world's 8 cm near plane would slice it open where it leaves the frame. The rig is all
 * within a metre or two, so a 1 cm near and short far keep its depth finer than the world's.
 * With post-processing on, the rig is drawn into the same target as the world before the bloom, so its flashes, plasma
 * and blades glow and its edges get the world's anti-aliasing; without it, straight onto the screen as before. */
const RIG_NEAR=PRESENTATION.rigNear,RIG_FAR=PRESENTATION.rigFar
export function renderFirstPerson(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera,viewmodel?:THREE.Object3D,post?:WorldPost):void {
  const rig=!!viewmodel?.visible
  // Also catches freshly loaded GLB descendants and transient held objects, and gives any weapon loaded after the warm-up
  // (prepare-weapons.ts) the map's viewmodel reflection and surfaces; a material already done costs one comparison.
  if(rig){viewmodel!.traverse(o=>o.layers.set(1));applyViewmodelLook(viewmodel!,viewmodelEnvironment(scene,renderer))}
  const layers=camera.layers.mask
  camera.layers.set(0)
  const posted=!!post?.begin(scene,camera)
  try{
    renderer.render(scene,camera)
    if(!rig)return
    const worldStats={...renderer.info.render}
    if(posted)post!.overlay?.()
    renderRig(renderer,scene,camera)
    // Keep the development performance counters inclusive of both passes.
    if(renderer.info.autoReset)for(const key of ['calls','triangles','points','lines'] as const)renderer.info.render[key]+=worldStats[key]
  }finally{
    camera.layers.mask=layers
    if(posted)post!.end()
  }
}

/** The rig over whatever the world pass left in the bound target: depth cleared, rig near/far, no background, no shadow
 * or matrix work (the world pass already did both). */
function renderRig(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera):void {
  const background=scene.background,autoClear=renderer.autoClear
  const shadowUpdate=renderer.shadowMap.autoUpdate,shadowNeedsUpdate=renderer.shadowMap.needsUpdate
  const matrixUpdate=scene.matrixWorldAutoUpdate
  const lens=(camera as THREE.PerspectiveCamera).isPerspectiveCamera?camera as THREE.PerspectiveCamera:null
  const near=lens?.near??0,far=lens?.far??0
  try{
    renderer.autoClear=false
    renderer.clearDepth()
    scene.background=null
    camera.layers.set(1)
    if(lens){lens.near=RIG_NEAR;lens.far=RIG_FAR;lens.updateProjectionMatrix()}
    scene.matrixWorldAutoUpdate=false
    renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=false
    renderer.render(scene,camera)
  }finally{
    scene.background=background;renderer.autoClear=autoClear
    if(lens){lens.near=near;lens.far=far;lens.updateProjectionMatrix()}
    scene.matrixWorldAutoUpdate=matrixUpdate
    renderer.shadowMap.autoUpdate=shadowUpdate;renderer.shadowMap.needsUpdate=shadowNeedsUpdate
  }
}
