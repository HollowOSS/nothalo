import * as THREE from 'three'
import type {WorldPost} from './first-person-pass.ts'
import {VolumetricLight, VOLUME_COMPOSITE, VOLUME_COMPOSITE_PARS, type VolumeSettings} from './volumetric-light.ts'

/** What a scene asks of the bloom: set by the map (arena-light-fx.ts); scenes without it render
 * straight to the screen exactly as before. */
export interface BloomSettings {
  /** Display-referred brightness (after tone mapping) where glow starts. */
  threshold: number
  /** Width of the soft knee below the threshold. */
  knee: number
  strength: number
  /** Optional colour grade: [S-curve contrast 0..1, vibrance, vignette depth]; default [.12, .14, .18]. */
  grade?: readonly [number, number, number]
}

const quad = new THREE.Mesh(new THREE.BufferGeometry()
  .setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3))
  .setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2)))
quad.frustumCulled = false
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const vertexShader = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, blending: THREE.Blending = THREE.NoBlending) =>
  new THREE.ShaderMaterial({vertexShader, fragmentShader, uniforms, blending, depthTest: false, depthWrite: false, toneMapped: false})

/**
 * Halo 3's glow: the bright parts of the frame bleed into their surroundings.
 *
 * The world pass is drawn into a half-float target flagged the way three.js flags an XR layer,
 * so every material tone-maps and encodes exactly as it does on the screen (the sky, dust,
 * tracers and other untone-mapped effects keep their look), while additive effects may still run
 * past 1. The bright part is thresholded into a half-resolution mip chain, blurred down and back
 * up (a dual-filter bloom: a few small passes rather than one wide Gaussian), and added over the
 * frame on the way to the screen. The weapon viewmodel is drawn into the same target between the
 * world and the bloom (`overlay`, first-person-pass.ts), so muzzle flashes, plasma, needles and
 * the sword glow like the world's lamps do, and the gun shares the world's anti-aliasing.
 */
/** Anti-aliased the canvas is; the world drawn into our own target is not, unless small enough. */
const MSAA_LIMIT = 1.5e6

export class Bloom implements WorldPost {
  /** The world target, rebuilt when it switches between multisampled and not. */
  private scene: THREE.WebGLRenderTarget | null = null
  private readonly mips: THREE.WebGLRenderTarget[] = []
  private readonly size = new THREE.Vector2()
  private active: BloomSettings | null = null
  private volumeSettings: VolumeSettings | undefined
  private resolution = 0
  private readonly prefilter = pass(`uniform sampler2D map; uniform vec2 texel; uniform float threshold; uniform float knee; varying vec2 vUv;
vec3 bright(vec3 c) {
  float b = max(c.r, max(c.g, c.b));
  float soft = clamp(b - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  return c * max(soft, b - threshold) / max(b, 1e-4);
}
// Karis average: one hot pixel (a specular glint) must not become a flickering blob.
vec4 tap(vec2 o) { vec3 c = bright(min(texture2D(map, vUv + o * texel).rgb, vec3(8.0))); float w = 1.0 / (1.0 + max(c.r, max(c.g, c.b))); return vec4(c * w, w); }
void main() {
  vec4 c = tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  gl_FragColor = vec4(c.rgb / c.a, 1.0);
}`, {map: {value: null}, texel: {value: new THREE.Vector2()}, threshold: {value: .8}, knee: {value: .2}})
  private readonly down = pass(`uniform sampler2D map; uniform vec2 texel; varying vec2 vUv;
void main() {
  vec3 c = texture2D(map, vUv).rgb * 4.0;
  c += texture2D(map, vUv + vec2(-1.0, -1.0) * texel).rgb + texture2D(map, vUv + vec2(1.0, -1.0) * texel).rgb;
  c += texture2D(map, vUv + vec2(-1.0, 1.0) * texel).rgb + texture2D(map, vUv + vec2(1.0, 1.0) * texel).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`, {map: {value: null}, texel: {value: new THREE.Vector2()}})
  private readonly up = pass(`uniform sampler2D map; uniform vec2 texel; varying vec2 vUv;
void main() {
  vec3 c = texture2D(map, vUv).rgb * 4.0;
  c += (texture2D(map, vUv + vec2(-texel.x, 0.0)).rgb + texture2D(map, vUv + vec2(texel.x, 0.0)).rgb
    + texture2D(map, vUv + vec2(0.0, -texel.y)).rgb + texture2D(map, vUv + vec2(0.0, texel.y)).rgb) * 2.0;
  c += texture2D(map, vUv - texel).rgb + texture2D(map, vUv + texel).rgb
    + texture2D(map, vUv + vec2(texel.x, -texel.y)).rgb + texture2D(map, vUv + vec2(-texel.x, texel.y)).rgb;
  gl_FragColor = vec4(c / 16.0, 1.0);
}`, {map: {value: null}, texel: {value: new THREE.Vector2()}}, THREE.AdditiveBlending)
  private readonly volume: VolumetricLight
  private camera: THREE.PerspectiveCamera | null = null
  private readonly composite: THREE.ShaderMaterial

  private readonly antialias: boolean

  /**
   * @param scale Bloom resolution as a fraction of the screen, 0 when off (AdaptiveQuality).
   * @param phone The cheap path: an 8-bit world target, four blur levels and no god rays.
   */
  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scale: () => number, private readonly phone = false) {
    this.antialias = !!(renderer.getContext() as WebGL2RenderingContext).getContextAttributes()?.antialias
    this.volume = new VolumetricLight(renderer)
    this.composite = pass(`uniform sampler2D map; uniform sampler2D glow; uniform float strength; uniform vec2 screenTexel; uniform vec3 grade; varying vec2 vUv;
#ifdef VOLUME
${VOLUME_COMPOSITE_PARS}
#endif
#ifdef FXAA
// The world target is not multisampled at high resolutions: smooth its edges here instead
// (FXAA's classic nine-tap form, on the tone-mapped colour it was designed for).
float luma(vec3 c) { return dot(min(c, vec3(1.0)), vec3(0.299, 0.587, 0.114)); }
vec3 fxaa(vec2 uv) {
  vec3 m = texture2D(map, uv).rgb;
  float nw = luma(texture2D(map, uv + vec2(-1.0, -1.0) * screenTexel).rgb), ne = luma(texture2D(map, uv + vec2(1.0, -1.0) * screenTexel).rgb);
  float sw = luma(texture2D(map, uv + vec2(-1.0, 1.0) * screenTexel).rgb), se = luma(texture2D(map, uv + vec2(1.0, 1.0) * screenTexel).rgb);
  float lm = luma(m), lo = min(lm, min(min(nw, ne), min(sw, se))), hi = max(lm, max(max(nw, ne), max(sw, se)));
  if (hi - lo < max(0.0312, hi * 0.125)) return m;
  vec2 dir = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  float reduce = max((nw + ne + sw + se) * 0.03125, 1.0 / 128.0);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * screenTexel;
  vec3 a = 0.5 * (texture2D(map, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(map, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(map, uv - dir * 0.5).rgb + texture2D(map, uv + dir * 0.5).rgb);
  float lb = luma(b);
  return lb < lo || lb > hi ? a : b;
}
#endif
void main() {
#ifdef FXAA
  vec3 c = fxaa(vUv);
#else
  vec3 c = texture2D(map, vUv).rgb;
#endif
#ifdef VOLUME
  ${VOLUME_COMPOSITE}
#endif
  c += texture2D(glow, vUv).rgb * strength;
  // Roll the sum off rather than clipping it flat where glow lands on something bright.
  c = c - max(c - 0.9, 0.0) * 0.6;
  // Grade (display-referred, after tone mapping): a gentle S-curve for depth in the mid-tones, vibrance that lifts muted
  // colours more than saturated ones (skin of the world, not the HUD-bright energy), a soft optical vignette that pulls the
  // eye to the crosshair, and a sub-LSB dither so fog, skies and bloom halos do not band in 8 bits.
  vec3 s = clamp(c, 0.0, 1.0);
  c = mix(c, s * s * (3.0 - 2.0 * s), grade.x);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)), sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, 1.0 + grade.y * (1.0 - sat));
  vec2 v = vUv - 0.5; v.x *= screenTexel.y / screenTexel.x;
  c *= 1.0 - grade.z * smoothstep(0.35, 1.05, length(v) * 1.35);
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`, {map: {value: null}, glow: {value: null}, strength: {value: .5}, screenTexel: {value: new THREE.Vector2()},
      // contrast S-curve mix, vibrance, vignette depth; a map can override through BloomSettings.grade
      grade: {value: new THREE.Vector3(.12, .14, .18)}, ...this.volume.composite})
  }

  /**
   * The world's target at the drawing buffer's size. Multisampling an offscreen half-float target
   * costs a great deal at high DPI (the resolve alone), so it is only done under MSAA_LIMIT pixels;
   * larger targets, and phones always, are single-sampled and smoothed by FXAA in the composite.
   * It carries the depth the god rays march against.
   */
  private target(w: number, h: number): THREE.WebGLRenderTarget {
    const samples = this.antialias && !this.phone && w * h <= MSAA_LIMIT ? 4 : 0
    if (this.scene && this.scene.samples !== samples) { this.scene.dispose(); this.scene = null }
    if (!this.scene) {
      // Phones store the tone-mapped frame in 8 bits: half the bandwidth, and nothing there runs past 1.
      this.scene = new THREE.WebGLRenderTarget(w, h, {type: this.phone ? THREE.UnsignedByteType : THREE.HalfFloatType, depthBuffer: true, samples,
        ...this.phone ? {} : {depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType)}})
      this.scene.texture.colorSpace = THREE.SRGBColorSpace
      this.scene.texture.generateMipmaps = false
      // As three.js's own WebXRManager does for its layers: materials then tone-map and encode
      // into this target exactly as they would onto the canvas. three marks that use "remove when
      // possible" (mrdoob/three.js#23278); `tonemapsIntoTarget` below checks it still works.
      ;(this.scene as THREE.WebGLRenderTarget & {isXRRenderTarget: boolean}).isXRRenderTarget = true
      const fxaa = this.antialias && samples === 0
      if (!!this.composite.defines.FXAA !== fxaa) {
        if (fxaa) this.composite.defines.FXAA = 1; else delete this.composite.defines.FXAA
        this.composite.needsUpdate = true
      }
    }
    if (this.scene.width !== w || this.scene.height !== h) this.scene.setSize(w, h)
    return this.scene
  }

  /** null until checked; false turns the bloom off for good. */
  private tonemaps: boolean | null = null

  /**
   * Once, at the first bloomed frame: a quad twice as bright as white, drawn into a 1×1 8-bit
   * linear target flagged like the scene's. Tone mapped (ACES compresses it to about 0.9 at any of
   * the maps' exposures) it comes back under 248 of 255; if a three.js upgrade stops honouring the
   * flag it is not tone mapped and clips to 255, and the whole frame would be untone-mapped, so
   * the bloom stays off and the frame goes straight to the screen as before. 8 bits so the test
   * runs on every GPU, phones included; linear so no sRGB encoding muddies the reading.
   */
  private tonemapsIntoTarget(): boolean {
    const renderer = this.renderer
    const target = new THREE.WebGLRenderTarget(1, 1, {depthBuffer: false, generateMipmaps: false})
    target.texture.colorSpace = THREE.LinearSRGBColorSpace
    ;(target as THREE.WebGLRenderTarget & {isXRRenderTarget: boolean}).isXRRenderTarget = true
    const material = new THREE.MeshBasicMaterial({color: new THREE.Color().setScalar(2)})
    const probe = new THREE.Mesh(quad.geometry, material)
    probe.frustumCulled = false
    const pixel = new Uint8Array(4)
    try {
      renderer.setRenderTarget(target)
      renderer.render(probe, ortho)
      renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel)
    } finally {
      renderer.setRenderTarget(null)
      target.dispose(); material.dispose()
    }
    const ok = pixel[0] < 248
    if (!ok) console.warn(`Bloom disabled: materials no longer tone-map into an XR-flagged render target (read ${pixel[0]} of 255 for twice white, expected under 248). See bloom.ts and three.js#23278.`)
    return ok
  }

  get mode(): string { return this.active ? `on 1/${Math.round(1 / this.resolution)}${this.scene?.samples ? ' msaa' : this.composite.defines.FXAA ? ' fxaa' : ''}${this.composite.defines.VOLUME ? ' + god rays' : ''}` : 'off' }

  /** God rays marched before the viewmodel overwrote the world's depth (see `overlay`); null when not yet run this frame. */
  private volumeDone: boolean | null = null

  /**
   * Between the world and the viewmodel: march the god rays now, against the world's own depth, then hand the world
   * target back so the viewmodel draws over the finished world (first-person-pass.ts clears depth itself).
   */
  overlay(): void {
    this.volumeDone = !this.phone && !!this.volumeSettings && !!this.camera && this.volume.render(this.volumeSettings, this.scene!, this.camera, this.resolution)
    this.renderer.setRenderTarget(this.scene)
  }

  begin(scene: THREE.Scene, camera?: THREE.Camera): boolean {
    this.camera = (camera as THREE.PerspectiveCamera | undefined)?.isPerspectiveCamera ? camera as THREE.PerspectiveCamera : null
    this.volumeSettings = scene.userData.volume as VolumeSettings | undefined
    const settings = scene.userData.bloom as BloomSettings | undefined, scale = settings ? this.scale() : 0
    scene.userData.bloomActive = scale > 0
    if (!settings || scale <= 0 || this.tonemaps === false) { this.active = null; scene.userData.bloomActive = false; return false }
    // Only meaningful once the map has set its tone mapping (arena-atmosphere.ts).
    if (this.tonemaps === null && this.renderer.toneMapping !== THREE.NoToneMapping) {
      this.tonemaps = this.tonemapsIntoTarget()
      if (!this.tonemaps) { this.active = null; scene.userData.bloomActive = false; return false }
    }
    this.renderer.getDrawingBufferSize(this.size)
    const w = Math.max(1, this.size.x), h = Math.max(1, this.size.y), target = this.target(w, h)
    this.layout(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)))
    this.resolution = scale
    this.active = settings
    this.renderer.setRenderTarget(target)
    return true
  }

  end(): void {
    const renderer = this.renderer, settings = this.active!, world = this.scene!
    const info = renderer.info, counts = {...info.render}
    const autoClear = renderer.autoClear
    try {
      renderer.autoClear = true
      const first = this.mips[0]
      this.prefilter.uniforms.threshold.value = settings.threshold
      this.prefilter.uniforms.knee.value = settings.knee
      this.draw(this.prefilter, world.texture, first, 1 / world.width, 1 / world.height)
      for (let i = 1; i < this.mips.length; i++) this.draw(this.down, this.mips[i - 1].texture, this.mips[i], .5 / this.mips[i].width, .5 / this.mips[i].height)
      renderer.autoClear = false
      for (let i = this.mips.length - 2; i >= 0; i--) this.draw(this.up, this.mips[i + 1].texture, this.mips[i], 1 / this.mips[i + 1].width, 1 / this.mips[i + 1].height)
      // God rays for the frame just drawn, at the bloom's resolution.
      const volume = this.volumeDone ?? (!this.phone && !!this.volumeSettings && !!this.camera && this.volume.render(this.volumeSettings, world, this.camera, this.resolution))
      this.volumeDone = null
      if (!!this.composite.defines.VOLUME !== volume) {
        if (volume) this.composite.defines.VOLUME = 1; else delete this.composite.defines.VOLUME
        this.composite.needsUpdate = true
      }
      this.composite.uniforms.map.value = world.texture
      this.composite.uniforms.screenTexel.value.set(1 / world.width, 1 / world.height)
      this.composite.uniforms.glow.value = first.texture
      this.composite.uniforms.strength.value = settings.strength
      if (settings.grade) this.composite.uniforms.grade.value.set(...settings.grade); else this.composite.uniforms.grade.value.set(.12, .14, .18)
      renderer.setRenderTarget(null)
      quad.material = this.composite
      renderer.render(quad, ortho)
    } finally {
      renderer.autoClear = autoClear
      renderer.setRenderTarget(null)
      // Keep the frame counters those of the world pass, plus the post-process draws.
      if (info.autoReset) for (const key of ['calls', 'triangles', 'points', 'lines'] as const) info.render[key] += counts[key]
    }
  }

  private draw(material: THREE.ShaderMaterial, source: THREE.Texture, target: THREE.WebGLRenderTarget, tx: number, ty: number): void {
    material.uniforms.map.value = source
    material.uniforms.texel.value.set(tx, ty)
    quad.material = material
    this.renderer.setRenderTarget(target)
    this.renderer.render(quad, ortho)
  }

  /** Mips from the bloom resolution down to about 8 pixels tall, at most six (four on phones). */
  private layout(w: number, h: number): void {
    const levels: [number, number][] = [], most = this.phone ? 4 : 6
    for (let x = w, y = h; levels.length < most && y >= 8; x = Math.max(1, x >> 1), y = y >> 1) levels.push([x, y])
    while (this.mips.length > levels.length) this.mips.pop()!.dispose()
    levels.forEach(([x, y], i) => {
      const mip = this.mips[i] ??= new THREE.WebGLRenderTarget(x, y, {type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter})
      if (mip.width !== x || mip.height !== y) mip.setSize(x, y)
    })
  }
}
