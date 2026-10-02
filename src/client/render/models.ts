import * as THREE from 'three'
import { SPECS, type ModelId } from '../../shared/assets.ts'

/**
 * The model registry.
 *
 * Every model in this game is built in code. A piece registers a factory here; everything else
 * asks for a model by id and gets a clone. No loader, no fetch, no file — which is why there is
 * nothing to license and nothing to 404.
 *
 * Each factory is called once and its result cached, so sixteen Warthogs cost one build.
 */

export type ModelFactory = () => THREE.Object3D

const factories = new Map<ModelId, ModelFactory>()
const built = new Map<ModelId, THREE.Object3D>()

export function registerModel(id: ModelId, factory: ModelFactory): void {
  // Two modules registering the same id means import order silently decides which model the game
  // uses, and the loser becomes dead code nobody notices. Fail loudly instead.
  if (factories.has(id)) {
    throw new Error(
      `two factories registered for model '${id}'. One id, one owner — delete the superseded one ` +
      `rather than relying on import order in registry.ts.`,
    )
  }
  factories.set(id, factory)
  built.delete(id)
}

export function hasModel(id: ModelId): boolean {
  return factories.has(id)
}

/**
 * A stand-in for anything not yet authored: a wireframe box at the model's real dimensions.
 * It is deliberately ugly — a placeholder that looks finished is a placeholder that ships.
 */
function placeholder(id: ModelId): THREE.Object3D {
  const [l, w, h] = SPECS[id].size
  const g = new THREE.Group()
  g.name = `placeholder:${id}`
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, l),
    new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true }),
  )
  box.position.y = h / 2
  g.add(box)
  return g
}

export function buildModel(id: ModelId): THREE.Object3D {
  let base = built.get(id)
  if (!base) {
    const factory = factories.get(id)
    base = factory ? factory() : placeholder(id)
    base.name ||= id
    built.set(id, base)
  }
  return base.clone(true)
}

/** Which models still have no author. Surfaced so a missing piece cannot hide. */
export function unbuilt(): ModelId[] {
  return (Object.keys(SPECS) as ModelId[]).filter((id) => !factories.has(id))
}

/**
 * Check a built model against its spec. Silhouette is what players recognise, and the fastest
 * way to look wrong is to be the wrong size next to a two-metre Spartan.
 */
export function checkSpec(id: ModelId): { ok: boolean; expected: number[]; actual: number[]; triangles: number } {
  const obj = buildModel(id)
  const box = new THREE.Box3().setFromObject(obj)
  const s = box.getSize(new THREE.Vector3())
  // Compare the sorted extents so a model authored on a different forward axis still matches.
  const actual = [s.x, s.y, s.z].sort((a, b) => b - a)
  const expected = [...SPECS[id].size].sort((a, b) => b - a)

  let triangles = 0
  obj.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && m.geometry) {
      triangles += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3
    }
  })

  const ok = expected.every((e, i) => Math.abs(actual[i] - e) / e < 0.15)
  return { ok, expected, actual: actual.map((n) => +n.toFixed(2)), triangles: Math.round(triangles) }
}
