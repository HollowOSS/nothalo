import { wu } from './units.ts'
import { PRESENTATION } from './presentation.ts'

/**
 * Halo CE's measured constants, converted to metres and seconds.
 *
 * Two unit systems show up in the community sources and they are easy to confuse:
 *   - world units (wu): 1 wu = 10 ft = 3.048 m. Weapon ranges and speeds use these.
 *   - HEK/3ds Max units: 10 units = 1 ft, so 100 units = 1 wu. Jump and collision use these.
 *
 * Source: the Halo Editing Kit player-statistics table
 * (https://www.haloce.org/HEK_Tutorial/references/general/halo_player_stats.html)
 * and Halopedia's CE-specific weapon pages. These are community/tag-derived, not an
 * official Bungie publication.
 *
 * Sanity check on the movement set: 6.86 m/s forward, a 2.44 m jump and a 9.51 m standing
 * jump distance are only mutually consistent at g ~= 10.1 m/s², which is what GRAVITY below
 * is derived from rather than assumed. Halo CE really is that fast and that floaty.
 */

const HEK_UNITS_PER_WU = 100
const hek = (units: number): number => wu(units / HEK_UNITS_PER_WU)

// ---------------------------------------------------------------- movement

export const MOVE = {
  /** m/s */
  forwardSpeed: wu(2.25),
  backwardSpeed: wu(2.0),
  strafeSpeed: wu(2.0),
  /** Peak of a standing jump, m. */
  jumpHeight: hek(80),
  crouchJumpHeight: hek(99),
  /** Horizontal reach of a standing jump at full forward speed, m. */
  jumpDistance: hek(312),
  /** Steps up to this height are climbed rather than blocked, m. */
  stepHeight: hek(12),
  crouchStepHeight: hek(8),
  maxWalkableSlopeDeg: 45,
  /** Capsule height, m. Chief is about 7 ft. */
  playerHeight: hek(70.127),
  eyeHeight: hek(70.127) * 0.9,
  // 70 degrees horizontal at 4:3, converted to Three.js vertical FOV.
  // Retain vertical framing on widescreen (about 86 degrees horizontal at 16:9).
  // Measurement: https://forums.bungie.org/halo/archive38.pl?read=1138638
  fovDeg: PRESENTATION.verticalFov,
} as const

/**
 * Derived, not looked up: g falls out of jumpHeight and jumpDistance at forwardSpeed.
 * h = v0²/2g and d = speed * 2v0/g solve to g ~= 10.14, v0 ~= 7.03.
 */
export const GRAVITY = (2 * MOVE.forwardSpeed * MOVE.forwardSpeed * MOVE.jumpHeight * 2) /
  (MOVE.jumpDistance * MOVE.jumpDistance / 2)

export const JUMP_VELOCITY = Math.sqrt(2 * GRAVITY * MOVE.jumpHeight)

export const FALL_DAMAGE = {
  /** Below this drop, no damage. m. */
  safeDrop: wu(3),
  /** At or past this drop, death. m. */
  fatalDrop: wu(16.5),
} as const

/**
 * The shield and health pools are placeholders picked so a magnum takes 3 body shots through
 * shields plus a headshot to kill, which is the CE feel everyone remembers. Tune against play,
 * not lore. The recharge timings are Halo 3's: shields start coming back 5 s after the last hit
 * and refill from empty in 2 s (halopedia.org/Energy_shielding).
 */
export interface Vitals {
  readonly shield: number
  readonly health: number
  /** Seconds without damage before shields start coming back. */
  readonly shieldRechargeDelay: number
  /** Seconds from empty to full once recharging. */
  readonly shieldRechargeTime: number
}

export const VITALS: Vitals = {
  shield: 70,
  health: 45,
  shieldRechargeDelay: 5,
  shieldRechargeTime: 2,
}

// ---------------------------------------------------------------- weapons

export interface WeaponSpec {
  readonly name: string
  /** Damage per bullet, pellet or projectile hit. */
  readonly damage: number
  /** Shots per second. */
  readonly rof: number
  readonly magazine: number
  readonly reserve: number
  /** Hitscan weapons resolve instantly; projectile weapons travel at this speed, m/s. */
  readonly projectileSpeed?: number
  readonly burst?: { readonly size: number; readonly pause: number }
  readonly pellets?: number
  /** Cone half-angle in degrees for spread weapons. */
  readonly spreadDeg?: number
  readonly zoom?: readonly number[]
  readonly headshotMultiplier?: number
  readonly notes?: string
}

export const WEAPONS: Record<string, WeaponSpec> = {
  assaultRifle: { name: 'MA5C Assault Rifle', damage: 10, rof: 15, magazine: 60, reserve: 600 },
  pistol: {
    name: 'M6D Magnum',
    damage: 25,
    rof: 3.5,
    magazine: 12,
    reserve: 120,
    projectileSpeed: wu(300),
    zoom: [2],
    headshotMultiplier: 1.5,
    notes: 'The CE magnum. Three body shots then a headshot. Getting this one wrong means the game is not Halo CE.',
  },
  sniper: {
    name: 'SRS99C-S2 AM Sniper Rifle',
    damage: 101,
    rof: 2,
    magazine: 4,
    reserve: 24,
    zoom: [2, 10],
  },
  rocket: {
    name: 'M41B SPNKr Rocket Launcher',
    zoom: [2],
    damage: 300,
    rof: 0.5,
    magazine: 2,
    reserve: 8,
    projectileSpeed: wu(12),
    notes: 'Splash 300 at 0.5 wu falling to 80 at 2 wu.',
  },
  shotgun: {
    name: 'M90 Shotgun',
    damage: 22,
    pellets: 15,
    spreadDeg: 10,
    rof: 1,
    magazine: 12,
    reserve: 72,
    notes: 'Full damage to 1.5 wu, falls to 8 per pellet past 3 wu.',
  },
  smg: {name:'M7 SMG',damage:7,rof:15,magazine:60,reserve:240},
  plasmaRifle: {
    name: 'Plasma Rifle',
    damage: 13,
    rof: 8,
    magazine: 200,
    reserve: 0,
    projectileSpeed: wu(50),
    notes: 'Battery, not magazine. Overheats at +8% per shot, cools 30%/s. Stuns the target 0.15 s per hit.',
  },
  plasmaPistol: {
    name: 'Plasma Pistol',
    damage: 18,
    rof: 5,
    magazine: 500,
    reserve: 0,
    projectileSpeed: wu(50),
    notes: 'Overcharge does 70 and EMPs shields after a 0.6 s charge.',
  },
  energySword: {
    name: 'Type-1 Energy Sword',
    damage: 150,
    rof: 1.4,
    magazine: 10,
    reserve: 0,
    notes: 'A battery, not a magazine, and it never reloads. One connected slash kills through full shields, which is what makes carrying it a decision rather than an upgrade.',
  },
  battleRifle: {name:'BR55HB Battle Rifle',damage:12,rof:16.67,magazine:36,reserve:108,zoom:[2],headshotMultiplier:1.5,burst:{size:3,pause:.34}},
  gravityHammer: {name:'Type-2 Gravity Hammer',damage:160,rof:.85,magazine:100,reserve:0},
  needler: {
    name: 'Type-33 Needler',
    damage: 7,
    rof: 9,
    magazine: 20,
    reserve: 80,
    projectileSpeed: 38,
    notes: 'Seven attached needles within 1.6 seconds supercombine for 115 additional damage; tuned for this reconstruction.',
  },
} as const

export const GRENADES = {
  frag: {
    name: 'M9 Frag Grenade',
    damage: 120,
    killRadius: wu(1.5),
    damageRadius: wu(2.5),
    throwSpeed: wu(10),
    /** Detonates this long after coming to rest, with a floor on total flight time. */
    restFuse: 0.5,
    minFuse: 1.5,
    carried: 2,
    max: 4,
  },
} as const

export const WARTHOG = {
  name: 'M12 LRV Warthog',
  /** m/s. 125 km/h. */
  topSpeed: 34.7,
  seats: 3,
  notes: 'Heavy, loose, superb off-road grip, rolls if you corner hard. The handling is the point.',
} as const

// ---------------------------------------------------------------- netcode

/**
 * Source-style authoritative netcode, running in a Cloudflare Durable Object — one DO per
 * match. See DECISIONS.md for why that platform and what it costs.
 *
 * The DO bills inbound WebSocket messages at 20:1 and outbound not at all, so the broadcast
 * fanout is free and only player input meters. That is why input is batched: the client samples
 * every frame and ships a packet of the last few frames, rather than one packet per frame.
 *
 * Free-tier play time at 100,000 requests/day, by lobby size and input packet rate:
 *   16 players @ 20 Hz -> 1.7 h/day     8 players @ 20 Hz -> 3.5 h/day
 *   16 players @ 10 Hz -> 3.5 h/day     8 players @ 10 Hz -> 6.9 h/day
 * Dial INPUT_SEND_HZ down if the meter becomes the binding constraint; the cost is that remote
 * players see your movement later, which client prediction does not hide.
 */
export const NET = {
  /** Fixed simulation timestep, Hz. The client predicts at the same rate. */
  tickRate: 60,
  /** State broadcast rate, Hz. Free on the wire; interpolation covers the gap. */
  snapshotRate: 20,
  /** Input packets per second from each client. Each carries every input frame since the last. */
  inputSendRate: 20,
  /** Remote players render this far in the past so interpolation always has two samples, s. */
  interpolationDelay: 0.1,
  /** How much position history the server keeps for hitscan rewind, s. */
  lagCompensationWindow: 0.2,
  /** Client input history, frames. One second at tickRate. */
  inputBufferSize: 60,
  /** Players per match. */
  maxPlayers: 16,
} as const

/**
 * The simulation is advanced from the WebSocket message handler, not from a timer.
 *
 * A Durable Object gives each documented invocation — an HTTP request, a WebSocket message, an
 * alarm — its own 10 ms CPU budget on the free plan, and Cloudflare does not document which
 * budget a setInterval callback draws from. Driving a fixed-timestep accumulator from inbound
 * messages keeps every tick inside a documented budget and sidesteps the question. A slow
 * keepalive timer only exists so the world still ticks when nobody is pressing anything.
 *
 * Exceeding CPU on a DO discards and recreates the whole object, which ends the match rather
 * than failing one request. Budget conservatively; a 16-player tick should cost 1-3 ms.
 */
export const KEEPALIVE_HZ = 1
