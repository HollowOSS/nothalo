import { preloadLevelData } from '../../shared/level-data.ts'
import { createArenaNavigation } from '../../shared/arena-navigation.ts'
import type { ArenaId } from '../../shared/arena.ts'

type Point = { x: number; y: number; z: number }
export interface ArenaPlanRequest {
  token: number
  map: ArenaId
  from: Point
  /** Who to fight or where to go; null plans a patrol from `destinations`. */
  aim: Point | null
  /** Also answer whether `aim` can be walked to in a straight line (a close fight). */
  nearby: boolean
  plan: boolean
  destinations: Point[]
}
export interface ArenaPlanResult {
  token: number
  reachable: boolean
  path: Point[]
  goal: Point | null
  error?: string
}

/**
 * Bot route planning for the imported arenas, off the rendering thread. A single plan walks
 * the full-detail collision mesh thousands of times (every 10 cm of every shortcut, plus a
 * controller walk), which took 25-50 ms on the main thread. This worker keeps its own copy of
 * the map's collision and navigation grid; the navigator keeps following its old route until
 * the answer comes back.
 */
let navigation: ReturnType<typeof createArenaNavigation> | null = null
let loaded: Promise<void> | null = null
let queue = Promise.resolve()
self.onmessage = (event: MessageEvent<ArenaPlanRequest>) => {
  queue = queue.then(async () => {
    const request = event.data
    try {
      loaded ??= preloadLevelData(request.map)
      await loaded
      navigation ??= createArenaNavigation(request.map)
      const reachable = !!request.aim && request.nearby && navigation.canWalk(request.from, request.aim)
      let path: Point[] = [], goal: Point | null = null
      if (request.plan && !reachable) {
        if (request.aim) { path = navigation.route(request.from, request.aim); if (path.length) goal = request.aim }
        if (!path.length) for (const destination of request.destinations) {
          path = navigation.route(request.from, destination)
          if (path.length) { goal = destination; break }
        }
      }
      self.postMessage({ token: request.token, reachable, path, goal } satisfies ArenaPlanResult)
    } catch (error) {
      self.postMessage({ token: request.token, reachable: false, path: [], goal: null, error: String(error) } satisfies ArenaPlanResult)
    }
  })
}
