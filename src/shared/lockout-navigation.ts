import { lockoutFloor, lockoutBlocked, LOCKOUT_PLAYER_RADIUS } from './lockout.ts'
import { MOVE, GRAVITY, JUMP_VELOCITY } from './constants.ts'
import {lockoutCollision} from './lockout-collision.ts'
import { lockoutNavigationData } from './level-data.ts'
import { lockoutScale } from './lockout-transform.ts'

/** Patrol points where bots should wander to on Lockout. */
export const lockoutPatrolPoints: readonly { x: number; y: number; z: number }[] = [
  // Tower decks and their lower landings, sampled from the authored collision mesh. The Sniper
  // tower's lower point sits in the corridor east of the room: the map has a wall at x -15.05, so
  // the old (-15, -20) stood inside it once the wall was modelled properly.
  { x: -20, y: 33.18, z: -20 }, { x: -13.8, y: 22.9, z: -18.6 },
  // 20.48 was the downward-facing underside inside the BR tower's solid base,
  // not its lower playable deck. The actual lower deck is at 23.79 m.
  { x: 21.5, y: 28.32, z: -28 }, { x: 15, y: 23.79, z: -25 },
  // Central lift stack: three playable elevations share this footprint.
  { x: -5, y: 27.59, z: -23 }, { x: 0, y: 22.69, z: -10 }, { x: 0, y: 15.77, z: -10 },
]

type Point = { x: number; y: number; z: number }
type NavNode = Point & { ix: number; iz: number; links: number; component: number }
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const
const NAV_RADIUS = 4.5
const NAV_HEIGHT = MOVE.playerHeight

let navNodes: NavNode[] | null = null
let navByCell: Map<string, number[]> | null = null
let navPortals: Map<number, number[]> | null = null

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function cellKey(ix: number, iz: number): string { return `${ix}:${iz}` }

/** Decode the compact grid once. The nav data is shared by the client, bots and Worker. */
function navigationGrid(): { nodes: NavNode[]; byCell: Map<string, number[]> } {
  if (navNodes && navByCell) return { nodes: navNodes, byCell: navByCell }
  const LOCKOUT_NAV_DATA = lockoutNavigationData()
  const bytes = decodeBase64(LOCKOUT_NAV_DATA.nodes)
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
  const scale = lockoutScale()
  const nodes: NavNode[] = []
  const byCell = new Map<string, number[]>()
  for (let i = 0; i < LOCKOUT_NAV_DATA.count; i++) {
    const w0 = words[i * 4], w1 = words[i * 4 + 1]
    const ix = w0 & 0xffff, iz = w0 >>> 16
    let millimetres = w1 & 0xffffff
    if (millimetres & 0x800000) millimetres |= ~0xffffff
    const node: NavNode = {
      ix, iz,
      x: (LOCKOUT_NAV_DATA.originX + ix * LOCKOUT_NAV_DATA.cell) * scale,
      y: (millimetres / 1000) * scale,
      z: (LOCKOUT_NAV_DATA.originZ + iz * LOCKOUT_NAV_DATA.cell) * scale,
      links: w1 >>> 24,
      component: words[i * 4 + 3] >>> 0,
    }
    nodes.push(node)
    const key = cellKey(ix, iz)
    const list = byCell.get(key)
    if (list) list.push(i); else byCell.set(key, [i])
  }
  navNodes = nodes; navByCell = byCell; navPortals = new Map()
  const portalBytes=decodeBase64(LOCKOUT_NAV_DATA.portals)
  const portalWords=new Uint32Array(portalBytes.buffer,portalBytes.byteOffset,portalBytes.byteLength/4)
  for(let i=0;i<portalWords.length;i+=2){
    const from=portalWords[i],to=portalWords[i+1]
    const list=navPortals.get(from)??[];list.push(to);navPortals.set(from,list)
  }
  return { nodes, byCell }
}

function nearestNode(point: Point, towardPoint: boolean): number | null {
  const { nodes, byCell } = navigationGrid()
  const data = lockoutNavigationData(), scale = lockoutScale(), cell = data.cell * scale
  const ix = (point.x - data.originX * scale) / cell, iz = (point.z - data.originZ * scale) / cell
  const reach = NAV_RADIUS / cell
  const candidates: { id: number; score: number }[] = []
  // The grid already indexes nodes by footprint. Preserve the same candidate scores
  // and tie order without scanning all 44,000 nodes for every route endpoint.
  for (let x = Math.ceil(ix - reach); x <= Math.floor(ix + reach); x++) for (let z = Math.ceil(iz - reach); z <= Math.floor(iz + reach); z++) for (const i of byCell.get(cellKey(x, z)) ?? []) {
    const node = nodes[i]
    const horizontal = Math.hypot(node.x - point.x, node.z - point.z)
    const vertical = Math.abs(node.y - point.y)
    if (horizontal > NAV_RADIUS || vertical > 3.5) continue
    const score = horizontal + vertical * 1.8
    candidates.push({ id: i, score })
  }
  candidates.sort((a, b) => a.score - b.score || a.id - b.id)
  for (const candidate of candidates) {
    const node = nodes[candidate.id]
    if (towardPoint ? lockoutCanWalk(node, point) : lockoutCanWalk(point, node)) return candidate.id
  }
  return null
}

function neighbours(id: number): number[] {
  const { nodes, byCell } = navigationGrid()
  const node = nodes[id], out: number[] = []
  for (let bit = 0; bit < DIRECTIONS.length; bit++) {
    if (!(node.links & (1 << bit))) continue
    const [dx, dz] = DIRECTIONS[bit]
    const candidates = byCell.get(cellKey(node.ix + dx, node.iz + dz))
    if (!candidates?.length) continue
    let best = candidates[0], bestDelta = Math.abs(nodes[best].y - node.y)
    for (const candidate of candidates.slice(1)) {
      const delta = Math.abs(nodes[candidate].y - node.y)
      if (delta < bestDelta) { best = candidate; bestDelta = delta }
    }
    // Static edges have already passed the full player-controller sweep during baking.
    // Recasting them on every A* expansion makes a level-wide route unnecessarily expensive.
    out.push(best)
  }
  // These short walking connections are checked offline too. Casting the entire
  // capsule corridor inside A* caused multi-second main-thread stalls on first use.
  out.push(...(navPortals!.get(id)??[]))
  return out
}

/** Can a standing player walk from A to B without hitting walls or skipping a step? */
export function lockoutCanWalk(from: Point, to: Point): boolean {
  const distance = Math.hypot(to.x - from.x, to.z - from.z)
  const steps = Math.max(1, Math.ceil(distance / 0.05))
  let y = from.y
  for (let i = 1; i <= steps; i++) {
    const f = i / steps
    const px = from.x + (to.x - from.x) * f
    const pz = from.z + (to.z - from.z) * f
    const floor = lockoutFloor(px, pz, y, MOVE.stepHeight)
    if (floor <= -29.5 || Math.abs(floor - y) > MOVE.stepHeight + .08) return false
    if (lockoutBlocked(px, pz, floor, NAV_HEIGHT)) return false
    y = floor
  }
  return Math.abs(y - to.y) <= MOVE.stepHeight + .2
}

/** Can a bot traverse a short navigation link by walking or jumping a small ledge? */
export function lockoutCanTraverse(from: Point, to: Point): boolean {
  if(lockoutBlocked(from.x,from.z,from.y,NAV_HEIGHT)||lockoutBlocked(to.x,to.z,to.y,NAV_HEIGHT))return false
  if(Math.abs(lockoutFloor(to.x,to.z,to.y,.02)-to.y)>.05)return false
  if (lockoutCanWalk(from, to)) return true
  const horizontal = Math.hypot(to.x - from.x, to.z - from.z)
  const rise = to.y - from.y
  if (horizontal > 1.5 || rise <= MOVE.stepHeight + .2 || rise > MOVE.jumpHeight) return false
  // Sample the whole ballistic arc, not only the landing. Endpoint-only tests let a
  // purported jump link pass through walls and lintels.
  const gravity=GRAVITY
  const discriminant=JUMP_VELOCITY*JUMP_VELOCITY-2*gravity*rise
  if(discriminant<0)return false
  const duration=(JUMP_VELOCITY+Math.sqrt(discriminant))/gravity
  const steps=Math.max(2,Math.ceil(duration*120))
  for(let i=0;i<=steps;i++){
    const t=duration*i/steps,f=i/steps
    const x=from.x+(to.x-from.x)*f,z=from.z+(to.z-from.z)*f
    const y=from.y+JUMP_VELOCITY*t-.5*gravity*t*t
    if(lockoutCollision().blocked(x,z,y,NAV_HEIGHT,LOCKOUT_PLAYER_RADIUS,.01))return false
  }
  return true
}

/** Find a route over Lockout's authored walkable grid. */
export function lockoutRoute(from: Point, to: Point): Point[] {
  if (lockoutCanWalk(from, to)) return [to]
  // Select nodes the actual endpoints can reach. The closest grid node can sit on the far side
  // of a doorway or rail, which used to let A* return a route whose first/last segment clipped the
  // player even though every baked grid edge was valid.
  const start = nearestNode(from, false), goal = nearestNode(to, true)
  if (start === null || goal === null) return []
  const { nodes } = navigationGrid()
  if(start===goal)return [nodes[start],to]
  const open = [start], came = new Int32Array(nodes.length).fill(-1)
  const g = new Float32Array(nodes.length).fill(Infinity), f = new Float32Array(nodes.length).fill(Infinity)
  const closed = new Uint8Array(nodes.length)
  g[start] = 0; f[start] = Math.hypot(nodes[start].x - nodes[goal].x, nodes[start].z - nodes[goal].z)
  while (open.length) {
    let bestAt = 0
    for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bestAt]]) bestAt = i
    const current = open.splice(bestAt, 1)[0]
    if (current === goal) break
    if (closed[current]) continue
    closed[current] = 1
    for (const next of neighbours(current)) {
      if (closed[next]) continue
      const a = nodes[current], b = nodes[next]
      const cost = Math.hypot(a.x - b.x, a.z - b.z) + Math.abs(a.y - b.y) * 1.5
      const tentative = g[current] + cost
      if (tentative >= g[next]) continue
      came[next] = current; g[next] = tentative
      f[next] = tentative + Math.hypot(b.x - nodes[goal].x, b.z - nodes[goal].z) + Math.abs(b.y - nodes[goal].y) * .8
      open.push(next)
    }
  }
  if (came[goal] < 0) return []
  const ids: number[] = []
  for (let id = goal; id >= 0; id = came[id]) { ids.push(id); if (id === start) break }
  if (ids.at(-1) !== start) return []
  ids.reverse()
  const route: Point[] = []
  for (let i = 0; i < ids.length; i++) {
    const p = nodes[ids[i]]
    route.push({ x: p.x, y: p.y, z: p.z })
  }
  route.push(to)
  return route
}
