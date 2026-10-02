import { BASE_RADIUS, BASE_DECK_HEIGHT, RED_BASE, BLUE_BASE } from './map.ts'
import { groundHeight } from './field.ts'

/** Shared authoring dimensions for both the base meshes and predicted/server movement. */
export const BASE_GEOMETRY = {
  facets: 16,
  footing: -6,
  coping: BASE_DECK_HEIGHT - 0.3,
  wallThickness: 0.65,
  floor: 0.5,
  roofThickness: 0.3,
  doorFacets: [1, 6, 14] as readonly number[],
  doorWidth: 3.2,
  doorTop: 3.15,
  pitX: 4.2,
  pitZ: 2.7,
  innerRampHalfWidth: 2.3,
  rampFacets: [4, 12] as readonly number[],
  rampNear: BASE_RADIUS + 0.1,
  rampRun: 6.8,
  rampHalfWidth: 2.4,
  playerRadius: 0.38,
} as const

export const BASE_FACET = Math.PI * 2 / BASE_GEOMETRY.facets
const HALF = BASE_FACET / 2
const SITES = [{ anchor: RED_BASE, sign: 1 }, { anchor: BLUE_BASE, sign: -1 }] as const
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))

export function baseWallRadius(y: number): number {
  return BASE_RADIUS - 2.5 + 2.5 * (y - BASE_GEOMETRY.footing) / (BASE_GEOMETRY.coping - BASE_GEOMETRY.footing)
}

/** Distance to the flat wall face, not the polygon's circumscribed radius. */
export function baseWallPlane(y: number): number { return baseWallRadius(y) * Math.cos(HALF) }

function polygonContains(x: number, z: number, radius: number): boolean {
  const plane = radius * Math.cos(HALF)
  for (let i = 0; i < BASE_GEOMETRY.facets; i++) {
    const a = i * BASE_FACET
    if (x * Math.sin(a) + z * Math.cos(a) > plane) return false
  }
  return true
}

/** The highest surface the capsule can land on from its present level. */
export function baseFloorHeight(x: number, z: number, feet: number, stepHeight: number): number {
  let floor = groundHeight(x, z)
  const b = BASE_GEOMETRY
  for (const { anchor, sign } of SITES) {
    const lx = (x - anchor.x) * sign, lz = (z - anchor.z) * sign
    if (Math.hypot(lx, lz) > b.rampNear + b.rampRun + 1) continue
    if (polygonContains(lx, lz, baseWallRadius(b.floor))) {
      floor = Math.max(floor, b.floor)
      if (Math.abs(lx) <= b.pitX && Math.abs(lz) <= b.innerRampHalfWidth) {
        floor = Math.max(floor, b.floor + (lx + b.pitX) / (2 * b.pitX) * (BASE_DECK_HEIGHT - b.floor))
      }
    }
    const inHatch = Math.abs(lx) < b.pitX && Math.abs(lz) < b.pitZ
    if (!inHatch && polygonContains(lx, lz, BASE_RADIUS + 0.3) && feet + stepHeight >= BASE_DECK_HEIGHT - 0.01) {
      floor = Math.max(floor, BASE_DECK_HEIGHT)
    }
    for (const i of b.rampFacets) {
      const a = i * BASE_FACET
      const along = lx * Math.sin(a) + lz * Math.cos(a)
      const across = lx * Math.cos(a) - lz * Math.sin(a)
      if (Math.abs(across) <= b.rampHalfWidth - 0.35 && along >= b.rampNear - 0.45 && along <= b.rampNear + b.rampRun) {
        const t = clamp((along - b.rampNear) / b.rampRun, 0, 1)
        floor = Math.max(floor, BASE_DECK_HEIGHT * (1 - t) + 0.05 * t)
      }
    }
    // Shallow concrete thresholds bridge uneven canyon ground into the level interior.
    for (const i of b.doorFacets) {
      const a = i * BASE_FACET
      const along = lx * Math.sin(a) + lz * Math.cos(a)
      const across = lx * Math.cos(a) - lz * Math.sin(a)
      const near = baseWallPlane(b.floor) - b.wallThickness
      if (Math.abs(across) < b.doorWidth / 2 && along >= near && along <= near + 2.7) {
        floor = Math.max(floor, b.floor * (1 - clamp((along - near) / 2.7, 0, 1)))
      }
    }
  }
  return floor
}

/** Solid exterior wall panels, with the same full-height openings as the render mesh. */
export function baseBlocksPlayer(x: number, z: number, feet: number, height: number): boolean {
  const b = BASE_GEOMETRY
  if (feet >= BASE_DECK_HEIGHT - 0.22) return false
  for (const { anchor, sign } of SITES) {
    const lx = (x - anchor.x) * sign, lz = (z - anchor.z) * sign
    if (Math.hypot(lx, lz) > BASE_RADIUS + 2) continue
    const low = baseWallPlane(Math.max(b.floor, feet)) - b.wallThickness - b.playerRadius
    const high = baseWallPlane(Math.min(b.coping, feet + height)) + b.playerRadius
    for (let i = 0; i < b.facets; i++) {
      const a = i * BASE_FACET
      const along = lx * Math.sin(a) + lz * Math.cos(a)
      const across = lx * Math.cos(a) - lz * Math.sin(a)
      if (along < low || along > high || Math.abs(across) > baseWallRadius(b.coping) * Math.sin(HALF) + b.playerRadius) continue
      if (b.doorFacets.includes(i) && Math.abs(across) < b.doorWidth / 2 - b.playerRadius && feet + height <= b.doorTop - 0.02) continue
      // The outer ramps meet the coping; standing on their upper lip clears the drum.
      if (b.rampFacets.includes(i) && Math.abs(across) < b.rampHalfWidth - 0.35 && feet >= BASE_DECK_HEIGHT - 0.3) continue
      return true
    }
  }
  return false
}

/** Interior roof underside. The central opening stays clear all the way to the sky. */
export function baseCeilingHeight(x: number, z: number, feet: number): number {
  const b = BASE_GEOMETRY
  const underside = BASE_DECK_HEIGHT - b.roofThickness
  if (feet >= underside - 0.01) return Infinity
  for (const { anchor, sign } of SITES) {
    const lx = (x - anchor.x) * sign, lz = (z - anchor.z) * sign
    for (const i of b.doorFacets) {
      const a = i * BASE_FACET
      const along = lx * Math.sin(a) + lz * Math.cos(a)
      const across = lx * Math.cos(a) - lz * Math.sin(a)
      if (Math.abs(across) < b.doorWidth / 2 + b.playerRadius && feet < b.doorTop &&
        along > baseWallPlane(b.floor) - b.wallThickness - b.playerRadius &&
        along < baseWallPlane(b.doorTop) + b.playerRadius) return b.doorTop
    }
    if (!polygonContains(lx, lz, BASE_RADIUS)) continue
    if (Math.abs(lx) < b.pitX - b.playerRadius && Math.abs(lz) < b.pitZ - b.playerRadius) continue
    return underside
  }
  return Infinity
}
