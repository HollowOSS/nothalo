/**
 * Game types, by identity only. Like `maps.ts` this must stay free of geometry so the menu can
 * list modes without downloading a level; the rules that need positions live in `objectives.ts`.
 *
 * Numbers follow Halo's own defaults where they exist and are shortened where a browser match
 * wants to finish in one sitting.
 */
export type GameModeId = 'slayer' | 'ffa' | 'ctf' | 'oddball' | 'assault' | 'swat' | 'btb'

export interface GameModeSpec {
  readonly name: string
  /** Four letters or so, for the score strip. */
  readonly short: string
  readonly blurb: string
  /** False for free-for-all: nobody has an ally and every other player is hostile. */
  readonly teams: boolean
  /** Kills, captures, seconds held or detonations, depending on the mode. */
  readonly scoreLimit: number
  /** Seconds. The higher score wins when it runs out; equal scores are a tie. */
  readonly timeLimit: number
  /** Word for one point on the scoreboard. */
  readonly unit: string
  /** Energy shields; off means health alone, as in SWAT. Default on. */
  readonly shields?: boolean
  /** A head hit kills outright regardless of the weapon's damage. */
  readonly headshotsKill?: boolean
  /** The motion tracker on the HUD. Default on. */
  readonly radar?: boolean
  /** Grenades in the loadout. Default on. */
  readonly grenades?: boolean
  /**
   * The weapons a player carries, as loadout model ids, in switching order; the first is the
   * one they spawn holding. Default: the whole loadout, spawning with the assault rifle.
   */
  readonly weapons?: readonly string[]
}

export const GAME_MODES: Record<GameModeId, GameModeSpec> = {
  slayer: { name: 'Team Slayer', short: 'SLAYER', blurb: 'Two teams, most kills wins', teams: true, scoreLimit: 30, timeLimit: 12 * 60, unit: 'kills' },
  ffa: { name: 'Free for All', short: 'FFA', blurb: 'Everyone for themselves', teams: false, scoreLimit: 25, timeLimit: 10 * 60, unit: 'kills' },
  ctf: { name: 'Capture the Flag', short: 'CTF', blurb: 'Take their flag to your base', teams: true, scoreLimit: 3, timeLimit: 15 * 60, unit: 'captures' },
  oddball: { name: 'Team Ball', short: 'BALL', blurb: 'Hold the skull to score', teams: true, scoreLimit: 100, timeLimit: 12 * 60, unit: 'seconds' },
  assault: { name: 'Assault', short: 'ASSAULT', blurb: 'Plant the bomb in their base', teams: true, scoreLimit: 3, timeLimit: 15 * 60, unit: 'detonations' },
  // Team Slayer for the big maps' bigger teams: more kills to the win, the same rules.
  btb: { name: 'Big Team Slayer', short: 'SLAYER', blurb: 'Big teams, most kills wins', teams: true, scoreLimit: 40, timeLimit: 12 * 60, unit: 'kills' },
  // Halo 3's SWAT: Team Slayer with no shields, no motion tracker and no grenades, carrying a
  // battle rifle and a magnum, where any headshot is a kill.
  swat: { name: 'SWAT', short: 'SWAT', blurb: 'No shields, no radar, headshots kill', teams: true, scoreLimit: 50, timeLimit: 12 * 60, unit: 'kills',
    shields: false, headshotsKill: true, radar: false, grenades: false, weapons: ['battle-rifle', 'magnum'] },
}

/** Stable wire order; append new modes so an existing room's byte keeps its meaning. */
export const WIRE_MODES: readonly GameModeId[] = ['slayer', 'ffa', 'ctf', 'oddball', 'assault', 'swat', 'btb']

export function modeId(raw: string | null | undefined): GameModeId {
  return raw && Object.hasOwn(GAME_MODES, raw) ? raw as GameModeId : 'slayer'
}

/** Loadout slots this mode lets a player carry, in switching order; the first is the spawn weapon. */
export function modeSlots(spec: GameModeSpec, loadout: readonly { model: string }[], fallback: number): number[] {
  if (!spec.weapons) return [fallback, ...loadout.map((_, i) => i).filter(i => i !== fallback)]
  const slots = spec.weapons.map(model => loadout.findIndex(slot => slot.model === model)).filter(i => i >= 0)
  return slots.length ? slots : [fallback]
}
