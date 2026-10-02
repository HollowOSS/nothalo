/**
 * Loose boulders and dead scrub. Both are instanced from a handful of merged prototypes:
 * a few hundred of these have to cost the frame budget of two draw calls, not two hundred.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BASE_RADIUS, RED_BASE, BLUE_BASE } from '../../../shared/map.ts'
import { noise2, rng, sfbm } from '../../../shared/noise.ts'
import { groundHeight, rimFraction, FLOOR_HALF_X, FLOOR_HALF_Z, sandMask } from '../../../shared/field.ts'
import { FORMATIONS, BOULDER_VARIANTS, scatterBoulders } from '../../../shared/cover.ts'

export interface Placement {
  x: number
  z: number
  y: number
  scale: number
  rot: number
}

function clearOfBases(x: number, z: number, pad: number): boolean {
  for (const b of [RED_BASE, BLUE_BASE]) {
    if (Math.hypot(x - b.x, z - b.z) < BASE_RADIUS + pad) return false
  }
  return true
}

function scatter(
  seed: number,
  count: number,
  maxRim: number,
  pad: number,
  accept?: (x: number, z: number) => boolean,
): Placement[] {
  const rand = rng(seed)
  const out: Placement[] = []
  for (let tries = 0; tries < count * 40 && out.length < count; tries++) {
    const x = (rand() * 2 - 1) * (FLOOR_HALF_X - 4)
    const z = (rand() * 2 - 1) * (FLOOR_HALF_Z - 4)
    const rim = rimFraction(x, z)
    if (rim > maxRim) continue
    if (!clearOfBases(x, z, pad)) continue
    if (accept && !accept(x, z)) continue
    out.push({ x, z, y: groundHeight(x, z), scale: 1, rot: rand() * Math.PI * 2 })
  }
  return out
}

function boulderGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1).toNonIndexed()
  const p = g.getAttribute('position') as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i)
    // Quantised radial noise gives the faceted, chipped look of the map's grey boulders.
    const n =
      0.62 +
      0.34 * noise2(v.x * 1.7 + seed, v.z * 1.7 - seed) +
      0.18 * noise2(v.y * 3.4 - seed, v.x * 3.4 + seed)
    v.multiplyScalar(n)
    v.y *= 0.72
    p.setXYZ(i, v.x, v.y, v.z)
  }
  g.computeVertexNormals()
  return g
}

function rockMaterial(surface: THREE.Texture): THREE.MeshStandardMaterial {
  // Boulders sit in the open with sky on every side, so their shaded faces stay pale
  // grey-brown in the frames (#705e42) rather than dropping to the near-black a single
  // directional light gives them. The emissive term is that sky bounce, and it is what
  // stops them reading as dark lozenges dropped on the grass.
  return new THREE.MeshStandardMaterial({
    map: surface,
    color: 0xd4c7b5,
    emissive: 0x594d3d,
    roughness: 0.96,
    metalness: 0,
    flatShading: true,
  })
}

/**
 * Loose boulders, placed by the shared scatter so the ones big enough to collide with are
 * exactly where the simulation thinks they are.
 */
export function buildBoulders(surface: THREE.Texture): THREE.Object3D[] {
  const mat = rockMaterial(surface)
  const meshes: THREE.Object3D[] = []
  const variants = scatterBoulders()
  for (let k = 0; k < BOULDER_VARIANTS; k++) {
    const list = variants[k]
    if (!list.length) continue
    const geo = boulderGeometry(k * 31 + 5)
    const mesh = new THREE.InstancedMesh(geo, mat, list.length)
    mesh.castShadow = true
    mesh.receiveShadow = true
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    for (let i = 0; i < list.length; i++) {
      const b = list[i]
      e.set(b.tiltX, b.rot, b.tiltZ)
      q.setFromEuler(e)
      m.compose(
        new THREE.Vector3(b.x, b.y + b.sc * 0.28, b.z),
        q,
        new THREE.Vector3(b.sc, b.sc * b.sy, b.sc),
      )
      mesh.setMatrixAt(i, m)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.name = `boulders-${k}`
    meshes.push(mesh)
  }
  return meshes
}

/**
 * One formation rock: a sphere pushed about by low-frequency noise so it reads as a slab of
 * sandstone rather than an egg, then stretched to the plan radius and height the collision
 * uses and sunk a third of its height into the ground so it grows out of the floor.
 */
function formationGeometry(r: number, h: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 3).toNonIndexed()
  const p = g.getAttribute('position') as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i)
    const n =
      0.82 +
      0.26 * sfbm(v.x * 1.3 + seed, v.z * 1.3 - seed * 0.7, 2) +
      0.12 * sfbm(v.y * 2.6 - seed, v.x * 2.6 + seed * 1.3, 2)
    // Flatten the crown: these are blocks, and the collision treats the top as flat.
    const cap = v.y > 0.55 ? 1 - 0.45 * (v.y - 0.55) : 1
    v.multiplyScalar(n)
    v.y *= cap
    p.setXYZ(i, v.x * r, v.y * h * 0.72, v.z * r)
  }
  g.translate(0, h * 0.3, 0)
  g.computeVertexNormals()
  return g
}

/**
 * The hand-placed rock formations, merged into one mesh. Named with the boulder prefix so
 * the match picks it up as cover for rockets and grenades without a second registry.
 */
export function buildFormations(surface: THREE.Texture): THREE.Object3D {
  const parts: THREE.BufferGeometry[] = []
  for (const f of FORMATIONS) {
    const g = formationGeometry(f.r, f.h, f.seed)
    g.rotateY(f.seed * 1.7)
    g.translate(f.x, groundHeight(f.x, f.z), f.z)
    parts.push(g)
  }
  const merged = mergeGeometries(parts, false)
  // Stretch the rock texture over metres, not over each rock, so neighbours do not repeat.
  const pos = merged.attributes.position
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) + pos.getY(i) * 0.6) / 5.5
    uv[i * 2 + 1] = (pos.getZ(i) - pos.getY(i) * 0.6) / 5.5
  }
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  const mesh = new THREE.Mesh(merged, rockMaterial(surface))
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.name = 'boulders-formations'
  return mesh
}

function segment(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r0: number, r1: number,
): THREE.BufferGeometry {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az)
  const len = dir.length()
  const g = new THREE.CylinderGeometry(r1, r0, len, 5, 1, true)
  g.translate(0, len / 2, 0)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()))
  g.translate(ax, ay, az)
  return g
}

/** A bare forked snag, the dead tree that stands midfield in every Blood Gulch frame. */
function deadTreeGeometry(seed: number): THREE.BufferGeometry {
  const rand = rng(seed)
  const parts: THREE.BufferGeometry[] = []
  const trunkH = 2.2 + rand() * 1.1
  const lean = new THREE.Vector3((rand() - 0.5) * 0.5, trunkH, (rand() - 0.5) * 0.5)
  parts.push(segment(0, -0.4, 0, lean.x, lean.y, lean.z, 0.22, 0.09))
  const forks = 3 + Math.floor(rand() * 3)
  for (let i = 0; i < forks; i++) {
    const t = 0.45 + rand() * 0.5
    const bx = lean.x * t
    const by = lean.y * t
    const bz = lean.z * t
    const a = (i / forks) * Math.PI * 2 + rand()
    const l = 0.7 + rand() * 1.3
    const ex = bx + Math.cos(a) * l
    const ez = bz + Math.sin(a) * l
    const ey = by + l * (0.5 + rand() * 0.9)
    parts.push(segment(bx, by, bz, ex, ey, ez, 0.1, 0.028))
    if (rand() > 0.45) {
      const a2 = a + (rand() - 0.5) * 1.6
      const l2 = l * 0.55
      parts.push(
        segment(ex, ey, ez, ex + Math.cos(a2) * l2, ey + l2 * 0.7, ez + Math.sin(a2) * l2, 0.03, 0.012),
      )
    }
  }
  const g = mergeGeometries(parts, false)
  g.computeVertexNormals()
  return g
}

function bushGeometry(seed: number): THREE.BufferGeometry {
  const rand = rng(seed)
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 5; i++) {
    const b = new THREE.IcosahedronGeometry(0.28 + rand() * 0.26, 0)
    b.translate((rand() - 0.5) * 0.7, 0.2 + rand() * 0.45, (rand() - 0.5) * 0.7)
    parts.push(b)
  }
  const g = mergeGeometries(parts, false)
  g.computeVertexNormals()
  return g
}

/** Dead snags on the grass, and the odd live bush tucked against the cliffs. */
export function buildScrub(): THREE.Object3D[] {
  const out: THREE.Object3D[] = []
  const woodMat = new THREE.MeshStandardMaterial({
    color: 0x8f8168,
    emissive: 0x241f18,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  const onGrass = (x: number, z: number) => sandMask(x, z) < 0.4
  const trees = scatter(777, 7, 0.98, 16, onGrass)
  const rand = rng(24601)
  const half = Math.ceil(trees.length / 2)
  for (let k = 0; k < 2; k++) {
    const list = trees.slice(k * half, (k + 1) * half)
    if (!list.length) continue
    const mesh = new THREE.InstancedMesh(deadTreeGeometry(k * 97 + 11), woodMat, list.length)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      const sc = 1.15 + rand() * 0.85
      q.setFromEuler(new THREE.Euler(0, s.rot, 0))
      m.compose(new THREE.Vector3(s.x, s.y - 0.1, s.z), q, new THREE.Vector3(sc, sc, sc))
      mesh.setMatrixAt(i, m)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.name = `snags-${k}`
    out.push(mesh)
  }

  const bushes = scatter(555, 34, 1.02, 14, (x, z) => rimFraction(x, z) > 0.55 && sandMask(x, z) < 0.6)
  const bushMesh = new THREE.InstancedMesh(
    bushGeometry(3),
    new THREE.MeshStandardMaterial({ color: 0x4a6a26, roughness: 1, metalness: 0, flatShading: true }),
    bushes.length,
  )
  const bm = new THREE.Matrix4()
  const bq = new THREE.Quaternion()
  for (let i = 0; i < bushes.length; i++) {
    const s = bushes[i]
    const sc = 0.7 + rand() * 0.9
    bq.setFromEuler(new THREE.Euler(0, s.rot, 0))
    bm.compose(new THREE.Vector3(s.x, s.y, s.z), bq, new THREE.Vector3(sc, sc * 0.8, sc))
    bushMesh.setMatrixAt(i, bm)
  }
  bushMesh.instanceMatrix.needsUpdate = true
  bushMesh.name = 'bushes'
  out.push(bushMesh)
  return out
}
