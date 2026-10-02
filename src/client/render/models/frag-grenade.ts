import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

let source: Promise<THREE.Group> | undefined

/** Shared geometry/textures for the Halo 3 frag in the hand and in flight. */
export async function loadFragGrenade(): Promise<THREE.Group> {
  source ??= new GLTFLoader().loadAsync('/assets/ce-models/frag-grenade.glb')
    .then(gltf => gltf.scene)
    .catch(error => { source = undefined; throw error })
  return (await source).clone(true)
}
