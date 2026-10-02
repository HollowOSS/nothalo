import * as THREE from 'three'
import type { TriangleMesh } from '../../shared/guardian-collision.ts'

export interface GrenadeContact { point: THREE.Vector3; normal: THREE.Vector3 }

/** Physical segment query: no camera-shot deck grace or heightfield underneath stacked decks. */
export function grenadeMeshContact(mesh: TriangleMesh, a: THREE.Vector3, b: THREE.Vector3): GrenadeContact | null {
  const direction = b.clone().sub(a), length = direction.length()
  if (length < 1e-8) return null
  direction.divideScalar(length)
  const hit = mesh.raycast(a.x, a.y, a.z, direction.x, direction.y, direction.z, length)
  if (!hit) return null
  const normal = new THREE.Vector3(hit.nx, hit.ny, hit.nz)
  if (normal.dot(direction) > 0) normal.negate()
  return { point: a.clone().addScaledVector(direction, hit.t), normal }
}

export function bounceGrenade(velocity: THREE.Vector3, normal: THREE.Vector3): void {
  const speed = velocity.dot(normal)
  if (speed >= 0) return
  velocity.addScaledVector(normal, -speed).multiplyScalar(.62).addScaledVector(normal, -speed * .42)
}
