import { assetUrl } from '../../../shared/runtime-config.ts'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export type VehicleKind = 'warthog' | 'ghost' | 'banshee' | 'mongoose' | 'chopper'
export type VehicleParts = {
  object: THREE.Object3D
  anchors: Map<string, THREE.Object3D>
  wheels: THREE.Object3D[]
  steeringWheels: THREE.Object3D[]
  turret: THREE.Object3D | null
  pitch: THREE.Object3D | null
  barrels: THREE.Object3D | null
  steering: THREE.Object3D | null
}
type PitchBlend = {
  mesh: THREE.Mesh
  positions: Float32Array
  normals: Float32Array
  weights: Float32Array
  lastPitch: number
}
const pitchBlends = new WeakMap<VehicleParts, PitchBlend[]>()
const blendVertex = new THREE.Vector3(), blendNormal = new THREE.Vector3()

/** Shared by gameplay and the review page so both exercise the same articulated rig. */
export function poseVehicleTurret(parts: VehicleParts, yaw: number, pitch: number, spin: number): void {
  if (parts.turret) parts.turret.rotation.set(0, yaw, 0)
  if (parts.pitch) parts.pitch.rotation.x = pitch
  if (parts.barrels) parts.barrels.rotation.z = spin
  if (!parts.pitch) return
  const pivot = parts.pitch.position, c = Math.cos(pitch), s = Math.sin(pitch)
  for (const blend of pitchBlends.get(parts) ?? []) {
    if (blend.lastPitch === pitch) continue
    blend.lastPitch = pitch
    const position = blend.mesh.geometry.getAttribute('position'), normal = blend.mesh.geometry.getAttribute('normal')
    for (let i = 0; i < position.count; i++) {
      const weight = blend.weights[i]
      blendVertex.fromArray(blend.positions, i * 3).sub(pivot)
      const y = blendVertex.y * c - blendVertex.z * s, z = blendVertex.y * s + blendVertex.z * c
      position.setXYZ(i, blend.positions[i * 3],
        blend.positions[i * 3 + 1] + (y - blendVertex.y) * weight,
        blend.positions[i * 3 + 2] + (z - blendVertex.z) * weight)
      blendNormal.fromArray(blend.normals, i * 3)
      const ny = blendNormal.y * c - blendNormal.z * s, nz = blendNormal.y * s + blendNormal.z * c
      blendNormal.y += (ny - blendNormal.y) * weight; blendNormal.z += (nz - blendNormal.z) * weight
      blendNormal.normalize(); normal.setXYZ(i, blendNormal.x, blendNormal.y, blendNormal.z)
    }
    position.needsUpdate = true; normal.needsUpdate = true
    blend.mesh.geometry.computeBoundingBox()
    blend.mesh.geometry.computeBoundingSphere()
  }
}
export interface AuthoredVehicle {
  object: THREE.Group
  parts: VehicleParts
  levels: VehicleParts[]
  groundOffset: number
  wheelRadius: number
  setDetail(distance: number): void
}

const loader = new GLTFLoader()
const sources = new Map<string, Promise<THREE.Object3D>>()
const wheelNames = ['wheel:front-left', 'wheel:front-right', 'wheel:rear-left', 'wheel:rear-right']

function source(kind: VehicleKind, level: number): Promise<THREE.Object3D> {
  const key = `${kind}${level ? `-lod${level}` : ''}`
  let promise = sources.get(key)
  if (!promise) {
    promise = loader.loadAsync(assetUrl(`/assets/ce-models/${key}.glb`)).then(gltf => {
      gltf.scene.traverse(node => {
        if (typeof node.userData.export_name === 'string') node.name = node.userData.export_name
        const mesh = node as THREE.Mesh
        if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true }
      })
      const object = gltf.scene.getObjectByName(kind)
      if (!object) throw new Error(`Authored ${key} is missing its named root`)
      return object
    })
    sources.set(key, promise)
  }
  return promise
}

function cloneParts(source: THREE.Object3D): VehicleParts {
  // Rigid scene clones share immutable geometry/materials/textures across both bases.
  const object = source.clone(true), anchors = new Map<string, THREE.Object3D>(), blends: PitchBlend[] = []
  object.traverse(node => {
    if (!anchors.has(node.name)) anchors.set(node.name, node)
    // Ghost boost intensity is animated per vehicle, so glow materials must not be shared.
    const mesh=node as THREE.Mesh
    const blend = node.userData.turretPitchBlend
    if (mesh.isMesh && blend) {
      // Only the small flexible belt needs mutable, per-vehicle geometry.
      mesh.geometry = mesh.geometry.clone()
      const position = mesh.geometry.getAttribute('position'), normal = mesh.geometry.getAttribute('normal')
      // GLTFLoader may interleave position, normal and UV data in one array.
      // Cache packed values through the attribute accessors, never its backing array.
      const positions = new Float32Array(position.count * 3), normals = new Float32Array(normal.count * 3)
      const weights = new Float32Array(position.count)
      for (let i = 0; i < position.count; i++) {
        positions.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3)
        normals.set([normal.getX(i), normal.getY(i), normal.getZ(i)], i * 3)
        const t = THREE.MathUtils.clamp((position.getY(i) - blend.lowerY) / (blend.upperY - blend.lowerY), 0, 1)
        weights[i] = t * t * (3 - 2 * t)
      }
      blends.push({ mesh, positions, normals, weights, lastPitch: 0 })
    }
    if(mesh.isMesh&&(node.name==='glow'||node.name.toLowerCase().includes('plasma'))){
      mesh.material=Array.isArray(mesh.material)?mesh.material.map(m=>m.clone()):mesh.material.clone()
      const material=Array.isArray(mesh.material)?mesh.material[0]:mesh.material
      if(material instanceof THREE.MeshStandardMaterial)mesh.userData.boostGlowBase=material.emissiveIntensity
    }
  })
  const get = (name: string) => anchors.get(name) ?? null
  const parts = { object, anchors, wheels: wheelNames.map(get).filter((o): o is THREE.Object3D => !!o),
    steeringWheels: wheelNames.slice(0, 2).map(n => get(`${n}:steer`)).filter((o): o is THREE.Object3D => !!o),
    turret: get('turret'), pitch: get('turret:pitch'), barrels: get('turret:barrels'), steering: get('steering') }
  pitchBlends.set(parts, blends)
  return parts
}

/** Loads only the newly authored public models. No legacy mesh or extracted-source fallback. */
export async function loadAuthoredVehicle(kind: VehicleKind): Promise<AuthoredVehicle> {
  const high = cloneParts(await source(kind, 0)), object = new THREE.Group()
  object.name = `${kind}:authored`; object.userData.backend = 'authored-blender'
  object.add(high.object); object.updateWorldMatrix(true, true)
  const bounds = new THREE.Box3().setFromObject(high.object)
  const groundOffset = -bounds.min.y
  object.position.y = groundOffset
  const levels: VehicleParts[] = [high]
  let desired = 0, active = 0
  const pending = new Set<number>()
  const wheel = high.wheels[0]
  const wheelRadius = wheel ? new THREE.Box3().setFromObject(wheel).getSize(new THREE.Vector3()).y / 2 : .65
  const show = () => {
    const available = levels[desired] ? desired : levels[1] && desired > 0 ? 1 : 0
    if (available === active) return
    for (let i = 0; i < levels.length; i++) if (levels[i]) levels[i].object.visible = i === available
    active = available
  }
  return { object, parts: high, levels, groundOffset, wheelRadius,
    setDetail(distance) {
      // Hysteresis prevents a switch at every frame around a distance boundary.
      desired = active === 2 ? distance < 78 ? distance < 29 ? 0 : 1 : 2
        : active === 1 ? distance > 92 ? 2 : distance < 29 ? 0 : 1
        : distance > 92 ? 2 : distance > 35 ? 1 : 0
      if (desired && !levels[desired] && !pending.has(desired)) {
        const level = desired; pending.add(level)
        source(kind, level).then(src => {
          const parts = cloneParts(src); parts.object.visible = false
          levels[level] = parts; object.add(parts.object); show()
        }).catch(error => console.error(`Could not load ${kind} LOD ${level}`, error))
      }
      show()
    },
  }
}
