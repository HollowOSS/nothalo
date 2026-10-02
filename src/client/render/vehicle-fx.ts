import * as THREE from 'three'
import { spriteTexture } from './plasma-fx.ts'

/**
 * Covenant engine light for the Ghost and the Banshee, in two draws shared by every vehicle on the map:
 *
 *  - Strips (one mesh): camera-facing ribbons, soft across their width. Plasma plumes are short strips straight back
 *    out of each nozzle (the Ghost's side turbines when it boosts, the Banshee's tail engines always), a wide flickering
 *    glow with a white-hot throat inside it. Contrails are long strips left behind by the Banshee's wingtips at speed,
 *    bright and long through flips and rolls, widening as the vapour spreads.
 *  - Sprites (one point draw): nozzle flares, the boost kick's flash, and the sparks both vehicles shed.
 *
 * Both are rebuilt every frame from the vehicles' state; nothing is allocated per frame. Colours run past 1 for the
 * bloom pass, as the plasma shots do (PlasmaFx), and both fade out right at the lens.
 */
export interface EngineFxState {
  /** Ghost: boosting. Banshee: mid-trick (a flip or a roll). */
  maneuver: boolean
  /** Forward speed (m/s). */
  speed: number
  /** Someone is driving it. */
  driven: boolean
  /** World velocity, for sparks to inherit. */
  vx: number; vy: number; vz: number
}

const SPRITES = 900
const STRIP_VERTS = 1800
const TRAIL_SAMPLES = 40
const PLUME_STATIONS = 7

// Nozzles and emitters in the authored model's space (+z forward, metres), measured from the GLBs: the Ghost's side
// turbines end at z = -.4, the Banshee's engine anchors sit at the tail (z = -4) and its wingtips at x = 3.72.
const GHOST_NOZZLES = [new THREE.Vector3(-.82, .7, -.42), new THREE.Vector3(.82, .7, -.42)]
const BANSHEE_ENGINES = [new THREE.Vector3(-.67, .8, -3.95), new THREE.Vector3(.67, .8, -3.95)]
const BANSHEE_WINGTIPS = [new THREE.Vector3(-3.72, .3, -.8), new THREE.Vector3(3.72, .3, -.8)]
const BACK = new THREE.Vector3(0, 0, -1)

type RGB = readonly [number, number, number]
const GHOST_GLOW: RGB = [.22, .42, 1.35], GHOST_CORE: RGB = [1.3, 1.75, 2.3]
const BANSHEE_GLOW: RGB = [1.05, .28, 1.25], BANSHEE_CORE: RGB = [2.1, 1.25, 2.3]

interface Spark { at: THREE.Vector3; v: THREE.Vector3; age: number; life: number; size: number; r: number; g: number; b: number }
interface Trail { at: THREE.Vector3[]; age: number[]; strength: number[]; count: number }
interface Rig { power: number; maneuver: boolean; kick: number; trail: number; trails: Trail[]; seed: number }

export class VehicleFx {
  private readonly points: THREE.Points
  private readonly position = new Float32Array(SPRITES * 3)
  private readonly color = new Float32Array(SPRITES * 3)
  private readonly size = new Float32Array(SPRITES)
  private count = 0
  private readonly sparks: Spark[] = []
  private readonly spare: Spark[] = []
  private readonly rigs = new WeakMap<THREE.Object3D, Rig>()
  private readonly strips: THREE.Mesh
  private readonly stripPosition = new Float32Array(STRIP_VERTS * 3)
  private readonly stripColor = new Float32Array(STRIP_VERTS * 3)
  private readonly stripEdge = new Float32Array(STRIP_VERTS)
  private readonly stripIndex = new Uint16Array((STRIP_VERTS / 2) * 6)
  private verts = 0
  private indices = 0
  private stripStart = 0
  private time = 0
  private readonly camera = new THREE.Vector3()
  private readonly world = new THREE.Vector3()
  private readonly dir = new THREE.Vector3()
  private readonly a = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private readonly c = new THREE.Vector3()
  private readonly toCamera = new THREE.Vector3()
  private readonly bufferSize = new THREE.Vector2()

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute('color', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    geometry.setDrawRange(0, 0)
    const uniforms = { map: { value: spriteTexture() }, pointScale: { value: 400 } }
    this.points = new THREE.Points(geometry, new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
      vertexShader: `
        attribute float size; varying vec3 vColor; uniform float pointScale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          float d = max(.05, -mv.z), near = smoothstep(.3, 3.2, d);
          vColor = color * near; gl_PointSize = size * pointScale * near / d;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying vec3 vColor;
        void main() { vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vColor * t.rgb * t.a, 1.0);
          #include <colorspace_fragment>
        }`,
    }))
    this.points.name = 'vehicle-fx:sprites'; this.points.frustumCulled = false; this.points.renderOrder = 5; this.points.visible = false
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(this.bufferSize)
      uniforms.pointScale.value = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5] * this.bufferSize.y / 2
    }
    scene.add(this.points)

    const strip = new THREE.BufferGeometry()
    strip.setAttribute('position', new THREE.BufferAttribute(this.stripPosition, 3).setUsage(THREE.DynamicDrawUsage))
    strip.setAttribute('color', new THREE.BufferAttribute(this.stripColor, 3).setUsage(THREE.DynamicDrawUsage))
    strip.setAttribute('edge', new THREE.BufferAttribute(this.stripEdge, 1).setUsage(THREE.DynamicDrawUsage))
    strip.setIndex(new THREE.BufferAttribute(this.stripIndex, 1).setUsage(THREE.DynamicDrawUsage))
    strip.setDrawRange(0, 0)
    this.strips = new THREE.Mesh(strip, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, vertexColors: true,
      vertexShader: `
        attribute float edge; varying vec3 vColor; varying float vEdge;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          // a contrail the camera flies through would smear across the screen: fade it inside the first few metres
          vColor = color * smoothstep(1.2, 6.0, -mv.z); vEdge = edge;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vEdge;
        // multisampled edge pixels shade outside the strip, where the colour extrapolates below zero and would darken: clamp it
        void main() { float soft = max(0.0, 1.0 - vEdge * vEdge); gl_FragColor = vec4(max(vColor, 0.0) * soft * soft, 1.0);
          #include <colorspace_fragment>
        }`,
    }))
    this.strips.name = 'vehicle-fx:strips'; this.strips.frustumCulled = false; this.strips.renderOrder = 5; this.strips.visible = false
    scene.add(this.strips)
  }

  /** Start a frame: age and move the sparks. */
  begin(dt: number, camera: THREE.Vector3): void {
    this.time += dt; this.count = 0; this.verts = 0; this.indices = 0
    this.camera.copy(camera)
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]
      s.age += dt
      if (s.age >= s.life) { this.spare.push(s); this.sparks[i] = this.sparks[this.sparks.length - 1]; this.sparks.pop(); continue }
      s.v.multiplyScalar(Math.exp(-2.6 * dt)); s.at.addScaledVector(s.v, dt)
    }
  }

  /** One Ghost this frame (`model` is its authored model, already placed). Boosting lights its turbines. */
  ghost(model: THREE.Object3D, s: EngineFxState, dt: number): void {
    const rig = this.rig(model, 0)
    const want = s.maneuver ? 1 : 0
    rig.power += (want - rig.power) * (1 - Math.exp(-(want > rig.power ? 18 : 6) * dt))
    const kicked = s.maneuver && !rig.maneuver
    if (kicked) rig.kick = 1
    rig.maneuver = s.maneuver
    rig.kick = Math.max(0, rig.kick - dt * 4)
    const p = rig.power
    if (p < .02) return
    model.updateWorldMatrix(true, false)
    const m = model.matrixWorld, back = this.dir.copy(BACK).transformDirection(m)
    for (let i = 0; i < GHOST_NOZZLES.length; i++) {
      const at = this.world.copy(GHOST_NOZZLES[i]).applyMatrix4(m)
      const flick = .82 + .18 * Math.sin(this.time * 61 + i * 2.1) * Math.sin(this.time * 23 + i)
      // A long blue plasma plume with a white-hot throat, stretching as the boost opens up.
      this.plume(at, back, (1.6 + .9 * p + .7 * rig.kick) * (.93 + .07 * Math.sin(this.time * 37 + i)), .24, p * flick, GHOST_GLOW, GHOST_CORE, rig.seed + i)
      this.put(at, (.5 + .45 * rig.kick) * p * flick, .35 * p, .7 * p, 1.6 * p)
      this.put(at, .2 * p, 1.4 * p, 1.8 * p, 2.3 * p)
      for (let n = this.emitCount(50 * p, dt); n > 0; n--)
        this.spark(at, back, s, 7 + Math.random() * 5, 1.4, .04 + Math.random() * .04, .25 + Math.random() * .2, .4, .75, 2)
      // The kick throws a burst of sparks out of each turbine.
      if (kicked) for (let n = 0; n < 12; n++) this.spark(at, back, s, 2 + Math.random() * 3, 5, .05 + Math.random() * .04, .25 + Math.random() * .15, .6, 1.1, 2.2)
    }
  }

  /**
   * One Banshee this frame: its tail engines always burn (harder with speed), its wingtips draw contrails at speed,
   * and a flip or a roll lights everything up and sheds sparks off the wingtips.
   */
  banshee(model: THREE.Object3D, s: EngineFxState, dt: number): void {
    const rig = this.rig(model, 2)
    const fast = THREE.MathUtils.clamp((Math.abs(s.speed) - 24) / 14, 0, 1)
    const want = s.driven || Math.abs(s.speed) > 2 ? .45 + .35 * fast + (s.maneuver ? .45 : 0) : 0
    rig.power += (want - rig.power) * (1 - Math.exp(-(want > rig.power ? 10 : 4) * dt))
    rig.maneuver = s.maneuver
    const trail = s.maneuver ? 1 : fast * .55
    rig.trail += (trail - rig.trail) * (1 - Math.exp(-(trail > rig.trail ? 12 : 3) * dt))
    model.updateWorldMatrix(true, false)
    const m = model.matrixWorld, p = rig.power, back = this.dir.copy(BACK).transformDirection(m)
    if (p > .02) for (let i = 0; i < BANSHEE_ENGINES.length; i++) {
      const at = this.world.copy(BANSHEE_ENGINES[i]).applyMatrix4(m)
      const flick = .86 + .14 * Math.sin(this.time * 53 + i * 1.3) * Math.sin(this.time * 19 + 2 + i)
      this.plume(at, back, (.8 + 1.6 * p) * (.92 + .08 * Math.sin(this.time * 31 + i)), .2, p * flick, BANSHEE_GLOW, BANSHEE_CORE, rig.seed + i)
      this.put(at, .62 * p * flick, .95 * p, .3 * p, 1.2 * p)
      this.put(at, .22 * p, 2 * p, 1.3 * p, 2.2 * p)
    }
    for (let i = 0; i < BANSHEE_WINGTIPS.length; i++) {
      const at = this.world.copy(BANSHEE_WINGTIPS[i]).applyMatrix4(m)
      this.trail(rig.trails[i], at, rig.trail, dt, s.maneuver ? 1.1 : .75)
      if (s.maneuver) {
        this.put(at, .3, 1.3, 1, 1.7)
        const out = this.a.set(Math.sign(BANSHEE_WINGTIPS[i].x), 0, -.6).transformDirection(m)
        for (let n = this.emitCount(40, dt); n > 0; n--) this.spark(at, out, s, 2 + Math.random() * 3, 2.5, .04 + Math.random() * .04, .35 + Math.random() * .25, 1.2, .75, 1.8)
      }
    }
  }

  /** Finish the frame: upload what was drawn. */
  end(): void {
    for (const s of this.sparks) {
      const k = 1 - s.age / s.life
      this.put(s.at, s.size * (.4 + .6 * k), s.r * k, s.g * k, s.b * k)
    }
    const g = this.points.geometry
    g.setDrawRange(0, this.count); this.points.visible = this.count > 0
    for (const name of ['position', 'color', 'size']) { const a = g.getAttribute(name) as THREE.BufferAttribute; a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, this.count * a.itemSize) }
    const r = this.strips.geometry
    r.setDrawRange(0, this.indices); this.strips.visible = this.indices > 0
    for (const name of ['position', 'color', 'edge']) { const a = r.getAttribute(name) as THREE.BufferAttribute; a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, this.verts * a.itemSize) }
    const index = r.getIndex()!; index.needsUpdate = true; index.clearUpdateRanges(); index.addUpdateRange(0, this.indices)
  }

  private rig(model: THREE.Object3D, trails: number): Rig {
    let rig = this.rigs.get(model)
    if (!rig) {
      rig = { power: 0, maneuver: false, kick: 0, trail: 0, seed: Math.random() * 100,
        trails: Array.from({ length: trails }, () => ({ at: Array.from({ length: TRAIL_SAMPLES }, () => new THREE.Vector3()), age: new Array(TRAIL_SAMPLES).fill(0), strength: new Array(TRAIL_SAMPLES).fill(0), count: 0 })) }
      this.rigs.set(model, rig)
    }
    return rig
  }

  /**
   * A plasma plume `length` metres back along `dir` from `at`: an outer glow that swells a little and then tapers,
   * licking in brightness down its length, and a short white-hot core inside it.
   */
  private plume(at: THREE.Vector3, dir: THREE.Vector3, length: number, radius: number, power: number, glow: RGB, core: RGB, seed: number): void {
    if (power < .02) return
    const t0 = this.time * 38 + seed
    for (const layer of [0, 1]) {
      const long = layer ? .42 : 1, wide = layer ? .45 : 1
      if (!this.beginStrip(PLUME_STATIONS)) return
      for (let i = 0; i < PLUME_STATIONS; i++) {
        const t = i / (PLUME_STATIONS - 1)
        const p = this.a.copy(at).addScaledVector(dir, length * long * t)
        const width = radius * wide * (1 + .55 * Math.sin(Math.PI * t)) * (1 - .55 * t)
        const lick = layer ? 1 : .72 + .28 * Math.sin(t * 9 - t0) * Math.sin(t * 4 + t0 * .37)
        const k = power * (1 - t) ** (layer ? 1.6 : 1.25) * lick
        const c = layer ? core : glow
        this.station(p, dir, width, c[0] * k, c[1] * k, c[2] * k)
      }
      this.endStrip()
    }
  }

  /**
   * Advance one wingtip trail and draw it. Sample 0 always rides the wingtip; a new sample is left behind every
   * 40 cm, and samples fade out over `life` seconds, widening as the vapour spreads.
   */
  private trail(t: Trail, at: THREE.Vector3, strength: number, dt: number, life: number): void {
    for (let i = 0; i < t.count; i++) t.age[i] += dt
    while (t.count > 0 && t.age[t.count - 1] > life) t.count--
    if (strength > .02) {
      if (t.count < 2 || t.at[0].distanceToSquared(t.at[1]) > .16) {
        // Leave the head where it is and start a fresh one at the wingtip (reusing the slot that falls off the end).
        const n = Math.min(t.count + 1, TRAIL_SAMPLES), recycled = t.at[n - 1]
        for (let i = n - 1; i > 0; i--) { t.at[i] = t.at[i - 1]; t.age[i] = t.age[i - 1]; t.strength[i] = t.strength[i - 1] }
        t.at[0] = recycled.copy(at)
        t.count = n
      }
      t.at[0].copy(at); t.age[0] = 0; t.strength[0] = strength
    }
    if (t.count < 2 || !this.beginStrip(t.count)) return
    for (let i = 0; i < t.count; i++) {
      const tangent = this.b.subVectors(t.at[Math.max(0, i - 1)], t.at[Math.min(t.count - 1, i + 1)])
      const u = t.age[i] / life, fade = (1 - u) * (1 - u) * Math.min(1, i / 2) * t.strength[i]
      this.station(t.at[i], tangent, .05 + .4 * u, .55 * fade, .52 * fade, .78 * fade)
    }
    this.endStrip()
  }

  private beginStrip(stations: number): boolean {
    if (this.verts + stations * 2 > STRIP_VERTS) return false
    this.stripStart = this.verts
    return true
  }
  /** One cross-section of a strip: two vertices `width` either side of `p`, across `tangent` and facing the camera. */
  private station(p: THREE.Vector3, tangent: THREE.Vector3, width: number, r: number, g: number, b: number): void {
    const side = this.c.crossVectors(tangent, this.toCamera.subVectors(this.camera, p)).normalize().multiplyScalar(width)
    for (const e of [-1, 1]) {
      const v = this.verts++
      this.stripPosition[v * 3] = p.x + side.x * e; this.stripPosition[v * 3 + 1] = p.y + side.y * e; this.stripPosition[v * 3 + 2] = p.z + side.z * e
      this.stripColor[v * 3] = r; this.stripColor[v * 3 + 1] = g; this.stripColor[v * 3 + 2] = b
      this.stripEdge[v] = e
    }
  }
  private endStrip(): void {
    for (let a = this.stripStart; a + 3 < this.verts; a += 2) {
      this.stripIndex.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], this.indices); this.indices += 6
    }
  }

  /** Whole sparks to emit this frame at `rate` per second, carrying the fraction over at random. */
  private emitCount(rate: number, dt: number): number { const n = rate * dt; return Math.floor(n) + (Math.random() < n % 1 ? 1 : 0) }

  private spark(at: THREE.Vector3, dir: THREE.Vector3, s: EngineFxState, speed: number, spread: number, size: number, life: number, r: number, g: number, b: number): void {
    if (this.sparks.length >= 260) return
    const k = this.spare.pop() ?? { at: new THREE.Vector3(), v: new THREE.Vector3(), age: 0, life: 0, size: 0, r: 0, g: 0, b: 0 }
    k.at.copy(at)
    // Inherit most of the vehicle's own velocity so the stream trails off behind it instead of hanging in the air.
    k.v.set(s.vx * .75, s.vy * .75, s.vz * .75).addScaledVector(dir, speed)
    k.v.x += (Math.random() - .5) * spread; k.v.y += (Math.random() - .5) * spread; k.v.z += (Math.random() - .5) * spread
    k.age = 0; k.life = life; k.size = size; k.r = r; k.g = g; k.b = b
    this.sparks.push(k)
  }

  private put(at: THREE.Vector3, size: number, r: number, g: number, b: number): void {
    if (this.count >= SPRITES || size < .005) return
    const i = this.count++
    this.position[i * 3] = at.x; this.position[i * 3 + 1] = at.y; this.position[i * 3 + 2] = at.z
    this.color[i * 3] = r; this.color[i * 3 + 1] = g; this.color[i * 3 + 2] = b
    this.size[i] = size
  }
}
