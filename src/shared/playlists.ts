import type { MapId } from './maps.ts'
import type { GameModeId } from './game-modes.ts'

/**
 * Matchmaking playlists, after Halo 3's: you pick a kind of game, not a map, and the matchmaker
 * puts you in the busiest match of that kind that still has room. A playlist is a weighted
 * rotation of map and game type pairs; each new match rolls one.
 *
 * Few playlists on purpose. Every playlist splits the people online, and a small population split
 * nine ways is nine empty rooms — which is how everyone ended up on Blood Gulch. The menu goes further
 * and offers one search across all of them (`findAny` in the matchmaker): the busiest open match of
 * any kind, or a new one rolled from these.
 *
 * Slayer and free for all only, for now: the other game types have not had a full test online.
 *
 * Identity only, like maps.ts and game-modes.ts, so the menu can list these without geometry.
 */
export type PlaylistId = 'team-slayer' | 'big-team' | 'rumble-pit'

export interface PlaylistEntry { readonly map: MapId; readonly mode: GameModeId; readonly weight: number }

export interface Playlist {
  readonly name: string
  readonly blurb: string
  /** The size line under the name, as Halo 3's "Team Size: 3-4". */
  readonly size: string
  /** Humans per match. The room turns away anyone past this; the matchmaker opens a new room first. */
  readonly maxPlayers: number
  /** Spartans kept in play while anyone is there: server bots make up the difference (server/bots.ts). */
  readonly botFill: number
  readonly entries: readonly PlaylistEntry[]
}

export const PLAYLISTS: Record<PlaylistId, Playlist> = {
  'team-slayer': {
    name: 'Team Slayer', blurb: 'Straight up team Slayer on the arena maps. Work with your team to outkill the other.',
    size: '4v4', maxPlayers: 8, botFill: 8,
    entries: [
      { map: 'lockout', mode: 'slayer', weight: 2 },
      { map: 'guardian', mode: 'slayer', weight: 2 },
      { map: 'the-pit', mode: 'slayer', weight: 2 },
      { map: 'narrows', mode: 'slayer', weight: 1 },
      { map: 'epitaph', mode: 'slayer', weight: 1 },
    ],
  },
  'big-team': {
    name: 'Big Team Battle', blurb: 'Large teams on the big maps, with vehicles on Blood Gulch.',
    size: 'Up to 8v8', maxPlayers: 16, botFill: 8,
    entries: [
      { map: 'blood-gulch', mode: 'btb', weight: 3 },
      { map: 'valhalla', mode: 'btb', weight: 2 },
      { map: 'sandtrap', mode: 'btb', weight: 1 },
      { map: 'rats-nest', mode: 'btb', weight: 1 },
    ],
  },
  'rumble-pit': {
    name: 'Rumble Pit', blurb: 'Free for all. Every other player is a target.',
    size: '8-player FFA', maxPlayers: 8, botFill: 6,
    entries: [
      { map: 'lockout', mode: 'ffa', weight: 2 },
      { map: 'guardian', mode: 'ffa', weight: 2 },
      { map: 'the-pit', mode: 'ffa', weight: 2 },
      { map: 'epitaph', mode: 'ffa', weight: 1 },
      { map: 'narrows', mode: 'ffa', weight: 1 },
    ],
  },
}

/** A seat from the matchmaker: the room to connect to, and the game it was rolled. */
export interface MatchTicket { room: string; playlist: PlaylistId; map: MapId; mode: GameModeId }

export interface MatchmakingStats {
  /** Everyone: in a match, or looking at the menu. */
  online: number
  /** Humans in matchmade matches, per playlist. */
  playlists: Record<PlaylistId, number>
}

export const PLAYLIST_IDS = Object.keys(PLAYLISTS) as PlaylistId[]

/** How often a new match from the single search is each playlist's: small games are what a small population fills. */
export const PLAYLIST_WEIGHTS: Record<PlaylistId, number> = { 'team-slayer': 2, 'big-team': 1, 'rumble-pit': 1 }

/** Game types offered anywhere on the menu, matchmade or custom. The rest wait for a full online test. */
export const OFFERED_MODES = ['slayer', 'ffa'] as const

export function playlistId(raw: string | null | undefined): PlaylistId | null {
  return raw && Object.hasOwn(PLAYLISTS, raw) ? raw as PlaylistId : null
}

/** Roll the next game, weighted, avoiding a repeat of the last map when there is anything else. */
export function pickEntry(id: PlaylistId, last?: MapId, random = Math.random): PlaylistEntry {
  const all = PLAYLISTS[id].entries
  const pool = all.some(e => e.map !== last) ? all.filter(e => e.map !== last) : all
  let roll = random() * pool.reduce((sum, e) => sum + e.weight, 0)
  for (const entry of pool) if ((roll -= entry.weight) < 0) return entry
  return pool[pool.length - 1]
}
