import { LOADOUT, type SplashKind } from './loadout.ts'

/**
 * How a kill was made, for the medals. The authority knows (the server online, match.ts offline)
 * and says so alongside the hit marker; the HUD only applies the rules.
 *
 * A cause below CAUSE_SPLATTER is the loadout slot that did it. The rest are the ways to kill
 * that are not the weapon in your hands.
 */
export const CAUSE_SPLATTER = 240
export const CAUSE_GRENADE = 241
export const CAUSE_STICK = 242
/** Turrets and vehicle cannons: the Warthog's chain gun, Ghost and Banshee bolts, fuel rods. */
export const CAUSE_VEHICLE_GUN = 243
export const CAUSE_UNKNOWN = 255

/** Facts about the victim and the killer at the moment it happened (bits). */
export const KILL_VICTIM_FLAG = 1
export const KILL_VICTIM_BOMB = 2
export const KILL_HOLDING_FLAG = 4
export const KILL_HOLDING_BALL = 8

export interface KillInfo {
  /** A loadout slot, or one of the CAUSE_ codes. */
  cause: number
  /** Hit flags (protocol.ts): headshot, melee, from behind, bulltrue, killjoy. */
  flags: number
  /** KILL_ bits. */
  context: number
}

export const UNKNOWN_KILL: KillInfo = { cause: CAUSE_UNKNOWN, flags: 0, context: 0 }

const ROCKET_SLOT = LOADOUT.findIndex(s => s.model === 'rocket-launcher')

/** A blast's cause: grenades are grenades whoever threw them; a rocket is the launcher's. */
export function splashCause(kind: SplashKind, stuck: boolean): number {
  if (kind === 'frag' || kind === 'plasma') return stuck ? CAUSE_STICK : CAUSE_GRENADE
  if (kind === 'rocket') return ROCKET_SLOT
  return CAUSE_VEHICLE_GUN
}

/**
 * Whether the attacker stands behind someone facing `yaw` (an assassination). Forward is -Z at
 * yaw 0, as everywhere else. Anywhere in the rear 110 degrees counts: a strike from the flank
 * still shows the victim's back, which is what Halo rewards.
 */
export function fromBehind(yaw: number, victimX: number, victimZ: number, attackerX: number, attackerZ: number): boolean {
  const dx = attackerX - victimX, dz = attackerZ - victimZ, d = Math.hypot(dx, dz)
  if (d < 1e-3) return false
  return (dx * -Math.sin(yaw) + dz * -Math.cos(yaw)) / d < -0.57
}

/** Kills in a row that make a spree: ending one of at least this many is a Killjoy. */
export const SPREE_FOR_KILLJOY = 5
