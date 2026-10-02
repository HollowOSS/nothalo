import { WEAPONS, type WeaponSpec } from './constants.ts'
import type { ModelId } from './assets.ts'

/**
 * The weapons a player carries, in swap order.
 *
 * Shared because the slot index is what goes over the wire: the server counts ammo and applies
 * rate of fire per slot, the client draws the viewmodel for the same slot, and a remote player's
 * `weapon` byte in a snapshot picks the world model everyone else sees in their hands.
 */
export interface LoadoutSlot {
  readonly model: ModelId
  readonly specKey: keyof typeof WEAPONS
  readonly spec: WeaponSpec
  /** Seconds a reload takes, matching the viewmodel rig so the server never denies a shot the
   *  client's animation has already allowed. */
  readonly reload: number
  /** True if firing spawns a projectile the owning client simulates rather than a hitscan. */
  readonly projectile: boolean
  /** A weapon that swings instead of shooting: reach in metres, and the cone it covers. */
  readonly melee?: { readonly reach: number; readonly cone: number }
}

export const LOADOUT: readonly LoadoutSlot[] = [
  { model: 'magnum', specKey: 'pistol', spec: WEAPONS.pistol, reload: 1.9, projectile: false },
  { model: 'assault-rifle', specKey: 'assaultRifle', spec: WEAPONS.assaultRifle, reload: 2.1, projectile: false },
  { model: 'shotgun', specKey: 'shotgun', spec: WEAPONS.shotgun, reload: 2.8, projectile: false },
  { model: 'sniper', specKey: 'sniper', spec: WEAPONS.sniper, reload: 2.4, projectile: false },
  { model: 'rocket-launcher', specKey: 'rocket', spec: WEAPONS.rocket, reload: 3.5, projectile: true },
  // A battery, not a magazine: the sword never consumes ammo or offers a reload.
  { model: 'energy-sword', specKey: 'energySword', spec: WEAPONS.energySword, reload: 0, projectile: false, melee: { reach: 2.9, cone: 0.55 } },
  {model:'needler',specKey:'needler',spec:WEAPONS.needler,reload:2,projectile:false},
  {model:'battle-rifle',specKey:'battleRifle',spec:WEAPONS.battleRifle,reload:2.4,projectile:false},
  {model:'gravity-hammer',specKey:'gravityHammer',spec:WEAPONS.gravityHammer,reload:0,projectile:false,melee:{reach:5,cone:.2}},
  {model:'smg',specKey:'smg',spec:WEAPONS.smg,reload:1.9,projectile:false},
  {model:'plasma-pistol',specKey:'plasmaPistol',spec:WEAPONS.plasmaPistol,reload:0,projectile:false},
  {model:'plasma-rifle',specKey:'plasmaRifle',spec:WEAPONS.plasmaRifle,reload:0,projectile:false},
]

/** The slot a fresh spawn holds. The assault rifle, as CE does. */
export const DEFAULT_SLOT = 1

/**
 * Seconds after a weapon swap before the new weapon may fire. Swapping is the one thing faster
 * than a reload in CE; the new gun is up in under half a second. The server enforces it and the
 * client holds its own trigger for the same time, so a shot inside the window is never shown.
 */
export const SWAP_READY = 0.45

/**
 * Melee, the same for every weapon on the wire. Reach is generous: the server sees the past.
 * The cooldown is an authority-side floor only — every melee animation is at least .65 s, so it
 * can never deny a swing a real client has already played, it just stops an injected one from
 * swinging every frame.
 */
export const MELEE = { damage: 60, reach: 2.6, cone: 0.65, cooldown: .3 } as const

/**
 * Halo 3's ordinary rifle strike. The AR and BR both use the same Strike Melee class: one
 * short rifle-butt action, one contact window, and no weapon-specific bonus. Keep this profile
 * shared so the first-person action and authoritative hit test cannot drift apart.
 *
 * Damage stays on this project's existing 60-point scale; the parity being reproduced here is
 * the Halo 3 AR/BR melee behavior, not a global health-pool conversion.
 */
export const RIFLE_MELEE = {
  damage: MELEE.damage,
  reach: 2.1,
  cone: MELEE.cone,
  cooldown: .65,
  duration: .65,
  hit: .22,
} as const

/**
 * Shotgun pellet falloff, from the CE table in `WEAPONS.shotgun`: every pellet lands for full
 * damage inside 1.5 world units and decays to a token 8 past 3, which is what makes the gun a
 * room weapon rather than a long-range one.
 */
export const SHOTGUN = { fullRange: 4.6, farRange: 9.2, farDamage: 8, range: 40 } as const

/**
 * Splash sources a client may report.
 *
 * Damage falls off linearly to the radius unless `flat`, matching the client's local blast so
 * what the thrower sees and what the server rules agree. Bolts are the Ghost's and Banshee's
 * plasma: a direct hit that happens to be reported as a very small blast, because the bolt
 * flies on the client that fired it like every other projectile.
 */
export const SPLASH = {
  rocket: { damage: 300, radius: 6, maxRange: 420, flat: false },
  frag: { damage: 160, radius: 5, maxRange: 70, flat: false },
  plasma: { damage: 160, radius: 5, maxRange: 70, flat: false },
  bolt: { damage: 12, radius: 1.3, maxRange: 260, flat: true },
  chopper: {damage:30,radius:1.7,maxRange:260,flat:true},
  fuelrod: { damage: 190, radius: 5.5, maxRange: 420, flat: false },
} as const

export type SplashKind = keyof typeof SPLASH
export const SPLASH_KINDS: readonly SplashKind[] = ['rocket', 'frag', 'plasma', 'bolt', 'fuelrod', 'chopper']

/** The Warthog's chain gun on the wire: a weapon code past the end of the loadout. */
export const WEAPON_WARTHOG = LOADOUT.length
export const WARTHOG_GUN = { damage: 12, rof: 10, range: 120 } as const

/** Shared shell contact and cycle timing; the viewmodel loops its first insertion. */
export const SHOTGUN_RELOAD = { enter: .28, shell: .5973333333, contact: .5189333333, exit: .728, clipExit: 2.072 } as const
