import { preloadLevelData } from '../../shared/level-data.ts'
import { lockoutCanWalk, lockoutRoute } from '../../shared/lockout-navigation.ts'

type Point = { x: number; y: number; z: number }
export interface NavigationRequest {
  token: number
  from: Point
  target: Point | null
  nearby: boolean
  plan: boolean
  destinations: Point[]
}
export interface NavigationResult {
  token: number
  reachable: boolean
  path: Point[]
  goal: Point | null
  error?: string
}

const ready = preloadLevelData('lockout')
// Keep requests in order while the worker's independent collision/grid cache warms.
let queue = Promise.resolve()
self.onmessage = (event: MessageEvent<NavigationRequest>) => {
  queue = queue.then(async () => {
    const request = event.data
    try {
      await ready
      const reachable = !!request.target && request.nearby && lockoutCanWalk(request.from, request.target)
      let path: Point[] = [], goal: Point | null = null
      if (request.plan && !reachable) {
        if (request.target) { path = lockoutRoute(request.from, request.target); if (path.length) goal = request.target }
        if (!path.length) for (const destination of request.destinations) {
          path = lockoutRoute(request.from, destination)
          if (path.length) { goal = destination; break }
        }
      }
      self.postMessage({ token: request.token, reachable, path, goal } satisfies NavigationResult)
    } catch (error) {
      self.postMessage({ token: request.token, reachable: false, path: [], goal: null, error: String(error) } satisfies NavigationResult)
    }
  })
}
