/**
 * Where a Spartan is in its stride, kept by the authority and shared with every client.
 *
 * The walk, run and crouch clips all play at one phase (0..1 through a stride) that advances with
 * distance covered, so the feet do not skate. Each client used to keep its own, starting from a
 * random point — fine for looks, but it meant nobody, the server least of all, knew where a
 * Spartan's legs were drawn. Now the server advances the phase for every player and sends it, the
 * clients draw remote Spartans at it, and the hit shapes are posed from it (src/shared/hitboxes.ts),
 * so a leg mid-stride is hittable where it is drawn.
 *
 * The cadence here is the character's own (character.ts): the clips' native strides, and the leg
 * IK's shortening for steps across the hips and back. The IK eases its hip turn in over a few
 * steps; this uses the settled turn, which only changes how fast the feet cycle, not where they are
 * at a given phase.
 */

/** Below this, m/s, the stride does not advance: standing still holds the feet. */
export const GAIT_MIN_SPEED = 0.1
/** The clip blend's walk and run speeds (character.ts). */
const WALK_SPEED = 0.6, RUN_SPEED = 5.2

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smoothstep = (x: number, a: number, b: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t) }

/** How far the legs have gone over to stepping (0 standing .. 1 moving): the leg IK's `moving`. */
export function gaitMoving(speed: number): number {
  return clamp01((speed - 0.3) / 1.2)
}

/** Direction of travel in the body's frame: 0 forward, +π/2 to the right, ±π straight back. Yaw 0 faces -Z. */
export function travelHeading(vx: number, vz: number, yaw: number): number {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  return Math.atan2(vx * c - vz * s, -vx * s - vz * c)
}

/** Metres covered per stride at this speed, crouch and direction of travel. */
export function strideLength(speed: number, crouched: boolean, heading: number): number {
  const run = clamp01((speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED))
  const native = crouched ? 2 : 2.03 + (3.47 - 2.03) * run
  // Steps across the hips are shorter, and backpedalling ones shorter still (leg-ik.ts).
  const across = (1 - 0.28 * Math.abs(Math.sin(heading))) * (1 - 0.35 * smoothstep(-Math.cos(heading), 0, 1))
  return native * (1 + (across - 1) * gaitMoving(speed))
}

/** The phase after `dt` seconds moving at (vx, vz) facing `yaw`. */
export function advanceGait(phase: number, dt: number, vx: number, vz: number, yaw: number, crouched: boolean, onGround: boolean): number {
  const speed = Math.hypot(vx, vz)
  if (!onGround || speed <= GAIT_MIN_SPEED) return phase
  const next = phase + dt * speed / strideLength(speed, crouched, travelHeading(vx, vz, yaw))
  return next - Math.floor(next)
}

/**
 * Whether the legs step as a backpedal: past 111 degrees off straight ahead they do, under 69 they walk, and in
 * between they keep what they were doing — the leg IK's own hysteresis, so a sidestep does not flip the hips to
 * and fro. In that band the legs can be drawn either way, so the authority decides and says.
 */
export function nextBackward(backward: boolean, heading: number, speed: number): boolean {
  if (gaitMoving(speed) <= 0.05) return backward
  const off = Math.abs(heading)
  return backward ? off >= 1.2 : off > 1.94
}

/** One byte on the wire: the phase in 128 steps, and the backpedal bit. */
export function packGait(phase: number, backward: boolean): number { return (Math.round(phase * 128) & 127) | (backward ? 128 : 0) }
export function unpackGait(byte: number): { phase: number; backward: boolean } { return { phase: (byte & 127) / 128, backward: (byte & 128) !== 0 } }

/** Blend two phases the short way round the cycle. */
export function lerpGait(a: number, b: number, f: number): number {
  let d = b - a
  if (d > 0.5) d -= 1; else if (d < -0.5) d += 1
  const v = a + d * f
  return v - Math.floor(v)
}
