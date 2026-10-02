import {isArena,arenaCollision} from './arena.ts'
import { guardianSolidAt, guardianRay, type MapId } from './guardian.ts'
import { lockoutSolidAt, lockoutRay } from './lockout.ts'
import { groundHeight } from './field.ts'
import { coverBlocksRay } from './cover.ts'
import { baseBlocksPlayer } from './base-collision.ts'

/**
 * What is solid, for anything that has to agree on it without a renderer.
 *
 * The client can raycast the scene; the Durable Object has no scene. Everything here is the
 * analytic description both already share — the fractal floor, the rock circles, the base
 * wall polygon — sampled at a metre. Vehicles, blasts and the server's hitscan all use it, so
 * a rock that stops a Warthog on your screen stops it on the server too.
 */

/** Is this point inside ground or a base wall? */
export function solidAt(x: number, y: number, z: number, map: MapId = 'blood-gulch'): boolean {
  if (isArena(map)) return y < -500 || arenaCollision(map).solidAt(x,y,z)
  if (map === 'guardian') return guardianSolidAt(x,y,z)
  if (map === 'lockout') return lockoutSolidAt(x,y,z)
  return y < groundHeight(x, z) || baseBlocksPlayer(x, z, y - 0.05, 0.1)
}

/** Does terrain, rock or a base wall stand between these two points? */
export function solidBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number, map: MapId = 'blood-gulch'): boolean {
  if (isArena(map)) return arenaCollision(map).ray(ax,ay,az,bx,by,bz)
  if (map === 'guardian') return guardianRay(ax,ay,az,bx,by,bz)
  if (map === 'lockout') return lockoutRay(ax,ay,az,bx,by,bz)
  if (coverBlocksRay(ax, ay, az, bx, by, bz)) return true
  const dist = Math.hypot(bx - ax, by - ay, bz - az)
  const steps = Math.max(2, Math.ceil(dist))
  for (let i = 1; i <= steps; i++) {
    const f = i / steps
    if (solidAt(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f)) return true
  }
  return false
}
