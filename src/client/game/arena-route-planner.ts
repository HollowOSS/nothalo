import type { ArenaId } from '../../shared/arena.ts'
import type { RoutePlanner } from './guardian-bot-navigation.ts'
import type { ArenaPlanRequest, ArenaPlanResult } from './arena-navigation-worker.ts'

type Point = { x: number; y: number; z: number }

/**
 * The arenas' route planner: requests go to arena-navigation-worker.ts, one at a time in order.
 * Returns null where Worker is unavailable (Node checks), so the navigator plans in-line.
 */
export function createArenaRoutePlanner(map: ArenaId): RoutePlanner | null {
  if (typeof Worker === 'undefined') return null
  const worker = new Worker(new URL('./arena-navigation-worker.ts', import.meta.url), { type: 'module' })
  const waiting = new Map<number, { resolve: (result: ArenaPlanResult) => void; reject: (error: Error) => void }>()
  let token = 0
  worker.onmessage = (event: MessageEvent<ArenaPlanResult>) => {
    const result = event.data, request = waiting.get(result.token)
    if (!request) return
    waiting.delete(result.token)
    if (result.error) { console.warn(`${map} navigation failed:`, result.error); request.reject(new Error(result.error)) }
    else request.resolve(result)
  }
  worker.onerror = event => {
    console.warn(`${map} navigation worker failed:`, event.message)
    for (const request of waiting.values()) request.reject(new Error(event.message))
    waiting.clear()
  }
  return {
    plan(from: Point, aim: Point | null, nearby: boolean, plan: boolean, destinations: Point[]) {
      return new Promise((resolve, reject) => {
        const id = ++token
        waiting.set(id, { resolve, reject })
        worker.postMessage({ token: id, map, from, aim, nearby, plan, destinations } satisfies ArenaPlanRequest)
      })
    },
  }
}
