import * as THREE from 'three'
import { FLOOR_HALF_X, FLOOR_HALF_Z, groundHeight, rimFraction } from '../../shared/field.ts'
import {
  applyGrain,
  makeGroundGrain,
  makeGroundMap,
  makeGroundNormal,
  makeRockTexture,
  makeRockySurface,
} from './terrain/textures.ts'
import { buildCliffRing, buildDistantMesas } from './terrain/cliffs.ts'
import { buildBoulders, buildFormations, buildScrub } from './terrain/props.ts'

/** Owner: terrain piece. Canyon floor, cliff walls, rocks, scrub. */

const FLOOR_STEP = 2

/**
 * The floor height is evaluated once onto a grid and then shared: the mesh reads it for
 * vertices, and the ground texture reads it (and its slope) to decide where grass gives
 * way to gravel and bare rock. Sampling the noise twice would be both slower and, when
 * the two drifted, visibly wrong.
 */
class HeightGrid {
  readonly nx: number
  readonly nz: number
  private readonly h: Float32Array

  constructor() {
    this.nx = Math.round((FLOOR_HALF_X * 2) / FLOOR_STEP)
    this.nz = Math.round((FLOOR_HALF_Z * 2) / FLOOR_STEP)
    this.h = new Float32Array((this.nx + 1) * (this.nz + 1))
    for (let j = 0; j <= this.nz; j++) {
      const z = -FLOOR_HALF_Z + j * FLOOR_STEP
      for (let i = 0; i <= this.nx; i++) {
        this.h[j * (this.nx + 1) + i] = groundHeight(-FLOOR_HALF_X + i * FLOOR_STEP, z)
      }
    }
  }

  at(i: number, j: number): number {
    const ci = i < 0 ? 0 : i > this.nx ? this.nx : i
    const cj = j < 0 ? 0 : j > this.nz ? this.nz : j
    return this.h[cj * (this.nx + 1) + ci]
  }

  height(x: number, z: number): number {
    const fi = (x + FLOOR_HALF_X) / FLOOR_STEP
    const fj = (z + FLOOR_HALF_Z) / FLOOR_STEP
    const i = Math.floor(fi)
    const j = Math.floor(fj)
    const tx = fi - i
    const tz = fj - j
    const a = this.at(i, j)
    const b = this.at(i + 1, j)
    const c = this.at(i, j + 1)
    const d = this.at(i + 1, j + 1)
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz
  }

  slope(x: number, z: number): number {
    const d = FLOOR_STEP
    const gx = (this.height(x + d, z) - this.height(x - d, z)) / (2 * d)
    const gz = (this.height(x, z + d) - this.height(x, z - d)) / (2 * d)
    return 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz)
  }
}

function buildFloor(grid: HeightGrid, map: THREE.Texture, normal: THREE.Texture, grain: THREE.Texture): THREE.Mesh {
  const nx = grid.nx
  const nz = grid.nz
  const cols = nx + 1
  const pos = new Float32Array(cols * (nz + 1) * 3)
  const uv = new Float32Array(cols * (nz + 1) * 2)
  for (let j = 0; j <= nz; j++) {
    const z = -FLOOR_HALF_Z + j * FLOOR_STEP
    for (let i = 0; i <= nx; i++) {
      const x = -FLOOR_HALF_X + i * FLOOR_STEP
      const o = (j * cols + i) * 3
      pos[o] = x
      pos[o + 1] = grid.at(i, j)
      pos[o + 2] = z
      const uo = (j * cols + i) * 2
      uv[uo] = i / nx
      uv[uo + 1] = j / nz
    }
  }
  /**
   * Emit only the quads that can actually be seen.
   *
   * The floor grid covers a rectangle that runs well past the canyon rim so the cliff feet
   * always have ground beneath them, but a quad whose every corner sits far outside the rim is
   * buried under rock. Keeping a margin past the rim costs nothing and skipping the rest drops
   * roughly a third of this mesh.
   */
  const KEEP_BEYOND_RIM = 1.22
  const idx = new Uint32Array(nx * nz * 6)
  let k = 0
  for (let j = 0; j < nz; j++) {
    const z0 = -FLOOR_HALF_Z + j * FLOOR_STEP
    const z1 = z0 + FLOOR_STEP
    for (let i = 0; i < nx; i++) {
      const x0 = -FLOOR_HALF_X + i * FLOOR_STEP
      const x1 = x0 + FLOOR_STEP
      const nearest = Math.min(
        rimFraction(x0, z0),
        rimFraction(x1, z0),
        rimFraction(x0, z1),
        rimFraction(x1, z1),
      )
      if (nearest > KEEP_BEYOND_RIM) continue

      const a = j * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      idx[k++] = a
      idx[k++] = c
      idx[k++] = b
      idx[k++] = b
      idx[k++] = c
      idx[k++] = d
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(new THREE.BufferAttribute(idx.subarray(0, k), 1))
  g.computeVertexNormals()

  normal.repeat.set((FLOOR_HALF_X * 2) / 4.5, (FLOOR_HALF_Z * 2) / 4.5)
  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap: normal,
    roughness: 1,
    metalness: 0,
  })
  mat.normalScale.set(0.55, 0.55)
  applyGrain(mat, grain, 2.3, 0.9, 'terrain-floor')

  const mesh = new THREE.Mesh(g, mat)
  mesh.receiveShadow = true
  mesh.name = 'canyon-floor'
  return mesh
}

export function createTerrain(): THREE.Object3D {
  const g = new THREE.Group()
  g.name = 'terrain'

  const grid = new HeightGrid()
  const grain = makeGroundGrain()
  g.add(buildFloor(grid, makeGroundMap(grid), makeGroundNormal(), grain))
  const rock = makeRockTexture()
  g.add(buildCliffRing(rock))
  g.add(buildDistantMesas(rock))
  const surface = makeRockySurface()
  for (const m of buildBoulders(surface)) g.add(m)
  g.add(buildFormations(surface))
  for (const m of buildScrub()) g.add(m)

  for (const child of g.children) {
    child.matrixAutoUpdate = false
    child.updateMatrix()
  }
  return g
}

/** Other pieces (spawns, vehicles, movement) can ask where the ground is. */
export { groundHeight }
