import type { Object3D, Mesh, Material } from 'three'
import type { MapId } from '../../shared/maps.ts'

/**
 * Per-map ambient beds: wind, water, insects, birds and machine hum, synthesized from a few
 * looped noise buffers and oscillators so there is nothing to download. Everything sits far
 * under gunfire (peaks near -24 dBFS into the combat master) and moves slowly: gusts and swells
 * are retargeted every few seconds by one coarse timer, never per frame.
 */
type Noise = 'white' | 'pink' | 'brown'
/** What moves a layer: shared wind gusts, slow insect swells, distance to water, or rare rumbles. */
type Follow = 'gust' | 'swell' | 'water' | 'rumble'
interface Layer {
  noise: Noise; filter: BiquadFilterType; freq: number; q?: number
  /** Peak linear gain; `floor` is the fraction left when its modulation is at rest. */
  level: number; follow?: Follow; floor?: number
  /** Filter frequency at full gust: wind brightens and whistles higher as it picks up. */
  sweep?: number
  /** Fast amplitude modulation, [Hz, depth ≤ .5]: the pulse of a cicada or cricket trill. */
  am?: readonly [number, number]
}
type BirdKind = 'song' | 'tropical' | 'raptor'
interface Bed {
  /** Bus gain, set from offline renders so each bed peaks near -24 dBFS into the master. */
  trim: number
  layers: readonly Layer[]
  gusts?: readonly [number, number]
  rumbles?: readonly [number, number]
  hum?: { freqs: readonly number[]; level: number; lowpass: number; wave: OscillatorType }
  birds?: readonly { kind: BirdKind; every: readonly [number, number]; level: number }[]
}

const BEDS: Partial<Record<MapId, Bed>> = {
  // Sunny Kenyan training ground: warm light breeze, crickets in the grass, distant birds.
  'the-pit': { trim: .77, gusts: [3, 7], layers: [
    { noise: 'pink', filter: 'lowpass', freq: 420, sweep: 850, level: .1, follow: 'gust', floor: .45 },
    { noise: 'pink', filter: 'bandpass', freq: 2600, q: .6, level: .014, follow: 'gust', floor: .2 },
    { noise: 'white', filter: 'bandpass', freq: 4300, q: 10, level: .05, follow: 'swell', floor: .25, am: [23, .45] },
  ], birds: [{ kind: 'song', every: [4, 11], level: .016 }, { kind: 'raptor', every: [30, 60], level: .007 }] },
  // A Forerunner bridge over a chasm: cold gusting wind, a whistle in the struts, faint machinery.
  narrows: { trim: .55, gusts: [2, 5], layers: [
    { noise: 'pink', filter: 'lowpass', freq: 320, sweep: 1100, level: .13, follow: 'gust', floor: .3 },
    { noise: 'white', filter: 'bandpass', freq: 800, sweep: 1500, q: 9, level: .05, follow: 'gust', floor: .08 },
  ], hum: { freqs: [55, 55.35, 110.2], level: .03, lowpass: 260, wave: 'sine' } },
  // Open desert: dry gusts, and sand hissing across the ground when they peak.
  sandtrap: { trim: .64, gusts: [2, 6], layers: [
    { noise: 'pink', filter: 'lowpass', freq: 420, sweep: 900, level: .13, follow: 'gust', floor: .35 },
    { noise: 'white', filter: 'highpass', freq: 4200, sweep: 2800, level: .022, follow: 'gust', floor: .05 },
  ] },
  // Green valley: breeze through the pines, birds, and the river louder as you near it.
  valhalla: { trim: .8, gusts: [3, 8], layers: [
    { noise: 'pink', filter: 'lowpass', freq: 450, sweep: 800, level: .075, follow: 'gust', floor: .45 },
    { noise: 'pink', filter: 'bandpass', freq: 3000, q: .7, level: .018, follow: 'gust', floor: .15 },
    { noise: 'pink', filter: 'bandpass', freq: 850, q: .5, level: .09, follow: 'water' },
    { noise: 'white', filter: 'bandpass', freq: 3300, q: 1.2, level: .02, follow: 'water' },
  ], birds: [{ kind: 'song', every: [2.5, 7], level: .02 }] },
  // A canyon shrine: low wind moaning through the structure and the odd distant rumble.
  epitaph: { trim: 1, gusts: [3, 8], rumbles: [18, 40], layers: [
    { noise: 'pink', filter: 'lowpass', freq: 280, sweep: 600, level: .09, follow: 'gust', floor: .4 },
    { noise: 'pink', filter: 'bandpass', freq: 260, sweep: 420, q: 14, level: .2, follow: 'gust', floor: .12 },
    { noise: 'pink', filter: 'bandpass', freq: 520, sweep: 780, q: 16, level: .12, follow: 'gust', floor: .06 },
    { noise: 'brown', filter: 'lowpass', freq: 110, level: .06, follow: 'rumble' },
  ] },
  // A jungle garage: humid still air, cicada waves, katydids, birds and fluorescent tubes.
  'rats-nest': { trim: 1, gusts: [4, 9], layers: [
    { noise: 'pink', filter: 'lowpass', freq: 380, level: .05 },
    { noise: 'white', filter: 'bandpass', freq: 5200, q: 7, level: .045, follow: 'swell', floor: .1, am: [52, .45] },
    { noise: 'white', filter: 'bandpass', freq: 3600, q: 14, level: .035, follow: 'gust', floor: .35, am: [17, .5] },
  ], hum: { freqs: [60, 120, 180], level: .012, lowpass: 700, wave: 'triangle' },
  birds: [{ kind: 'tropical', every: [5, 12], level: .014 }, { kind: 'song', every: [7, 16], level: .01 }] },
  // Box canyon: gusting wind with a hollow moan off the walls, sparse birds and a hawk.
  'blood-gulch': { trim: .75, gusts: [3, 7], layers: [
    { noise: 'pink', filter: 'lowpass', freq: 380, sweep: 900, level: .11, follow: 'gust', floor: .35 },
    { noise: 'pink', filter: 'bandpass', freq: 380, sweep: 520, q: 8, level: .06, follow: 'gust', floor: .1 },
  ], birds: [{ kind: 'song', every: [6, 14], level: .013 }, { kind: 'raptor', every: [22, 45], level: .008 }] },
  // Forest: wind in the canopy, rustling leaves and birdsong.
  guardian: { trim: 1, gusts: [3, 8], layers: [
    { noise: 'pink', filter: 'lowpass', freq: 450, sweep: 800, level: .085, follow: 'gust', floor: .4 },
    { noise: 'pink', filter: 'bandpass', freq: 2800, q: .7, level: .028, follow: 'gust', floor: .15 },
  ], birds: [{ kind: 'song', every: [2.5, 7], level: .02 }] },
  // Arctic heights: hard cold wind whistling over the ledges, nothing living.
  lockout: { trim: .55, gusts: [2, 6], layers: [
    { noise: 'pink', filter: 'lowpass', freq: 330, sweep: 1200, level: .13, follow: 'gust', floor: .25 },
    { noise: 'white', filter: 'bandpass', freq: 1100, sweep: 1900, q: 10, level: .045, follow: 'gust', floor: .05 },
    { noise: 'pink', filter: 'bandpass', freq: 600, sweep: 900, q: 12, level: .08, follow: 'gust', floor: .05 },
  ] },
}

/** Distance from the river where its layers are at half level, and what remains far away. */
const WATER_HALF = 11, WATER_FLOOR = .1
const FADE_IN = 2, FADE_OUT = 1.5
const MAX_CALLS = 3
const NOISE_RATE = 22050, NOISE_SECONDS = 6

const rand = (a: number, b: number) => a + Math.random() * (b - a)

type Moving = { gain: AudioParam; filter: AudioParam; layer: Layer }
interface Running {
  map: MapId; bed: Bed; bus: GainNode
  sources: AudioScheduledSourceNode[]; nodes: AudioNode[]; moving: Moving[]
  gust: number; swell: number; rumble: number; birds: number[]; calls: number; water: boolean
}
interface WaterField { x0: number; z0: number; cols: number; rows: number; cell: number; dist: Float32Array }

export class AmbienceAudio {
  private readonly noise = new Map<Noise, AudioBuffer>()
  private bed: Running | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private field: WaterField | null = null
  private fieldRoot: Object3D | null = null
  private proximity = 1
  private readonly context: BaseAudioContext
  private readonly output: AudioNode
  /** `manual` leaves the event clock to the caller (offline level checks). */
  constructor(context: BaseAudioContext, output: AudioNode, private readonly manual = false) { this.context = context; this.output = output }

  get playing(): MapId | null { return this.bed?.map ?? null }

  /** Crossfade to `map`'s bed, or fade out with null. `root` is searched for Valhalla's water. */
  play(map: MapId | null, root?: Object3D | null, fade = FADE_OUT): void {
    if (map && this.bed?.map === map) return
    if (this.bed) this.release(this.bed, fade)
    this.bed = null
    const bed = map ? BEDS[map] : undefined
    if (map && bed) {
      if (bed.layers.some(layer => layer.follow === 'water') && root && root !== this.fieldRoot) {
        this.fieldRoot = root; this.field = waterField(root)
      }
      this.bed = this.start(map, bed)
    }
    if (this.manual) return
    if (this.bed && !this.timer) this.timer = setInterval(() => this.tick(), 250)
    else if (!this.bed && this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** Listener position, every frame: an array lookup, and a param write only on a real change. */
  listen(x: number, z: number): void {
    const bed = this.bed, field = this.field
    if (!bed?.water) return
    let p = .35
    if (field) {
      const c = Math.floor((x - field.x0) / field.cell), r = Math.floor((z - field.z0) / field.cell)
      const d = c < 0 || r < 0 || c >= field.cols || r >= field.rows ? Infinity : field.dist[r * field.cols + c]
      p = WATER_FLOOR + (1 - WATER_FLOOR) / (1 + (d / WATER_HALF) ** 2)
    }
    if (Math.abs(p - this.proximity) < .015) return
    this.proximity = p
    const now = this.context.currentTime
    for (const m of bed.moving) if (m.layer.follow === 'water') m.gain.setTargetAtTime(m.layer.level * p, now, .35)
  }

  /** Random events: gust and swell retargets, rumbles and bird calls. */
  tick(): void {
    const bed = this.bed, context = this.context
    if (!bed || (!this.manual && context.state !== 'running')) return
    const now = context.currentTime
    if (now >= bed.gust) { this.retarget(bed, 'gust', now); bed.gust = now + rand(...(bed.bed.gusts ?? [4, 8])) }
    if (now >= bed.swell) { this.retarget(bed, 'swell', now); bed.swell = now + rand(5, 12) }
    if (bed.bed.rumbles && now >= bed.rumble) {
      for (const m of bed.moving) if (m.layer.follow === 'rumble') {
        const peak = m.layer.level * rand(.5, 1)
        m.gain.setTargetAtTime(peak, now, rand(.6, 1.4)); m.gain.setTargetAtTime(0, now + rand(1.5, 3.5), rand(1.2, 2.4))
      }
      bed.rumble = now + rand(...bed.bed.rumbles)
    }
    bed.bed.birds?.forEach((bird, i) => {
      if (now < bed.birds[i]) return
      bed.birds[i] = now + rand(...bird.every)
      if (bed.calls < MAX_CALLS) this.call(bed, bird.kind, bird.level * rand(.35, 1))
    })
  }

  stop(): void { this.play(null, null, .25) }

  private retarget(bed: Running, follow: 'gust' | 'swell', now: number): void {
    // Skewed low so most of the time is a breeze and full gusts are occasional.
    const g = Math.random() ** 1.6, tau = follow === 'gust' ? rand(.8, 2.4) : rand(2, 4)
    for (const m of bed.moving) {
      const layer = m.layer
      if (layer.follow !== follow) continue
      const floor = layer.floor ?? 0
      m.gain.setTargetAtTime(layer.level * (floor + (1 - floor) * g), now, tau)
      if (layer.sweep) m.filter.setTargetAtTime(layer.freq + (layer.sweep - layer.freq) * g * rand(.85, 1.1), now, tau * 1.3)
    }
  }

  private start(map: MapId, bed: Bed): Running {
    const context = this.context, now = context.currentTime
    const bus = context.createGain()
    bus.gain.setValueAtTime(0, now); bus.gain.linearRampToValueAtTime(bed.trim, now + FADE_IN)
    bus.connect(this.output)
    const running: Running = { map, bed, bus, sources: [], nodes: [bus], moving: [], gust: now, swell: now, water: false, calls: 0,
      rumble: now + rand(...(bed.rumbles ?? [0, 0])), birds: (bed.birds ?? []).map(b => now + rand(1, b.every[1])) }
    for (const layer of bed.layers) {
      const source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain()
      source.buffer = this.buffer(layer.noise); source.loop = true
      // A random start and slightly different rate keep layers sharing a buffer uncorrelated.
      source.playbackRate.value = rand(.94, 1.06)
      filter.type = layer.filter; filter.frequency.value = layer.freq; filter.Q.value = layer.q ?? .707
      const floor = layer.floor ?? 0
      gain.gain.value = layer.follow === 'rumble' ? 0 : layer.follow === 'water' ? layer.level * this.proximity : layer.level * (layer.follow ? floor + (1 - floor) * .3 : 1)
      source.connect(filter)
      let tail: AudioNode = filter
      if (layer.am) {
        // Gain = (1 - depth) + depth·sin: a trill pulsing between 1 - 2·depth and full level.
        const am = context.createGain(), lfo = context.createOscillator(), depth = context.createGain()
        am.gain.value = 1 - layer.am[1]; depth.gain.value = layer.am[1]; lfo.frequency.value = layer.am[0] * rand(.95, 1.05)
        lfo.connect(depth); depth.connect(am.gain); filter.connect(am); tail = am
        lfo.start(now); running.sources.push(lfo); running.nodes.push(am, depth)
      }
      tail.connect(gain); gain.connect(bus)
      source.start(now, Math.random() * NOISE_SECONDS)
      running.sources.push(source); running.nodes.push(filter, gain)
      if (layer.follow) running.moving.push({ gain: gain.gain, filter: filter.frequency, layer })
      if (layer.follow === 'water') running.water = true
    }
    if (bed.hum) {
      const hum = bed.hum, filter = context.createBiquadFilter(), gain = context.createGain()
      filter.type = 'lowpass'; filter.frequency.value = hum.lowpass
      gain.gain.value = hum.level / hum.freqs.length
      filter.connect(gain); gain.connect(bus); running.nodes.push(filter, gain)
      for (const f of hum.freqs) {
        const osc = context.createOscillator()
        osc.type = hum.wave; osc.frequency.value = f; osc.connect(filter); osc.start(now)
        running.sources.push(osc)
      }
    }
    return running
  }

  private release(bed: Running, fade: number): void {
    const now = this.context.currentTime, g = bed.bus.gain
    // Hold wherever a fade-in had reached, then ramp down; Firefox lacks cancelAndHoldAtTime.
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(now)
    else { const v = g.value; g.cancelScheduledValues(now); g.setValueAtTime(v, now) }
    g.linearRampToValueAtTime(0, now + fade)
    for (const s of bed.sources) s.stop(now + fade + .05)
    // Wall-clock cleanup still runs if the context was suspended mid-fade (hidden tab).
    setTimeout(() => { for (const n of bed.nodes) n.disconnect(); for (const s of bed.sources) s.disconnect() }, (fade + .3) * 1000)
  }

  /** One bird call: a single oscillator whose pitch and envelope trace every syllable. */
  private call(bed: Running, kind: BirdKind, level: number): void {
    const context = this.context, t0 = context.currentTime + .05
    const osc = context.createOscillator(), env = context.createGain(), pan = context.createStereoPanner()
    osc.type = kind === 'tropical' ? 'triangle' : 'sine'
    pan.pan.value = rand(-.8, .8)
    const f = osc.frequency, a = env.gain
    a.setValueAtTime(0, t0)
    let t = t0
    const note = (from: number, to: number, d: number, peak: number) => {
      f.setValueAtTime(from, t); f.exponentialRampToValueAtTime(to, t + d)
      a.setValueAtTime(0, t); a.linearRampToValueAtTime(peak, t + Math.min(.015, d * .3)); a.linearRampToValueAtTime(peak * .5, t + d * .75); a.linearRampToValueAtTime(0, t + d)
      t += d
    }
    if (kind === 'song') {
      // A short phrase of quick slurred chirps, sometimes ending in a longer falling whistle.
      const base = rand(2600, 4800), count = 2 + Math.floor(Math.random() * 5)
      for (let i = 0; i < count; i++) {
        const from = base * rand(.85, 1.15)
        note(from, from * (Math.random() < .5 ? rand(.65, .8) : rand(1.2, 1.45)), rand(.05, .13), level)
        t += rand(.03, .11)
      }
      if (Math.random() < .35) note(base * 1.1, base * .6, rand(.25, .4), level * .8)
    } else if (kind === 'tropical') {
      // Hollow rising whoops, repeated, with a short drop at the end of each.
      const base = rand(850, 1500), count = 2 + Math.floor(Math.random() * 3)
      for (let i = 0; i < count; i++) {
        note(base, base * rand(1.6, 2), rand(.16, .3), level)
        note(base * 1.8, base * 1.3, .06, level * .6)
        t += rand(.12, .3)
      }
    } else {
      // A distant raptor's "kee-eeer": a thin descending cry, sometimes twice.
      for (let i = Math.random() < .4 ? 2 : 1; i > 0; i--) {
        const base = rand(2600, 3100)
        f.setValueAtTime(base * .92, t); f.exponentialRampToValueAtTime(base, t + .12); f.exponentialRampToValueAtTime(base * .62, t + 1)
        a.setValueAtTime(0, t); a.linearRampToValueAtTime(level, t + .05); a.linearRampToValueAtTime(level * .6, t + .7); a.linearRampToValueAtTime(0, t + 1)
        t += 1 + rand(.25, .5)
      }
    }
    osc.connect(env); env.connect(pan); pan.connect(bed.bus)
    bed.calls++
    osc.onended = () => { bed.calls--; osc.disconnect(); env.disconnect(); pan.disconnect() }
    osc.start(t0); osc.stop(t + .05)
  }

  /** Loopable noise, generated once per colour: stereo, decorrelated, peak-normalized. */
  private buffer(kind: Noise): AudioBuffer {
    const cached = this.noise.get(kind)
    if (cached) return cached
    const length = NOISE_RATE * NOISE_SECONDS, overlap = NOISE_RATE >> 2
    const buffer = this.context.createBuffer(2, length, NOISE_RATE)
    const raw = new Float32Array(length + overlap)
    for (let ch = 0; ch < 2; ch++) {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0, peak = 0
      for (let i = 0; i < raw.length; i++) {
        const w = Math.random() * 2 - 1
        let v = w
        if (kind === 'pink') {
          // Paul Kellet's economy pink filter.
          b0 = .99886 * b0 + w * .0555179; b1 = .99332 * b1 + w * .0750759; b2 = .969 * b2 + w * .153852
          b3 = .8665 * b3 + w * .3104856; b4 = .55 * b4 + w * .5329522; b5 = -.7616 * b5 - w * .016898
          v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * .5362; b6 = w * .115926
        } else if (kind === 'brown') { brown = (brown + .02 * w) / 1.02; v = brown }
        raw[i] = v
      }
      // Equal-power crossfade of the tail into the head, so the loop point has no step.
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < length; i++) {
        const u = i < overlap ? i / overlap : 1
        data[i] = raw[i] * Math.sqrt(u) + (i < overlap ? raw[length + i] * Math.sqrt(1 - u) : 0)
        peak = Math.max(peak, Math.abs(data[i]))
      }
      for (let i = 0; i < length; i++) data[i] /= peak
    }
    this.noise.set(kind, buffer)
    return buffer
  }
}

/**
 * Distance (m, horizontal) to the nearest water surface, on a 4 m grid: water triangles are
 * rasterized into cells, then a two-pass chamfer transform spreads distance outward. Built
 * once per map load, so the per-frame lookup is a single array read.
 */
function waterField(root: Object3D): WaterField | null {
  const cell = 4, points: number[] = []
  root.updateWorldMatrix(true, true)
  root.traverse(object => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (!materials.some(m => /water/i.test(m.name) && !/bed/i.test(m.name))) return
    const position = mesh.geometry.attributes.position, index = mesh.geometry.index, e = mesh.matrixWorld.elements
    const count = index ? index.count : position.count
    const xz = (i: number): [number, number] => {
      const v = index ? index.getX(i) : i, x = position.getX(v), y = position.getY(v), z = position.getZ(v)
      return [e[0] * x + e[4] * y + e[8] * z + e[12], e[2] * x + e[6] * y + e[10] * z + e[14]]
    }
    for (let i = 0; i + 2 < count; i += 3) {
      const [ax, az] = xz(i), [bx, bz] = xz(i + 1), [cx, cz] = xz(i + 2)
      const n = Math.min(24, Math.ceil(Math.max(Math.hypot(bx - ax, bz - az), Math.hypot(cx - ax, cz - az), Math.hypot(cx - bx, cz - bz)) / cell))
      for (let u = 0; u <= n; u++) for (let v = 0; u + v <= n; v++) {
        const s = u / Math.max(1, n), t = v / Math.max(1, n)
        points.push(ax + (bx - ax) * s + (cx - ax) * t, az + (bz - az) * s + (cz - az) * t)
      }
    }
  })
  if (!points.length) return null
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]); minZ = Math.min(minZ, points[i + 1]); maxZ = Math.max(maxZ, points[i + 1])
  }
  const margin = 80, x0 = minX - margin, z0 = minZ - margin
  const cols = Math.ceil((maxX - minX + margin * 2) / cell), rows = Math.ceil((maxZ - minZ + margin * 2) / cell)
  const dist = new Float32Array(cols * rows).fill(1e9)
  for (let i = 0; i < points.length; i += 2) dist[Math.floor((points[i + 1] - z0) / cell) * cols + Math.floor((points[i] - x0) / cell)] = 0
  const d1 = cell, d2 = cell * Math.SQRT2
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c
    let d = dist[i]
    if (c > 0) d = Math.min(d, dist[i - 1] + d1)
    if (r > 0) {
      d = Math.min(d, dist[i - cols] + d1)
      if (c > 0) d = Math.min(d, dist[i - cols - 1] + d2)
      if (c < cols - 1) d = Math.min(d, dist[i - cols + 1] + d2)
    }
    dist[i] = d
  }
  for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
    const i = r * cols + c
    let d = dist[i]
    if (c < cols - 1) d = Math.min(d, dist[i + 1] + d1)
    if (r < rows - 1) {
      d = Math.min(d, dist[i + cols] + d1)
      if (c < cols - 1) d = Math.min(d, dist[i + cols + 1] + d2)
      if (c > 0) d = Math.min(d, dist[i + cols - 1] + d2)
    }
    dist[i] = d
  }
  return { x0, z0, cols, rows, cell, dist }
}
