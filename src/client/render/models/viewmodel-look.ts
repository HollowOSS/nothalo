import * as THREE from 'three'
import { DEBUG_HOOKS } from '../../debug/build-flags.ts'

/**
 * The first-person weapons' surfaces: what they reflect, how rough and metallic they are, and how their energy parts glow.
 *
 * The downloaded guns mostly arrive as a colour map on a flat 0.6-rough dielectric (spec/gloss conversions, see
 * weapon-finish.ts), which reads as grey plastic. Halo's guns are painted and bare metal (UNSC) or polished alloy
 * (Covenant), and they read as metal because they reflect their surroundings. So, for the viewmodel only:
 *
 * - Reflections come from a small environment built per map from its own sky, fog, ground and sun, plus two soft
 *   "studio" panels that give the metal its crisp highlights (`viewmodelEnvironment`). Maps such as Guardian turn the
 *   scene environment off for the world's sake; the gun's few thousand pixels can afford one lookup.
 * - Materials that only have a colour map get a roughness/metalness map and a fine detail normal map derived from it
 *   once at load (`deriveSurface`): bright, unsaturated texels read as worn bare metal, dark ones as paint or polymer,
 *   and local contrast (edges, scratches, panel lines) turns into polish and relief.
 * - Emissive parts (displays, plasma, crystals, the hammer's glow) are pushed past the bloom threshold, which since the
 *   viewmodel is drawn inside the bloom target (first-person-pass.ts) makes them glow.
 * The world weapons keep weapon-finish.ts alone: a third-person gun is a few dozen pixels and not worth the maps.
 */

interface Profile {
  /** metalness for [paint/dark, bare/bright] texels (derived) or a single value */
  metal: readonly [number, number]
  rough: readonly [number, number]
  /** luminance window that maps to bare metal (0..1) */
  bright?: readonly [number, number]
  env: number
  /** detail normal strength from the colour map, 0 for none */
  relief: number
  emissive?: number
}
const UNSC_PAINT: Profile = {metal: [.08, .5], rough: [.56, .36], bright: [.72, .96], env: .75, relief: .4}
/** The Halo 3 rips (BR, shotgun, sniper, rocket): dark painted steel. Satin, never glossy; the brightest texels (edges,
 * wear) are bare metal. Their converted maps say "glossy dielectric", which is what plastic looks like, so they are
 * replaced (see finishSurface). */
const GUNMETAL: Profile = {metal: [.3, .85], rough: [.54, .32], env: .8, relief: .35}
const UNSC_STEEL: Profile = {metal: [.55, .9], rough: [.42, .26], bright: [.35, .75], env: .95, relief: .5}
const COVENANT: Profile = {metal: [.6, .8], rough: [.3, .16], bright: [.15, .6], env: 1.1, relief: .4}
const BRUTE: Profile = {metal: [.45, .8], rough: [.55, .32], bright: [.35, .75], env: .9, relief: .6}
/** Material name -> profile. Names are the imported materials' own (see tools/import-*.mjs). First match wins. */
const PROFILES: [RegExp, Profile][] = [
  // the Chief's arms keep their authored maps; only how much they reflect is set
  [/glove|^body$/i, {metal: [1, 1], rough: [1, 1], env: .4, relief: 0}],
  [/^magnum/i, UNSC_STEEL],
  [/battle_rifle|^mat_0_1$|shotgun_body|sniper_body|rocket_body/i, GUNMETAL],
  [/smg|assault_rifle|shotgun|sniper|rocket|^m6/i, UNSC_PAINT],
  [/plasma_(pistol|rifle)|needler_dull|covenant/i, COVENANT],
  [/storm_energ|sword.*(hilt|handle)|energy.?sword/i, COVENANT],
  [/hammer/i, BRUTE],
]
/** Energy and screens: how far past 1 their emission goes (the bloom threshold is ~0.9 after tone mapping). */
const GLOW: [RegExp, number][] = [
  [/luminous|crystal|plasma|illum|light$|_light/i, 3.2],
  [/display|screen|compass|counter/i, 2.2],
]

/** Gun finish: the texture does the work (user: the guns "only look bad because of the weird glossy reflections" — "what if
 * we just let the texture do the work"). Fully rough, no metal, no specular, a trace of reflection; the ripped gun textures
 * are very dark, so their colour is lifted (liftDarkAlbedo) to let the painted panel detail read under plain lighting. */
const SATIN = {rough: 1, metal: 0, env: .08, specular: 0}

const ENV_KEY = 'viewmodelEnvironment'

/** The map's reflection for the viewmodel, built once per scene from its own colours and sun. */
export function viewmodelEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer): THREE.Texture {
  const cached = scene.userData[ENV_KEY] as THREE.Texture | undefined
  if (cached) return cached
  // Mostly neutral, with a hint of the map: a tinted reflection turns every gun the colour of the fog.
  const sky = new THREE.Color(0xaeb6bd), ground = new THREE.Color(0x4a4946), sunColor = new THREE.Color(0xfff2dc), sunDir = new THREE.Vector3(-.4, .8, .3)
  const mapSky = (scene.background as THREE.Color)?.isColor ? scene.background as THREE.Color : scene.fog?.color
  if (mapSky) sky.lerp(mapSky, .3)
  let strongest = 0
  scene.traverse(o => {
    const hemi = o as THREE.HemisphereLight
    if (hemi.isHemisphereLight) { sky.lerp(hemi.color, .15); ground.lerp(hemi.groundColor, .35) }
    const sun = o as THREE.DirectionalLight
    if (sun.isDirectionalLight && sun.intensity > strongest) {
      strongest = sun.intensity; sunColor.copy(sun.color)
      sunDir.copy(sun.position).sub(sun.target.position).normalize()
    }
  })
  const env = new THREE.Scene()
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: {sky: {value: sky}, ground: {value: ground}, sun: {value: sunColor}, sunDir: {value: sunDir}},
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 sky; uniform vec3 ground; uniform vec3 sun; uniform vec3 sunDir; varying vec3 vDir;
      void main(){
        float y = vDir.y;
        vec3 horizon = mix(ground, sky, .65) * 1.15;
        vec3 c = y > 0.0 ? mix(horizon, sky * .85, smoothstep(0.0, .6, y)) : mix(horizon, ground * .6, smoothstep(0.0, -.35, y));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        c += sun * (pow(s, 600.0) * 40.0 + pow(s, 12.0) * .5);
        gl_FragColor = vec4(c, 1.0);
      }`,
  }))
  env.add(dome)
  // Two soft panels: a key above and ahead, a cool rim behind-left. They are what makes polished metal read as metal.
  const panel = (w: number, h: number, color: THREE.ColorRepresentation, intensity: number, at: THREE.Vector3) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide}))
    m.position.copy(at); m.lookAt(0, 0, 0); env.add(m)
  }
  panel(7, 3, sunColor, 3.2, new THREE.Vector3(1.5, 6, -5))
  panel(3, 6, sky, 2.2, new THREE.Vector3(-6, 2.5, 3))
  const pmrem = new THREE.PMREMGenerator(renderer)
  const texture = pmrem.fromScene(env, 0, .1, 50).texture
  pmrem.dispose()
  dome.geometry.dispose(); (dome.material as THREE.Material).dispose()
  env.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose() } })
  scene.userData[ENV_KEY] = texture
  return texture
}

/** Give every viewmodel material under `root` this map's reflection, and its profile (once per material). */
export function applyViewmodelLook(root: THREE.Object3D, env: THREE.Texture): void {
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = material as THREE.MeshStandardMaterial
      if (!m.isMeshStandardMaterial || m.userData.viewmodelEnv === env) continue
      if (!m.userData.viewmodelLook) finishSurface(m)
      m.envMap = env
      m.envMapIntensity = m.userData.viewmodelLook.env
      m.userData.viewmodelEnv = env
      m.needsUpdate = true
    }
  })
}

function finishSurface(m: THREE.MeshStandardMaterial): void {
  const name = m.name ?? ''
  // Anything still carrying a spec/gloss conversion's index of refraction of 1000 (the held frag grenade) is a mirror at
  // grazing angles: reset it to a normal dielectric, as weapon-finish.ts does for the guns.
  const physical = m as THREE.MeshPhysicalMaterial
  if (physical.isMeshPhysicalMaterial && physical.ior > 2) { physical.ior = 1.5; physical.specularColorMap = null; physical.specularIntensityMap = null }
  // optics are coated glass, not lights: dark, polished, a faint tint in the coating and a sharp reflection
  if (/lens/i.test(name)) {
    m.userData.viewmodelLook = {env: 1.6}
    m.roughness = .06; m.metalness = .6; m.emissiveIntensity = .04; m.color.set(0x141a3a)
    return
  }
  const profile = PROFILES.find(([pattern]) => pattern.test(name))?.[1]
  m.userData.viewmodelLook = {env: profile?.env ?? 1}
  // the Chief's arms: texture-only like the guns and the third-person armour
  if (/glove|^body$/i.test(name)) { m.roughnessMap = null; m.metalnessMap = null; m.roughness = 1; m.metalness = 0; m.userData.viewmodelLook.env = .08; return }
  const glow = GLOW.find(([pattern]) => pattern.test(name))?.[1]
  const emits = !!m.emissiveMap || m.emissive.getHex() !== 0
  if (emits && glow) m.emissiveIntensity = Math.max(m.emissiveIntensity, glow)
  else if (emits && m.emissiveMap) m.emissiveIntensity = Math.max(m.emissiveIntensity, 2)
  if (!profile) return
  // A spec/gloss conversion arrives as a roughness map with metalness zeroed: a glossy dielectric, i.e. plastic. Those maps
  // are replaced with ones derived from the colour; genuine metal/rough maps (metalness factor 1) are kept.
  const converted = !!m.roughnessMap && m.metalness === 0 && !!m.map
  if (!converted && (m.roughnessMap || m.metalnessMap || !m.map)) {
    // authored maps win; a flat conversion just gets the satin finish
    // authored roughness/metal maps are dropped too: the ripped maps are what put the sheen on (AR, SMG)
    m.roughnessMap = null; m.metalnessMap = null
    m.roughness = SATIN.rough; m.metalness = SATIN.metal
    m.userData.viewmodelLook.env = Math.min(m.userData.viewmodelLook.env, SATIN.env)
    if (physical.isMeshPhysicalMaterial) physical.specularIntensity = SATIN.specular
    liftDarkAlbedo(m)
    return
  }
  // Maps derived from the colour texture read as smeared wet chrome over the painted detail (user: "weird glossy
  // material ... just making the texture maps look worse"), so the converted maps are dropped for a plain satin finish
  // and the colour texture carries the look. deriveSurface stays available but unused.
  m.roughnessMap = null; m.metalnessMap = null
  m.roughness = SATIN.rough; m.metalness = SATIN.metal
  m.userData.viewmodelLook.env = Math.min(m.userData.viewmodelLook.env, SATIN.env)
  if (physical.isMeshPhysicalMaterial) physical.specularIntensity = SATIN.specular
  liftDarkAlbedo(m)
}

/** Brighten a very dark colour texture (through the material colour) so its mean luminance reaches ~0.1; never more than 3x. */
function liftDarkAlbedo(m: THREE.MeshStandardMaterial): void {
  const image = m.map?.image as (CanvasImageSource & {width: number; height: number}) | undefined
  if (!image?.width || m.userData.albedoLift) return
  const c = document.createElement('canvas'); c.width = c.height = 32
  const g = c.getContext('2d', {willReadFrequently: true}); if (!g) return
  g.drawImage(image, 0, 0, 32, 32)
  const d = g.getImageData(0, 0, 32, 32).data; let sum = 0
  // the texture is sRGB; average in linear light, as the shader will see it
  const lin = (v: number) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }
  for (let i = 0; i < d.length; i += 4) sum += .2126 * lin(d[i]) + .7152 * lin(d[i + 1]) + .0722 * lin(d[i + 2])
  const mean = sum / (d.length / 4), lift = Math.min(3, Math.max(1, .1 / Math.max(mean, 1e-3)))
  m.userData.albedoLift = lift
  m.color.multiplyScalar(lift)
}

/** Main-thread time spent deriving maps (read by tools/fps-audit.mjs through window.__viewmodelLook). */
export const deriveStats = {ms: 0, count: 0}
if (DEBUG_HOOKS) (window as unknown as Record<string, unknown>).__viewmodelLook = deriveStats
const COARSE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
const derivedCache = new Map<THREE.Texture, {surface: THREE.Texture; normal: THREE.Texture | null} | null>()
/** Roughness (G) and metalness (B), and a detail normal, from a colour map. Once per source texture. */
function deriveSurface(map: THREE.Texture, p: Profile): {surface: THREE.Texture; normal: THREE.Texture | null} | null {
  if (derivedCache.has(map)) return derivedCache.get(map)!
  const started = performance.now()
  const image = map.image as CanvasImageSource & {width: number; height: number} | undefined
  if (!image?.width) { derivedCache.set(map, null); return null }
  // half size on touch devices: a quarter of the (one-off, load-time) work, and a phone shows the gun at half the pixels
  const size = Math.min(COARSE ? 256 : 512, image.width), h = Math.max(1, Math.round(size * image.height / image.width))
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = h
  const g = canvas.getContext('2d', {willReadFrequently: true})
  if (!g) { derivedCache.set(map, null); return null }
  g.drawImage(image, 0, 0, size, h)
  const src = g.getImageData(0, 0, size, h).data, n = size * h
  const lum = new Float32Array(n), sat = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const r = src[i * 4] / 255, gr = src[i * 4 + 1] / 255, b = src[i * 4 + 2] / 255
    const hi = Math.max(r, gr, b), lo = Math.min(r, gr, b)
    lum[i] = .2126 * r + .7152 * gr + .0722 * b; sat[i] = hi > 0 ? (hi - lo) / hi : 0
  }
  const blur = boxBlur(lum, size, h, 3)
  const out = g.createImageData(size, h), o = out.data
  // bare metal is the brightest part of this texture: a fixed window where the profile gives one, otherwise the top ~12%
  // of its own luminance (the Halo 3 rips are nearly black overall, so an absolute window would find no metal at all)
  const sample: number[] = []; for (let i = 0; i < n; i += 7) sample.push(lum[i]); sample.sort((a, b) => a - b)
  const q = (f: number) => sample[Math.min(sample.length - 1, Math.floor(f * sample.length))]
  const [b0, b1] = p.bright ?? [q(.88), Math.max(q(.995), q(.88) + .04)]
  for (let i = 0; i < n; i++) {
    // bare metal: bright and unsaturated; edges and scratches (local contrast) are polished
    const bare = smooth(b0, b1, lum[i]) * (1 - .8 * sat[i])
    const edge = Math.min(1, Math.abs(lum[i] - blur[i]) * 6)
    const metal = p.metal[0] + (p.metal[1] - p.metal[0]) * bare
    const rough = Math.max(.08, p.rough[0] + (p.rough[1] - p.rough[0]) * bare - .12 * edge)
    o[i * 4] = 255; o[i * 4 + 1] = Math.round(rough * 255); o[i * 4 + 2] = Math.round(metal * 255); o[i * 4 + 3] = 255
  }
  g.putImageData(out, 0, 0)
  const surface = texture(canvas, map)
  let normal: THREE.Texture | null = null
  if (p.relief > 0) {
    // height = slightly blurred luminance; a Sobel of it is the relief (fine panel lines, scratches, stamped text)
    const height = boxBlur(lum, size, h, 1), nrm = g.createImageData(size, h), q = nrm.data
    const at = (x: number, y: number) => height[Math.min(h - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))]
    for (let y = 0; y < h; y++) for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const k = 2.5, nx = -dx * k, ny = dy * k, len = Math.hypot(nx, ny, 1), i = (y * size + x) * 4
      q[i] = Math.round((nx / len * .5 + .5) * 255); q[i + 1] = Math.round((ny / len * .5 + .5) * 255); q[i + 2] = Math.round((1 / len * .5 + .5) * 255); q[i + 3] = 255
    }
    const nc = document.createElement('canvas'); nc.width = size; nc.height = h
    nc.getContext('2d')!.putImageData(nrm, 0, 0)
    normal = texture(nc, map)
  }
  const result = {surface, normal}
  derivedCache.set(map, result)
  deriveStats.ms += performance.now() - started; deriveStats.count++
  return result
}

function texture(canvas: HTMLCanvasElement, like: THREE.Texture): THREE.Texture {
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.NoColorSpace; t.flipY = like.flipY; t.wrapS = like.wrapS; t.wrapT = like.wrapT
  t.channel = like.channel; t.anisotropy = 4
  t.offset.copy(like.offset); t.repeat.copy(like.repeat); t.rotation = like.rotation; t.center.copy(like.center)
  return t
}
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), d = 2 * r + 1
  for (let y = 0; y < h; y++) { let s = 0; for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) { tmp[y * w + x] = s / d; s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)] } }
  for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) { out[y * w + x] = s / d; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x] } }
  return out
}
