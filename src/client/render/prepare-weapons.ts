import * as THREE from 'three'
import type { HeldWeapon } from '../game/weapon.ts'
import { prepareStaticLightMaterials } from './static-lights.ts'
import { applyViewmodelLook, viewmodelEnvironment } from './models/viewmodel-look.ts'

/** Compile with the exact first-person lighting, then draw once offscreen to upload geometry,
 * skinning and shader-owned textures. compileAsync alone only prepares programs. */
export async function prepareWeapons(renderer: THREE.WebGLRenderer, scene: THREE.Scene,
  camera: THREE.PerspectiveCamera, weapons: readonly HeldWeapon[], held: HeldWeapon): Promise<void> {
  prepareStaticLightMaterials(scene)
  const warmCamera = new THREE.PerspectiveCamera(camera.fov, camera.aspect)
  warmCamera.layers.set(1); warmCamera.near = .01; warmCamera.far = 20; warmCamera.updateProjectionMatrix()
  const target = new THREE.WebGLRenderTarget(8, 8)
  target.texture.colorSpace = renderer.outputColorSpace
  // Match the screen's tone mapping and output encoding (the same convention as bloom.ts).
  ;(target as THREE.WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true
  // No other held weapon may contribute a fill light during compilation.
  for (const weapon of weapons) weapon.object.removeFromParent()
  // The viewmodel's reflection and surfaces (viewmodel-look.ts) before compiling, so the shaders built here are the ones drawn.
  const environment = viewmodelEnvironment(scene, renderer)
  for (const weapon of weapons) applyViewmodelLook(weapon.object, environment)
  try {
    for (const weapon of weapons) {
      weapon.object.visible = true
      weapon.object.traverse(node => node.layers.set(1))
      weapon.lit = true
      await renderer.compileAsync(weapon.object, warmCamera, scene)
      const previousTarget = renderer.getRenderTarget(), background = scene.background
      const auto = renderer.shadowMap.autoUpdate, update = renderer.shadowMap.needsUpdate
      const hidden: THREE.Object3D[] = []
      // Include tiny/hidden grenade props and muzzle effects in the upload, too.
      weapon.object.traverse(node => { if (!node.visible && !(node as THREE.Light).isLight) { hidden.push(node); node.visible = true } })
      try {
        camera.getWorldPosition(warmCamera.position); camera.getWorldQuaternion(warmCamera.quaternion)
        warmCamera.add(weapon.object); scene.add(warmCamera)
        scene.background = null
        renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false
        renderer.setRenderTarget(target)
        renderer.render(scene, warmCamera)
      } finally {
        renderer.setRenderTarget(previousTarget); scene.background = background
        renderer.shadowMap.autoUpdate = auto; renderer.shadowMap.needsUpdate = update
        for (const node of hidden) node.visible = false
        weapon.object.removeFromParent(); warmCamera.removeFromParent(); weapon.lit = false
      }
      // Let the menu and touch events paint between individual weapon preparations.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
  } finally {
    target.dispose()
    for (const weapon of weapons) { camera.add(weapon.object); weapon.lit = weapon === held }
  }
}
