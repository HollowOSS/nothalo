import { TriangleMesh, MeshCollision } from './guardian-collision.ts'
import { lockoutCollisionData } from './level-data.ts'
import { lockoutScale } from './lockout-transform.ts'

/**
 * Lockout's gameplay collision: a cleaned, welded and simplified static triangle mesh
 * (tools/build-lockout-collision-mesh.mjs), indexed into the
 * same BVH the Guardian queries use. Walls, deck rims, rails and floors are all here; the cliff
 * shell around the arena is not, because nothing can reach it and a body that leaves the decks
 * is meant to fall. Runs unchanged in the browser, the Worker and the Node checks.
 */
function decode(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

let mesh: TriangleMesh | null = null
export function lockoutMesh(): TriangleMesh {
  if (mesh) return mesh
  const data = lockoutCollisionData()
  const positionBytes = decode(data.positions), indexBytes = decode(data.indices)
  const quantized = new Uint16Array(positionBytes.buffer, positionBytes.byteOffset, positionBytes.byteLength / 2)
  const k = lockoutScale()
  const positions = new Float32Array(quantized.length)
  for (let i = 0; i < quantized.length; i++) positions[i] = (data.bounds.min[i % 3] + quantized[i] * data.quantum) * k
  const raw = (data.indexBytes as number) === 2
    ? new Uint16Array(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength / 2)
    : new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength / 4)
  mesh = new TriangleMesh(positions, new Uint32Array(raw))
  return mesh
}

/** Below the lowest deck by a margin; a body that drops past it is over the pit. */
export const LOCKOUT_VOID_FLOOR = -30

let collision: MeshCollision | null = null
export function lockoutCollision(): MeshCollision {
  return collision ??= new MeshCollision(lockoutMesh(), LOCKOUT_VOID_FLOOR * lockoutScale(), true)
}
