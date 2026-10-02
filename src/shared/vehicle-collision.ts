import type { PlayerState } from './movement.ts'

/** The gameplay hull is deliberately simpler than the render mesh: a stable oriented box. */
export type VehicleCollider = {
  kind: 'warthog' | 'ghost' | 'banshee' | 'mongoose' | 'chopper'
  x: number
  y: number
  z: number
  yaw: number
}

const HULLS = {
  mongoose: {halfX:1,halfZ:1.8,bottom:0,height:1.7},
  chopper: {halfX:1.42,halfZ:3.2,bottom:0,height:2.85},
  warthog: { halfX: 1.15, halfZ: 2.6, bottom: 0, height: 2.25 },
  ghost: { halfX: 1.85, halfZ: 2.30, bottom: 0, height: 1.25 },
  banshee: { halfX: 2.8, halfZ: 1.8, bottom: .2, height: 1.55 },
} as const

const PLAYER_RADIUS = .38

/** Keep an on-foot capsule outside every vehicle hull. Shared by prediction and authority. */
export function resolveVehicleCollisions(state: PlayerState, vehicles: readonly VehicleCollider[]): void {
  const playerHeight = state.crouched ? 1.05 : 1.8
  for (const vehicle of vehicles) {
    const hull = HULLS[vehicle.kind]
    const bottom = vehicle.y + hull.bottom, top = bottom + hull.height
    if (state.y + playerHeight <= bottom || state.y >= top) continue

    const sin = Math.sin(vehicle.yaw), cos = Math.cos(vehicle.yaw)
    const dx = state.x - vehicle.x, dz = state.z - vehicle.z
    const localX = cos * dx - sin * dz
    const localZ = -sin * dx - cos * dz
    const closestX = Math.max(-hull.halfX, Math.min(hull.halfX, localX))
    const closestZ = Math.max(-hull.halfZ, Math.min(hull.halfZ, localZ))
    let nx = localX - closestX, nz = localZ - closestZ
    let distance = Math.hypot(nx, nz)
    if (distance < PLAYER_RADIUS) {
      if (distance < 1e-6) {
        // The player can be teleported or reconciled inside a hull. Choose the shallowest exit
        // face rather than producing a NaN normal or trapping them at the vehicle centre.
        const xEscape = hull.halfX - Math.abs(localX)
        const zEscape = hull.halfZ - Math.abs(localZ)
        if (xEscape < zEscape) { nx = localX >= 0 ? 1 : -1; nz = 0; distance = 0 }
        else { nx = 0; nz = localZ >= 0 ? 1 : -1; distance = 0 }
      } else { nx /= distance; nz /= distance }
      const push = PLAYER_RADIUS - distance
      const worldX = cos * nx - sin * nz, worldZ = -sin * nx - cos * nz
      state.x += worldX * push
      state.z += worldZ * push
      const into = state.vx * worldX + state.vz * worldZ
      if (into < 0) { state.vx -= worldX * into; state.vz -= worldZ * into }
    }
  }
}

