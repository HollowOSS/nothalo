import type { Vector3 } from 'three'

/** Check the barrel hasn't protruded through cover, then trace the actual bullet path. */
export function botShotObstruction(eye: Vector3, muzzle: Vector3, target: Vector3,
  trace: (a: Vector3, b: Vector3) => Vector3 | null): Vector3 | null {
  return trace(eye, muzzle) ?? trace(muzzle, target)
}
