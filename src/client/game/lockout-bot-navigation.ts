import { lockoutRoute, lockoutCanWalk, lockoutPatrolPoints } from '../../shared/lockout-navigation.ts'
import { lockoutFloor } from '../../shared/lockout.ts'
import { MOVE } from '../../shared/constants.ts'
import type { NavigationRequest, NavigationResult } from './lockout-navigation-worker.ts'

interface Point { x: number; y: number; z: number }
interface Peer extends Point { id: string; alive: boolean }
interface Journey { path: Point[]; next: number; goal: Point | null; stuck: number; last: Point; plansIn: number; visits: Map<string, number>; serial: number; fightIn: number; fightReachable: boolean; fightTarget: Point | null }

const PLANS_PER_FRAME = 1
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const key = (p: Point) => `${p.x},${p.y},${p.z}`
const seed = (id: string) => [...id].reduce((n, c) => ((n * 31 + c.charCodeAt(0)) >>> 0), 0)

export class LockoutBotNavigator {
  private journeys = new Map<string, Journey>()
  private planFrame = -1
  private plansThisFrame = 0
  private worker: Worker | null = null
  private workerInitialized = false
  private token = 0
  private readonly pending = new Map<number, { id: string; journey: Journey; from: Point; target: Point | null; plan: boolean }>()
  private readonly pendingIds = new Set<string>()

  private initializeWorker(): void {
    if (this.workerInitialized) return
    this.workerInitialized = true
    // Node's traversal checks use the synchronous solver. In the browser only
    // short, immediate movement sweeps run on the rendering thread.
    this.worker = typeof Worker === 'undefined' ? null : new Worker(new URL('./lockout-navigation-worker.ts', import.meta.url), { type: 'module' })
    if (this.worker) this.worker.onmessage = (event: MessageEvent<NavigationResult>) => {
      const result = event.data, request = this.pending.get(result.token)
      if (!request) return
      this.pending.delete(result.token); this.pendingIds.delete(request.id)
      const j = this.journeys.get(request.id)
      if (j !== request.journey) return
      if (result.error) { console.warn('Lockout navigation failed:', result.error); j.plansIn = 2; return }
      // A bot that continued along its old route must not snap back to a stale route start.
      if (distance(j.last, request.from) > 1.5) return
      j.fightReachable = result.reachable; j.fightTarget = request.target; j.fightIn = .5
      if (request.plan && !result.reachable) {
        j.path = result.path; j.goal = result.goal; j.next = 0; j.stuck = 0; j.plansIn = .65
        if (result.goal) j.visits.set(key(result.goal), (j.visits.get(key(result.goal)) ?? 0) + 1)
      }
    }
  }

  reset(id: string): void {
    this.journeys.delete(id); this.pendingIds.delete(id)
    for (const [token, request] of this.pending) if (request.id === id) this.pending.delete(token)
  }

  private destinations(id: string, from: Point, j: Journey): Point[] {
    const offset = (seed(id) + j.serial++ * 7) % lockoutPatrolPoints.length
    const candidates = lockoutPatrolPoints.map((p, i) => ({ p, score:
      (j.visits.get(key(p)) ?? 0) * 35 +
      [...this.journeys].filter(([other, s]) => other !== id && s.goal && distance(s.goal, p) < 5).length * 50 +
      (Math.abs(from.y - p.y) < 2 ? 12 : 0) + distance(from, p) * 0.03 +
      ((i - offset + lockoutPatrolPoints.length) % lockoutPatrolPoints.length) * 0.2
    })).filter(c => distance(c.p, from) > 5).sort((a, b) => a.score - b.score)

    return candidates.map(c => c.p)
  }

  private destination(id: string, from: Point, j: Journey): Point[] {
    for (const p of this.destinations(id, from, j)) {
      const route = lockoutRoute(from, p)
      if (route.length) { j.goal = p; j.visits.set(key(p), (j.visits.get(key(p)) ?? 0) + 1); return route }
    }
    j.goal = null; return []
  }

  /** `objective` is somewhere to go when there is nobody to fight: a flag, the ball, a plate. */
  steer(id: string, from: Point, dt: number, peers: readonly Peer[], target: Point | null, time: number, objective: Point | null = null): { x: number; z: number } {
    this.initializeWorker()
    let j = this.journeys.get(id)
    if (!j) { j = { path: [], next: 0, goal: null, stuck: 0, last: { ...from }, plansIn: 0, visits: new Map(), serial: 0, fightIn: 0, fightReachable: false, fightTarget: null }; this.journeys.set(id, j) }

    // Follow waypoints every simulation tick. At running speed a 15 Hz cached
    // direction overshoots several 25 cm cells, including corners next to the void.
    if (time !== this.planFrame) { this.planFrame = time; this.plansThisFrame = 0 }

    const moved = distance(from, j.last); j.last = { ...from }; j.plansIn = Math.max(0, j.plansIn - dt)
    j.stuck = moved > dt * 0.3 ? 0 : j.stuck + dt

    let dx = 0, dz = 0, probe = 0.8
    const range = target ? Math.hypot(target.x - from.x, target.z - from.z) : Infinity

    // A long combat corridor is a tactical decision, not a movement sweep. Cache
    // it briefly and share the planning budget so a crowd cannot recast 15 long
    // corridors in one tick. The short movement candidate is still checked every tick.
    j.fightIn = Math.max(0, j.fightIn - dt)
    const nearby = target && Math.abs(target.y - from.y) < 1 && range < 25
    if (!nearby || (target && j.fightTarget && distance(target, j.fightTarget) > 2)) {
      j.fightReachable = false; j.fightIn = 0
    }
    const seek = target ? null : objective
    const aim = target ?? seek
    const seekRange = seek ? Math.hypot(seek.x - from.x, seek.z - from.z) : Infinity
    const exhausted = j.next >= j.path.length
    const targetMoved = aim && (!j.goal || distance(aim, j.goal) > (target ? 5 : 3))
    const needsPlan = j.plansIn <= 0 && (exhausted || j.stuck > 1.3 || !!targetMoved)
    if (this.worker && (needsPlan || (nearby && j.fightIn <= 0)) && !this.pendingIds.has(id) && this.plansThisFrame < PLANS_PER_FRAME) {
      this.plansThisFrame++
      const token = ++this.token
      this.pending.set(token, { id, journey: j, from: { ...from }, target: aim ? { ...aim } : null, plan: needsPlan })
      this.pendingIds.add(id)
      this.worker.postMessage({ token, from: { ...from }, target: aim ? { ...aim } : null, nearby: !!nearby, plan: needsPlan, destinations: needsPlan ? this.destinations(id, from, j) : [] } satisfies NavigationRequest)
    }
    if (!this.worker && nearby && j.fightIn <= 0 && this.plansThisFrame < PLANS_PER_FRAME) {
      this.plansThisFrame++
      j.fightReachable = lockoutCanWalk(from, target!)
      j.fightTarget = { ...target! }; j.fightIn = .5
    }
    const localFight = nearby && j.fightReachable

    if (localFight) {
      const approach = range > 19 ? 0.65 : range < 8 ? -0.45 : 0
      const side = Math.sin(time * 0.9 + seed(id)) * 0.28
      dx = (target!.x - from.x) / Math.max(range, 0.1) * approach - (target!.z - from.z) / Math.max(range, 0.1) * side
      dz = (target!.z - from.z) / Math.max(range, 0.1) * approach + (target!.x - from.x) / Math.max(range, 0.1) * side
      j.stuck = 0
    } else if (seek && seekRange < 2.5 && Math.abs(seek.y - from.y) < 1.5) {
      // Standing on it already: step the last metre rather than planning a route to here.
      if (seekRange > .3) { dx = (seek.x - from.x) / seekRange; dz = (seek.z - from.z) / seekRange; probe = Math.min(.8, seekRange) }
      j.stuck = 0
    } else {
      if (!this.worker && needsPlan && this.plansThisFrame < PLANS_PER_FRAME) {
        this.plansThisFrame++
        const chase = aim ? lockoutRoute(from, aim) : []
        if (chase.length) { j.path = chase; j.goal = { ...aim! } }
        else j.path = this.destination(id, from, j)
        j.next = 0; j.stuck = 0; j.plansIn = 0.65
      }

      // Footprint support can settle a few centimetres above a baked centre sample
      // on trim/ramp joins. Match the walking-edge check's 6 cm vertical tolerance;
      // retain tight horizontal arrival so bots cannot cut a doorway or ledge corner.
      while (j.next < j.path.length &&
        Math.hypot(from.x-j.path[j.next].x,from.z-j.path[j.next].z)<.025 &&
        Math.abs(from.y-j.path[j.next].y)<.06) j.next++
      const next = j.path[j.next]
      if (next) {
        const length = Math.hypot(next.x - from.x, next.z - from.z)
        probe = Math.min(0.8, length)
        const speed = Math.min(1,length/(MOVE.forwardSpeed*Math.max(dt*2,.05)))
        dx = (next.x - from.x) / Math.max(length, 0.001)*speed
        dz = (next.z - from.z) / Math.max(length, 0.001)*speed
      }
    }

    // Separation from other players
    let sx = 0, sz = 0
    for (const p of peers) {
      if (p.id === id || !p.alive || Math.abs(p.y - from.y) > 1.3) continue
      const x = from.x - p.x, z = from.z - p.z, d = Math.hypot(x, z)
      if (d < 2.2 && d > 0.001) { const force = (2.2 - d) / 2.2; sx += x / d * force; sz += z / d * force }
    }

    const candidate = (x: number, z: number) => {
      const length = Math.hypot(x, z), scale = length > 1 ? 1 / length : 1
      x *= scale; z *= scale
      const px = from.x + x * probe, pz = from.z + z * probe
      // floor() already adds stepHeight. Adding another 35 cm selects a different
      // sheet/landing above the bot and can veto a perfectly valid downhill step.
      const y = lockoutFloor(px, pz, from.y, MOVE.stepHeight)
      return lockoutCanWalk(from, { x: px, y, z: pz }) ? { x, z } : null
    }

    // Do not let avoidance push a waypoint follower outside its narrow corridor.
    const result = localFight ? candidate(dx + sx * 0.7, dz + sz * 0.7) ?? candidate(dx, dz) ?? { x: 0, z: 0 }
      : candidate(dx,dz) ?? { x:0,z:0 }
    return result
  }

  debug(id: string): Readonly<Journey> | undefined { return this.journeys.get(id) }
}
