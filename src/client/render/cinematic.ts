import * as THREE from 'three'
import { CANYON_LENGTH, CANYON_WIDTH, RED_BASE, BLUE_BASE } from '../../shared/map.ts'
import { groundHeight } from '../../shared/field.ts'

/**
 * The camera that flies the canyon behind the menu.
 *
 * CE's own menu sat over a slowly drifting view of a level rather than a still image, and the
 * map is already built and lit by the time anyone reads the menu — leaving it unrendered to
 * show a black screen would be the odd choice, not this one.
 *
 * The path is a slow arc between fixed vantage points rather than a circle: a circle reads as
 * a screensaver, where a drift from the ridge down toward a base reads as somewhere you are
 * about to be. Each leg eases in and out, and the camera always looks at a point ahead of
 * where it is going.
 */

interface Leg {
  /** Where the camera sits, and what it looks at. */
  readonly from: readonly [number, number, number]
  readonly at: readonly [number, number, number]
  readonly to: readonly [number, number, number]
  readonly seconds: number
}

const HALF_Z = CANYON_LENGTH / 2
const HALF_X = CANYON_WIDTH / 2

const LEGS: readonly Leg[] = [
  // High off the red end, coming down the length of the canyon. The look-at point is far past
  // the far wall on purpose: it puts the horizon in the top third instead of filling the frame
  // with grass, which is the difference between a view and a patch of ground.
  { from: [-HALF_X * 0.5, 58, -HALF_Z - 70], at: [-HALF_X * 0.2, 44, -HALF_Z + 10], to: [0, 26, HALF_Z], seconds: 24 },
  // Along the east wall at rooftop height, both bases and the midfield hill across the frame.
  { from: [HALF_X + 22, 36, HALF_Z * 0.7], at: [HALF_X + 14, 30, -HALF_Z * 0.5], to: [-HALF_X * 0.35, 18, -HALF_Z * 0.15], seconds: 26 },
  // Banking over blue base, looking back down the map toward red.
  { from: [BLUE_BASE.x + 40, 30, BLUE_BASE.z + 48], at: [BLUE_BASE.x + 8, 24, BLUE_BASE.z - 18], to: [0, 20, -HALF_Z * 0.6], seconds: 24 },
  // A low run up the middle, the cliffs rising on both sides.
  { from: [HALF_X * 0.15, 15, -HALF_Z * 0.75], at: [-HALF_X * 0.15, 13, HALF_Z * 0.35], to: [0, 22, HALF_Z + 60], seconds: 22 },
]

const TOTAL = LEGS.reduce((n, leg) => n + leg.seconds, 0)
const ease = (t: number): number => t * t * (3 - 2 * t)

const position = new THREE.Vector3()
const target = new THREE.Vector3()

/**
 * Put the camera where the flight is at `seconds`. Pure in `seconds`, so it can be driven from
 * the render loop without keeping any state of its own.
 */
export function flyCanyon(camera: THREE.PerspectiveCamera, seconds: number): void {
  let t = ((seconds % TOTAL) + TOTAL) % TOTAL
  let leg = LEGS[0]
  for (const candidate of LEGS) {
    if (t < candidate.seconds) { leg = candidate; break }
    t -= candidate.seconds
  }
  const f = ease(t / leg.seconds)
  position.set(
    leg.from[0] + (leg.at[0] - leg.from[0]) * f,
    leg.from[1] + (leg.at[1] - leg.from[1]) * f,
    leg.from[2] + (leg.at[2] - leg.from[2]) * f,
  )
  // Never let the flight clip through a hill, whatever the leg says.
  position.y = Math.max(position.y, groundHeight(position.x, position.z) + 3)
  camera.position.copy(position)
  target.set(leg.to[0], leg.to[1], leg.to[2])
  camera.lookAt(target)
  // A touch of roll, so a paused menu is never a frozen frame. It has to be applied as a
  // rotation on top of the look-at, not by writing rotation.z: that overwrites the Euler the
  // look-at just produced, and for half the flight the recomposed orientation is upside down.
  camera.rotateZ(Math.sin(seconds * 0.11) * 0.012)
}
