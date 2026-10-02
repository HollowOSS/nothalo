import {bloodGulchFloor} from './blood-gulch.ts'
import type { Team } from './map.ts'
import { RED_BASE, BLUE_BASE } from './map.ts'
import type { MapId } from './maps.ts'
import { spawnCandidates } from './spawns.ts'
import { GAME_MODES, WIRE_MODES, type GameModeId, type GameModeSpec } from './game-modes.ts'
import { Msg } from './protocol.ts'

/**
 * The rules of every game type: who is hostile to whom, what is on the field, what scores and
 * who has won.
 *
 * One engine, run in two places. Online the Room owns it and the client only mirrors the wire
 * state; offline the Match owns it and steps it with the bots. Keeping the rules pure and shared
 * is the same choice movement and vehicles already make — two copies of "does this capture
 * count" would disagree the first time anybody changed one of them.
 *
 * Items are the flags, the ball and the bomb. Zones are where they go: a flag stand per team,
 * and for Assault a plate per team that the other side plants on. Positions come from the map's
 * own validated respawn anchors, so every objective sits on a floor a player can stand on.
 */

export interface Point { x: number; y: number; z: number }
/** Anyone the rules need to know about. Ids are the wire ids online, small integers offline. */
export interface Contender extends Point { id: number; team: Team; alive: boolean; seated?: boolean }
export type ItemKind = 'flag' | 'ball' | 'bomb'
export type ItemState = 'home' | 'carried' | 'dropped'
export interface ObjectiveItem extends Point {
  kind: ItemKind
  /** A flag's owner. The ball and the bomb belong to nobody. */
  team: Team | null
  home: Point
  state: ItemState
  /** Player id, or 0. */
  carrier: number
  /** Seconds until a dropped item goes home on its own. */
  resetIn: number
}
export interface ObjectiveZone extends Point { kind: 'stand' | 'plate'; team: Team; radius: number }
export type ObjectiveEventKind = 'taken' | 'dropped' | 'returned' | 'captured' | 'reset' | 'detonated' | 'won' | 'restart'
export interface ObjectiveEvent { kind: ObjectiveEventKind; team: Team | null; player: number; item: ItemKind | null }
export type Winner = { team: Team } | { player: number } | 'tie' | null

export interface ObjectiveLayout { red: Point; blue: Point; center: Point }

const PICKUP_RADIUS = 1.6
const PICKUP_HEIGHT = 2.4
const ZONE_RADIUS = 3
const FLAG_RESET = 20
const ITEM_RESET = 15
/** Seconds a bomb carrier has to stand on the plate. */
export const ARM_TIME = 3
/** A voluntary drop is not an instant regrab. */
const REGRAB_COOLDOWN = 2
const RESTART_DELAY = 10

export const enemyOf = (team: Team): Team => team === 'red' ? 'blue' : 'red'
const horizontal = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z)

const layouts = new Map<MapId, ObjectiveLayout>()
/**
 * Where the two bases and the middle are. Blood Gulch's bases are authored; every other map's
 * respawn anchors are shared by both teams, so the two anchors furthest apart become the bases
 * and the anchor least far from both becomes the middle.
 */
export function objectiveLayout(map: MapId): ObjectiveLayout {
  const cached = layouts.get(map)
  if (cached) return cached
  let layout: ObjectiveLayout
  if (map === 'blood-gulch') {
    // Out in front of each base's door rather than inside it: the canyon bots patrol open
    // terrain, and a flag under a deck they cannot path into would never be taken.
    const at = (x: number, z: number) => ({ x, y: bloodGulchFloor(x, z), z })
    layout = { red: at(RED_BASE.x, RED_BASE.z + 20), blue: at(BLUE_BASE.x, BLUE_BASE.z - 20), center: at(0, 0) }
  } else {
    const points = spawnCandidates(map)
    // Arena maps are built mirrored or rotated about their middle. Prefer a far-apart pair that
    // are each other's reflection, so neither team's base is the better one.
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length, cz = points.reduce((s, p) => s + p.z, 0) / points.length
    let a = points[0], b = points[0], best = -Infinity
    for (const p of points) for (const q of points) {
      if (p === q) continue
      const mismatch = Math.min(
        Math.hypot(q.x - (2 * cx - p.x), q.z - (2 * cz - p.z)),
        Math.hypot(q.x - p.x, q.z - (2 * cz - p.z)),
        Math.hypot(q.x - (2 * cx - p.x), q.z - p.z),
      ) + Math.abs(q.y - p.y) * 2
      const score = horizontal(p, q) - mismatch * 3
      if (score > best) { best = score; a = p; b = q }
    }
    // Red takes the lower-z end, as on Blood Gulch, so the choice is stable across reloads.
    const [red, blue] = a.z < b.z || (a.z === b.z && a.x < b.x) ? [a, b] : [b, a]
    let center = points[0], worst = Infinity
    for (const p of points) {
      const score = Math.max(horizontal(p, red), horizontal(p, blue)) + Math.abs(horizontal(p, red) - horizontal(p, blue)) * .25
      if (score < worst && p !== red && p !== blue) { worst = score; center = p }
    }
    layout = { red: { ...red }, blue: { ...blue }, center: { ...center } }
  }
  layouts.set(map, layout)
  return layout
}

/** The lowest respawn anchor, less a margin: anything dropped below it fell out of the world. */
function voidBelow(map: MapId): number {
  if (map === 'blood-gulch') return -Infinity
  return Math.min(...spawnCandidates(map).map(p => p.y)) - 12
}

export class Objectives {
  readonly spec: GameModeSpec
  readonly items: ObjectiveItem[] = []
  readonly zones: ObjectiveZone[] = []
  readonly layout: ObjectiveLayout
  readonly scores: Record<Team, number> = { red: 0, blue: 0 }
  /** Free for all counts kills per player; team modes leave this empty. */
  readonly playerScores = new Map<number, number>()
  timeLeft: number
  winner: Winner = null
  restartIn = 0
  /** Assault: which team is standing on a plate with the bomb, and how far along the arming is. */
  arming: { team: Team | null; progress: number } = { team: null, progress: 0 }
  /** Set by anything the wire should carry; the Room sends and clears it. */
  dirty = true
  private readonly cooldowns = new Map<number, number>()
  private ballClock = 0
  private readonly lowest: number
  readonly mode: GameModeId
  readonly map: MapId
  /** Floor under a point, for settling a dropped item. Omitted, items stay where they fell. */
  private readonly floor?: (x: number, y: number, z: number) => number

  constructor(mode: GameModeId, map: MapId, floor?: (x: number, y: number, z: number) => number, layout: ObjectiveLayout = objectiveLayout(map)) {
    this.mode = mode
    this.map = map
    this.floor = floor
    this.spec = GAME_MODES[mode]
    this.timeLeft = this.spec.timeLimit
    this.layout = layout
    this.lowest = voidBelow(map)
    const item = (kind: ItemKind, team: Team | null, home: Point): ObjectiveItem =>
      ({ kind, team, home: { ...home }, ...home, state: 'home', carrier: 0, resetIn: 0 })
    if (mode === 'ctf') {
      for (const team of ['red', 'blue'] as const) {
        this.zones.push({ kind: 'stand', team, ...layout[team], radius: ZONE_RADIUS })
        this.items.push(item('flag', team, layout[team]))
      }
    } else if (mode === 'oddball') {
      this.items.push(item('ball', null, layout.center))
    } else if (mode === 'assault') {
      for (const team of ['red', 'blue'] as const) this.zones.push({ kind: 'plate', team, ...layout[team], radius: ZONE_RADIUS })
      this.items.push(item('bomb', null, layout.center))
    }
  }

  get over(): boolean { return this.winner !== null }

  /** Everyone is hostile to everyone in free for all; otherwise only the other team is. */
  hostile(a: { id: number; team: Team }, b: { id: number; team: Team }): boolean {
    return a.id !== b.id && (!this.spec.teams || a.team !== b.team)
  }

  /**
   * Objective modes lean a team's respawns toward its own base, as Halo's do. The bonus is
   * smaller than any safety penalty in the spawn scorer, so it never picks a covered spawn.
   */
  spawnBias(team: Team): (p: Point) => number {
    if (this.mode !== 'ctf' && this.mode !== 'assault') return () => 0
    const own = this.layout[team], other = this.layout[enemyOf(team)], span = Math.max(1, horizontal(own, other))
    return p => 18 * Math.max(0, Math.min(1, (horizontal(p, other) - horizontal(p, own)) / span * .5 + .5))
  }

  /** The team a spawn scorer should see another player on. In free for all, nobody is an ally. */
  spawnTeam(chooser: { id: number; team: Team }, other: { id: number; team: Team }): Team {
    return this.hostile(chooser, other) ? enemyOf(chooser.team) : chooser.team
  }

  carried(id: number): ObjectiveItem | null {
    if (!id) return null
    return this.items.find(i => i.state === 'carried' && i.carrier === id) ?? null
  }

  zone(kind: ObjectiveZone['kind'], team: Team): ObjectiveZone | undefined {
    return this.zones.find(z => z.kind === kind && z.team === team)
  }

  /** A kill counts toward Slayer and Free for All. Suicides and falls score nothing. */
  onKill(killer: { id: number; team: Team } | null, victim: { id: number; team: Team }): ObjectiveEvent[] {
    const events: ObjectiveEvent[] = []
    if (this.over || !killer || !this.hostile(killer, victim)) return events
    if (this.mode === 'slayer' || this.mode === 'swat' || this.mode === 'btb') { this.scores[killer.team]++; this.dirty = true }
    else if (this.mode === 'ffa') { this.playerScores.set(killer.id, (this.playerScores.get(killer.id) ?? 0) + 1); this.dirty = true }
    this.checkLimit(events)
    return events
  }

  /** Whatever the player held falls where they stood. Called on death, on leaving and on a voluntary drop. */
  drop(id: number, at: Point, voluntary = false): ObjectiveEvent[] {
    const item = this.carried(id)
    if (!item) return []
    const events: ObjectiveEvent[] = []
    item.carrier = 0
    this.cooldowns.set(id, voluntary ? REGRAB_COOLDOWN : 0)
    let y = at.y
    const floor = this.floor?.(at.x, at.y + .5, at.z)
    if (floor !== undefined && Number.isFinite(floor) && floor <= at.y + .5 && at.y - floor < 30) y = floor
    const fell = at.y < this.lowest || (floor !== undefined && !(floor > this.lowest))
    if (this.arming.team) this.arming = { team: null, progress: 0 }
    if (fell) {
      this.sendHome(item)
      events.push({ kind: 'reset', team: item.team, player: id, item: item.kind })
    } else {
      Object.assign(item, { x: at.x, y, z: at.z, state: 'dropped', resetIn: item.kind === 'flag' ? FLAG_RESET : ITEM_RESET })
      events.push({ kind: 'dropped', team: item.team, player: id, item: item.kind })
    }
    this.dirty = true
    return events
  }

  /**
   * Advance the clock, move carried items with their carriers, and resolve pickups, returns,
   * captures, ball time and bomb arming. `people` is everyone in the match this tick.
   */
  step(dt: number, people: readonly Contender[]): ObjectiveEvent[] {
    const events: ObjectiveEvent[] = []
    if (this.over) {
      this.restartIn -= dt
      if (this.restartIn <= 0) { this.restart(); events.push({ kind: 'restart', team: null, player: 0, item: null }) }
      return events
    }
    const wholeBefore = Math.ceil(this.timeLeft)
    this.timeLeft = Math.max(0, this.timeLeft - dt)
    if (Math.ceil(this.timeLeft) !== wholeBefore) this.dirty = true
    for (const [id, left] of this.cooldowns) left - dt <= 0 ? this.cooldowns.delete(id) : this.cooldowns.set(id, left - dt)

    const byId = new Map<number, Contender>()
    for (const p of people) byId.set(p.id, p)
    for (const item of this.items) {
      if (item.state === 'carried') {
        const carrier = byId.get(item.carrier)
        if (!carrier || !carrier.alive) { events.push(...this.drop(item.carrier, carrier ?? item)); continue }
        item.x = carrier.x; item.y = carrier.y; item.z = carrier.z
      } else if (item.state === 'dropped') {
        const whole = Math.ceil(item.resetIn)
        item.resetIn -= dt
        if (Math.ceil(item.resetIn) !== whole) this.dirty = true
        if (item.resetIn <= 0) { this.sendHome(item); events.push({ kind: 'reset', team: item.team, player: 0, item: item.kind }) }
      }
    }

    for (const item of this.items) {
      if (item.state === 'carried') continue
      for (const p of people) {
        if (!p.alive || p.seated || this.cooldowns.has(p.id) || this.carried(p.id)) continue
        if (horizontal(p, item) > PICKUP_RADIUS || p.y - item.y > PICKUP_HEIGHT || item.y - p.y > PICKUP_HEIGHT * .6) continue
        if (item.kind === 'flag' && item.team === p.team) {
          // Your own flag: touching it where it fell sends it home. At home there is nothing to do.
          if (item.state === 'dropped') {
            this.sendHome(item)
            events.push({ kind: 'returned', team: item.team, player: p.id, item: 'flag' })
          }
          continue
        }
        item.state = 'carried'; item.carrier = p.id; item.resetIn = 0
        item.x = p.x; item.y = p.y; item.z = p.z
        this.dirty = true
        events.push({ kind: 'taken', team: item.kind === 'flag' ? item.team : p.team, player: p.id, item: item.kind })
        break
      }
    }

    if (this.mode === 'ctf') {
      for (const flag of this.items) {
        if (flag.state !== 'carried') continue
        const carrier = byId.get(flag.carrier)!
        const stand = this.zone('stand', carrier.team)!
        if (horizontal(carrier, stand) > stand.radius || Math.abs(carrier.y - stand.y) > PICKUP_HEIGHT) continue
        this.scores[carrier.team]++
        this.sendHome(flag)
        events.push({ kind: 'captured', team: carrier.team, player: carrier.id, item: 'flag' })
      }
    } else if (this.mode === 'oddball') {
      const ball = this.items[0]
      const carrier = ball.state === 'carried' ? byId.get(ball.carrier) : undefined
      if (carrier) {
        this.ballClock += dt
        while (this.ballClock >= 1) {
          this.ballClock -= 1
          this.scores[carrier.team]++
          this.playerScores.set(carrier.id, (this.playerScores.get(carrier.id) ?? 0) + 1)
          this.dirty = true
        }
      } else this.ballClock = 0
    } else if (this.mode === 'assault') {
      const bomb = this.items[0]
      const carrier = bomb.state === 'carried' ? byId.get(bomb.carrier) : undefined
      const plate = carrier && this.zone('plate', enemyOf(carrier.team))
      if (carrier && plate && horizontal(carrier, plate) <= plate.radius && Math.abs(carrier.y - plate.y) <= PICKUP_HEIGHT) {
        const before = this.arming.progress
        this.arming = { team: carrier.team, progress: Math.min(1, this.arming.progress + dt / ARM_TIME) }
        if (Math.floor(before * 20) !== Math.floor(this.arming.progress * 20)) this.dirty = true
        if (this.arming.progress >= 1) {
          this.scores[carrier.team]++
          this.sendHome(bomb)
          events.push({ kind: 'detonated', team: carrier.team, player: carrier.id, item: 'bomb' })
        }
      } else if (this.arming.team) { this.arming = { team: null, progress: 0 }; this.dirty = true }
    }

    this.checkLimit(events)
    if (!this.over && this.timeLeft <= 0) {
      this.finish(this.leader(), events)
    }
    return events
  }

  /** The side or player ahead, or a tie. */
  leader(): Winner {
    if (!this.spec.teams) {
      let best = -1, id = 0, tied = false
      for (const [player, score] of this.playerScores) {
        if (score > best) { best = score; id = player; tied = false } else if (score === best) tied = true
      }
      return id && !tied ? { player: id } : 'tie'
    }
    return this.scores.red === this.scores.blue ? 'tie' : { team: this.scores.red > this.scores.blue ? 'red' : 'blue' }
  }

  restart(): void {
    this.scores.red = this.scores.blue = 0
    this.playerScores.clear()
    for (const item of this.items) this.sendHome(item)
    this.arming = { team: null, progress: 0 }
    this.timeLeft = this.spec.timeLimit
    this.winner = null
    this.restartIn = 0
    this.ballClock = 0
    this.cooldowns.clear()
    this.dirty = true
  }

  private checkLimit(events: ObjectiveEvent[]): void {
    if (this.over) return
    const limit = this.spec.scoreLimit
    if (!this.spec.teams) {
      for (const [player, score] of this.playerScores) if (score >= limit) { this.finish({ player }, events); return }
      return
    }
    for (const team of ['red', 'blue'] as const) if (this.scores[team] >= limit) { this.finish({ team }, events); return }
  }

  private finish(winner: Winner, events: ObjectiveEvent[]): void {
    this.winner = winner
    this.restartIn = RESTART_DELAY
    for (const item of this.items) if (item.state === 'carried') this.sendHome(item)
    this.arming = { team: null, progress: 0 }
    this.dirty = true
    events.push({ kind: 'won', team: winner && typeof winner === 'object' && 'team' in winner ? winner.team : null,
      player: winner && typeof winner === 'object' && 'player' in winner ? winner.player : 0, item: null })
  }

  private sendHome(item: ObjectiveItem): void {
    Object.assign(item, item.home)
    item.state = 'home'; item.carrier = 0; item.resetIn = 0
    this.dirty = true
  }

  // ------------------------------------------------------------------ wire

  /** Everything a client draws: sent on change, not on the snapshot tick. */
  pack(): ArrayBuffer {
    const buf = new ArrayBuffer(15 + this.items.length * 17)
    const view = new DataView(buf)
    const teamByte = (t: Team | null) => t === 'red' ? 1 : t === 'blue' ? 2 : 0
    view.setUint8(0, Msg.Objective)
    view.setUint8(1, WIRE_MODES.indexOf(this.mode))
    view.setUint16(2, Math.round(this.timeLeft * 10))
    view.setUint16(4, Math.min(65535, this.scores.red))
    view.setUint16(6, Math.min(65535, this.scores.blue))
    const w = this.winner
    view.setUint8(8, w === null ? 0 : w === 'tie' ? 3 : 'team' in w ? (w.team === 'red' ? 1 : 2) : 4)
    view.setUint8(9, w && typeof w === 'object' && 'player' in w ? w.player : 0)
    view.setUint8(10, Math.min(255, Math.round(this.restartIn * 10)))
    view.setUint8(11, teamByte(this.arming.team))
    view.setUint8(12, Math.round(this.arming.progress * 255))
    view.setUint8(13, this.items.length)
    view.setUint8(14, 0)
    let off = 15
    for (const item of this.items) {
      view.setUint8(off, ['flag', 'ball', 'bomb'].indexOf(item.kind))
      view.setUint8(off + 1, teamByte(item.team))
      view.setUint8(off + 2, ['home', 'carried', 'dropped'].indexOf(item.state))
      view.setUint8(off + 3, item.carrier)
      view.setFloat32(off + 4, item.x); view.setFloat32(off + 8, item.y); view.setFloat32(off + 12, item.z)
      view.setUint8(off + 16, Math.min(255, Math.ceil(item.resetIn)))
      off += 17
    }
    return buf
  }

  /** Mirror the server. The layout and zones are derived locally from the same map and mode. */
  apply(buf: ArrayBuffer): void {
    const view = new DataView(buf)
    if (buf.byteLength < 15) return
    const team = (b: number): Team | null => b === 1 ? 'red' : b === 2 ? 'blue' : null
    this.timeLeft = view.getUint16(2) / 10
    this.scores.red = view.getUint16(4)
    this.scores.blue = view.getUint16(6)
    const w = view.getUint8(8)
    this.winner = w === 0 ? null : w === 3 ? 'tie' : w === 4 ? { player: view.getUint8(9) } : { team: w === 1 ? 'red' : 'blue' }
    this.restartIn = view.getUint8(10) / 10
    this.arming = { team: team(view.getUint8(11)), progress: view.getUint8(12) / 255 }
    const count = Math.min(view.getUint8(13), this.items.length, Math.floor((buf.byteLength - 15) / 17))
    let off = 15
    for (let i = 0; i < count; i++, off += 17) {
      const item = this.items[i]
      item.state = (['home', 'carried', 'dropped'] as const)[view.getUint8(off + 2)] ?? 'home'
      item.carrier = view.getUint8(off + 3)
      item.x = view.getFloat32(off + 4); item.y = view.getFloat32(off + 8); item.z = view.getFloat32(off + 12)
      item.resetIn = view.getUint8(off + 16)
    }
  }
}

const EVENT_KINDS: readonly ObjectiveEventKind[] = ['taken', 'dropped', 'returned', 'captured', 'reset', 'detonated', 'won', 'restart']
const ITEM_KINDS: readonly (ItemKind | null)[] = [null, 'flag', 'ball', 'bomb']

export function packObjectiveEvent(e: ObjectiveEvent): ArrayBuffer {
  const buf = new ArrayBuffer(5)
  const view = new DataView(buf)
  view.setUint8(0, Msg.ObjectiveEvent)
  view.setUint8(1, EVENT_KINDS.indexOf(e.kind))
  view.setUint8(2, e.team === 'red' ? 1 : e.team === 'blue' ? 2 : 0)
  view.setUint8(3, e.player)
  view.setUint8(4, ITEM_KINDS.indexOf(e.item))
  return buf
}

export function unpackObjectiveEvent(view: DataView): ObjectiveEvent | null {
  if (view.byteLength < 5) return null
  const kind = EVENT_KINDS[view.getUint8(1)]
  if (!kind) return null
  const t = view.getUint8(2)
  return { kind, team: t === 1 ? 'red' : t === 2 ? 'blue' : null, player: view.getUint8(3), item: ITEM_KINDS[view.getUint8(4)] ?? null }
}

/** The line the feed shows and the announcer's cue. `name` turns an id into a player's name. */
export function describeEvent(e: ObjectiveEvent, name: (id: number) => string): string {
  const side = (t: Team | null) => t ? `${t === 'red' ? 'Red' : 'Blue'}` : ''
  const who = name(e.player), you = who === 'you'
  switch (e.kind) {
    case 'taken':
      return e.item === 'flag' ? `${who} took the ${side(e.team).toLowerCase()} flag`
        : `${who} ${you ? 'have' : 'has'} the ${e.item === 'ball' ? 'ball' : 'bomb'}`
    case 'dropped': return e.item === 'flag' ? `${side(e.team)} flag dropped` : `${e.item === 'ball' ? 'Ball' : 'Bomb'} dropped`
    case 'returned': return `${side(e.team)} flag returned`
    case 'reset': return e.item === 'flag' ? `${side(e.team)} flag reset` : `${e.item === 'ball' ? 'Ball' : 'Bomb'} reset`
    case 'captured': return `${name(e.player)} captured the flag for ${side(e.team).toLowerCase()}`
    case 'detonated': return `${name(e.player)} detonated the bomb for ${side(e.team).toLowerCase()}`
    case 'won': return e.player ? `${who} ${you ? 'win' : 'wins'}` : e.team ? `${side(e.team)} team wins` : 'Tie game'
    case 'restart': return 'New game'
  }
}

/**
 * Where a bot should be heading for the objective, or null to fight and patrol as usual.
 * `urgent` asks the movement to ignore a fight and keep going — a carrier running home does not
 * stop to trade shots. `attacker` splits a team so somebody always stays home.
 */
export function objectiveGoal(o: Objectives, me: Contender, attacker: boolean, people: readonly Contender[]): { point: Point; urgent: boolean } | null {
  if (o.over) return null
  const mine = o.carried(me.id)
  const find = (id: number) => people.find(p => p.id === id && p.alive)
  const at = (p: Point) => ({ x: p.x, y: p.y, z: p.z })
  if (o.mode === 'ctf') {
    const own = o.items.find(i => i.team === me.team)!, theirs = o.items.find(i => i.team !== me.team)!
    const stand = o.zone('stand', me.team)!
    if (mine) return { point: at(stand), urgent: true }
    if (own.state !== 'home' && (!attacker || horizontal(me, own) < 45)) return { point: at(own), urgent: own.state === 'dropped' }
    if (attacker) {
      if (theirs.state !== 'carried') return { point: at(theirs), urgent: false }
      const carrier = find(theirs.carrier)
      return carrier ? { point: at(carrier), urgent: false } : null
    }
    return horizontal(me, stand) > 14 ? { point: at(stand), urgent: false } : null
  }
  if (o.mode === 'oddball') {
    const ball = o.items[0]
    if (mine) return null
    if (ball.state !== 'carried') return { point: at(ball), urgent: attacker }
    const carrier = find(ball.carrier)
    return carrier ? { point: at(carrier), urgent: false } : null
  }
  if (o.mode === 'assault') {
    const bomb = o.items[0]
    const target = o.zone('plate', enemyOf(me.team))!, home = o.zone('plate', me.team)!
    if (mine) return { point: at(target), urgent: true }
    if (bomb.state !== 'carried') return { point: at(bomb), urgent: false }
    const carrier = find(bomb.carrier)
    if (!carrier) return null
    if (carrier.team === me.team) return { point: at(attacker ? target : carrier), urgent: false }
    return { point: at(attacker ? carrier : home), urgent: false }
  }
  return null
}
