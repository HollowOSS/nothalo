/**
 * Teleporters, as the simulation sees them.
 *
 * A pure lookup: is this capsule standing in the plane of an entrance frame? If so, here is
 * where it comes out and which way it faces. Movement calls this on both sides of the wire,
 * so a predicted trip through a teleporter lands where the server says it does.
 *
 * The trigger is a thin slab across the frame opening rather than a volume you stand in,
 * so walking up beside the frame does nothing and walking through it always fires — the
 * slab is thicker than the furthest a step can carry you, so it cannot be jumped over.
 */
import { TELEPORTERS, type Teleporter } from './map.ts'
import { bloodGulchFloor } from './blood-gulch.ts'

export interface TeleportHit {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly yaw: number
  readonly link: Teleporter
}

/** Opening between the uprights, m. Matches the authored frame. */
export const FRAME_HALF_WIDTH = 1.05
export const FRAME_HEIGHT = 3.0
const SLAB_HALF_DEPTH = 0.45
/** How far in front of the receiver frame you are placed, so you do not stand in it. */
const EXIT_STEP = 1.3

export function teleportAt(x: number, z: number, feet: number): TeleportHit | null {
  for (const t of TELEPORTERS) {
    const fx = -Math.sin(t.entranceYaw)
    const fz = -Math.cos(t.entranceYaw)
    const dx = x - t.entrance.x
    const dz = z - t.entrance.z
    const along = dx * fx + dz * fz
    if (along < -SLAB_HALF_DEPTH || along > SLAB_HALF_DEPTH) continue
    const across = dx * -fz + dz * fx
    if (Math.abs(across) > FRAME_HALF_WIDTH) continue
    if (feet < t.entrance.y - 0.6 || feet > t.entrance.y + FRAME_HEIGHT - 0.5) continue
    const ex = -Math.sin(t.exitYaw)
    const ez = -Math.cos(t.exitYaw)
    const ox = t.exit.x + ex * EXIT_STEP
    const oz = t.exit.z + ez * EXIT_STEP
    return { x: ox, z: oz, y: bloodGulchFloor(ox, oz), yaw: t.exitYaw, link: t }
  }
  return null
}

/** Ground under a receiver frame, for anything that has to draw or stand on it. */
export function exitGround(t: Teleporter): number {
  return bloodGulchFloor(t.exit.x, t.exit.z)
}
