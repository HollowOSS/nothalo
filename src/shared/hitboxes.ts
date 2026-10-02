import { HITBOX_CROUCH, HITBOX_HEADINGS, HITBOX_KINDS, HITBOX_MOVING_BACK_MM, HITBOX_MOVING_MM, HITBOX_PHASES, HITBOX_PITCHES, HITBOX_RADII, HITBOX_STAND } from './hitbox-data.ts'
import { gaitMoving } from './gait.ts'

/**
 * Where a shot lands on a Spartan: eleven capsules — head, chest, pelvis, an upper and lower
 * segment for each arm and leg — fitted to the drawn model by tools/build-hitboxes.mjs.
 *
 * Nobody's skeleton runs on the server, so the capsules are posed from what the server does know
 * about a player: where they stand, which way they face, how far up or down they aim, whether they
 * crouch, how fast and which way they move, and where they are in their stride — the stride phase
 * the server keeps and every client draws remote Spartans at (gait.ts). That is interpolated between
 * poses sampled from the real rig and leg IK, so a leg mid-step is where it is drawn.
 *
 * The server's hitscan, the offline match and the client's red reticle all call `rayHitBody`, which
 * is what makes "the reticle was red" and "the shot landed" the same statement.
 */

export type HitPart = 'head' | 'chest' | 'pelvis' | 'arm' | 'leg'
const PART_NAMES: readonly HitPart[] = ['head', 'chest', 'pelvis', 'arm', 'leg']

/**
 * What the shapes are posed from. Yaw 0 faces -Z, as everywhere; pitch is the aim, + up. Moving: horizontal
 * `speed` (m/s), `heading` of travel in the body's frame (gait.ts `travelHeading`) and stride `phase` (0..1).
 */
export interface HitPose {
  x: number; y: number; z: number; yaw: number; pitch: number; crouched: boolean
  speed?: number; heading?: number; phase?: number
  /** Stepping as a backpedal (gait.ts `nextBackward`): sidesteps are drawn either way. */
  backward?: boolean
}

export interface BodyHit { dist: number; part: HitPart }

/**
 * Added to each fitted radius, m, by part (head, chest, pelvis, arm, leg): the fit hugs the armour, and a
 * little forgiveness past the silhouette — most of all on the helmet — is what makes a hit read as fair.
 * Tuned by play; the fitted shapes underneath stay as measured, so a refit keeps the forgiveness.
 */
export const HIT_PADDING: readonly number[] = [0.065, 0.025, 0.025, 0.025, 0.025]
const RADII = HITBOX_KINDS.map((kind, k) => HITBOX_RADII[k] + HIT_PADDING[kind])

/** The whole body fits in this sphere about its middle; rays that miss it skip the capsules. */
const BOUND_Y = 1.05, BOUND_R = 1.4
/** A ray through the collar can touch the chest a little before the helmet: give the head the benefit. */
const HEAD_PREFERENCE = 0.15

const CAPSULES = HITBOX_KINDS.length
const posed = new Float64Array(CAPSULES * 6)
/** Body-frame working poses: still at this pitch, still at pitch 0, and moving. */
const still = new Float64Array(CAPSULES * 6), level = new Float64Array(CAPSULES * 6), stride = new Float64Array(CAPSULES * 6)
const decode = (b64: string) => new Int16Array(Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)).buffer)
const MOVING = decode(HITBOX_MOVING_MM), MOVING_BACK = decode(HITBOX_MOVING_BACK_MM)
/** Directions of travel where the legs may be drawn walking or backpedalling (gait.ts): these have a second, backpedalling table. */
const BAND = Array.from({ length: HITBOX_HEADINGS }, (_, i) => i).filter(i => {
  const off = Math.abs(Math.atan2(Math.sin(i / HITBOX_HEADINGS * Math.PI * 2), Math.cos(i / HITBOX_HEADINGS * Math.PI * 2)))
  return off > 1.2 && off < 1.94
})
const POSE_SIZE = CAPSULES * 6
const LEVEL = HITBOX_PITCHES.indexOf(0)

/** The still pose at `pitch`, body frame, into `out`. */
function stillAt(crouched: boolean, pitch: number, out: Float64Array): void {
  const table = crouched ? HITBOX_CROUCH : HITBOX_STAND
  const last = HITBOX_PITCHES.length - 1
  const clamped = Math.min(Math.max(pitch, HITBOX_PITCHES[0]), HITBOX_PITCHES[last])
  let i = 0
  while (i < last - 1 && clamped > HITBOX_PITCHES[i + 1]) i++
  const f = (clamped - HITBOX_PITCHES[i]) / (HITBOX_PITCHES[i + 1] - HITBOX_PITCHES[i])
  const lo = table[i], hi = table[i + 1]
  for (let k = 0; k < CAPSULES; k++) for (let j = 0; j < 6; j++) out[k * 6 + j] = lo[k][j] + (hi[k][j] - lo[k][j]) * f
}

/** The moving pose at this direction of travel and stride phase, body frame, aim level, into `out`: bilinear and wrapping in both. */
function movingAt(crouched: boolean, heading: number, phase: number, backward: boolean, out: Float64Array): void {
  const h = ((heading / (Math.PI * 2)) % 1 + 1) % 1 * HITBOX_HEADINGS, ph = ((phase % 1) + 1) % 1 * HITBOX_PHASES
  const h0 = Math.floor(h) % HITBOX_HEADINGS, h1 = (h0 + 1) % HITBOX_HEADINGS, fh = h - Math.floor(h)
  const p0 = Math.floor(ph) % HITBOX_PHASES, p1 = (p0 + 1) % HITBOX_PHASES, fp = ph - Math.floor(ph)
  const crouch = crouched ? 1 : 0
  const table = (hi: number) => backward && BAND.includes(hi) ? MOVING_BACK : MOVING
  const at = (hi: number, pi: number) => backward && BAND.includes(hi)
    ? ((crouch * BAND.length + BAND.indexOf(hi)) * HITBOX_PHASES + pi) * POSE_SIZE
    : ((crouch * HITBOX_HEADINGS + hi) * HITBOX_PHASES + pi) * POSE_SIZE
  const T0 = table(h0), T1 = table(h1)
  const a = at(h0, p0), b = at(h0, p1), c = at(h1, p0), d = at(h1, p1)
  for (let j = 0; j < POSE_SIZE; j++) {
    const top = T0[a + j] + (T0[b + j] - T0[a + j]) * fp
    const bottom = T1[c + j] + (T1[d + j] - T1[c + j]) * fp
    out[j] = (top + (bottom - top) * fh) / 1000
  }
}

/** Fill `posed` with the capsules' world end points for this pose. */
function poseShapes(p: HitPose): void {
  stillAt(p.crouched, p.pitch, still)
  const moving = gaitMoving(p.speed ?? 0)
  if (moving > 0) {
    // The stride's pose, with the aim's effect on the head, chest and arms laid over it, eased in with speed.
    movingAt(p.crouched, p.heading ?? 0, p.phase ?? 0, p.backward ?? false, stride)
    stillAt(p.crouched, HITBOX_PITCHES[LEVEL], level)
    for (let k = 0; k < CAPSULES; k++) {
      const upper = HITBOX_KINDS[k] !== 2 && HITBOX_KINDS[k] !== 4
      for (let j = 0; j < 6; j++) {
        const i = k * 6 + j, walking = stride[i] + (upper ? still[i] - level[i] : 0)
        still[i] += (walking - still[i]) * moving
      }
    }
  }
  // The same turn the renderer gives the model: three.js rotation about +Y.
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw)
  for (let k = 0; k < CAPSULES; k++) {
    for (let e = 0; e < 2; e++) {
      const o = k * 6 + e * 3
      const lx = still[o], ly = still[o + 1], lz = still[o + 2]
      posed[o] = p.x + lx * c + lz * s
      posed[o + 1] = p.y + ly
      posed[o + 2] = p.z - lx * s + lz * c
    }
  }
}

/** Distance along a unit ray to a capsule, or -1. A ray starting inside it does not count. */
function rayCapsule(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number,
): number {
  const bax = bx - ax, bay = by - ay, baz = bz - az
  const oax = ox - ax, oay = oy - ay, oaz = oz - az
  const baba = bax * bax + bay * bay + baz * baz
  const bard = bax * dx + bay * dy + baz * dz
  const baoa = bax * oax + bay * oay + baz * oaz
  const rdoa = dx * oax + dy * oay + dz * oaz
  const oaoa = oax * oax + oay * oay + oaz * oaz
  const a = baba - bard * bard
  if (a > 1e-9) {
    // The cylinder between the end points.
    const b = baba * rdoa - baoa * bard
    const cc = baba * oaoa - baoa * baoa - r * r * baba
    const h = b * b - a * cc
    if (h < 0) return -1
    const t = (-b - Math.sqrt(h)) / a
    const y = baoa + t * bard
    if (y > 0 && y < baba) return t > 0 ? t : -1
    // Past an end: the sphere capping that end.
    const cx = y <= 0 ? oax : ox - bx, cy = y <= 0 ? oay : oy - by, cz = y <= 0 ? oaz : oz - bz
    return raySphere(cx, cy, cz, dx, dy, dz, r)
  }
  // Ray along the axis, or a capsule shrunk to a sphere: the nearer end sphere decides.
  const ta = raySphere(oax, oay, oaz, dx, dy, dz, r)
  const tb = raySphere(ox - bx, oy - by, oz - bz, dx, dy, dz, r)
  return ta < 0 ? tb : tb < 0 ? ta : Math.min(ta, tb)
}

/** Ray from offset (cx, cy, cz) relative to a sphere's centre. */
function raySphere(cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, r: number): number {
  const b = cx * dx + cy * dy + cz * dz
  const c = cx * cx + cy * cy + cz * cz - r * r
  const h = b * b - c
  if (h < 0) return -1
  const t = -b - Math.sqrt(h)
  return t > 0 ? t : -1
}

/**
 * The first body part a unit-length ray meets on this player, within `maxDist`, or null. Walls are
 * the caller's business: this only knows about the body.
 */
export function rayHitBody(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  pose: HitPose, maxDist: number,
): BodyHit | null {
  // Cheap reject first: almost every ray in a match passes nowhere near almost every player.
  const bx = pose.x - ox, by = pose.y + BOUND_Y - oy, bz = pose.z - oz
  const along = bx * dx + by * dy + bz * dz
  if (along < -BOUND_R || along - BOUND_R > maxDist) return null
  if (bx * bx + by * by + bz * bz - along * along > BOUND_R * BOUND_R) return null

  poseShapes(pose)
  let best = -1, bestKind = 0, head = -1
  for (let k = 0; k < HITBOX_KINDS.length; k++) {
    const o = k * 6
    const t = rayCapsule(ox, oy, oz, dx, dy, dz, posed[o], posed[o + 1], posed[o + 2], posed[o + 3], posed[o + 4], posed[o + 5], RADII[k])
    if (t < 0 || t > maxDist) continue
    if (HITBOX_KINDS[k] === 0) head = t
    if (best < 0 || t < best) { best = t; bestKind = HITBOX_KINDS[k] }
  }
  if (best < 0) return null
  if (head >= 0 && head - best <= HEAD_PREFERENCE) return { dist: head, part: 'head' }
  return { dist: best, part: PART_NAMES[bestKind] }
}

/** The posed capsules, for drawing them over the model when checking the fit (`?hitboxes`). */
export function bodyCapsules(pose: HitPose): { a: [number, number, number]; b: [number, number, number]; r: number; part: HitPart }[] {
  poseShapes(pose)
  return HITBOX_KINDS.map((kind, k) => ({
    a: [posed[k * 6], posed[k * 6 + 1], posed[k * 6 + 2]],
    b: [posed[k * 6 + 3], posed[k * 6 + 4], posed[k * 6 + 5]],
    r: RADII[k], part: PART_NAMES[kind],
  }))
}
