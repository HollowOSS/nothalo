import * as THREE from 'three'
import type { MapId } from '../../shared/maps.ts'
import type { Surface } from './combat-audio.ts'

/**
 * What a player is standing on, for footsteps.
 *
 * The collision meshes carry no materials, but the rendered scenery does. Once the map has loaded, every
 * upward-facing triangle of the scenery is rasterised into a coarse grid, cell by cell, keeping a few
 * floor layers per cell (a bridge over a river, a catwalk over a floor), each tagged with the surface its
 * material name implies. The build runs in small slices across frames; until it finishes the map's
 * default surface answers. A lookup is one array read.
 *
 * Map defaults cover cells with no scenery floor: Blood Gulch and Valhalla are dirt and grass, Sandtrap
 * is sand, Rat's Nest is concrete, and the Forerunner and UNSC interiors are metal. Scenery whose material
 * name says nothing (crates, bases, generic props) is metal, or concrete on Rat's Nest.
 */
const DEFAULT: Record<MapId, Surface> = {
  'blood-gulch': 'ground', valhalla: 'ground', sandtrap: 'sand', 'rats-nest': 'stone',
  guardian: 'metal', lockout: 'metal', epitaph: 'metal', narrows: 'metal', 'the-pit': 'metal',
}
const CODES: readonly Surface[] = ['ground', 'sand', 'metal', 'stone', 'wood', 'water']
/** Material name to surface, first match wins; null for things nobody walks on (leaves, glass walls). */
const RULES: readonly [RegExp, Surface | null][] = [
  [/leaf|leaves|foliage|glass_wall|broken_glass|distant|illum|holo|_light|light_|railing|fence|cable|sky/, null],
  [/water|riverbed/, 'water'],
  [/sand|dune|desert|shrine_ground/, 'sand'],
  [/bark|stump|trunk|wood|tree_a|tree_blend/, 'wood'],
  [/concrete|cement|stone|pyramid|marble|obelisk|slab|tile|brick|cobble/, 'stone'],
  [/metal|panel|plate|copper|grate|grill|grating|floor|trim|steel|hull|brace|girder|catwalk|pelican|ramp|rubber/, 'metal'],
  [/ground|terrain|dirt|grass|moss|cliff|boulder|rock|mud|glacier|snow/, 'ground'],
]
export function classifySurface(material: string): Surface | null | undefined {
  const name = material.toLowerCase()
  for (const [pattern, surface] of RULES) if (pattern.test(name)) return surface
  return undefined
}

const CELL = 1, LAYERS = 4, MERGE = .3
/** Floors further than this below the feet, or above them, are not what the player stands on. */
const BELOW = .75, ABOVE = .4

export class SurfaceMap {
  readonly fallback: Surface
  private heights: Float32Array | null = null
  private codes: Uint8Array | null = null
  private x0 = 0; private z0 = 0; private columns = 0; private rows = 0
  private work: Generator<void, void, number> | null = null
  /** Triangles rasterised, for debug hooks. */
  triangles = 0
  ready = false

  readonly map: MapId

  /** `bounds` ([minX, maxX, minZ, maxZ]) limits the grid to where players can stand: scenery reaches far past it. */
  constructor(map: MapId, root?: THREE.Object3D | null, bounds?: readonly [number, number, number, number]) {
    this.map = map
    this.fallback = DEFAULT[map] ?? 'ground'
    if (root) this.work = this.build(root, bounds)
  }

  /** Advance the build by about `budgetMs` of work. Cheap no-op once built. */
  step(budgetMs = 2): void {
    if (!this.work) return
    if (this.work.next(performance.now() + budgetMs).done) { this.work = null; this.ready = true }
  }

  /** The surface under feet at (x, y, z). */
  at(x: number, y: number, z: number): Surface {
    const heights = this.heights, codes = this.codes
    if (!heights || !codes) return this.fallback
    const cx = Math.floor((x - this.x0) / CELL), cz = Math.floor((z - this.z0) / CELL)
    if (cx < 0 || cz < 0 || cx >= this.columns || cz >= this.rows) return this.fallback
    const base = (cz * this.columns + cx) * LAYERS
    let best = -Infinity, code = 0
    for (let i = base; i < base + LAYERS; i++) {
      const h = heights[i]
      if (codes[i] && h >= y - BELOW && h <= y + ABOVE && h > best) { best = h; code = codes[i] }
    }
    return code ? CODES[code - 1] : this.fallback
  }

  private *build(root: THREE.Object3D, bounds?: readonly [number, number, number, number]): Generator<void, void, number> {
    let deadline: number = yield
    root.updateWorldMatrix(true, true)
    const meshes: { mesh: THREE.Mesh; surfaces: (Surface | null | undefined)[] }[] = []
    const found = new Set<Surface>(), unnamed: Surface = this.fallback === 'stone' ? 'stone' : 'metal'
    root.traverseVisible(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return
      // Valhalla's raised water sheet is widened under the banks; the riverbed below it is the real extent.
      if (/water-surface|waterfalls|splashes/.test(mesh.name)) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const surfaces = materials.map(m => classifySurface(m?.name ?? ''))
      for (const s of surfaces) if (s !== null) found.add(s ?? unnamed)
      meshes.push({ mesh, surfaces })
    })
    // A map whose named floors all agree with its default needs no grid at all (Rat's Nest's concrete).
    if (found.size === 0 || (found.size === 1 && found.has(this.fallback))) return
    const box = new THREE.Box3().setFromObject(root)
    if (bounds) box.intersect(new THREE.Box3(new THREE.Vector3(bounds[0], -Infinity, bounds[2]), new THREE.Vector3(bounds[1], Infinity, bounds[3])))
    if (box.isEmpty()) return
    this.x0 = Math.floor(box.min.x); this.z0 = Math.floor(box.min.z)
    this.columns = Math.ceil((box.max.x - this.x0) / CELL) + 1; this.rows = Math.ceil((box.max.z - this.z0) / CELL) + 1
    if (this.columns * this.rows > 4_000_000) return
    const heights = new Float32Array(this.columns * this.rows * LAYERS).fill(-Infinity)
    const codes = new Uint8Array(this.columns * this.rows * LAYERS)
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const matrix = new THREE.Matrix4(), instance = new THREE.Matrix4()
    const insert = (cx: number, cz: number, y: number, code: number) => {
      const base = (cz * this.columns + cx) * LAYERS
      let empty = -1, lowest = base
      for (let i = base; i < base + LAYERS; i++) {
        if (!codes[i]) { if (empty < 0) empty = i; continue }
        // The same floor seen twice (seams, decals, a thin slab's two faces): the upper face wins.
        if (Math.abs(heights[i] - y) < MERGE) { if (y > heights[i]) { heights[i] = y; codes[i] = code } return }
        if (heights[i] < heights[lowest]) lowest = i
      }
      const slot = empty >= 0 ? empty : y > heights[lowest] ? lowest : -1
      if (slot >= 0) { heights[slot] = y; codes[slot] = code }
    }
    let count = 0
    for (const { mesh, surfaces } of meshes) {
      const geometry = mesh.geometry, position = geometry.attributes.position as THREE.BufferAttribute | undefined
      if (!position) continue
      const index = geometry.index
      const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: index ? index.count : position.count, materialIndex: 0 }]
      const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1
      for (let n = 0; n < instances; n++) {
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) { (mesh as THREE.InstancedMesh).getMatrixAt(n, instance); matrix.multiplyMatrices(mesh.matrixWorld, instance) }
        else matrix.copy(mesh.matrixWorld)
        for (const group of groups) {
          const surface = surfaces[group.materialIndex ?? 0] ?? surfaces[0]
          if (surface === null) continue
          const code = CODES.indexOf(surface ?? unnamed) + 1
          const end = Math.min(group.start + group.count, index ? index.count : position.count)
          for (let i = group.start; i + 2 < end; i += 3) {
            if ((++count & 255) === 0 && performance.now() > deadline) deadline = yield
            const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2
            a.fromBufferAttribute(position, ia).applyMatrix4(matrix)
            b.fromBufferAttribute(position, ib).applyMatrix4(matrix)
            c.fromBufferAttribute(position, ic).applyMatrix4(matrix)
            const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
            const length = Math.hypot(nx, ny, nz)
            // Floors and walkable slopes only (either winding): walls and ceilings are not stood on.
            if (length < 1e-9 || Math.abs(ny) / length < .6) continue
            this.triangles++
            // Barycentric test of every cell centre the triangle covers; a triangle smaller than a
            // cell still marks the cell under its centroid.
            const minX = Math.floor((Math.min(a.x, b.x, c.x) - this.x0) / CELL), maxX = Math.floor((Math.max(a.x, b.x, c.x) - this.x0) / CELL)
            const minZ = Math.floor((Math.min(a.z, b.z, c.z) - this.z0) / CELL), maxZ = Math.floor((Math.max(a.z, b.z, c.z) - this.z0) / CELL)
            const det = ux * vz - uz * vx
            let marked = false
            if (Math.abs(det) > 1e-9) for (let cz = Math.max(0, minZ); cz <= Math.min(this.rows - 1, maxZ); cz++) {
              for (let cx = Math.max(0, minX); cx <= Math.min(this.columns - 1, maxX); cx++) {
                const px = this.x0 + (cx + .5) * CELL - a.x, pz = this.z0 + (cz + .5) * CELL - a.z
                const s = (px * vz - pz * vx) / det, t = (ux * pz - uz * px) / det
                if (s < -1e-4 || t < -1e-4 || s + t > 1 + 1e-4) continue
                insert(cx, cz, a.y + s * uy + t * vy, code); marked = true
              }
            }
            if (!marked) {
              const cx = Math.floor(((a.x + b.x + c.x) / 3 - this.x0) / CELL), cz = Math.floor(((a.z + b.z + c.z) / 3 - this.z0) / CELL)
              if (cx >= 0 && cz >= 0 && cx < this.columns && cz < this.rows) insert(cx, cz, (a.y + b.y + c.y) / 3, code)
            }
          }
        }
      }
    }
    this.heights = heights; this.codes = codes
  }
}
