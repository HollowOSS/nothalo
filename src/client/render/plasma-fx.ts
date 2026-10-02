import * as THREE from 'three'

/**
 * Plasma shots as light, not balls: every plasma bolt, overcharged orb, trail and spark on screen is one additive point sprite in a single
 * draw call (one Points object, per-particle size and HDR colour, no lights, nothing allocated per shot), so a room full of plasma pistols
 * costs the same draw as one. Colours run past 1 and are not tone mapped: the bloom pass turns the cores white-hot and keeps the halos in
 * the weapon's colour.
 *
 *  - A tap bolt (`bolt`): a white-green core in a green glow, a comet tail of fading sprites behind it and a few sparks shed along the way.
 *  - An overcharged orb (`orb`, driven by ChargedPlasma each frame): a bright core, a pulsing halo, wisps orbiting it, and a long trail
 *    that sheds embers.
 *  - A live projectile (`tracer`, driven each frame by whatever flies it, e.g. the Ghost's and Banshee's cannon bolts and the fuel
 *    rod): the tap bolt's look at any scale, following the real projectile, bursting into embers where it hits (`tracerGone`).
 *
 * One PlasmaFx per scene (`plasmaFx(scene)`); `update(dt)` advances it, the buffer is written just before it renders so it always shows
 * the latest positions.
 */
const CAPACITY = 900

let sprite: THREE.CanvasTexture | null = null
/** The soft round glow every additive sprite here is drawn with (shared with vehicle-fx.ts). */
export function spriteTexture(): THREE.CanvasTexture {
  if (sprite) return sprite
  const c = document.createElement('canvas'); c.width = c.height = 64
  const g = c.getContext('2d')!, r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.22, 'rgba(255,255,255,.85)'); r.addColorStop(.5, 'rgba(255,255,255,.28)'); r.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = r; g.fillRect(0, 0, 64, 64)
  sprite = new THREE.CanvasTexture(c); sprite.colorSpace = THREE.SRGBColorSpace
  return sprite
}

interface Bolt { from: THREE.Vector3; to: THREE.Vector3; color: THREE.Color; age: number; flight: number; seed: number }
interface Orb { at: THREE.Vector3; trail: THREE.Vector3[]; head: number; age: number; seed: number; live: boolean; fade: number }
interface Ember { at: THREE.Vector3; v: THREE.Vector3; age: number; life: number; size: number; color: THREE.Color }
interface Tracer { from: THREE.Vector3; at: THREE.Vector3; color: THREE.Color; size: number; age: number; seed: number; live: boolean; fade: number }

export class PlasmaFx {
  private readonly points: THREE.Points
  private readonly position = new Float32Array(CAPACITY * 3)
  private readonly color = new Float32Array(CAPACITY * 3)
  private readonly size = new Float32Array(CAPACITY)
  private count = 0
  private bolts: Bolt[] = []
  private orbs = new Map<object, Orb>()
  private embers: Ember[] = []
  private tracers = new Map<object, Tracer>()
  private clock = 0
  private readonly scratch = new THREE.Vector3()
  private readonly scratch2 = new THREE.Vector3()
  private readonly c = new THREE.Color()

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute('color', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    geometry.setDrawRange(0, 0)
    const uniforms = { map: { value: spriteTexture() }, pointScale: { value: 400 } }
    const material = new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
      vertexShader: `
        attribute float size; varying vec3 vColor; uniform float pointScale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          // right at the lens (a shot leaving your own gun) a halo would fill the screen: fade and shrink it inside the first couple of metres
          float d = max(.05, -mv.z), near = smoothstep(.3, 3.2, d);
          vColor = color * near; gl_PointSize = size * pointScale * near / d;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying vec3 vColor;
        void main() { vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vColor * t.rgb * t.a, 1.0);
          #include <colorspace_fragment>
        }`,
    })
    this.points = new THREE.Points(geometry, material)
    this.points.name = 'plasma-fx'; this.points.frustumCulled = false; this.points.renderOrder = 5
    // world metres -> pixels: the projection's focal length times half the drawing buffer's height
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(this.bufferSize)
      uniforms.pointScale.value = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5] * this.bufferSize.y / 2
      this.write()
    }
    scene.add(this.points)
  }
  private readonly bufferSize = new THREE.Vector2()

  /** A tap bolt from the muzzle to where it hit, flying at `speed` m/s. */
  bolt(from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation, speed = 80): void {
    if (this.bolts.length > 48) this.bolts.shift()
    this.bolts.push({ from: from.clone(), to: to.clone(), color: new THREE.Color(color), age: 0, flight: Math.min(.4, Math.max(.03, from.distanceTo(to) / speed)), seed: Math.random() * 100 })
  }

  /** An overcharged orb (keyed by its owner object) is at `at` this frame. */
  orb(key: object, at: THREE.Vector3): void {
    let o = this.orbs.get(key)
    if (!o || !o.live) { o = { at: at.clone(), trail: Array.from({ length: 14 }, () => at.clone()), head: 0, age: 0, seed: Math.random() * 100, live: true, fade: 1 }; this.orbs.set(key, o) }
    o.at.copy(at)
  }
  /** The orb keyed `key` burst or vanished: its trail fades out on its own. */
  orbGone(key: object): void {
    const o = this.orbs.get(key); if (!o || !o.live) return
    o.live = false
    // it bursts: a spray of embers where it went off
    for (let i = 0; i < 18; i++) this.emit(o.at, 3.2, .08 + Math.random() * .08, .35 + Math.random() * .25, this.c.setRGB(.55, 1, .35))
  }

  /** A projectile keyed `key` is at `at` this frame: draw it as a plasma bolt `size` times the pistol's. */
  tracer(key: object, at: THREE.Vector3, color: THREE.ColorRepresentation, size = 1): void {
    let t = this.tracers.get(key)
    if (!t || !t.live) { t = { from: at.clone(), at: at.clone(), color: new THREE.Color(color), size, age: 0, seed: Math.random() * 100, live: true, fade: 1 }; this.tracers.set(key, t) }
    t.at.copy(at)
  }
  /** The projectile keyed `key` hit something (`burst`) or ran out: its tail fades on its own. */
  tracerGone(key: object, burst = true): void {
    const t = this.tracers.get(key); if (!t || !t.live) return
    t.live = false
    if (burst) for (let i = 0; i < 6 + 4 * t.size; i++) this.emit(t.at, 2.4 * t.size, (.05 + Math.random() * .05) * t.size, .25 + Math.random() * .2, t.color)
  }

  update(dt: number): void {
    this.clock += dt
    for (const [key, t] of this.tracers) {
      const before = t.age; t.age += dt
      if (t.live) { if (Math.floor(before * 30) !== Math.floor(t.age * 30)) this.emit(t.at, .7 * t.size, (.04 + Math.random() * .03) * t.size, .25, t.color) }
      else { t.fade -= dt * 7; if (t.fade <= 0) this.tracers.delete(key) }
    }
    for (const b of this.bolts) {
      const before = b.age; b.age += dt
      // sparks thrown off the bolt as it flies
      if (b.age < b.flight && Math.floor(before * 40) !== Math.floor(b.age * 40)) {
        const at = this.scratch.lerpVectors(b.from, b.to, Math.min(1, b.age / b.flight))
        this.emit(at, .6, .05 + Math.random() * .03, .22, b.color)
      }
    }
    this.bolts = this.bolts.filter(b => b.age < b.flight + .12)
    for (const [key, o] of this.orbs) {
      o.age += dt
      if (o.live) {
        o.head = (o.head + 1) % o.trail.length; o.trail[o.head].copy(o.at)
        if (Math.random() < dt * 40) this.emit(o.at, 1.2, .06 + Math.random() * .05, .45, this.c.setRGB(.5, 1, .3))
      } else { o.fade -= dt * 4; if (o.fade <= 0) this.orbs.delete(key) }
    }
    for (const e of this.embers) { e.age += dt; e.v.multiplyScalar(Math.exp(-3 * dt)); e.v.y -= 1.5 * dt; e.at.addScaledVector(e.v, dt) }
    this.embers = this.embers.filter(e => e.age < e.life)
  }

  private emit(at: THREE.Vector3, spread: number, size: number, life: number, color: THREE.Color): void {
    if (this.embers.length > 200) this.embers.shift()
    this.embers.push({ at: at.clone(), v: new THREE.Vector3((Math.random() - .5) * spread, (Math.random() - .3) * spread, (Math.random() - .5) * spread), age: 0, life, size, color: color.clone() })
  }

  private put(at: THREE.Vector3, size: number, r: number, g: number, b: number): void {
    if (this.count >= CAPACITY) return
    const i = this.count++
    this.position[i * 3] = at.x; this.position[i * 3 + 1] = at.y; this.position[i * 3 + 2] = at.z
    this.color[i * 3] = r; this.color[i * 3 + 1] = g; this.color[i * 3 + 2] = b
    this.size[i] = size
  }

  private write(): void {
    this.count = 0
    const t = this.clock
    for (const b of this.bolts) {
      const k = Math.min(1, b.age / b.flight), gone = b.age > b.flight ? 1 - (b.age - b.flight) / .12 : 1
      const dir = this.scratch2.subVectors(b.to, b.from); const len = dir.length(); dir.divideScalar(Math.max(1e-4, len))
      const head = this.scratch.lerpVectors(b.from, b.to, k)
      const flick = .85 + .15 * Math.sin(t * 90 + b.seed), cr = b.color.r, cg = b.color.g, cb = b.color.b
      if (b.age <= b.flight) {
        // halo, then the white-hot core
        this.put(head, .42 * flick, cr * 1.4, cg * 1.4, cb * 1.4)
        this.put(head, .16, 1.6 + cr, 2.2 + cg, 1.4 + cb)
      }
      // comet tail: sprites back along the path, shrinking and dimming (it lingers a moment after the bolt lands)
      const travelled = k * len
      for (let i = 1; i <= 8; i++) {
        const back = i * .11
        if (back > travelled) break
        const f = (1 - i / 9) * gone
        this.put(this.scratch.lerpVectors(b.from, b.to, (travelled - back) / Math.max(1e-4, len)), .26 * (1 - i / 11), cr * 1.3 * f, cg * 1.3 * f, cb * 1.3 * f)
      }
    }
    for (const o of this.orbs.values()) {
      const f = Math.max(0, o.fade), pulse = 1 + .12 * Math.sin(t * 22 + o.seed) + .06 * Math.sin(t * 57 + o.seed * 2)
      if (o.live) {
        // halo, core, and four wisps on a slowly turning, wobbling orbit
        this.put(o.at, 1.1 * pulse, .35, .95, .25)
        this.put(o.at, .5 * pulse, .9, 2.2, .6)
        this.put(o.at, .24, 2.4, 3.4, 2)
        for (let w = 0; w < 4; w++) {
          const a = t * (7 + w) + w * 1.57 + o.seed, e = Math.sin(t * 5 + w) * .8
          const p = this.scratch.set(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)).multiplyScalar(.22).add(o.at)
          this.put(p, .16, .6, 1.8, .45)
        }
      }
      // trail: newest to oldest behind the orb, filled in between the per-frame samples (a fast orb moves ~0.5 m a frame: without the fill
      // its trail was a string of beads)
      const n = o.trail.length
      for (let i = 0; i < n - 1; i++) {
        const a = o.trail[(o.head - i + n) % n], b = o.trail[(o.head - i - 1 + n) % n], steps = Math.min(6, 1 + Math.floor(a.distanceTo(b) / .08))
        for (let j = i === 0 ? 1 : 0; j < steps; j++) {
          const u = (i + j / steps) / (n - 1), k = (1 - u) * f
          this.put(this.scratch.lerpVectors(a, b, j / steps), .46 * (1 - .8 * u), .3 * k, .95 * k, .22 * k)
        }
      }
    }
    for (const tr of this.tracers.values()) {
      const s = tr.size, cr = tr.color.r, cg = tr.color.g, cb = tr.color.b, f = Math.max(0, tr.fade)
      const flick = .85 + .15 * Math.sin(t * 90 + tr.seed)
      if (tr.live) {
        this.put(tr.at, .42 * s * flick, cr * 1.4, cg * 1.4, cb * 1.4)
        this.put(tr.at, .16 * s, 1.3 + cr * 1.2, 1.3 + cg * 1.2, 1.3 + cb * 1.2)
      }
      // comet tail back along the flight line, no longer than the distance flown (it never pokes out behind the muzzle)
      const dir = this.scratch2.subVectors(tr.at, tr.from), travelled = dir.length()
      if (travelled < 1e-4) continue
      dir.divideScalar(travelled)
      // the tail is as long as a bolt's scaled up, but its sprites stay packed tight so a big one (the fuel rod) is not a string of beads
      const n = Math.round(8 * Math.max(1, s / 1.4)), step = .88 * s / n
      for (let i = 1; i <= n; i++) {
        const back = i * step, u = i / (n + 1)
        if (back > travelled) break
        const k = (1 - u) * f * 8 / n
        this.put(this.scratch.copy(tr.at).addScaledVector(dir, -back), .26 * s * (1 - u * .8), cr * 1.3 * k, cg * 1.3 * k, cb * 1.3 * k)
      }
    }
    for (const e of this.embers) {
      const k = 1 - e.age / e.life
      this.put(e.at, e.size * (.5 + .5 * k), e.color.r * 1.6 * k, e.color.g * 1.6 * k, e.color.b * 1.6 * k)
    }
    const g = this.points.geometry
    g.setDrawRange(0, this.count)
    for (const name of ['position', 'color', 'size']) { const a = g.getAttribute(name) as THREE.BufferAttribute; a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, this.count * a.itemSize) }
  }
}

const perScene = new WeakMap<THREE.Scene, PlasmaFx>()
/** The one PlasmaFx for a scene. */
export function plasmaFx(scene: THREE.Scene): PlasmaFx {
  let fx = perScene.get(scene)
  if (!fx) { fx = new PlasmaFx(scene); perScene.set(scene, fx) }
  return fx
}
