import * as THREE from 'three'

/**
 * Halo 3-style explosions, built from layered billboards rather than a growing sphere.
 *
 * A covenant or human blast in the footage is never one shape: a white flash that lasts a
 * couple of frames, a fireball of many overlapping billows that cool from white through
 * orange to soot, sparks and dark debris thrown ballistically, dust shoved along the ground,
 * and smoke that lingers and rises for seconds afterwards. Plasma swaps the fire for a blue
 * electrical burst laced with crackling filaments and leaves glowing motes instead of soot.
 *
 * Every particle lives in one instanced draw call. Puffs are eroded by a tiling noise texture
 * so each one has a ragged, billowing silhouette that dissolves as it ages, and fire and smoke
 * share premultiplied blending: hot particles add light, cooled ones occlude like real soot.
 */
export type ExplosionKind = 'rocket' | 'frag' | 'plasma' | 'fuelrod'

// Shapes (the fragment shader's branch) and the colour ramps the CPU applies over a lifetime.
const FIRE = 0, STREAK = 1, GLOW = 2, RING = 3, SMOKE = 4, ENERGY = 5
const R_FIRE = 0, R_SMOKE = 1, R_DUST = 2, R_SPARK = 3, R_DEBRIS = 4, R_FLASH = 5, R_RING = 6, R_ENERGY = 7, R_EMBER = 8

type RGB = readonly [number, number, number]
interface Palette { flash: RGB; hot: RGB; mid: RGB; cool: RGB; smoke: RGB; ring: RGB; light: number }
const WARM: Palette = { flash: [3.2, 2.3, 1.2], hot: [1.9, .78, .17], mid: [.95, .26, .05], cool: [.24, .07, .02], smoke: [.16, .145, .128], ring: [.9, .7, .5], light: 0xffa04a }
const PLASMA: Palette = { flash: [1, 1.6, 3], hot: [.2, .55, 1.9], mid: [.06, .22, 1.1], cool: [.02, .07, .4], smoke: [.26, .3, .38], ring: [.5, .95, 1.9], light: 0x5aa8ff }
const FUEL: Palette = { flash: [1.4, 2.4, 1], hot: [.35, 1.4, .2], mid: [.1, .65, .06], cool: [.03, .2, .015], smoke: [.22, .28, .19], ring: [.7, 1.5, .5], light: 0x8cff5a }
const PALETTES = [WARM, PLASMA, FUEL]

const CAPACITY = 2048
const FLOATS = 20

/** Tiling fractal value noise; R and G carry two different scales for the erosion mask. */
function noiseTexture(): THREE.DataTexture {
  const size = 128, data = new Uint8Array(size * size * 4)
  let seed = 1337
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const lattices = [4, 8, 16, 32, 64].map(n => ({ n, v: Float32Array.from({ length: n * n }, random) }))
  const sample = (l: { n: number; v: Float32Array }, x: number, y: number) => {
    const fx = x * l.n / size, fy = y * l.n / size, ix = Math.floor(fx), iy = Math.floor(fy)
    const tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
    const at = (i: number, j: number) => l.v[((j % l.n) * l.n) + (i % l.n)]
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4
    const low = sample(lattices[0], x, y) * .5 + sample(lattices[1], x, y) * .27 + sample(lattices[2], x, y) * .15 + sample(lattices[3], x, y) * .08
    const high = sample(lattices[2], x, y) * .5 + sample(lattices[3], x, y) * .3 + sample(lattices[4], x, y) * .2
    data[i] = Math.round(low * 255); data[i + 1] = Math.round(high * 255); data[i + 2] = 0; data[i + 3] = 255
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true; texture.needsUpdate = true
  return texture
}

const vertexShader = `
  attribute vec3 iPos; attribute vec3 iVel; attribute vec4 iColor; attribute vec4 iData; attribute vec2 iSize; attribute vec4 iPlane;
  varying vec2 vUv; varying vec4 vColor; varying vec4 vData; varying float vUp; varying float vGround;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv; vColor = iColor; vData = iData; vUp = position.y * 2.0;
    vec4 mvPosition = viewMatrix * vec4(iPos, 1.0);
    vec2 corner = position.xy;
    vec4 anchor = mvPosition;
    if (abs(iData.x - 1.0) < .5) {
      // Streaks stretch along their screen-space motion and trail behind the head.
      vec2 motion = (viewMatrix * vec4(iVel, 0.0)).xy;
      float len = length(motion);
      vec2 dir = len > 1e-5 ? motion / len : vec2(1.0, 0.0);
      mvPosition.xy += dir * (corner.x * (len + iSize.x) - len * .5) + vec2(-dir.y, dir.x) * corner.y * iSize.x;
    } else {
      float c = cos(iSize.y), s = sin(iSize.y);
      mvPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * iSize.x;
    }
    // Billboards have no depth of their own, so fade them out as they reach the struck surface
    // instead of letting the floor or wall slice them with a hard edge.
    vec3 offset = mvPosition.xyz - anchor.xyz;
    vec3 world = iPos + vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * offset.x + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * offset.y;
    vGround = dot(iPlane.xyz, iPlane.xyz) > .5 ? (dot(world, iPlane.xyz) - iPlane.w) / max(.05, iSize.x * .45) : 1.0;
    // Fade what would otherwise be drawn across the lens.
    vColor.a *= smoothstep(.12, .75, -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`

const fragmentShader = `
  uniform sampler2D noiseMap;
  varying vec2 vUv; varying vec4 vColor; varying vec4 vData; varying float vUp; varying float vGround;
  #include <fog_pars_fragment>
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p), shape = vData.x, t = vData.y, seed = vData.z;
    vec3 col = vColor.rgb;
    float a;
    if (shape < .5 || shape > 3.5) {
      vec2 nuv = vUv * .55 + vec2(seed, fract(seed * 7.13));
      float n1 = texture2D(noiseMap, nuv + vec2(0.0, t * .14)).r;
      float n2 = texture2D(noiseMap, nuv * 2.2 + vec2(t * .11, seed)).g;
      float n = n1 * .62 + n2 * .38;
      // Radial body, broken up by noise, and eaten away as the particle ages.
      float d = (1.0 - r) * 1.3 + (n - .5) * 1.25 - t * (shape > 3.5 && shape < 4.5 ? .25 : .5);
      a = smoothstep(0.0, .38, d);
      float thick = smoothstep(.05, .95, d);
      if (shape < .5) col *= (.22 + 1.35 * thick) * (.7 + .6 * n);
      else if (shape < 4.5) col *= (.5 + .8 * n) * (.82 + .3 * vUp) * (.8 + .35 * thick);
      else {
        float web = pow(1.0 - abs(n2 * 2.0 - 1.0), 6.0);
        col *= .15 + .45 * thick + 1.5 * web;
        a = max(a * .55, web * smoothstep(.0, .15, d));
      }
    } else if (shape < 1.5) {
      a = (1.0 - smoothstep(0.0, 1.0, abs(p.y))) * (1.0 - smoothstep(.45, 1.0, abs(p.x)));
    } else if (shape < 2.5) {
      a = exp(-r * r * 5.5);
    } else {
      float ring = (r - .8) / .1;
      a = exp(-ring * ring) * (1.0 - smoothstep(.96, 1.0, r));
    }
    a = clamp(a * vColor.a, 0.0, 1.0) * smoothstep(0.0, 1.0, vGround);
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        a *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
      #endif
    #endif
    if (a < .002) discard;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor = vec4(gl_FragColor.rgb * a, a * vData.w);
  }`

interface LightEvent { position: THREE.Vector3; color: THREE.Color; peak: number; age: number; life: number }

export class ExplosionFx {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>
  readonly light = new THREE.PointLight(0xffa04a, 0, 18, 2)
  // Structure-of-arrays particle state.
  private readonly pos = new Float32Array(CAPACITY * 3)
  private readonly vel = new Float32Array(CAPACITY * 3)
  private readonly age = new Float32Array(CAPACITY)
  private readonly life = new Float32Array(CAPACITY)
  private readonly size0 = new Float32Array(CAPACITY)
  private readonly size1 = new Float32Array(CAPACITY)
  private readonly rot = new Float32Array(CAPACITY)
  private readonly spin = new Float32Array(CAPACITY)
  private readonly drag = new Float32Array(CAPACITY)
  private readonly gravity = new Float32Array(CAPACITY)
  private readonly seed = new Float32Array(CAPACITY)
  private readonly alpha = new Float32Array(CAPACITY)
  private readonly stretch = new Float32Array(CAPACITY)
  private readonly shape = new Uint8Array(CAPACITY)
  private readonly ramp = new Uint8Array(CAPACITY)
  private readonly palette = new Uint8Array(CAPACITY)
  /** The struck surface as (normal, offset); a zero normal disables the fade. */
  private readonly plane = new Float32Array(CAPACITY * 4)
  private readonly surface = [0, 0, 0, 0]
  private active = 0
  private readonly order = new Uint16Array(CAPACITY)
  private readonly depth = new Float32Array(CAPACITY)
  private readonly buffer = new Float32Array(CAPACITY * FLOATS)
  private readonly interleaved: THREE.InstancedInterleavedBuffer
  private readonly lights: LightEvent[] = []
  private readonly color = [0, 0, 0, 0, 0]
  private readonly camera = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()
  private readonly direction = new THREE.Vector3()

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(1, 1)
    geometry.index = quad.index
    geometry.setAttribute('position', quad.getAttribute('position'))
    geometry.setAttribute('uv', quad.getAttribute('uv'))
    this.interleaved = new THREE.InstancedInterleavedBuffer(this.buffer, FLOATS).setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('iPos', new THREE.InterleavedBufferAttribute(this.interleaved, 3, 0))
    geometry.setAttribute('iVel', new THREE.InterleavedBufferAttribute(this.interleaved, 3, 3))
    geometry.setAttribute('iColor', new THREE.InterleavedBufferAttribute(this.interleaved, 4, 6))
    geometry.setAttribute('iData', new THREE.InterleavedBufferAttribute(this.interleaved, 4, 10))
    geometry.setAttribute('iSize', new THREE.InterleavedBufferAttribute(this.interleaved, 2, 14))
    geometry.setAttribute('iPlane', new THREE.InterleavedBufferAttribute(this.interleaved, 4, 16))
    geometry.instanceCount = 0
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { noiseMap: { value: null } }]),
      vertexShader, fragmentShader, fog: true, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    })
    material.uniforms.noiseMap.value = noiseTexture()
    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.name = 'explosion-fx'; this.mesh.frustumCulled = false; this.mesh.renderOrder = 20; this.mesh.visible = false
    scene.add(this.mesh)
    // One light, always present: toggling lights in and out recompiles every lit material.
    this.light.name = 'explosion-light'
    scene.add(this.light)
  }

  get activeCount(): number { return this.active }

  private emit(shape: number, ramp: number, palette: number, x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number, drag: number, gravity: number, alpha = 1, stretch = 0): void {
    if (this.active >= CAPACITY) return
    const i = this.active++
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz
    this.age[i] = 0; this.life[i] = life; this.size0[i] = size0; this.size1[i] = size1
    this.rot[i] = Math.random() * Math.PI * 2; this.spin[i] = (Math.random() - .5) * 1.4
    this.drag[i] = drag; this.gravity[i] = gravity; this.seed[i] = Math.random(); this.alpha[i] = alpha
    this.stretch[i] = stretch; this.shape[i] = shape; this.ramp[i] = ramp; this.palette[i] = palette
    const soft = shape !== STREAK
    for (let k = 0; k < 4; k++) this.plane[i * 4 + k] = soft ? this.surface[k] : 0
  }

  /** A random direction biased away from the struck surface. */
  private spray(normal: THREE.Vector3, bias: number, flat = 0): THREE.Vector3 {
    const d = this.direction.randomDirection()
    if (flat > 0) d.addScaledVector(normal, -d.dot(normal) * flat)
    if (d.dot(normal) < 0 && flat === 0) d.addScaledVector(normal, -2 * d.dot(normal) * Math.min(1, bias))
    return d.addScaledVector(normal, bias).normalize()
  }

  /**
   * Detonate at a contact point. `normal` is the struck surface's outward direction; up when
   * the blast went off in the open or the caller does not know.
   */
  explode(point: THREE.Vector3, kind: ExplosionKind, normal: THREE.Vector3 = new THREE.Vector3(0, 1, 0)): void {
    const n = normal.clone().normalize()
    const energy = kind === 'plasma' || kind === 'fuelrod'
    const palette = kind === 'plasma' ? 1 : kind === 'fuelrod' ? 2 : 0
    const scale = kind === 'rocket' ? 1.35 : kind === 'fuelrod' ? 1.1 : 1
    const count = (base: number) => Math.round(base * (kind === 'rocket' ? 1.4 : 1))
    const c = point.clone().addScaledVector(n, .25 * scale)
    const rand = (a: number, b: number) => a + Math.random() * (b - a)
    const at = (d: THREE.Vector3, k: number) => [c.x + d.x * k, c.y + d.y * k, c.z + d.z * k] as const
    this.surface[0] = n.x; this.surface[1] = n.y; this.surface[2] = n.z; this.surface[3] = n.dot(point) - .05

    // The first frames: a lens-filling flash, a white-hot core and the shockwave.
    this.emit(GLOW, R_FLASH, palette, c.x, c.y, c.z, 0, 0, 0, .11, 5 * scale, 6.5 * scale, 0, 0, .75)
    this.emit(GLOW, R_FLASH, palette, c.x, c.y, c.z, 0, 0, 0, .38, 2.2 * scale, 3.4 * scale, 0, 0, energy ? .35 : .7)
    this.emit(RING, R_RING, palette, c.x, c.y, c.z, 0, 0, 0, .26, .6, 7.5 * scale, 0, 0, energy ? .45 : .3)

    if (!energy) {
      for (let i = 0; i < count(18); i++) {
        const d = this.spray(n, .55), speed = rand(2.5, 7.5) * scale, [x, y, z] = at(d, rand(.05, .45) * scale)
        this.emit(FIRE, R_FIRE, palette, x, y, z, d.x * speed, d.y * speed, d.z * speed, rand(.5, .95) * scale, rand(.5, .9) * scale, rand(1.6, 2.6) * scale, 5.5, 1.2)
      }
      for (let i = 0; i < count(14); i++) {
        const d = this.spray(n, .7), speed = rand(1.2, 4) * scale, [x, y, z] = at(d, rand(.2, .8) * scale)
        this.emit(SMOKE, R_SMOKE, palette, x, y, z, d.x * speed, d.y * speed, d.z * speed, rand(2.6, 4) * scale, rand(.8, 1.3) * scale, rand(3, 4.4) * scale, 2.4, 1.1, kind === 'rocket' ? rand(.55, .75) : rand(.38, .55))
      }
      for (let i = 0; i < count(9); i++) {
        const d = this.spray(n, .08, 1), speed = rand(5, 9) * scale
        this.emit(SMOKE, R_DUST, palette, point.x + d.x * .4, point.y + d.y * .4 + n.y * .2, point.z + d.z * .4, d.x * speed, d.y * speed, d.z * speed, rand(1.3, 2.1), .5 * scale, rand(2.2, 3.2) * scale, 3.2, .25, rand(.35, .5))
      }
      for (let i = 0; i < count(30); i++) {
        const d = this.spray(n, .45), speed = rand(9, 25) * scale
        this.emit(STREAK, R_SPARK, palette, c.x, c.y, c.z, d.x * speed, d.y * speed, d.z * speed, rand(.3, .85), rand(.022, .04), 0, .9, -9.8, 1, .024)
      }
      for (let i = 0; i < count(16); i++) {
        const d = this.spray(n, .7), speed = rand(5, 14) * scale
        this.emit(STREAK, R_DEBRIS, palette, c.x, c.y, c.z, d.x * speed, d.y * speed, d.z * speed, rand(.8, 1.4), rand(.035, .07), 0, .4, -13, 1, .02)
      }
      for (let i = 0; i < count(10); i++) {
        const d = this.spray(n, .6), speed = rand(1.5, 5), [x, y, z] = at(d, rand(.2, .9) * scale)
        this.emit(GLOW, R_EMBER, palette, x, y, z, d.x * speed, d.y * speed + 1, d.z * speed, rand(.9, 1.7), rand(.05, .09), .03, 2.2, -1.2)
      }
    } else {
      // Plasma: an electrical burst with filaments, crackling arcs and lingering motes.
      for (let i = 0; i < 11; i++) {
        const d = this.spray(n, .4), speed = rand(4, 9) * scale, [x, y, z] = at(d, rand(.25, .7) * scale)
        this.emit(ENERGY, R_ENERGY, palette, x, y, z, d.x * speed, d.y * speed, d.z * speed, rand(.32, .6), rand(.4, .7) * scale, rand(1.6, 2.5) * scale, 7, 0, .6)
      }
      for (let i = 0; i < 44; i++) {
        const d = this.spray(n, .25), speed = rand(7, 22) * scale
        this.emit(STREAK, R_SPARK, palette, c.x, c.y, c.z, d.x * speed, d.y * speed, d.z * speed, rand(.2, .55), rand(.02, .04), 0, 2.6, -3, 1, .05)
      }
      for (let i = 0; i < (kind === 'fuelrod' ? 26 : 18); i++) {
        const d = this.spray(n, .5), speed = rand(1, 4.5), [x, y, z] = at(d, rand(.2, 1.1) * scale)
        this.emit(GLOW, R_EMBER, palette, x, y, z, d.x * speed, d.y * speed + .6, d.z * speed, rand(.8, 1.7), rand(.05, .11), .02, 2.5, -.6)
      }
      for (let i = 0; i < 7; i++) {
        const d = this.spray(n, .8), speed = rand(.8, 2.4), [x, y, z] = at(d, rand(.2, .7))
        this.emit(SMOKE, R_SMOKE, palette, x, y, z, d.x * speed, d.y * speed, d.z * speed, rand(1.1, 1.9), .7, rand(2.2, 3), 2, .7, rand(.18, .28))
      }
    }
    this.lights.push({ position: c.clone().addScaledVector(n, .4), color: new THREE.Color(PALETTES[palette].light),
      peak: kind === 'rocket' ? 90 : energy ? 55 : 60, age: 0, life: kind === 'rocket' ? .55 : .42 })
    this.surface.fill(0)
    this.mesh.visible = true
  }

  /** Blue sparks flung off a plasma grenade when it bites into something. */
  plasmaStick(point: THREE.Vector3): void {
    this.emit(GLOW, R_FLASH, 1, point.x, point.y, point.z, 0, 0, 0, .12, .55, .9, 0, 0, .8)
    for (let i = 0; i < 12; i++) {
      const d = this.direction.randomDirection(), speed = 2 + Math.random() * 4
      this.emit(STREAK, R_SPARK, 1, point.x, point.y, point.z, d.x * speed, d.y * speed + 1, d.z * speed, .15 + Math.random() * .2, .012, 0, 3, -6, 1, .04)
    }
    this.mesh.visible = true
  }

  /** The armed grenade's constant fizz: call per crackle with how far along the fuse is. */
  plasmaCrackle(point: THREE.Vector3, armed: number): void {
    const d = this.direction.randomDirection(), speed = 1.2 + Math.random() * (2 + armed * 3)
    this.emit(STREAK, R_SPARK, 1, point.x + d.x * .05, point.y + d.y * .05, point.z + d.z * .05, d.x * speed, d.y * speed + .6, d.z * speed, .1 + Math.random() * .16, .01, 0, 3.5, -4, .9, .035)
    this.mesh.visible = true
  }

  /** The faint blue wake a plasma grenade leaves in flight. */
  plasmaTrail(point: THREE.Vector3): void {
    this.emit(GLOW, R_EMBER, 1, point.x, point.y, point.z, 0, 0, 0, .28, .16, .05, 0, 0, .55)
    this.mesh.visible = true
  }

  /** Colour, opacity and occlusion for a particle at normalized age t. */
  private shade(i: number, t: number): number[] {
    const p = PALETTES[this.palette[i]], out = this.color, a0 = this.alpha[i]
    const mix = (x: RGB, y: RGB, k: number) => { out[0] = x[0] + (y[0] - x[0]) * k; out[1] = x[1] + (y[1] - x[1]) * k; out[2] = x[2] + (y[2] - x[2]) * k }
    const fadeIn = (k: number) => Math.min(1, t / k)
    switch (this.ramp[i]) {
      case R_FIRE: {
        if (t < .06) mix(p.flash, p.hot, t / .06)
        else if (t < .28) mix(p.hot, p.mid, (t - .1) / .18)
        else if (t < .5) mix(p.mid, p.cool, (t - .28) / .22)
        else mix(p.cool, p.smoke, Math.min(1, (t - .5) / .3))
        // Hot fire adds light; as it cools to soot it starts to occlude what is behind it.
        out[3] = a0 * fadeIn(.03) * (1 - smoothstep(.72, 1, t)) * .95
        return this.pack(.22 + smoothstep(.3, .62, t) * .66)
      }
      case R_SMOKE: {
        out[0] = p.smoke[0]; out[1] = p.smoke[1]; out[2] = p.smoke[2]
        // Underlit by the fireball for its first moments.
        const glow = 1 - smoothstep(0, .16, t)
        out[0] += p.mid[0] * .35 * glow; out[1] += p.mid[1] * .35 * glow; out[2] += p.mid[2] * .35 * glow
        out[3] = a0 * smoothstep(0, .08, t) * (1 - smoothstep(.35, 1, t))
        return this.pack(1)
      }
      case R_DUST:
        out[0] = .34; out[1] = .3; out[2] = .24
        out[3] = a0 * smoothstep(0, .08, t) * Math.pow(1 - t, 1.6)
        return this.pack(1)
      case R_SPARK:
        mix(p.flash, p.mid, Math.min(1, t * 1.4)); out[3] = a0 * (1 - t * t)
        return this.pack(0)
      case R_DEBRIS:
        out[0] = .035; out[1] = .03; out[2] = .026; out[3] = 1 - smoothstep(.75, 1, t)
        return this.pack(1)
      case R_FLASH:
        mix(p.flash, p.hot, t); out[3] = a0 * Math.pow(1 - t, 2)
        return this.pack(0)
      case R_RING:
        out[0] = p.ring[0]; out[1] = p.ring[1]; out[2] = p.ring[2]; out[3] = a0 * Math.pow(1 - t, 1.5)
        return this.pack(0)
      case R_ENERGY:
        if (t < .25) mix(p.flash, p.hot, t / .25)
        else mix(p.hot, p.cool, Math.min(1, (t - .25) / .6))
        out[3] = a0 * fadeIn(.04) * (1 - smoothstep(.6, 1, t))
        return this.pack(0)
      default: { // R_EMBER
        mix(p.hot, p.cool, t)
        const flicker = .65 + .35 * Math.sin(this.seed[i] * 91 + this.age[i] * 38)
        out[3] = a0 * flicker * (1 - smoothstep(.55, 1, t))
        return this.pack(0)
      }
    }
  }
  private pack(occlusion: number): number[] { this.color[4] = occlusion; return this.color }

  update(dt: number, camera?: THREE.Camera): void {
    // Light: the strongest explosion still burning decides where the one light sits.
    let best: LightEvent | null = null, bestIntensity = 0
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const l = this.lights[i]; l.age += dt
      if (l.age >= l.life) { this.lights.splice(i, 1); continue }
      const k = l.age / l.life, intensity = l.peak * Math.pow(1 - k, 2) * (.85 + .15 * Math.sin(l.age * 60))
      if (intensity > bestIntensity) { bestIntensity = intensity; best = l }
    }
    this.light.intensity = bestIntensity
    if (best) { this.light.position.copy(best.position); this.light.color.copy(best.color) }
    if (this.active === 0) { this.mesh.visible = false; return }

    // Integrate and retire, compacting survivors into the front of the arrays.
    let alive = 0
    for (let i = 0; i < this.active; i++) {
      const age = this.age[i] + dt
      if (age >= this.life[i]) continue
      if (alive !== i) this.move(i, alive)
      const j = alive++
      this.age[j] = age
      const damping = Math.exp(-this.drag[j] * dt)
      this.vel[j * 3] *= damping; this.vel[j * 3 + 1] = this.vel[j * 3 + 1] * damping + this.gravity[j] * dt; this.vel[j * 3 + 2] *= damping
      this.pos[j * 3] += this.vel[j * 3] * dt; this.pos[j * 3 + 1] += this.vel[j * 3 + 1] * dt; this.pos[j * 3 + 2] += this.vel[j * 3 + 2] * dt
      this.rot[j] += this.spin[j] * dt
    }
    this.active = alive
    if (!alive) { this.mesh.visible = false; this.mesh.geometry.instanceCount = 0; return }

    // Back to front, so cooled soot in front of a fireball hides it and not the reverse.
    if (camera) { camera.getWorldPosition(this.camera); camera.getWorldDirection(this.forward) }
    for (let i = 0; i < alive; i++) {
      this.order[i] = i
      this.depth[i] = (this.pos[i * 3] - this.camera.x) * this.forward.x + (this.pos[i * 3 + 1] - this.camera.y) * this.forward.y + (this.pos[i * 3 + 2] - this.camera.z) * this.forward.z
    }
    const order = this.order.subarray(0, alive).sort((a, b) => this.depth[b] - this.depth[a])
    for (let k = 0; k < alive; k++) {
      const i = order[k], o = k * FLOATS, t = this.age[i] / this.life[i]
      const shaded = this.shade(i, t)
      const ease = 1 - Math.pow(1 - t, 2.2)
      const b0 = this.buffer
      b0[o] = this.pos[i * 3]; b0[o + 1] = this.pos[i * 3 + 1]; b0[o + 2] = this.pos[i * 3 + 2]
      const s = this.stretch[i]
      b0[o + 3] = this.vel[i * 3] * s; b0[o + 4] = this.vel[i * 3 + 1] * s; b0[o + 5] = this.vel[i * 3 + 2] * s
      b0[o + 6] = shaded[0]; b0[o + 7] = shaded[1]; b0[o + 8] = shaded[2]; b0[o + 9] = shaded[3]
      b0[o + 10] = this.shape[i]; b0[o + 11] = t; b0[o + 12] = this.seed[i]; b0[o + 13] = shaded[4]
      b0[o + 14] = this.shape[i] === STREAK ? this.size0[i] : this.size0[i] + (this.size1[i] - this.size0[i]) * ease; b0[o + 15] = this.rot[i]
      b0[o + 16] = this.plane[i * 4]; b0[o + 17] = this.plane[i * 4 + 1]; b0[o + 18] = this.plane[i * 4 + 2]; b0[o + 19] = this.plane[i * 4 + 3]
    }
    this.interleaved.needsUpdate = true
    this.interleaved.clearUpdateRanges(); this.interleaved.addUpdateRange(0, alive * FLOATS)
    this.mesh.geometry.instanceCount = alive
    this.mesh.visible = true
  }

  private move(from: number, to: number): void {
    for (let k = 0; k < 4; k++) this.plane[to * 4 + k] = this.plane[from * 4 + k]
    for (const array of [this.pos, this.vel]) { array[to * 3] = array[from * 3]; array[to * 3 + 1] = array[from * 3 + 1]; array[to * 3 + 2] = array[from * 3 + 2] }
    for (const array of [this.age, this.life, this.size0, this.size1, this.rot, this.spin, this.drag, this.gravity, this.seed, this.alpha, this.stretch, this.shape, this.ramp, this.palette]) array[to] = array[from]
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
