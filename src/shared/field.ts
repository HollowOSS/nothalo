/**
 * The canyon as a set of pure functions.
 *
 * This lives in shared/ rather than with the renderer because the server has to agree with the
 * client about where the ground is, exactly. A predicted step that lands on a different height
 * than the authority computed is a rubber-band, so both sides call this same function.
 *
 * The original note follows.
 *
 * The canyon as a set of pure functions: where the rim is, how high the ground is, and
 * how much of a given spot is bare sand rather than grass.
 *
 * Floor mesh, cliff ring and ground texture all read from here, so the wall always meets
 * the floor at exactly the same height and the sand under the wall never disagrees with
 * the sand on it.
 */
import { CANYON_LENGTH, CANYON_WIDTH, BASE_RADIUS, RED_BASE, BLUE_BASE, HILL } from './map.ts'
import { clamp01, fbm, sfbm, smoothstep } from './noise.ts'

const HX = CANYON_WIDTH / 2
const HZ = CANYON_LENGTH / 2

/** Ground area the floor mesh covers; it runs well under the cliff walls. */
export const FLOOR_HALF_X = HX + 32
export const FLOOR_HALF_Z = HZ + 42

/**
 * Distance from the canyon centre to the foot of the cliff, for a direction angle.
 * A superellipse gives the long rounded-rectangle plan from the tactical map; the noise
 * term wobbles it into bays and headlands. Star-shaped by construction, which is what
 * lets the floor use a cheap implicit test against the same curve.
 */
export function rimRadius(angle: number): number {
  const cx = Math.cos(angle)
  const cz = Math.sin(angle)
  const e = 4
  const base =
    1 / Math.pow(Math.pow(Math.abs(cx) / HX, e) + Math.pow(Math.abs(cz) / HZ, e), 1 / e)
  const wob =
    0.93 +
    0.15 * fbm(cx * 3.4 + 11.3, cz * 3.4 + 4.7, 3) +
    0.035 * fbm(cx * 11.0 - 3.1, cz * 11.0 + 8.2, 2)
  return base * wob
}

/** 1 at the foot of the cliff, 0 at the canyon centre. */
export function rimFraction(x: number, z: number): number {
  const r = Math.hypot(x, z)
  if (r < 1e-4) return 0
  return r / rimRadius(Math.atan2(z, x))
}

/**
 * The sniper shelf on the east wall that the `ridge-overlook` vantage stands on, and its
 * mirror image on the west wall in blue's half. Both carry a teleporter receiver
 * (`TELEPORTERS` in map.ts), so the ledges are the same feature the real map has: a raised
 * flank you arrive on and walk down from, not a dead-end perch.
 * Written as a blend toward an absolute height, not an additive bump, so the camera
 * height in vantage.ts stays a fixed distance above it however the mounds move.
 */
export const SHELF_TOP = 18.6

function shelfMask(x: number, z: number): number {
  const sx = smoothstep(57.5, 60.5, x)
  const sz = smoothstep(-114, -99, z) * (1 - smoothstep(-52, -34, z))
  return sx * sz
}

function shelfTop(x: number, z: number): number {
  // The shelf tilts down toward its lip, so standing on it you see the canyon, not
  // twenty metres of your own ledge.
  return SHELF_TOP - 1.0 + 2.4 * smoothstep(60, 84, x) + 1.3 * sfbm(x / 24, z / 24, 2) + 0.6 * sfbm(x / 7, z / 7, 2)
}

/** The midfield hill: a smooth dome with a little noise so its flank is not a perfect arc. */
function hillRise(x: number, z: number): number {
  const d = Math.hypot(x - HILL.x, z - HILL.z)
  if (d >= HILL.r) return 0
  const t = 1 - d / HILL.r
  const dome = t * t * (3 - 2 * t)
  return HILL.h * dome * (0.88 + 0.24 * fbm(x / 11 + 2.2, z / 11 - 4.4, 2))
}

/** Metres above the floor datum. */
export function groundHeight(x: number, z: number): number {
  let h = 4.8 * sfbm(x / 46 + 3.7, z / 46 - 1.2, 3)
  h += 1.3 * sfbm(x / 15 - 8.1, z / 15 + 5.5, 2)

  // Talus swells up against the cliff foot — the floor never meets rock at a sharp line.
  const ap = smoothstep(0.58, 1.04, rimFraction(x, z))
  h += 12 * ap * ap

  h += hillRise(x, z)

  // Each base sits in its own shallow sandy bowl, so flatten the mounds around it.
  for (const b of [RED_BASE, BLUE_BASE]) {
    const f = 1 - smoothstep(BASE_RADIUS * 0.9, BASE_RADIUS * 3.6, Math.hypot(x - b.x, z - b.z))
    h *= 1 - 0.88 * f
  }

  // The two shelves are point-symmetric through the canyon centre, like the map itself.
  const shelf = shelfMask(x, z)
  if (shelf > 0) h = h * (1 - shelf) + shelf * shelfTop(x, z)
  const mirror = shelfMask(-x, -z)
  if (mirror > 0) h = h * (1 - mirror) + mirror * shelfTop(-x, -z)
  return h
}

/**
 * One strand of the braided path network. Domain-warped ridged noise: the |v| ridge gives
 * a thin winding line, the warp makes it meander and split the way the map's paths do.
 */
function braid(x: number, z: number, freq: number, warp: number, seed: number, width: number): number {
  const wf = freq * 2.4
  const wx = x + warp * sfbm(x * wf + seed, z * wf - seed, 2)
  const wz = z + warp * sfbm(x * wf - seed * 1.7, z * wf + seed * 0.6, 2)
  // Anisotropic: the noise is squashed across the canyon and stretched along it, so the
  // ridge lines run end to end and fork, instead of closing into the rings that isotropic
  // ridged noise makes.
  const v = sfbm(wx * freq * 2.1 + seed * 3, wz * freq * 0.5 - seed * 2, 3)
  return smoothstep(width, width * 0.12, Math.abs(v))
}

/** 0 = grass, 1 = bare sand. */
export function sandMask(x: number, z: number): number {
  // Four strands at spread frequencies: the map's tracks are a network of narrow forks,
  // so one wide strand reads as a river and three narrow ones read as traffic.
  let s = braid(x, z, 0.0098, 30, 1.7, 0.080)
  s = Math.max(s, 0.94 * braid(x, z, 0.0058, 46, 5.1, 0.056))
  s = Math.max(s, 0.82 * braid(x, z, 0.0176, 16, 9.3, 0.040))

  // Traffic wears the ground bare around the bases and along the cliff foot.
  for (const b of [RED_BASE, BLUE_BASE]) {
    const d = Math.hypot(x - b.x, z - b.z)
    s = Math.max(s, 1 - smoothstep(BASE_RADIUS * 1.15, BASE_RADIUS * 2.8, d))
  }
  s = Math.max(s, smoothstep(0.90, 1.03, rimFraction(x, z)))
  return clamp01(s)
}
