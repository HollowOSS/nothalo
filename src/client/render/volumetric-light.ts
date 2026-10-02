import * as THREE from 'three'

/**
 * Sunlight scattered by the air: god rays that exist only where the sun really reaches.
 *
 * At a fraction of the screen's resolution, each pixel marches from the eye to the surface it
 * sees (the world pass's depth), asking the sun's shadow map at every step whether that point of
 * air is in sunlight. Lit air scatters sun towards the eye by a Henyey-Greenstein phase, strongly
 * forwards, so shafts blaze looking towards the sun and fade looking away, and wherever a wall,
 * a pillar or a roof beam blocks the sun the air behind it stays dark. The steps are jittered by
 * interleaved gradient noise and the result is smoothed by a depth-aware blur, then upsampled to
 * the screen in bloom.ts's composite without bleeding across silhouettes.
 *
 * Glass that lets the sun through (Epitaph's holographic panels) is drawn once from the sun's
 * view into a transmission map: its colour and depth. Air, floors and walls behind it from the
 * sun take its colour, so the shafts and the sunlight on the stone come through cyan.
 *
 * It rides on the bloom's half-float world target, so it runs wherever the bloom does (desktop);
 * phones have neither.
 */
export interface VolumeSettings {
  /** The map's sun: its static shadow map says where the air is lit. */
  sun: THREE.DirectionalLight
  color: THREE.Color
  /** Scattering per metre. */
  density: number
  /** Brightness of the scattered light on screen. */
  intensity: number
  /** Henyey-Greenstein anisotropy: 0 even, towards 1 all forwards. */
  anisotropy: number
  /** How far the march reaches, in metres. */
  distance: number
  /** The most the scattered light may add: towards the sun it saturates here rather than whiting out. */
  ceiling: number
  /** Haze scale height in metres above `floor`: the air thins with height, so looking up through it scatters far less
   * than looking across it. Unset keeps the air even all the way up. */
  thinning?: {floor: number; height: number}
  /** Resolution relative to the bloom's (half the screen on the top tier): open maps, whose
   * scattered light is a soft veil, can march at a quarter of the screen with fewer steps. */
  resolution?: number
  /** Glass the sun shines through, which colours what lies behind it. */
  glass?: THREE.Mesh[]
  /** How strongly surfaces behind the glass take its colour, 0 to 1. */
  glassTint?: number
}

const quad = new THREE.Mesh(new THREE.BufferGeometry()
  .setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3))
  .setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2)))
quad.frustumCulled = false
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const vertexShader = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'

/** Shared by the march and the composite: where a screen pixel is, and what the sun makes of it. */
const COMMON = `
#include <packing>
uniform sampler2D depthMap; uniform float cameraNear; uniform float cameraFar;
uniform mat4 projectionInverse; uniform mat4 cameraWorld;
uniform sampler2DShadow sunShadow; uniform mat4 sunMatrix;
uniform sampler2D transmission; uniform float glassTint;
// The eye ray through a screen point, in view space, scaled so its z is -1.
vec3 viewRay(vec2 uv) { vec4 r = projectionInverse * vec4(uv * 2.0 - 1.0, 1.0, 1.0); return r.xyz / r.w / (-r.z / r.w); }
float viewDistance(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(depthMap, uv).x, cameraNear, cameraFar); }
// 1 where the sun reaches a world point, 0 in shadow; outside the shadow map's box, lit.
float sunlit(vec3 p) {
  vec4 s = sunMatrix * vec4(p, 1.0);
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  return texture(sunShadow, vec3(s.xy, s.z - 0.0015));
}
// The colour sunlight has taken on by the time it reaches a world point: glass between it and the sun tints it.
vec3 sunTint(vec3 p) {
  vec4 s = sunMatrix * vec4(p, 1.0);
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return vec3(1.0);
  vec4 g = texture2D(transmission, s.xy);
  return s.z > g.a + 0.002 ? mix(vec3(1.0), g.rgb, glassTint) : vec3(1.0);
}`

export class VolumetricLight {
  private readonly low = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, {type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter}))
  /** The glass as the sun sees it: rgb its colour, a its depth. White and far where there is none. */
  private readonly transmission = new THREE.WebGLRenderTarget(1024, 1024, {type: THREE.HalfFloatType, depthBuffer: true, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter})
  private transmissionFor: THREE.Mesh[] | null = null
  /**
   * The world's distance per screen pixel, saved when the march runs. The viewmodel is drawn into the same target after
   * the march (first-person-pass.ts) and clears its depth first, so by the time bloom.ts composites, the depth texture
   * holds the gun over a cleared far plane: the depth-aware upsample then threw the scattered light away on every world
   * pixel (and washed it over the gun instead). One full-resolution single-channel write per frame.
   */
  private readonly linear = new THREE.WebGLRenderTarget(1, 1, {type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false,
    generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter})
  private readonly saveDepth = new THREE.ShaderMaterial({
    vertexShader, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
    uniforms: {depthMap: {value: null as THREE.Texture | null}, cameraNear: {value: .1}, cameraFar: {value: 1000}},
    fragmentShader: `#include <packing>
uniform sampler2D depthMap; uniform float cameraNear; uniform float cameraFar; varying vec2 vUv;
void main() { gl_FragColor = vec4(min(-perspectiveDepthToViewZ(texture2D(depthMap, vUv).x, cameraNear, cameraFar), 60000.0), 0.0, 0.0, 1.0); }`,
  })
  private readonly white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  private readonly shared = {
    depthMap: {value: null as THREE.Texture | null}, cameraNear: {value: .1}, cameraFar: {value: 1000},
    projectionInverse: {value: new THREE.Matrix4()}, cameraWorld: {value: new THREE.Matrix4()},
    sunShadow: {value: null as THREE.Texture | null}, sunMatrix: {value: new THREE.Matrix4()},
    transmission: {value: null as THREE.Texture | null}, glassTint: {value: 0},
  }
  private readonly march = new THREE.ShaderMaterial({
    vertexShader, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
    defines: {STEPS: 24},
    uniforms: {...this.shared, sunDirection: {value: new THREE.Vector3()}, color: {value: new THREE.Color()}, density: {value: .02},
      intensity: {value: 1}, anisotropy: {value: .6}, reachMax: {value: 60}, ceiling: {value: .4}, hazeFloor: {value: 0}, hazeFalloff: {value: 0}, eye: {value: new THREE.Vector3()}},
    fragmentShader: `${COMMON}
uniform vec3 sunDirection; uniform vec3 color; uniform float density; uniform float intensity; uniform float anisotropy; uniform float reachMax; uniform float ceiling; uniform float hazeFloor; uniform float hazeFalloff; uniform vec3 eye;
varying vec2 vUv;
void main() {
  vec3 ray = viewRay(vUv);
  float depth = viewDistance(vUv);
  float reach = min(depth * length(ray), reachMax);
  vec3 direction = normalize(mat3(cameraWorld) * ray);
  // Interleaved gradient noise: neighbouring pixels start their steps at different offsets.
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float stride = reach / float(STEPS);
  vec3 light = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    float t = (float(i) + jitter) * stride;
    vec3 p = eye + direction * t;
    float thin = exp(-max(p.y - hazeFloor, 0.0) * hazeFalloff);
#ifdef GLASS
    light += sunlit(p) * sunTint(p) * thin * exp(-density * t);
#else
    light += vec3(sunlit(p) * thin * exp(-density * t));
#endif
  }
  float c = dot(direction, sunDirection), g = anisotropy;
  float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
  vec3 scattered = light * stride * density * phase * intensity * color;
  gl_FragColor = vec4(ceiling * (1.0 - exp(-scattered / ceiling)), min(depth, 1000.0));
}`,
  })
  /** Smooths the march's noise, but never across a jump in depth (a silhouette). */
  private readonly blur = new THREE.ShaderMaterial({
    vertexShader, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
    uniforms: {map: {value: null}, texel: {value: new THREE.Vector2()}},
    fragmentShader: `uniform sampler2D map; uniform vec2 texel; varying vec2 vUv;
void main() {
  vec4 centre = texture2D(map, vUv);
  vec3 sum = centre.rgb; float weight = 1.0;
  for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) {
    if (x == 0 && y == 0) continue;
    vec4 s = texture2D(map, vUv + vec2(float(x), float(y)) * texel);
    float w = exp(-abs(s.a - centre.a) / (0.05 * centre.a + 0.1)) * exp(-float(x * x + y * y) * 0.25);
    sum += s.rgb * w; weight += w;
  }
  gl_FragColor = vec4(sum / weight, centre.a);
}`,
  })
  private readonly glassMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, toneMapped: false,
    uniforms: {map: {value: null}},
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D map; varying vec2 vUv;
void main() {
  // The glass's own colour at full strength: its hue, with the brightest channel at 1. Black is
  // a broken pane: the sun goes straight through.
  vec3 a = texture2D(map, vUv).rgb;
  float peak = max(max(a.r, a.g), a.b);
  gl_FragColor = vec4(peak < 0.06 ? vec3(1.0) : a / peak, gl_FragCoord.z);
}`,
  })

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.white.needsUpdate = true
  }

  /** Uniforms the composite needs to upsample the result and colour sunlight through glass. */
  readonly composite = {volume: {value: null as THREE.Texture | null}, volumeTexel: {value: new THREE.Vector2()}, worldDistance: {value: this.linear.texture as THREE.Texture}, ...this.shared}

  /**
   * March the air for the frame just drawn into `world` (its depth texture), at `scale` of its
   * resolution. Returns false, leaving nothing to composite, when there is no shadow map yet.
   */
  render(settings: VolumeSettings, world: THREE.WebGLRenderTarget, camera: THREE.PerspectiveCamera, scale: number): boolean {
    const shadow = settings.sun.shadow, map = shadow.map?.depthTexture
    if (!map || !world.depthTexture) return false
    // At most a third of a megapixel of marching, however dense the screen: the light is soft.
    scale = Math.min(scale * (settings.resolution ?? 1), Math.sqrt(3.5e5 / (world.width * world.height)))
    const renderer = this.renderer, w = Math.max(1, Math.round(world.width * scale)), h = Math.max(1, Math.round(world.height * scale))
    for (const target of this.low) if (target.width !== w || target.height !== h) target.setSize(w, h)
    const s = this.shared
    s.depthMap.value = world.depthTexture
    s.cameraNear.value = camera.near; s.cameraFar.value = camera.far
    s.projectionInverse.value.copy(camera.projectionMatrixInverse); s.cameraWorld.value.copy(camera.matrixWorld)
    s.sunShadow.value = map; s.sunMatrix.value.copy(shadow.matrix)
    s.transmission.value = this.glass(settings) ?? this.white
    s.glassTint.value = settings.glassTint ?? 0
    const u = this.march.uniforms
    u.sunDirection.value.copy(settings.sun.position).sub(settings.sun.target.position).normalize()
    u.color.value.copy(settings.color); u.density.value = settings.density; u.intensity.value = settings.intensity
    u.anisotropy.value = settings.anisotropy; u.reachMax.value = settings.distance; u.ceiling.value = settings.ceiling
    u.hazeFloor.value = settings.thinning?.floor ?? 0; u.hazeFalloff.value = settings.thinning ? 1 / settings.thinning.height : 0
    u.eye.value.setFromMatrixPosition(camera.matrixWorld)
    const steps = scale >= .5 ? 24 : 16, glass = !!settings.glass?.length
    if (this.march.defines.STEPS !== steps || !!this.march.defines.GLASS !== glass) {
      this.march.defines.STEPS = steps
      if (glass) this.march.defines.GLASS = 1; else delete this.march.defines.GLASS
      this.march.needsUpdate = true
    }
    // The world's depth, kept for the composite before anything else draws into the target.
    if (this.linear.width !== world.width || this.linear.height !== world.height) this.linear.setSize(world.width, world.height)
    const d = this.saveDepth.uniforms
    d.depthMap.value = world.depthTexture; d.cameraNear.value = camera.near; d.cameraFar.value = camera.far
    quad.material = this.saveDepth
    renderer.setRenderTarget(this.linear); renderer.render(quad, ortho)
    quad.material = this.march
    renderer.setRenderTarget(this.low[0]); renderer.render(quad, ortho)
    this.blur.uniforms.map.value = this.low[0].texture
    this.blur.uniforms.texel.value.set(1 / w, 1 / h)
    quad.material = this.blur
    renderer.setRenderTarget(this.low[1]); renderer.render(quad, ortho)
    this.composite.volume.value = this.low[1].texture
    this.composite.volumeTexel.value.set(1 / w, 1 / h)
    return true
  }

  /** The transmission map, drawn once per set of glass (the sun and its shadow camera never move). */
  private glass(settings: VolumeSettings): THREE.Texture | null {
    const glass = settings.glass
    if (!glass?.length) return null
    if (this.transmissionFor === glass) return this.transmission.texture
    const renderer = this.renderer, camera = settings.sun.shadow.camera, clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha()
    const autoClear = renderer.autoClear
    try {
      renderer.setRenderTarget(this.transmission)
      renderer.setClearColor(0xffffff, 1); renderer.clear()
      renderer.autoClear = false
      for (const mesh of glass) {
        const material = mesh.material
        this.glassMaterial.uniforms.map.value = (material as THREE.MeshStandardMaterial).map ?? this.white
        mesh.material = this.glassMaterial
        try { renderer.render(mesh, camera) } finally { mesh.material = material }
      }
    } finally {
      renderer.autoClear = autoClear; renderer.setClearColor(clear, alpha); renderer.setRenderTarget(null)
    }
    this.transmissionFor = glass
    return this.transmission.texture
  }
}

/** For bloom.ts's composite: the scattered light, upsampled without bleeding over silhouettes,
 * and sunlit surfaces behind glass given its colour. Expects `vUv` and `c` (the frame's colour). */
export const VOLUME_COMPOSITE_PARS = `${COMMON}
uniform sampler2D volume; uniform vec2 volumeTexel; uniform sampler2D worldDistance;`
export const VOLUME_COMPOSITE = `{
  // The world's own distance, saved before the viewmodel overwrote the depth buffer (see VolumetricLight.linear).
  // Capped as the march caps it, so the sky near the sun keeps its glow.
  float depth = min(texture2D(worldDistance, vUv).r, 1000.0);
  // The gun: drawn over the saved world, so the depth buffer now disagrees with it. Nothing scatters in front of it.
  float raw = texture2D(depthMap, vUv).x;
  float drawn = -perspectiveDepthToViewZ(raw, cameraNear, cameraFar);
  bool rig = raw < 1.0 && abs(min(drawn, 1000.0) - depth) > 0.01 * depth + 0.05;
  vec2 base = vUv / volumeTexel - 0.5, f = fract(base), cell = (floor(base) + 0.5) * volumeTexel;
  vec3 sum = vec3(0.0); float weight = 1e-4;
  for (int x = 0; x <= 1; x++) for (int y = 0; y <= 1; y++) {
    vec4 s = texture2D(volume, cell + vec2(float(x), float(y)) * volumeTexel);
    float w = (x == 0 ? 1.0 - f.x : f.x) * (y == 0 ? 1.0 - f.y : f.y) * exp(-abs(s.a - depth) / (0.05 * depth + 0.1));
    sum += s.rgb * w; weight += w;
  }
  if (!rig && glassTint > 0.0 && depth < 900.0) {
    vec3 p = (cameraWorld * vec4(viewRay(vUv) * depth, 1.0)).xyz;
    // Sunlight that came through glass: the lit stone takes the glass's colour.
    c *= mix(vec3(1.0), sunTint(p), sunlit(p));
  }
  if (!rig) c += sum / weight;
}`
