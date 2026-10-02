/** Map identity must stay independent of geometry so menus do not download the game. */
export type MapId = 'blood-gulch' | 'guardian' | 'lockout' | 'the-pit' | 'narrows' | 'sandtrap' | 'valhalla' | 'epitaph' | 'rats-nest'
export const MAP_NAMES: Record<MapId, string> = { 'blood-gulch': 'Blood Gulch', guardian: 'Guardian', lockout: 'Lockout', 'the-pit': 'The Pit', narrows: 'Narrows', sandtrap: 'Sandtrap', valhalla: 'Valhalla', epitaph: 'Epitaph', 'rats-nest': "Rat's Nest" }
export function mapId(raw: string | null | undefined): MapId {
  return raw && Object.hasOwn(MAP_NAMES, raw) ? raw as MapId : 'blood-gulch'
}

/** Explicit level paths win over old query links; unknown paths never start a match. */
export function mapFromUrl(url: URL): MapId | null {
  const path = url.pathname.replace(/\/+$/, '')
  for (const id of Object.keys(MAP_NAMES) as MapId[]) if (path === `/${id}`) return id
  if (path !== '' && path !== '/index.html') return null
  if (url.searchParams.has('map')) return mapId(url.searchParams.get('map'))
  // Preserve existing room links and local screenshot / gameplay harnesses.
  if (['room', 'offline', 'nooverlay', 'cam'].some(key => url.searchParams.has(key))) return 'blood-gulch'
  return null
}

export function levelUrl(map: MapId, from: URL): URL {
  const url = new URL(from)
  url.pathname = `/${map}`
  url.searchParams.delete('map')
  return url
}

/** Stable wire IDs: append maps so existing room snapshots keep their meaning. */
export const WIRE_MAPS: readonly MapId[] = ['blood-gulch', 'guardian', 'lockout', 'the-pit', 'narrows', 'sandtrap', 'valhalla', 'epitaph', 'rats-nest']
