import {unpackArsenal,type ArsenalMessage} from '../../shared/weapon-pickups.ts'
import { NET } from '../../shared/constants.ts'
import {
  Msg, packInput, packPing, packSplash, packLaunch, packName, unpackSnapshot, unpackWelcome, unpackShot,
  unpackHit, unpackDeath, unpackPing, unpackExplosion, unpackLaunch, unpackRoster,
  unpackScoreboard, unpackSession, PROTOCOL_VERSION,
  type WireInput, type Snapshot, type Welcome, type Shot, type Hit, type Death, type Explosion, type Launch,
  type RosterEntry, type ScoreboardEntry,
} from '../../shared/protocol.ts'
import { unpackObjectiveEvent, type ObjectiveEvent } from '../../shared/objectives.ts'

/**
 * The socket to the match.
 *
 * Decodes the binary protocol into events and batches outbound input. Input is the only thing
 * the server meters, so frames are collected and sent `NET.inputSendRate` times a second rather
 * than once per simulation step; a packet carries every frame since the last one.
 */

const FRAMES_PER_PACKET = Math.max(1, Math.round(NET.tickRate / NET.inputSendRate))
const PING_INTERVAL_MS = 1000
/** How long to keep trying to get back in after the socket drops: a deploy takes a few seconds. */
const RECONNECT_FOR_MS = 45_000
const RECONNECT_BACKOFF_MS = [250, 500, 1000, 1500, 2500, 4000]
/** Closed by the server because this seat was reclaimed on another socket (another tab): no retry. */
const CLOSE_REPLACED = 4000

/**
 * reconnecting: the socket dropped and we are trying to get back in. connected: back in our seat.
 * lost: gave up. outdated: the server speaks a newer protocol; only a reload can play on.
 * reseated: back in, but not in our old seat; the match must start over from the page.
 */
export type ConnectionStatus = 'reconnecting' | 'connected' | 'lost' | 'outdated' | 'reseated'

/** The rejoin token for a match, kept for this tab so a dropped socket or a reload gets the seat back. */
function tokenKey(url: string): string {
  const params = new URL(url, location.href).searchParams
  return `rejoin:${params.get('room')}:${params.get('map')}:${params.get('mode')}`
}
function storedToken(url: string): string | null {
  try { return sessionStorage.getItem(tokenKey(url)) } catch { return null }
}
function withToken(url: string): string {
  const token = storedToken(url)
  return token ? `${url}${url.includes('?') ? '&' : '?'}rejoin=${token}` : url
}

export class Connection {
  readonly id: number
  readonly team: 'red' | 'blue'
  readonly maxPlayers: number
  /** The server's wire version, once it has said (an older server never does). */
  protocol: number | null = null
  /** Round trip, milliseconds, smoothed. */
  rtt = 0
  /** Set when the server closes on us; the match falls back to a spectator of nothing. */
  closed = false

  onArsenal: ((state:ArsenalMessage)=>void)|null=null
  onSnapshot: ((s: Snapshot) => void) | null = null
  onShot: ((s: Shot) => void) | null = null
  onHit: ((h: Hit) => void) | null = null
  onDeath: ((d: Death) => void) | null = null
  onExplosion: ((e: Explosion) => void) | null = null
  onLaunch: ((l: Launch) => void) | null = null
  onRoster: ((entries: RosterEntry[]) => void) | null = null
  onScoreboard: ((entries: ScoreboardEntry[]) => void) | null = null
  /** The raw game-type state; the Match's Objectives mirror decodes it. */
  onObjective: ((buf: ArrayBuffer) => void) | null = null
  onObjectiveEvent: ((e: ObjectiveEvent) => void) | null = null
  onClose: ((reason: string) => void) | null = null
  /** Reconnecting, back, gave up, or out of date (see ConnectionStatus). */
  onStatus: ((status: ConnectionStatus) => void) | null = null

  private readonly frames: WireInput[] = []
  private lastFlush = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null

  private socket: WebSocket
  /** Set by close(): this side ended it, so a close is not a drop to recover from. */
  private leaving = false
  private reconnecting = false

  private constructor(socket: WebSocket, welcome: Welcome, private readonly url: string) {
    this.id = welcome.id
    this.team = welcome.team
    this.maxPlayers = welcome.maxPlayers
    this.socket = socket
    this.attach(socket)
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS)
    this.ping()
  }

  private attach(socket: WebSocket): void {
    this.socket = socket
    socket.addEventListener('message', (e) => { if (socket === this.socket) this.receive(e.data as ArrayBuffer) })
    socket.addEventListener('close', (e) => { if (socket === this.socket) this.dropped(e.code, e.reason || 'connection closed') })
    socket.addEventListener('error', () => { if (socket === this.socket) this.dropped(0, 'connection error') })
  }

  /**
   * Open the socket and wait for the server's Welcome. Rejects on refusal, a full match or a
   * timeout, so the caller can start an offline match instead of a broken online one. A token
   * this tab already holds for the match comes along, so a reload gets the same seat back.
   */
  static async connect(url: string, timeoutMs = 4000): Promise<Connection> {
    const { socket, welcome } = await Connection.handshake(withToken(url), timeoutMs)
    return new Connection(socket, welcome, url)
  }

  /**
   * The socket dropped. A deploy restarts the match server and closes every socket; it is back
   * within seconds, holding everyone's seat for their token. Keep trying for a while, quietly.
   */
  private async dropped(code: number, reason: string): Promise<void> {
    if (this.leaving || this.closed || this.reconnecting) return
    if (code === CLOSE_REPLACED) { this.finish(reason); return }
    this.reconnecting = true
    this.onStatus?.('reconnecting')
    const until = performance.now() + RECONNECT_FOR_MS
    for (let attempt = 0; !this.leaving && performance.now() < until; attempt++) {
      await new Promise(r => setTimeout(r, RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]))
      if (this.leaving) return
      try {
        const { socket, welcome } = await Connection.handshake(withToken(this.url), 4000)
        if (this.leaving) { socket.close(); return }
        this.reconnecting = false
        this.frames.length = 0
        this.attach(socket)
        this.onStatus?.(welcome.id === this.id && welcome.team === this.team ? 'connected' : 'reseated')
        return
      } catch { /* the server is still coming up; try again */ }
    }
    this.reconnecting = false
    if (!this.leaving) { this.onStatus?.('lost'); this.finish(reason) }
  }

  private static handshake(url: string, timeoutMs: number): Promise<{ socket: WebSocket; welcome: Welcome }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      const timer = setTimeout(() => { cleanup(); socket.close(); reject(new Error('timed out waiting for the match')) }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('close', onClose)
        socket.removeEventListener('error', onError)
      }
      const onMessage = (e: MessageEvent) => {
        const data = e.data as ArrayBuffer
        if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return
        const view = new DataView(data)
        const type = view.getUint8(0)
        if (type === Msg.Full) { cleanup(); reject(new Error('match is full')); return }
        if (type !== Msg.Welcome || data.byteLength < 4) return
        cleanup()
        resolve({ socket, welcome: unpackWelcome(view) })
      }
      const onClose = (e: CloseEvent) => { cleanup(); reject(new Error(e.reason || 'the server closed the connection')) }
      const onError = () => { cleanup(); reject(new Error('could not reach the match server')) }
      socket.addEventListener('message', onMessage)
      socket.addEventListener('close', onClose)
      socket.addEventListener('error', onError)
    })
  }

  /** One simulation step's worth of input. Sent when a packet's worth has collected. */
  pushInput(frame: WireInput): void {
    this.frames.push(frame)
    const now = performance.now()
    if (this.frames.length >= FRAMES_PER_PACKET || now - this.lastFlush > 1000 / NET.inputSendRate * 1.5) this.flush()
  }

  flush(): void {
    // Input made while reconnecting is dropped, not saved up: the server could not replay it truthfully.
    if (this.frames.length === 0 || this.socket.readyState !== WebSocket.OPEN) { this.frames.length = 0; return }
    this.socket.send(packInput(this.frames))
    this.frames.length = 0
    this.lastFlush = performance.now()
  }

  /** Tell the match what to call you. The server cleans it and tells everyone. */
  setName(name: string): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(packName(name))
  }

  /** `stuck`: the player id a plasma grenade was stuck to, for the Stick medal. */
  sendSplash(kind: number, x: number, y: number, z: number, stuck = 0): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(packSplash({ kind, x, y, z, stuck }))
  }

  sendLaunch(kind: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number): void {
    if (this.socket.readyState !== WebSocket.OPEN) return
    const yaw = Math.atan2(-dx, -dz)
    const pitch = Math.asin(Math.max(-1, Math.min(1, dy)))
    this.socket.send(packLaunch({ owner: 0, kind, x, y, z, yaw, pitch, speed }))
  }

  close(): void {
    this.leaving = true
    this.finish('left the match')
    this.socket.close()
  }

  private ping(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(packPing(performance.now() >>> 0))
  }

  private receive(data: ArrayBuffer): void {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return
    const view = new DataView(data)
    switch (view.getUint8(0)) {
      case Msg.Arsenal: this.onArsenal?.(unpackArsenal(data)); break
      case Msg.Snapshot: this.onSnapshot?.(unpackSnapshot(data)); break
      case Msg.Shot: this.onShot?.(unpackShot(view)); break
      case Msg.Hit: this.onHit?.(unpackHit(view)); break
      case Msg.Death: this.onDeath?.(unpackDeath(view)); break
      case Msg.Explosion: this.onExplosion?.(unpackExplosion(view)); break
      case Msg.Launch: this.onLaunch?.(unpackLaunch(view)); break
      case Msg.Roster: this.onRoster?.(unpackRoster(data)); break
      case Msg.Scoreboard: this.onScoreboard?.(unpackScoreboard(data)); break
      case Msg.Objective: this.onObjective?.(data); break
      case Msg.Session: {
        const session = unpackSession(view)
        if (!session) break
        try { sessionStorage.setItem(tokenKey(this.url), session.token) } catch { /* private mode: no rejoin after a reload */ }
        this.protocol = session.protocol
        if (session.protocol !== PROTOCOL_VERSION) this.onStatus?.('outdated')
        break
      }
      case Msg.ObjectiveEvent: { const e = unpackObjectiveEvent(view); if (e) this.onObjectiveEvent?.(e); break }
      case Msg.Ping: {
        const sample = ((performance.now() >>> 0) - unpackPing(view)) >>> 0
        if (sample < 10000) this.rtt = this.rtt === 0 ? sample : this.rtt * 0.7 + sample * 0.3
        break
      }
    }
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    this.onClose?.(reason)
  }
}
