import { assetUrl } from '../../../shared/runtime-config.ts'
import * as THREE from 'three'
import {finishWeapon} from './weapon-finish.ts'
import { loadResource } from '../load-resource.ts'
import type { ModelId } from '../../../shared/assets.ts'
import { collectPlasma, flickerPlasma } from './plasma.ts'
import { registerModel, hasModel } from '../models.ts'

/**
 * The authored weapons, as everyone else sees them in your hands.
 *
 * The first-person view has always loaded the Blender models from assetUrl(`/assets/viewmodels`); the
 * weapon in a remote player's hands was still the older procedural mesh from the registry, so
 * the rocket launcher across the canyon was not the rocket launcher you were holding. These are
 * the same authored meshes packaged as world models, with the LOD chain the vehicles use.
 *
 * They share the procedural convention exactly — metres, +z down the barrel, `anchor:muzzle` at
 * the tip — which is why they drop into the same hand mount without a correction.
 */

export interface AuthoredWeapon {
  object: THREE.Group
  /** Swap detail by how far away the holder is. Safe to call every frame. */
  setDetail(distance: number): void
  /** Advance anything that is alive on this weapon, which so far means plasma. */
  animate(dt: number): void
  muzzle: THREE.Object3D | null
}

/** Weapons that have an authored world model beside their viewmodel. */
const AUTHORED = new Set<ModelId>(['smg', 'plasma-pistol', 'plasma-rifle', 'magnum', 'assault-rifle', 'sniper', 'rocket-launcher', 'shotgun', 'energy-sword', 'battle-rifle', 'needler', 'gravity-hammer'])

export function hasAuthoredWeapon(id: ModelId): boolean {
  return AUTHORED.has(id)
}

const sources = new Map<string, Promise<THREE.Object3D>>()

function source(id: ModelId, level: number): Promise<THREE.Object3D> {
  const key = `${id}${level ? `-lod${level}` : ''}`
  let promise = sources.get(key)
  if (!promise) {
    promise = loadResource(`/assets/ce-models/${key}.glb`, undefined, level === 0).then(gltf => {
      gltf.scene.traverse(node => {
        // The exporter keeps the authored name in userData; anchors are found by it.
        if (typeof node.userData.export_name === 'string') node.name = node.userData.export_name
        const mesh = node as THREE.Mesh
        if (mesh.isMesh) { for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])finishWeapon(material); mesh.castShadow = true; mesh.receiveShadow = true; mesh.layers.enable(2) }
      })
      addMissingMuzzle(gltf.scene)
      return gltf.scene
    })
    promise = promise.catch(error => { sources.delete(key); throw error })
    sources.set(key, promise)
  }
  return promise
}

/**
 * The Halo 3 rifles (assault rifle, battle rifle, shotgun, sniper, rocket launcher) came without an `anchor:muzzle`, so a Spartan holding
 * one had its shots, tracers and flash start at its eye. Give such a model one at the end of its barrel: the front of its geometry
 * (+z runs down the barrel), centred on the vertices in the last 3 cm (between the tubes for the launcher).
 */
function addMissingMuzzle(scene: THREE.Object3D): void {
  let has = false
  scene.traverse(node => { if (node.name === 'anchor:muzzle') has = true })
  if (has) return
  scene.updateWorldMatrix(true, true)
  const toScene = scene.matrixWorld.clone().invert(), v = new THREE.Vector3(), points: THREE.Vector3[] = []
  scene.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const position = mesh.geometry.getAttribute('position'), m = toScene.clone().multiply(mesh.matrixWorld)
    for (let i = 0; i < position.count; i++) points.push(v.fromBufferAttribute(position, i).applyMatrix4(m).clone())
  })
  if (!points.length) return
  const front = Math.max(...points.map(p => p.z)), tip = points.filter(p => p.z > front - .03)
  const anchor = new THREE.Object3D(); anchor.name = 'anchor:muzzle'
  anchor.position.set(tip.reduce((a, p) => a + p.x, 0) / tip.length, tip.reduce((a, p) => a + p.y, 0) / tip.length, front)
  scene.add(anchor)
}

/** Rigid clones share geometry and textures, so sixteen Spartans holding rifles cost one upload. */
function cloneLevel(from: THREE.Object3D): THREE.Object3D {
  return from.clone(true)
}

/**
 * Hand the authored mesh to the model registry for any weapon that has no code-built one.
 *
 * The registry is synchronous by design — a piece asks for a model and gets a clone — so a
 * weapon that only exists as a file has to be fetched before anything asks. The shotgun and
 * the energy sword were authored in Blender and never had a procedural twin, and this is what
 * lets the first-person view, the pickup and the debug viewer all treat them as ordinary
 * models. Weapons that already have a factory are left alone: two owners for one id is an
 * error the registry deliberately throws on.
 */
export async function registerAuthoredWeapons(ids: readonly ModelId[]): Promise<void> {
  await Promise.all(ids.map(async id => {
    if (hasModel(id) || !AUTHORED.has(id)) return
    const built = await source(id, 0)
    registerModel(id, () => built.clone(true))
  }))
}

export async function loadAuthoredWeapon(id: ModelId): Promise<AuthoredWeapon> {
  if (!AUTHORED.has(id)) throw new Error(`no authored world model for '${id}'`)
  const object = new THREE.Group()
  object.name = `${id}:authored`
  object.userData.backend = 'authored-blender'
  const high = cloneLevel(await source(id, 0))
  object.add(high)

  const levels: (THREE.Object3D | undefined)[] = [high]
  const pending = new Set<number>()
  let desired = 0
  let active = 0

  const show = (): void => {
    const available = levels[desired] ? desired : levels[1] && desired > 0 ? 1 : 0
    if (available === active) return
    for (let i = 0; i < levels.length; i++) if (levels[i]) levels[i]!.visible = i === available
    active = available
  }

  const plasma = collectPlasma(object)
  let clock = 0

  return {
    object,
    muzzle: high.getObjectByName('anchor:muzzle') ?? null,
    animate(dt) {
      if (!plasma.length) return
      clock += dt
      flickerPlasma(plasma, clock)
    },
    setDetail(distance) {
      // A weapon is a tenth the size of a Warthog, so it drops detail far sooner. Hysteresis
      // on the way back keeps it from switching every frame at the boundary.
      desired = active === 2 ? distance < 30 ? distance < 12 ? 0 : 1 : 2
        : active === 1 ? distance > 38 ? 2 : distance < 12 ? 0 : 1
        : distance > 38 ? 2 : distance > 16 ? 1 : 0
      if (desired && !levels[desired] && !pending.has(desired)) {
        const level = desired
        pending.add(level)
        source(id, level).then(src => {
          const clone = cloneLevel(src)
          clone.visible = false
          levels[level] = clone
          object.add(clone)
          show()
        }).catch(error => console.error(`Could not load the ${id} world model at LOD ${level}`, error))
      }
      show()
    },
  }
}
