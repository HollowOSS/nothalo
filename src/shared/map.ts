/**
 * The single source of truth for Blood Gulch's world layout, in metres.
 *
 * Every piece — terrain, bases, vehicles, spawns, netcode — reads its coordinates from
 * here so the map stays one coherent space while pieces are built in parallel.
 *
 * Axes: +X across the canyon (wall to wall), +Y up, +Z along the canyon.
 * Red base sits at -Z, Blue base at +Z. Origin is midfield, at ground datum.
 *
 * The base anchors are measured from the imported Xbox Blood Gulch mesh.
 * Legacy procedural dimensions below are retained for reference authoring tools.
 * The original estimates were scaled from `reference/frames/tactical-map.png`
 * and the canyon frames. They are meant to be corrected against measured values, and
 * correcting them here must move everything together — never hardcode a position
 * anywhere else.
 */

/** Playable canyon floor, wall to wall and end to end. */
export const CANYON_LENGTH = 322
export const CANYON_WIDTH = 280

/** Cliff walls rise this far above the floor datum and box the playable area in. */
export const CLIFF_HEIGHT = 70

export const BASE_INSET_FROM_END = 45

export interface Anchor {
  readonly x: number
  readonly y: number
  readonly z: number
}

export const RED_BASE: Anchor = { x: -60.7, y: 0, z: -89.6 }
export const BLUE_BASE: Anchor = { x: 60.9, y: 0, z: 87.8 }

/**
 * Base footprint. In the reference frames the base reads as a low, wide octagonal
 * platform ringed by a parapet, sunk into a sandy bowl — not a tower.
 */
export const BASE_RADIUS = 13
export const BASE_DECK_HEIGHT = 4.5
export const BASE_PARAPET_HEIGHT = 1.6

/** The two cliffside caves, roughly opposite each other on the long walls. */
export const CAVES: readonly Anchor[] = [
  { x: -CANYON_WIDTH / 2, y: 0, z: -30 },
  { x: CANYON_WIDTH / 2, y: 0, z: 30 },
]

/** The sniper ridge that overlooks a base — the `ridge-overlook` vantage. */
export const SNIPER_RIDGE: Anchor = { x: CANYON_WIDTH / 2 - 18, y: 22, z: -60 }

/**
 * The rocky hill that rises just off the centre of the floor. Blood Gulch's midfield is not
 * flat: a broad mound with a boulder crown breaks the sightline between the bases and is
 * the one piece of high ground anyone can reach on foot. A terrain feature, so it collides
 * for free; the crown rocks are in `cover.ts`.
 */
export const HILL = { x: 16, z: 12, r: 28, h: 6.5 } as const

/**
 * Player yaw convention, shared with movement: forward is (-sin yaw, -cos yaw).
 * `yaw` on a teleporter is the direction a player faces walking *through* it.
 */
export interface Teleporter {
  readonly id: Team
  /** Ground-level frame inside the team's base, at the rear of the room. */
  readonly entrance: Anchor
  readonly entranceYaw: number
  /** Receiver frame on a cliff ledge in the far half of the canyon. One-way, as in CE. */
  readonly exit: Anchor
  readonly exitYaw: number
}

/** Where each base's teleporter frame stands, in the base's own frame (+Z faces midfield). */
export const TELEPORTER_LOCAL = { x: 0, y: 0.5, z: -8.6 } as const

/** Source roof portal centres; receivers use clear terrain on the opposite flank. */
export const TELEPORTERS: readonly Teleporter[] = [
  {id:'red',entrance:{x:-60.817,y:4.612,z:-79.641},entranceYaw:Math.PI,exit:{x:-69,y:10.15,z:53},exitYaw:-Math.PI/2},
  {id:'blue',entrance:{x:60.978,y:4.612,z:79.205},entranceYaw:0,exit:{x:51,y:2.766,z:-37},exitYaw:Math.PI/2},
]

export type Team = 'red' | 'blue'

export const TEAM_COLOR: Record<Team, number> = {
  red: 0x9d2f2a,
  blue: 0x2f4f9d,
}
