import { guardianCollisionData } from './level-data.ts'
import { GUARDIAN_COLLISION_BOUNDS } from './guardian-collision-meta.ts'

/**
 * Static triangle-mesh collision shared by browser prediction, the Worker authority, bots
 * and the navigation build. It is deliberately dependency-free: the same file runs in a
 * Durable Object, in Node test tools and in the client bundle.
 *
 * Queries are the ones movement needs, not a general physics engine:
 *   floor    - highest standable surface at or below a step above the feet
 *   blocked  - a vertical capsule/cylinder slice intersects any surface
 *   ceiling  - first surface above the head while rising
 *   ray      - any surface between two points (shots, sight lines, splash)
 * Surfaces are two-sided: an exported wall is a thin sheet, so both facings must stop a
 * player and a bullet.
 */
export interface RayHit { t: number; triangle: number; nx: number; ny: number; nz: number }

const WALKABLE_NORMAL_Y = Math.cos(50 * Math.PI / 180)
/** Capsule radius used for every Guardian collision query. Set a few centimetres under the
 * true Spartan radius as a skin margin: the collision mesh is a simplification of the
 * downloaded model, and decimation, welding and per-plane merging can each shift a wall or a
 * doorway jamb by a millimetre or two. Without margin those add up at a tight doorway into a
 * capsule that catches on geometry a player cannot see the difference from. */
export const GUARDIAN_PLAYER_RADIUS = .25
const LEAF_SIZE = 6

export class TriangleMesh {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  readonly triangleCount: number
  /** Unit normals, 3 per triangle. */
  readonly normals: Float32Array
  private readonly bounds: Float32Array
  /** Per node: [firstChild or -(start+1), childCount or triangleCount]. */
  private readonly nodes: Int32Array
  private readonly order: Uint32Array
  private nodeCount = 0

  constructor(positions: Float32Array, indices: Uint32Array) {
    this.positions = positions
    this.indices = indices
    this.triangleCount = indices.length / 3
    this.normals = new Float32Array(this.triangleCount * 3)
    const centroids = new Float32Array(this.triangleCount * 3)
    for (let t = 0; t < this.triangleCount; t++) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
      const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const length = Math.hypot(nx, ny, nz) || 1
      nx /= length; ny /= length; nz /= length
      this.normals[t * 3] = nx; this.normals[t * 3 + 1] = ny; this.normals[t * 3 + 2] = nz
      centroids[t * 3] = (positions[a] + positions[b] + positions[c]) / 3
      centroids[t * 3 + 1] = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3
      centroids[t * 3 + 2] = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3
    }
    const maxNodes = Math.max(1, 2 * Math.ceil(this.triangleCount / LEAF_SIZE) * 2)
    this.bounds = new Float32Array(maxNodes * 6)
    this.nodes = new Int32Array(maxNodes * 2)
    this.order = new Uint32Array(this.triangleCount)
    for (let i = 0; i < this.triangleCount; i++) this.order[i] = i
    this.build(centroids)
  }

  private build(centroids: Float32Array): void {
    const stack: [number, number, number][] = []
    const root = this.nodeCount++
    stack.push([root, 0, this.triangleCount])
    const order = this.order, positions = this.positions, indices = this.indices, bounds = this.bounds
    while (stack.length) {
      const [node, start, end] = stack.pop()!
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity, cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity
      for (let i = start; i < end; i++) {
        const t = order[i]
        for (let k = 0; k < 3; k++) {
          const v = indices[t * 3 + k] * 3
          const x = positions[v], y = positions[v + 1], z = positions[v + 2]
          if (x < minX) minX = x; if (x > maxX) maxX = x
          if (y < minY) minY = y; if (y > maxY) maxY = y
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
        }
        const cx = centroids[t * 3], cy = centroids[t * 3 + 1], cz = centroids[t * 3 + 2]
        if (cx < cMinX) cMinX = cx; if (cx > cMaxX) cMaxX = cx
        if (cy < cMinY) cMinY = cy; if (cy > cMaxY) cMaxY = cy
        if (cz < cMinZ) cMinZ = cz; if (cz > cMaxZ) cMaxZ = cz
      }
      bounds[node * 6] = minX; bounds[node * 6 + 1] = minY; bounds[node * 6 + 2] = minZ
      bounds[node * 6 + 3] = maxX; bounds[node * 6 + 4] = maxY; bounds[node * 6 + 5] = maxZ
      const count = end - start
      const spanX = cMaxX - cMinX, spanY = cMaxY - cMinY, spanZ = cMaxZ - cMinZ
      if (count <= LEAF_SIZE || Math.max(spanX, spanY, spanZ) < 1e-6) {
        this.nodes[node * 2] = -(start + 1)
        this.nodes[node * 2 + 1] = count
        continue
      }
      const axis = spanX >= spanY && spanX >= spanZ ? 0 : spanY >= spanZ ? 1 : 2
      const slice = Array.from(order.subarray(start, end)).sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis])
      order.set(slice, start)
      const mid = start + (count >> 1)
      const left = this.nodeCount++, right = this.nodeCount++
      this.nodes[node * 2] = left
      this.nodes[node * 2 + 1] = 2
      stack.push([left, start, mid], [right, mid, end])
    }
  }

  private rayBox(node: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, maxT: number): boolean {
    const b = this.bounds, o = node * 6
    let tMin = 0, tMax = maxT
    let t1 = (b[o] - ox) * ix, t2 = (b[o + 3] - ox) * ix
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s }
    if (t1 > tMin) tMin = t1; if (t2 < tMax) tMax = t2
    if (tMin > tMax) return false
    t1 = (b[o + 1] - oy) * iy; t2 = (b[o + 4] - oy) * iy
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s }
    if (t1 > tMin) tMin = t1; if (t2 < tMax) tMax = t2
    if (tMin > tMax) return false
    t1 = (b[o + 2] - oz) * iz; t2 = (b[o + 5] - oz) * iz
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s }
    if (t1 > tMin) tMin = t1; if (t2 < tMax) tMax = t2
    return tMin <= tMax
  }

  /** Two-sided Möller–Trumbore; returns distance along the ray or -1. */
  private rayTriangle(t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const p = this.positions, i = this.indices
    const a = i[t * 3] * 3, b = i[t * 3 + 1] * 3, c = i[t * 3 + 2] * 3
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2]
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2]
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-12) return -1
    const inv = 1 / det
    const tx = ox - p[a], ty = oy - p[a + 1], tz = oz - p[a + 2]
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < -1e-6 || u > 1 + 1e-6) return -1
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < -1e-6 || u + v > 1 + 1e-6) return -1
    return (e2x * qx + e2y * qy + e2z * qz) * inv
  }

  /** Closest hit along a ray, optionally restricted to triangles accepted by `filter`. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, filter?: (triangle: number) => boolean): RayHit | null {
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz
    let best = maxT, bestTriangle = -1
    const stack = [0]
    while (stack.length) {
      const node = stack.pop()!
      if (!this.rayBox(node, ox, oy, oz, ix, iy, iz, best)) continue
      const first = this.nodes[node * 2]
      if (first < 0) {
        const start = -first - 1, end = start + this.nodes[node * 2 + 1]
        for (let i = start; i < end; i++) {
          const t = this.order[i]
          if (filter && !filter(t)) continue
          const d = this.rayTriangle(t, ox, oy, oz, dx, dy, dz)
          if (d > 1e-7 && d < best) { best = d; bestTriangle = t }
        }
      } else stack.push(first, first + 1)
    }
    if (bestTriangle < 0) return null
    return { t: best, triangle: bestTriangle, nx: this.normals[bestTriangle * 3], ny: this.normals[bestTriangle * 3 + 1], nz: this.normals[bestTriangle * 3 + 2] }
  }

  /** True if any surface lies on the segment. Cheaper than the closest hit. */
  segmentHits(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const length = Math.hypot(dx, dy, dz)
    if (length < 1e-6) return false
    const ix = length / dx, iy = length / dy, iz = length / dz
    const ux = dx / length, uy = dy / length, uz = dz / length
    const stack = [0]
    while (stack.length) {
      const node = stack.pop()!
      if (!this.rayBox(node, ax, ay, az, ix, iy, iz, length)) continue
      const first = this.nodes[node * 2]
      if (first < 0) {
        const start = -first - 1, end = start + this.nodes[node * 2 + 1]
        for (let i = start; i < end; i++) {
          const d = this.rayTriangle(this.order[i], ax, ay, az, ux, uy, uz)
          if (d > 1e-7 && d < length) return true
        }
      } else stack.push(first, first + 1)
    }
    return false
  }

  /** Visit every triangle whose bounding box overlaps the query box; return true to stop. */
  forEachInBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, visit: (triangle: number) => boolean | void): boolean {
    const b = this.bounds, stack = [0]
    while (stack.length) {
      const node = stack.pop()!, o = node * 6
      if (b[o] > maxX || b[o + 3] < minX || b[o + 1] > maxY || b[o + 4] < minY || b[o + 2] > maxZ || b[o + 5] < minZ) continue
      const first = this.nodes[node * 2]
      if (first < 0) {
        const start = -first - 1, end = start + this.nodes[node * 2 + 1]
        for (let i = start; i < end; i++) if (visit(this.order[i])) return true
      } else stack.push(first, first + 1)
    }
    return false
  }

  /** The triangle clipped to the horizontal slab y0..y1, or null when nothing is left. */
  private clipToSlab(t: number, y0: number, y1: number): number[][] | null {
    const p = this.positions, i = this.indices
    let poly: number[][] = [0, 1, 2].map(k => { const v = i[t * 3 + k] * 3; return [p[v], p[v + 1], p[v + 2]] })
    for (const [level, keepAbove] of [[y0, true], [y1, false]] as const) {
      const next: number[][] = []
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length]
        const aIn = keepAbove ? a[1] >= level : a[1] <= level, bIn = keepAbove ? b[1] >= level : b[1] <= level
        if (aIn) next.push(a)
        if (aIn !== bIn) { const s = (level - a[1]) / (b[1] - a[1]); next.push([a[0] + (b[0] - a[0]) * s, level, a[2] + (b[2] - a[2]) * s]) }
      }
      poly = next
      if (poly.length < 2) return null
    }
    return poly
  }

  /** Where a vertical cylinder at (x,z) touches the triangle: the horizontal direction from the
   * nearest contact to the axis and how deep the triangle reaches in, or null if they miss. */
  cylinderContact(t: number, x: number, z: number, y0: number, y1: number, r: number): [number, number, number] | null {
    const poly = this.clipToSlab(t, y0, y1)
    if (!poly) return null
    let positive = 0, negative = 0, distance = Infinity, projectedArea = 0, cx = 0, cz = 0
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length]
      projectedArea += a[0]*b[2]-b[0]*a[2]
      const ex = b[0] - a[0], ez = b[2] - a[2], wx = x - a[0], wz = z - a[2]
      const cross = ex * wz - ez * wx
      if (cross > 1e-12) positive++; else if (cross < -1e-12) negative++
      const lengthSq = ex * ex + ez * ez
      const s = lengthSq > 1e-12 ? Math.max(0, Math.min(1, (wx * ex + wz * ez) / lengthSq)) : 0
      const d = Math.hypot(wx - ex * s, wz - ez * s)
      if (d < distance) { distance = d; cx = a[0] + ex * s; cz = a[2] + ez * s }
    }
    let nx = this.normals[t * 3], nz = this.normals[t * 3 + 2]
    const flat = Math.hypot(nx, nz)
    // Surfaces are two-sided: turn the face toward the side of it the body's centre is on.
    const p = this.positions, a = this.indices[t * 3] * 3
    if ((x - p[a]) * nx + ((y0 + y1) / 2 - p[a + 1]) * this.normals[t * 3 + 1] + (z - p[a + 2]) * nz < 0) { nx = -nx; nz = -nz }
    // The axis stands over a sloped face: push along the face's own horizontal normal.
    if (poly.length >= 3 && Math.abs(projectedArea)>1e-10 && !(positive && negative))
      return flat > 1e-6 ? [nx / flat, nz / flat, r + distance] : null
    if (distance > r) return null
    if (distance > 1e-6) return [(x - cx) / distance, (z - cz) / distance, r - distance]
    return flat > 1e-6 ? [nx / flat, nz / flat, r] : null
  }

  /** Does the triangle intersect a vertical cylinder (radius r, height y0..y1) at (x,z)? */
  triangleHitsCylinder(t: number, x: number, z: number, y0: number, y1: number, r: number): boolean {
    // Clip the triangle to the horizontal slab, then measure the planar distance to (x,z).
    const poly = this.clipToSlab(t, y0, y1)
    if (!poly) return false
    // The clipped triangle is convex: (x,z) is inside when every edge turns the same way.
    let positive = 0, negative = 0, distance = Infinity, projectedArea = 0
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length]
      projectedArea += a[0]*b[2]-b[0]*a[2]
      const ex = b[0] - a[0], ez = b[2] - a[2], wx = x - a[0], wz = z - a[2]
      const cross = ex * wz - ez * wx
      if (cross > 1e-12) positive++; else if (cross < -1e-12) negative++
      const lengthSq = ex * ex + ez * ez
      const s = lengthSq > 1e-12 ? Math.max(0, Math.min(1, (wx * ex + wz * ez) / lengthSq)) : 0
      distance = Math.min(distance, Math.hypot(wx - ex * s, wz - ez * s))
    }
    // A vertical wall projects to a line, not a filled polygon. On that line all cross
    // products vanish even OUTSIDE the segment (e.g. in its doorway opening). Such a
    // degenerate projection must use edge distance instead of the polygon-inside shortcut.
    if (poly.length >= 3 && Math.abs(projectedArea)>1e-10 && !(positive && negative)) return true
    return distance <= r
  }
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

let mesh: TriangleMesh | null = null
/** The shipped Guardian collision mesh, decoded and indexed on first use. */
export function guardianMesh(): TriangleMesh {
  if (mesh) return mesh
  const data = guardianCollisionData()
  const positionBytes = decode(data.positions), indexBytes = decode(data.indices)
  const quantized = new Uint16Array(positionBytes.buffer, positionBytes.byteOffset, positionBytes.byteLength / 2)
  const positions = new Float32Array(quantized.length)
  for (let i = 0; i < quantized.length; i++) positions[i] = data.bounds.min[i % 3] + quantized[i] * data.quantum
  const raw = data.indexBytes === 2
    ? new Uint16Array(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength / 2)
    : new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength / 4)
  mesh = new TriangleMesh(positions, new Uint32Array(raw))
  return mesh
}

/** Nothing stands below this; movement treats it as the bottom of the void. */
export const GUARDIAN_VOID_FLOOR = Math.floor(GUARDIAN_COLLISION_BOUNDS.min[1]) - 6
/** Movement queries against any TriangleMesh, so the tools can also run them on the full render mesh. */
export class MeshCollision {
  readonly mesh: TriangleMesh
  readonly voidFloor: number
  private readonly supportMesh: TriangleMesh
  constructor(mesh: TriangleMesh, voidFloor = GUARDIAN_VOID_FLOOR, indexSupport = false) {
    this.mesh = mesh; this.voidFloor = voidFloor
    // Detailed static maps spend most movement queries looking down past walls and
    // trim. Index the same walkable-angle triangles separately; no geometry is added,
    // moved or removed from body/projectile collision. Guardian keeps its original path.
    if(indexSupport){
      const indices:number[]=[]
      for(let t=0;t<mesh.triangleCount;t++)if(Math.abs(mesh.normals[t*3+1])>=WALKABLE_NORMAL_Y)
        indices.push(mesh.indices[t*3],mesh.indices[t*3+1],mesh.indices[t*3+2])
      this.supportMesh=new TriangleMesh(mesh.positions,new Uint32Array(indices))
    }else this.supportMesh=mesh
  }
  private walkable = (t: number): boolean => Math.abs(this.supportMesh.normals[t * 3 + 1]) >= WALKABLE_NORMAL_Y
  /** Highest standable surface no higher than `step` above `y`; the void floor if none. */
  floor(x: number, z: number, y: number, step: number): number {
    const top = y + step + .005
    const hit = this.supportMesh.raycast(x, top, z, 0, -1, 0, top - this.voidFloor, this.walkable)
    return hit ? top - hit.t : this.voidFloor
  }
  /** Capsule-foot support over narrow mesh seams. Extend the contacted plane to the
   * foot centre only within the footprint; never manufacture support over a wide gap. */
  supportedFloor(x:number,z:number,y:number,step:number,radius:number):number {
    const top=y+step+.005
    let floor=this.floor(x,z,y,step)
    for(const [dx,dz] of [[radius,0],[-radius,0],[0,radius],[0,-radius]]){
      const hit=this.supportMesh.raycast(x+dx,top,z+dz,0,-1,0,top-this.voidFloor,this.walkable)
      if(!hit)continue
      const atCentre=top-hit.t+(hit.nx*dx+hit.nz*dz)/hit.ny
      if(atCentre<=top&&atCentre>floor)floor=atCentre
    }
    return floor
  }
  /** Any surface inside the standing cylinder between the step line and the head. */
  blocked(x: number, z: number, y: number, height: number, radius = GUARDIAN_PLAYER_RADIUS, step = .3658): boolean {
    const y0 = y + step + .001, y1 = y + height - .02
    if (y1 <= y0) return false
    return this.mesh.forEachInBox(x - radius, y0, z - radius, x + radius, y1, z + radius, t => this.mesh.triangleHitsCylinder(t, x, z, y0, y1, radius))
  }
  /** The horizontal push-out direction of whatever the standing cylinder overlaps, and the
   * deepest overlap: the plane a collide-and-slide move slides along, or the way out for
   * depenetration. Deeper contacts weigh more, so a rock's many facets average into its overall
   * face. With a motion (mx,mz), faces the body is moving away from are left out. */
  contactNormal(x: number, z: number, y: number, height: number, radius: number, step: number, mx = 0, mz = 0): [number, number, number] | null {
    const y0 = y + step + .001, y1 = y + height - .02
    if (y1 <= y0) return null
    let sx = 0, sz = 0, deepest = 0
    this.mesh.forEachInBox(x - radius, y0, z - radius, x + radius, y1, z + radius, t => {
      const contact = this.mesh.cylinderContact(t, x, z, y0, y1, radius)
      if (!contact) return
      const [nx, nz, depth] = contact
      if (nx * mx + nz * mz > 0) return
      sx += nx * depth; sz += nz * depth; deepest = Math.max(deepest, depth)
    })
    const length = Math.hypot(sx, sz)
    return length > 1e-9 ? [sx / length, sz / length, deepest] : null
  }
  /** First surface above `y0` up to `y1`, or null. */
  ceiling(x: number, z: number, y0: number, y1: number): number | null {
    if (y1 <= y0) return null
    // A vertical ray can also cross a sloped wall or a door jamb at the sampled x/z. Those
    // surfaces are not ceilings; treating them as one creates phantom zero-height doorways in
    // Lockout's navigation grid. Only walkable-angle surfaces are ceilings here, so steep jambs
    // and walls cannot become phantom zero-height doorways.
    const hit = this.supportMesh.raycast(x, y0, z, 0, 1, 0, y1 - y0, this.walkable)
    return hit ? y0 + hit.t : null
  }
  /** Is anything solid between the two points? */
  ray(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.mesh.segmentHits(ax, ay, az, bx, by, bz)
  }
  /** Is the point inside a thin margin of a surface? Used for server hit tracing along a ray. */
  solidAt(x: number, y: number, z: number, margin = .06): boolean {
    return this.mesh.forEachInBox(x - margin, y - margin, z - margin, x + margin, y + margin, z + margin, t => this.pointNearTriangle(t, x, y, z, margin))
  }
  private pointNearTriangle(t: number, x: number, y: number, z: number, margin: number): boolean {
    const n = this.mesh.normals, p = this.mesh.positions, i = this.mesh.indices, a = i[t * 3] * 3
    const distance = (x - p[a]) * n[t * 3] + (y - p[a + 1]) * n[t * 3 + 1] + (z - p[a + 2]) * n[t * 3 + 2]
    if (Math.abs(distance) > margin) return false
    // Project onto the plane and check the footprint with the cylinder test around the vertical axis.
    const px = x - n[t * 3] * distance, py = y - n[t * 3 + 1] * distance, pz = z - n[t * 3 + 2] * distance
    return this.mesh.triangleHitsCylinder(t, px, pz, py - margin, py + margin, margin)
  }
}

let collision: MeshCollision | null = null
export function guardianCollision(): MeshCollision {
  return collision ??= new MeshCollision(guardianMesh())
}
