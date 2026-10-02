import {isArena,arenaFloor,arenaBlocked,arenaCollision} from './arena.ts'
import {guardianRay,guardianFloor,guardianBlocked,type MapId} from './guardian.ts'
import {lockoutRay,lockoutFloor,lockoutBlocked} from './lockout.ts'
import { MOVE } from './constants.ts'
import { LOADOUT } from './loadout.ts'
import type { PlayerState } from './movement.ts'
import { groundHeight, rimFraction } from './field.ts'
import { baseBlocksPlayer, baseFloorHeight } from './base-collision.ts'
import { coverBlocksPlayer, coverFloorHeight } from './cover.ts'

/** Shared by prediction and authority. These are movement limits, not extra sword reach. */
export const SWORD_LUNGE = { range: 5.5, cone: .88, stopDistance: 1.65, duration: .14, cooldown: .715 } as const
/**
 * Every melee strike closes distance the same way the sword's swing does, just far less of it:
 * a fist or rifle butt covers the last stride, not the room. Reach stays inside `MELEE.reach`
 * (2.6) so the swing that follows always lands, and the short duration reads as a snap-step
 * rather than a dash.
 */
export const MELEE_LUNGE = { range: 3, cone: .8, stopDistance: 1.15, duration: .09, cooldown: .4 } as const
export interface LungeConfig { readonly range: number; readonly cone: number; readonly stopDistance: number; readonly duration: number }
export interface LungeTarget { readonly map?:MapId; readonly x: number; readonly y: number; readonly z: number }
export interface SwordLunge { dx: number; dz: number; remaining: number; timeLeft: number }

function beginLunge(config: LungeConfig, state: PlayerState, yaw: number, pitch: number, targets: Iterable<LungeTarget>): SwordLunge | null {
  const fx = -Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = -Math.cos(yaw) * Math.cos(pitch)
  let best: LungeTarget | null = null, bestDistance = Infinity
  for (const target of targets) {
    const dx = target.x - state.x, dy = target.y - state.y, dz = target.z - state.z
    const distance = Math.hypot(dx, dy, dz), horizontal = Math.hypot(dx, dz)
    if (distance > config.range || distance >= bestDistance || horizontal <= config.stopDistance || Math.abs(dy) > MOVE.playerHeight * .85) continue
    if ((dx * fx + dy * fy + dz * fz) / distance < config.cone) continue
    if (swordTargetVisible(state, target)) { best = target; bestDistance = distance }
  }
  if (!best) return null
  const dx = best.x - state.x, dz = best.z - state.z, distance = Math.hypot(dx, dz)
  return { dx: dx / distance, dz: dz / distance, remaining: distance - config.stopDistance, timeLeft: config.duration }
}

/** Callers supply living enemies only. No target tracking after acquisition. */
export function beginSwordLunge(state: PlayerState, yaw: number, pitch: number, targets: Iterable<LungeTarget>): SwordLunge | null {
  return beginLunge(SWORD_LUNGE, state, yaw, pitch, targets)
}

/** Same acquisition as the sword, tuned short so any weapon's quick melee gets a matching snap. */
export function beginMeleeLunge(state: PlayerState, yaw: number, pitch: number, targets: Iterable<LungeTarget>): SwordLunge | null {
  return beginLunge(MELEE_LUNGE, state, yaw, pitch, targets)
}

/** Reticle and acquisition use the same occlusion samples. */
function swordTargetVisible(state: LungeTarget, target: LungeTarget): boolean {
  if(isArena(state.map))return !arenaCollision(state.map).ray(state.x,state.y+1,state.z,target.x,target.y+1,target.z)
  if(state.map==='guardian')return !guardianRay(state.x,state.y+1,state.z,target.x,target.y+1,target.z)
  if(state.map==='lockout')return !lockoutRay(state.x,state.y+1,state.z,target.x,target.y+1,target.z)
  const dx = target.x - state.x, dy = target.y - state.y, dz = target.z - state.z
  const horizontal = Math.hypot(dx, dz)
  for (let d = .12; d < horizontal; d += .12) {
    const t = d / horizontal, x = state.x + dx * t, z = state.z + dz * t
    const y = state.y + dy * t + MOVE.eyeHeight * .55
    if (groundHeight(x, z) > y || baseBlocksPlayer(x, z, y, .25) || coverBlocksPlayer(x, z, y, 0, x, z)) return false
  }
  return true
}

const SWORD_MELEE = LOADOUT.find(slot => slot.model === 'energy-sword')!.melee!

/** Includes point-blank attacks, where acquiring a dash would overshoot the enemy. */
export function swordTargetInRange(state: PlayerState, yaw: number, pitch: number, targets: readonly LungeTarget[]): boolean {
  const fx = -Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = -Math.cos(yaw) * Math.cos(pitch)
  for (const target of targets) {
    const dx = target.x - state.x, dy = target.y - state.y, dz = target.z - state.z
    const horizontal = Math.hypot(dx, dz), distance = Math.hypot(dx, dy, dz)
    if (horizontal >= SWORD_MELEE.reach || Math.abs(dy) > MOVE.playerHeight) continue
    if (distance > .05 && (dx * fx + dy * fy + dz * fz) / distance < SWORD_MELEE.cone) continue
    if (swordTargetVisible(state, target)) return true
  }
  // Query the very same acquisition routine the swing start uses. A visible enemy beyond
  // melee distance is not actionable if the collision sweep cannot close to blade reach.
  const lunge = beginSwordLunge(state, yaw, pitch, targets)
  if (!lunge) return false
  const probe = { ...state }, requested = lunge.remaining
  advanceSwordLunge(probe, lunge, SWORD_LUNGE.duration)
  const moved = Math.hypot(probe.x - state.x, probe.z - state.z)
  return requested - moved < SWORD_MELEE.reach - SWORD_LUNGE.stopDistance
}

/**
 * Sweep in <= 10 cm increments so neither a frame hitch nor a fast dash tunnels through cover.
 * Shared by both lunge kinds: the state it advances came from `beginSwordLunge` or
 * `beginMeleeLunge` and carries no record of which.
 */
export function advanceSwordLunge(state: PlayerState, lunge: SwordLunge, dt: number): boolean {
  if (lunge.remaining <= 1e-5 || lunge.timeLeft <= 1e-5) return false
  const elapsed = Math.min(Math.max(dt, 0), lunge.timeLeft)
  const distance = lunge.remaining * elapsed / lunge.timeLeft
  const slices = Math.max(1, Math.ceil(distance / .1)), stride = distance / slices
  const height = MOVE.playerHeight * (state.crouched ? .62 : 1)
  let moved = 0
  for (let i = 0; i < slices; i++) {
    const x = state.x + lunge.dx * stride, z = state.z + lunge.dz * stride
    const maxStep = state.crouched ? MOVE.crouchStepHeight : MOVE.stepHeight
    const floor = isArena(state.map)?arenaFloor(state.map,x,z,state.y,maxStep):state.map==='guardian'?guardianFloor(x,z,state.y,maxStep):state.map==='lockout'?lockoutFloor(x,z,state.y,maxStep):Math.max(baseFloorHeight(x, z, state.y, maxStep), coverFloorHeight(x, z, state.y, maxStep))
    if (isArena(state.map) ? arenaBlocked(state.map,x,z,state.y,height)||floor<state.y-.5 : state.map==='guardian' ? guardianBlocked(x,z,state.y,height)||floor<state.y-.5 : state.map==='lockout' ? lockoutBlocked(x,z,state.y,height)||floor<state.y-.5 : rimFraction(x, z) >= .965 || floor - state.y > maxStep || baseBlocksPlayer(x, z, state.y, height) || coverBlocksPlayer(x, z, state.y, maxStep, state.x, state.z)) {
      lunge.remaining = lunge.timeLeft = 0
      return false
    }
    state.x = x; state.z = z
    if (state.onGround && floor >= state.y - .08) state.y = floor
    moved += stride
  }
  lunge.remaining = Math.max(0, lunge.remaining - moved)
  lunge.timeLeft -= elapsed
  return lunge.remaining > 1e-5 && lunge.timeLeft > 1e-5
}
