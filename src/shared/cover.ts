/**
 * Solid rock on the canyon floor: the things you can hide behind.
 *
 * Shared, because the server has to agree with the client about what stops a player. Every
 * rock is a vertical blob — a circle in plan with a flat-ish top — which is enough for the
 * capsule to slide round it and land on it, and cheap enough to test against every step.
 *
 * Two populations live here. The *formations* are placed by hand from the map: the boulder
 * crown on the midfield hill, spires by the walls, nooks against the cliff foot, low walls in
 * the open. The *boulders* are the scattered loose rock; the scatter is deterministic so it can
 * be drawn on the client and collided with on the server without either sending a list.
 */
import { BASE_RADIUS, RED_BASE, BLUE_BASE, HILL, TELEPORTERS } from './map.ts'
import { rng } from './noise.ts'
import { groundHeight, rimFraction, FLOOR_HALF_X, FLOOR_HALF_Z } from './field.ts'

export interface Rock {
  readonly x: number
  readonly z: number
  /** Plan radius, m. Rendering wobbles the silhouette around it. */
  readonly r: number
  /** Top of the rock above the ground it stands on, m. */
  readonly h: number
  readonly seed: number
}

/**
 * Formations on the red half and the midfield, mirrored through the canyon centre for the
 * blue half. Blood Gulch is point-symmetric to within a few metres, and authoring one half
 * keeps the two sides fair.
 */
const HALF: readonly Omit<Rock, 'seed'>[] = [
  // Spire off the west wall, mid-canyon: a lone tall rock you can round the corner of.
  { x: -56, z: -12, r: 2.8, h: 9 },
  // Outcrop on the approach to the base, the last cover before the open sand bowl.
  { x: -28, z: -66, r: 3.4, h: 4.2 },
  { x: -23, z: -62, r: 2.0, h: 2.4 },
  // A nook against the cliff foot: three rocks round a pocket you can stand inside.
  { x: -70, z: -32, r: 3.6, h: 6.5 },
  { x: -72, z: -20, r: 3.2, h: 5.5 },
  { x: -64, z: -38, r: 2.2, h: 3.8 },
  // Low walls out in the open. Chest height: cover from the base, not from the shelf.
  { x: -8, z: -42, r: 2.6, h: 2.2 },
  { x: -36, z: -4, r: 2.2, h: 2.8 },
  // Small outcrop under the shelf foot.
  { x: 40, z: -52, r: 2.4, h: 3.2 },
  // Rocks flanking the teleporter receiver on the shelf.
  { x: 60, z: -92, r: 2.6, h: 3.5 },
  { x: 69, z: -76, r: 2.4, h: 3.2 },
]

/** The boulder crown on the hill. Not mirrored: there is one hill. */
const CROWN: readonly Omit<Rock, 'seed'>[] = [
  { x: HILL.x + 3, z: HILL.z + 3, r: 4.6, h: 5.5 },
  { x: HILL.x - 4, z: HILL.z + 8, r: 2.6, h: 3.0 },
  { x: HILL.x + 9, z: HILL.z - 4, r: 2.2, h: 2.6 },
]

export const FORMATIONS: readonly Rock[] = [
  ...HALF.map((r, i) => ({ ...r, seed: i * 7 + 1 })),
  ...HALF.map((r, i) => ({ ...r, x: -r.x, z: -r.z, seed: i * 7 + 4 })),
  ...CROWN.map((r, i) => ({ ...r, seed: 90 + i * 3 })),
]

export interface Boulder {
  readonly x: number
  readonly z: number
  readonly y: number
  /** Uniform scale of the unit blob. */
  readonly sc: number
  /** Extra vertical squash. */
  readonly sy: number
  readonly rot: number
  readonly tiltX: number
  readonly tiltZ: number
  readonly variant: number
}

function clearOfBases(x: number, z: number, pad: number): boolean {
  for (const b of [RED_BASE, BLUE_BASE]) {
    if (Math.hypot(x - b.x, z - b.z) < BASE_RADIUS + pad) return false
  }
  return true
}

/**
 * Loose boulders. The random sequence is fixed and consumed in exactly this order, so the
 * renderer and the simulation see the same rocks in the same places.
 */
export const BOULDER_VARIANTS = 3

export function scatterBoulders(): Boulder[][] {
  const rand = rng(1337)
  const spots: { x: number; z: number; rot: number }[] = []
  for (let tries = 0; tries < 58 * 40 && spots.length < 58; tries++) {
    const x = (rand() * 2 - 1) * (FLOOR_HALF_X - 4)
    const z = (rand() * 2 - 1) * (FLOOR_HALF_Z - 4)
    if (rimFraction(x, z) > 1.04) continue
    if (!clearOfBases(x, z, 14)) continue
    spots.push({ x, z, rot: rand() * Math.PI * 2 })
  }
  const pick = rng(4242)
  const buckets: { x: number; z: number; rot: number }[][] = Array.from({ length: BOULDER_VARIANTS }, () => [])
  for (const s of spots) buckets[Math.floor(pick() * BOULDER_VARIANTS) % BOULDER_VARIANTS].push(s)

  const out: Boulder[][] = []
  for (let k = 0; k < BOULDER_VARIANTS; k++) {
    const list: Boulder[] = []
    for (const s of buckets[k]) {
      // Boulders bunch up big against the cliff foot and thin out to pebbles midfield.
      const near = Math.min(1, Math.max(0, (rimFraction(s.x, s.z) - 0.55) / 0.45))
      const sc = 0.55 + pick() * 0.75 + near * near * (0.6 + pick() * 2.6)
      const tiltX = (pick() - 0.5) * 0.5
      const tiltZ = (pick() - 0.5) * 0.5
      const sy = 0.7 + pick() * 0.4
      list.push({ x: s.x, z: s.z, y: groundHeight(s.x, s.z), sc, sy, rot: s.rot, tiltX, tiltZ, variant: k })
    }
    out.push(list)
  }
  return out
}

interface Solid {
  x: number
  z: number
  r: number
  /** Absolute height of the top, m. */
  top: number
}

/** Everything that collides, flattened, with absolute tops. Built once per process. */
let solids: Solid[] | null = null

function allSolids(): Solid[] {
  if (solids) return solids
  const list: Solid[] = []
  for (const f of FORMATIONS) list.push({ x: f.x, z: f.z, r: f.r, top: groundHeight(f.x, f.z) + f.h })
  for (const variant of scatterBoulders()) {
    for (const b of variant) {
      // The blob's mean radius is ~0.85 of its scale and it sits sunk a little into the ground.
      const r = b.sc * 0.82
      const top = b.y + b.sc * (0.28 + 0.62 * b.sy)
      // Pebbles are stepped over, not collided with.
      if (top - b.y < 0.55) continue
      list.push({ x: b.x, z: b.z, r, top })
    }
  }
  solids = list
  return list
}

const PLAYER_RADIUS = 0.38

/**
 * Highest rock top under this point that the capsule can land on from its present level,
 * or -Infinity. Mirrors the base deck rule: you can only be *on* a rock you could step up to.
 */
export function coverFloorHeight(x: number, z: number, feet: number, stepHeight: number): number {
  let floor = -Infinity
  for (const s of allSolids()) {
    if (s.top > floor && Math.hypot(x - s.x, z - s.z) <= s.r && feet + stepHeight >= s.top - 0.01) floor = s.top
  }
  return floor
}

/**
 * Would a capsule standing here be inside a rock it cannot step onto? Leaving a rock is always
 * allowed — a player or bot that spawns inside one has to be able to walk out — so the caller
 * passes where it came from.
 */
export function coverBlocksPlayer(x: number, z: number, feet: number, stepHeight: number, fromX: number, fromZ: number): boolean {
  for (const s of allSolids()) {
    if (feet + stepHeight >= s.top - 0.01) continue
    const reach = s.r + PLAYER_RADIUS
    if (Math.hypot(x - s.x, z - s.z) > reach) continue
    if (Math.hypot(fromX - s.x, fromZ - s.z) <= reach) continue
    return true
  }
  return false
}

/**
 * Does solid rock stand between these two points? Sampled, like the terrain test it sits
 * beside: a metre of resolution is finer than any rock here.
 */
export function coverBlocksRay(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const dist = Math.hypot(bx - ax, bz - az)
  const steps = Math.min(48, Math.max(2, Math.ceil(dist / 1.0)))
  const list = allSolids()
  for (let i = 1; i < steps; i++) {
    const f = i / steps
    const x = ax + (bx - ax) * f
    const z = az + (bz - az) * f
    const y = ay + (by - ay) * f
    for (const s of list) {
      if (y < s.top && Math.hypot(x - s.x, z - s.z) < s.r) return true
    }
  }
  return false
}

/** Continuous intersection with the same rock cylinders, for bulk spawn visibility queries. */
export function coverBlocksSpawnRay(ax:number,ay:number,az:number,bx:number,by:number,bz:number):boolean {
  const dx=bx-ax,dz=bz-az,dy=by-ay,a=dx*dx+dz*dz
  for(const s of allSolids()){
    const ox=ax-s.x,oz=az-s.z,c=ox*ox+oz*oz-s.r*s.r
    if(a<1e-12){if(c<0&&Math.min(ay,by)<s.top)return true;continue}
    const b=ox*dx+oz*dz,discriminant=b*b-a*c
    if(discriminant<=0)continue
    const d=Math.sqrt(discriminant),enter=Math.max(0,(-b-d)/a),exit=Math.min(1,(-b+d)/a)
    if(enter<exit&&Math.min(ay+enter*dy,ay+exit*dy)<s.top)return true
  }
  return false
}

/** True if a spawn or goal point is clear of solid rock, for placement code. */
export function clearOfCover(x: number, z: number, pad = 0): boolean {
  for (const s of allSolids()) if (Math.hypot(x - s.x, z - s.z) <= s.r + pad) return false
  for (const t of TELEPORTERS) if (Math.hypot(x - t.exit.x, z - t.exit.z) <= 2 + pad) return false
  return true
}
