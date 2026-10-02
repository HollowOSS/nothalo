export interface ArenaData {
  collision: {bounds:{min:readonly number[];max:readonly number[]};quantum:number;indexBytes:number;encoding?:string;positionCount?:number;indexCount?:number;positions:string;indices:string}
  nodes:string
  slabs:readonly (readonly number[])[]
}
const arenas = new Map<string,ArenaData>()
/** Whether a level's arena data is loaded: a placeholder spawn (a Player built before its map is assigned) must not require it. */
export function hasArenaData(map:string):boolean { return arenas.has(map) }
export function arenaData(map:string):ArenaData {
  const data=arenas.get(map)
  if(!data)throw new Error(`Load ${map} data before creating its world`)
  return data
}
import type { MapId } from './maps.ts'

type GuardianCollision = typeof import('./guardian-collision-data.ts').GUARDIAN_COLLISION_DATA
type GuardianNavigation = typeof import('./guardian-nav-data.ts').GUARDIAN_NAV_DATA
type LockoutCollision = typeof import('./lockout-collision-data.ts').LOCKOUT_COLLISION_DATA
type LockoutNavigation = typeof import('./lockout-nav-data.ts').LOCKOUT_NAV_DATA
let guardianCollision: GuardianCollision | undefined
let guardianNavigation: GuardianNavigation | undefined
let lockoutCollision: LockoutCollision | undefined
let lockoutNavigation: LockoutNavigation | undefined
const pending = new Map<MapId, Promise<void>>()

/** Complete before creating a world. Failed requests remain retryable. */
export function preloadLevelData(map: MapId): Promise<void> {
  const existing = pending.get(map)
  if (existing) return existing
  const ready = (async () => {
    if (map === 'blood-gulch') {
      arenas.set(map,(await import('./blood-gulch-data.ts')).default)
    } else if (map === 'the-pit') {
      arenas.set(map,(await import('./the-pit-data.ts')).default)
    } else if (map === 'narrows') {
      arenas.set(map,(await import('./narrows-data.ts')).default)
    } else if (map === 'sandtrap') {
      arenas.set(map,(await import('./sandtrap-data.ts')).default)
    } else if (map === 'valhalla') {
      arenas.set(map,(await import('./valhalla-data.ts')).default)
    } else if (map === 'epitaph') {
      arenas.set(map,(await import('./epitaph-data.ts')).default)
    } else if (map === 'rats-nest') {
      arenas.set(map,(await import('./rats-nest-data.ts')).default)
    } else if (map === 'guardian') {
      const [collision, navigation] = await Promise.all([
        import('./guardian-collision-data.ts'), import('./guardian-nav-data.ts'),
      ])
      guardianCollision = collision.GUARDIAN_COLLISION_DATA
      guardianNavigation = navigation.GUARDIAN_NAV_DATA
    } else if (map === 'lockout') {
      const [collision, navigation] = await Promise.all([
        import('./lockout-collision-data.ts'), import('./lockout-nav-data.ts'),
      ])
      lockoutCollision = collision.LOCKOUT_COLLISION_DATA
      lockoutNavigation = navigation.LOCKOUT_NAV_DATA
    }
  })().catch(error => { pending.delete(map); throw error })
  pending.set(map, ready)
  return ready
}

function required<T>(data: T | undefined, map: MapId): T {
  if (!data) throw new Error(`Load ${map} data before creating its world`)
  return data
}
export const guardianCollisionData = () => required(guardianCollision, 'guardian')
export const guardianNavigationData = () => required(guardianNavigation, 'guardian')
export const lockoutCollisionData = () => required(lockoutCollision, 'lockout')
export const lockoutNavigationData = () => required(lockoutNavigation, 'lockout')

// The Worker and Node tools serve/check multiple maps with synchronous simulation APIs.
// Browser pages and their background workers explicitly preload only the selected level.
// Module workers have no document, but still expose the importScripts global.
if (!('document' in globalThis) && !('importScripts' in globalThis)) {
  await Promise.all([preloadLevelData('blood-gulch'),preloadLevelData('guardian'), preloadLevelData('lockout'),preloadLevelData('the-pit'),preloadLevelData('narrows'),preloadLevelData('sandtrap'),preloadLevelData('valhalla'),preloadLevelData('epitaph'),preloadLevelData('rats-nest')])
}
