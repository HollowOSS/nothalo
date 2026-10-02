import * as THREE from 'three'
import {DEBUG_HOOKS} from '../debug/build-flags.ts'

/**
 * Surface correction and generated detail for the imported Halo 3 arenas.
 *
 * The exports lose most of what made Halo 3's surfaces read: its detail maps, specular and
 * cube-map terms are gone, and what is left arrives partly wrong. At load, per material:
 *
 * - Specular: the spec-gloss to metal-rough conversion leaves every material with a black
 *   specular colour and an index of refraction of 1000, so non-metals had no reflectance at all:
 *   no sun highlight, no sky in the floor. They get the ordinary dielectric response back.
 * - Normal maps: the exported ones are DirectX-style (green toward +v). The exported tangents agree
 *   with them, but where a mesh has none three derives its frame with glTF's green-up, which would
 *   light every bump from the wrong side; either way they are read green toward +v.
 * - Occlusion: a few exports put a copy of the albedo's red channel in the occlusion slot, which
 *   darkened the dark metals' shade to a tenth. Those are dropped; real occlusion is kept.
 * - Alpha: fences and grates with a cut-out alpha are alpha-tested rather than blended, so they
 *   stop sorting against each other and cast shadows.
 * - Detail: materials without a normal map get one derived from their albedo's luminance (a
 *   blurred height, Sobel, two scales), rendered once per texture on the GPU into a two-channel
 *   target at no more than 512 texels. Every material's roughness then follows its albedo against
 *   its own neighbourhood, so worn bright edges polish and grime roughens and highlights break up.
 * - Tiling: a shared world-space detail layer keeps surfaces sharp up close, as Halo 3's detail
 *   maps did, and the few floors whose export UVs lost their tiling get it back (RETILE).
 *
 * The maps are built once at load; per pixel it costs a low-mip albedo read and a detail read.
 */

/**
 * By Halo 3 shader family, first match wins: relief (generated normal strength), roughness
 * variation, and a base roughness for materials finishSurface() left fully rough.
 */
interface Family {relief: number; roughness: number; base: number; detail: [number, number]}
const FAMILIES: [RegExp, Family][] = [
  // Flat, emissive or already handled elsewhere: nothing to add.
  [/glass|water|holo|plasma|illum|light_|leaf|gradient/, {relief: 0, roughness: 0, base: 1, detail: [0, 0]}],
  // Rough masonry and ground: the strongest relief.
  [/concrete|stone|rock|ground|terrain|cliff|pyramid|slab|tombstone|wood|bark|rubber|corrug/, {relief: 1.4, roughness: .35, base: .82, detail: [.3, .35]}],
  // Human steel, worn and grimy.
  [/metal|girder|pipe|rail|pelican|bracket|boilerplate|cables|rustbucket|grate|fence|hull|military|equipment/, {relief: .8, roughness: .3, base: .62, detail: [.18, .3]}],
  // Forerunner alloy and trim: machined, so only a little relief, and a satin finish.
  [/panel|trim|copper|plate|obelisk|chill|waste|sal_|altar|man_cannon|for_|cust_|shrine/, {relief: .5, roughness: .22, base: .55, detail: [.12, .22]}],
]
const DEFAULT_FAMILY: Family = {relief: 1, roughness: .3, base: .85, detail: [.2, .35]}

/**
 * Materials whose export UVs lost their tiling. The exporter squeezed a tiling texture into one UV
 * square across a whole floor (Narrows' deck: a 2 m hex tile stretched to 63 x 183 m, three times
 * longer than wide) or unwrapped it once over the whole map (Rat's Nest's concrete at 350 m a
 * tile). Where the export's UVs are still a clean planar projection they are scaled back up, which
 * keeps their orientation and the trims' alignment; where they are not, the texture is projected
 * in world space instead.
 */
type Retile = {repeat: [number, number]} | {triplanar: number; macro?: number}
const RETILE: [RegExp, Retile][] = [
  // Planar UVs over 62.7 x 182.7 m (u along x, v along -z): a 2 m hex tile, 1.5 m dark plate.
  [/^chill_ground_floor$/, {repeat: [62.7 / 2, 182.7 / 2]}],
  [/^chill_ground_darkfloor$/, {repeat: [62.9 / 1.5, 182.1 / 1.5]}],
  // One unwrap over the whole map: 6 m rock-and-concrete (Rat's Nest's cliffs and walls, keeping the
  // export's broad light and dark as macro variation so the tile does not show), 8 m slabs.
  [/^hb_concrete_slabs_01$/, {triplanar: 6, macro: .8}],
  [/^cyberdyne_ground_concrete$/, {triplanar: 8}],
  // Tiled already, but at 150 m a tile: Sandtrap's cracked canyon stone at a 37 m tile instead.
  [/^z_null_stone_broken$/, {repeat: [4, 4]}],
]
/** Valhalla's terrain materials are rebuilt in world space by valhalla-look.ts. */
const WORLD_SPACE = /^riverworld_ground/

const corrected = new WeakSet<THREE.Material>()
/** Development only: ?nosurface shows the export as it arrives, for comparison. */
const DISABLED = DEBUG_HOOKS && new URLSearchParams(location.search).has('nosurface')

/** Fix what the export got wrong, then add generated detail. Safe to call more than once. */
export function detailSurface(material: THREE.Material, renderer: THREE.WebGLRenderer): void {
  const standard = material as THREE.MeshPhysicalMaterial
  if (DISABLED || !standard.isMeshStandardMaterial || corrected.has(material)) return
  corrected.add(material)
  // ---- corrections ----
  if (standard.isMeshPhysicalMaterial) {
    // The ordinary dielectric response (F0 0.04). The two converted spec-gloss maps (Sandtrap's
    // ground, Valhalla's metal) are near-black masks or a copy of the albedo; neither reads right
    // as F0 at an index of 1000, so they go too.
    standard.ior = 1.5; standard.specularIntensity = 1; standard.specularColor.setRGB(1, 1, 1)
    standard.specularColorMap = null; standard.specularIntensityMap = null
  }
  // Only the base colour had anisotropic filtering; normal and emissive detail smeared at grazing angles.
  const anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())
  for (const texture of [standard.map, standard.normalMap, standard.emissiveMap, standard.roughnessMap]) if (texture) texture.anisotropy = Math.max(texture.anisotropy, anisotropy)
  if (standard.normalMap) standard.normalScale.y = Math.abs(standard.normalScale.y)
  if (standard.aoMap && standard.aoMap.channel === 0 && standard.map && sameRedChannel(standard.aoMap, standard.map)) standard.aoMap = null
  if (standard.transparent && standard.map && cutOut(standard.map)) {
    standard.transparent = false; standard.alphaTest = .5; standard.depthWrite = true
    standard.alphaToCoverage = !!renderer.getContext().getContextAttributes()?.antialias
    bleedCutout(standard.map)
  }
  standard.needsUpdate = true
  if (WORLD_SPACE.test(material.name) || /^(blood_ground|cap_moss01b)$/.test(material.name) || !standard.map) return

  // ---- detail ----
  const family = FAMILIES.find(([pattern]) => pattern.test(material.name))?.[1] ?? DEFAULT_FAMILY
  const emissive = !!standard.emissiveMap || standard.emissive.getHex() !== 0
  if (family.relief && !standard.normalMap && !emissive && !standard.transparent) {
    const normal = detailNormalMap(renderer, standard.map, family.relief)
    if (normal) {
      standard.normalMap = normal
      // Generated maps follow glTF's convention (green against +v).
      standard.normalScale.set(1, -1)
    }
  }
  if (standard.roughness === 1 && !standard.roughnessMap) standard.roughness = family.base
  const retile = RETILE.find(([pattern]) => pattern.test(material.name))?.[1]
  patchSurface(standard, {roughness: emissive ? 0 : family.roughness, detail: emissive || standard.transparent ? [0, 0] : family.detail, retile,
    // Imported normal maps are DirectX-style, generated ones glTF-style (see above).
    normalSign: standard.normalMap?.name.endsWith('detail-normal') ? -1 : 1})
}

/**
 * The per-pixel part, one shader patch per material:
 *
 * - Roughness follows the albedo against its blurred self: brighter than its surroundings is worn
 *   smooth, darker is dirt. One read of the albedo's low mip.
 * - A tiled detail layer in world space, as Halo 3's detail maps did: fine grain in the colour and
 *   the normal within about 15 m, fading out beyond. One read of a small shared texture.
 * - Retiling (RETILE): scaled UVs, or a three-way world-space projection of the albedo and normal
 *   map (three reads each instead of one) for the few materials that need it.
 */
function patchSurface(material: THREE.MeshStandardMaterial, options: {roughness: number; detail: [number, number]; retile?: Retile; normalSign: number}): void {
  const {roughness, detail, retile, normalSign} = options
  const repeat = retile && 'repeat' in retile ? retile.repeat : null, triplanar = retile && 'triplanar' in retile ? retile.triplanar : 0
  const detailed = detail[0] > 0 || detail[1] > 0
  if (!roughness && !detailed && !retile) return
  const previous = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey.bind(material)
  const uniforms = {
    surfaceRoughness: {value: roughness}, surfaceDetail: {value: new THREE.Vector2(...detail)}, surfaceDetailMap: {value: detailTexture()},
    surfaceRepeat: {value: new THREE.Vector2(...(repeat ?? [1, 1]))}, surfaceTile: {value: triplanar || 1}, surfaceNormalSign: {value: normalSign},
    surfaceMacro: {value: retile && 'macro' in retile ? retile.macro ?? 0 : 0},
  }
  const defines = [repeat ? '#define SURFACE_REPEAT' : '', triplanar ? '#define SURFACE_TRIPLANAR' : '', detailed ? '#define SURFACE_DETAIL' : '', roughness ? '#define SURFACE_ROUGHNESS' : ''].join('\n')
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
${defines}
uniform vec2 surfaceRepeat;
varying vec3 vSurfaceWorld;
varying vec3 vSurfaceNormal;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef SURFACE_REPEAT
  #ifdef USE_MAP
  vMapUv *= surfaceRepeat;
  #endif
  #ifdef USE_NORMALMAP
  vNormalMapUv *= surfaceRepeat;
  #endif
#endif`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vSurfaceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vSurfaceNormal = normalize(mat3(modelMatrix) * objectNormal);`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${defines}
uniform float surfaceRoughness;
uniform vec2 surfaceDetail;
uniform sampler2D surfaceDetailMap;
uniform float surfaceTile;
uniform float surfaceNormalSign;
uniform float surfaceMacro;
varying vec3 vSurfaceWorld;
varying vec3 vSurfaceNormal;
vec2 surfaceUv;
vec4 surfaceGrain;
float surfaceNear;
// The world axes a projection along the surface's dominant axis maps u and v to.
void surfaceAxes(vec3 n, out vec3 u, out vec3 v, out vec2 p, vec3 world) {
  vec3 a = abs(n);
  if (a.y > max(a.x, a.z)) { u = vec3(1.0, 0.0, 0.0); v = vec3(0.0, 0.0, 1.0); p = world.xz; }
  else if (a.x > a.z) { u = vec3(0.0, 0.0, 1.0); v = vec3(0.0, 1.0, 0.0); p = world.zy; }
  else { u = vec3(1.0, 0.0, 0.0); v = vec3(0.0, 1.0, 0.0); p = world.xy; }
}`)
      .replace('#include <map_fragment>', `
#if defined(SURFACE_TRIPLANAR) && defined(USE_MAP)
{
  vec3 n = normalize(vSurfaceNormal), p = vSurfaceWorld / surfaceTile;
  vec3 w = pow(abs(n), vec3(4.0)); w /= w.x + w.y + w.z;
  diffuseColor *= texture2D(map, p.zy) * w.x + texture2D(map, p.xz) * w.y + texture2D(map, p.xy) * w.z;
  // The export's own UVs, blurred, against the texture's mean: its broad light and dark, kept.
  vec3 broad = texture2D(map, vMapUv, 3.0).rgb / max(textureLod(map, vec2(0.5), 12.0).rgb, vec3(0.02));
  diffuseColor.rgb *= mix(vec3(1.0), clamp(broad, 0.4, 1.8), surfaceMacro);
  vec3 u, v; surfaceAxes(n, u, v, surfaceUv, p);
}
#else
#include <map_fragment>
#ifdef USE_MAP
surfaceUv = vMapUv;
#endif
#endif
#ifdef SURFACE_DETAIL
{
  vec3 u, v; vec2 p;
  surfaceAxes(normalize(vSurfaceNormal), u, v, p, vSurfaceWorld);
  surfaceNear = 1.0 - smoothstep(5.0, 16.0, distance(vSurfaceWorld, cameraPosition));
  surfaceGrain = texture2D(surfaceDetailMap, p / 0.8);
  diffuseColor.rgb *= 1.0 + (surfaceGrain.b - 0.5) * 2.0 * surfaceDetail.x * surfaceNear;
}
#endif`)
      .replace('#include <normal_fragment_maps>', `
#if defined(SURFACE_TRIPLANAR) && defined(USE_NORMALMAP)
{
  // Each projection's map bends the normal along that projection's two world axes: red is -dh/du,
  // green dh/dv (glTF) or -dh/dv (DirectX), which surfaceNormalSign turns into the bend along v.
  vec3 n = normalize(vSurfaceNormal), p = vSurfaceWorld / surfaceTile;
  vec3 w = pow(abs(n), vec3(4.0)); w /= w.x + w.y + w.z;
  vec2 bx = texture2D(normalMap, p.zy).xy * 2.0 - 1.0, by = texture2D(normalMap, p.xz).xy * 2.0 - 1.0, bz = texture2D(normalMap, p.xy).xy * 2.0 - 1.0;
  float s = surfaceNormalSign;
  vec3 bend = w.x * vec3(0.0, s * bx.y, bx.x) + w.y * vec3(by.x, 0.0, s * by.y) + w.z * vec3(bz.x, s * bz.y, 0.0);
  bend -= n * dot(bend, n);
  normal = normalize(normal + mat3(viewMatrix) * bend * abs(normalScale.x));
}
#else
#include <normal_fragment_maps>
#endif
#ifdef SURFACE_DETAIL
{
  vec3 u, v; vec2 p;
  vec3 n = normalize(vSurfaceNormal);
  surfaceAxes(n, u, v, p, vSurfaceWorld);
  vec3 bend = u * (surfaceGrain.r * 2.0 - 1.0) + v * (surfaceGrain.g * 2.0 - 1.0);
  bend -= n * dot(bend, n);
  normal = normalize(normal + mat3(viewMatrix) * bend * surfaceDetail.y * surfaceNear);
}
#endif`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
#if defined(SURFACE_ROUGHNESS) && defined(USE_MAP)
{
  float here = sqrt(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)));
  float around = sqrt(dot(texture2D(map, surfaceUv, 4.0).rgb * diffuse, vec3(0.2126, 0.7152, 0.0722)));
  float wear = clamp((here - around) * 5.0, -1.0, 1.0);
  roughnessFactor = clamp(roughnessFactor - wear * surfaceRoughness, 0.06, 1.0);
}
#endif`)
  }
  material.customProgramCacheKey = () => `${key()}|surface|${repeat ? 'r' : ''}${triplanar ? 't' : ''}${detailed ? 'd' : ''}${roughness ? 'g' : ''}`
}

/**
 * The shared detail layer: 256x256 tiling fine grain, height in blue and its slopes (-dh/du,
 * -dh/dv) in red and green, from wrapped value noise. Built once.
 */
let grain: THREE.DataTexture | null = null
function detailTexture(): THREE.DataTexture {
  if (grain) return grain
  const size = 256, data = new Uint8Array(size * size * 4), height = new Float32Array(size * size)
  let seed = 11
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (const [cells, weight] of [[8, .35], [16, .3], [32, .2], [64, .15]] as const) {
    const lattice = Array.from({length: cells * cells}, random)
    const at = (i: number, j: number) => lattice[((j % cells + cells) % cells) * cells + ((i % cells + cells) % cells)]
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / size * cells, fy = y / size * cells, x0 = Math.floor(fx), y0 = Math.floor(fy)
      const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
      height[y * size + x] += ((at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy) * weight
    }
  }
  const h = (x: number, y: number) => height[((y + size) % size) * size + (x + size) % size]
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, dx = (h(x + 1, y) - h(x - 1, y)) * 6, dy = (h(x, y + 1) - h(x, y - 1)) * 6
    data[i] = Math.max(0, Math.min(255, (-dx * .5 + .5) * 255)); data[i + 1] = Math.max(0, Math.min(255, (-dy * .5 + .5) * 255))
    data[i + 2] = Math.max(0, Math.min(255, h(x, y) * 255)); data[i + 3] = 255
  }
  grain = new THREE.DataTexture(data, size, size)
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping
  grain.generateMipmaps = true; grain.minFilter = THREE.LinearMipmapLinearFilter; grain.magFilter = THREE.LinearFilter
  grain.anisotropy = 4; grain.needsUpdate = true
  return grain
}

// ---- generated normal maps ----

const generated = new WeakMap<THREE.Source<unknown>, Map<number, THREE.Texture>>()
let flat: THREE.DataTexture | null = null
let pass: {scene: THREE.Scene; camera: THREE.Camera; material: THREE.RawShaderMaterial} | null = null

/**
 * A tangent-space normal map (glTF convention, two channels) derived from a colour texture's
 * luminance, cached per texture and relief. Rendered on the GPU once; null for textures too
 * small to carry relief. Relief 1 is an authored-looking map (RMS slope about 0.18) whatever the
 * texture's contrast: a dark, low-contrast stone gets as much as a bright, busy one.
 */
export function detailNormalMap(renderer: THREE.WebGLRenderer, source: THREE.Texture, relief: number): THREE.Texture | null {
  if (DISABLED) return flat ??= Object.assign(new THREE.DataTexture(new Uint8Array([128, 128]), 1, 1, THREE.RGFormat), {needsUpdate: true})
  const image = source.image as {width: number; height: number} | undefined
  if (!image?.width || Math.max(image.width, image.height) < 64) return null
  let bySource = generated.get(source.source)
  if (!bySource) generated.set(source.source, bySource = new Map())
  const cached = bySource.get(relief)
  if (cached) return cached

  // Half resolution from 512 up, and never above 512: relief comes from a blurred height anyway.
  const size = (n: number) => Math.min(512, n >= 512 ? n / 2 : n)
  const width = size(image.width), height = size(image.height)
  const target = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGFormat, type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS: source.wrapS, wrapT: source.wrapT, anisotropy: Math.max(source.anisotropy, Math.min(4, renderer.capabilities.getMaxAnisotropy())),
  })
  target.texture.name = `${source.name || 'albedo'}-detail-normal`
  // Disposing the texture with its map releases the framebuffer too.
  target.texture.addEventListener('dispose', () => target.dispose())

  pass ??= createPass()
  renderer.initTexture(source)
  const uniforms = pass.material.uniforms
  uniforms.albedo.value = source
  uniforms.texel.value.set(1 / width, 1 / height)
  uniforms.lod.value = Math.log2(image.width / width)
  // The pass's slope RMS comes out at about 8x its strength times the albedo's luminance gradient
  // (measured at 64x64), at either resolution.
  uniforms.strength.value = relief * .18 / (8 * Math.max(.006, contrast(source) ?? .02))
  const previous = renderer.getRenderTarget()
  renderer.setRenderTarget(target)
  renderer.render(pass.scene, pass.camera)
  renderer.setRenderTarget(previous)
  uniforms.albedo.value = null
  bySource.set(relief, target.texture)
  return target.texture
}

function createPass() {
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
    uniforms: {albedo: {value: null}, texel: {value: new THREE.Vector2()}, lod: {value: 0}, strength: {value: 1}},
    vertexShader: `in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `precision highp float;
uniform sampler2D albedo; uniform vec2 texel; uniform float lod; uniform float strength;
in vec2 vUv;
out vec4 color;
// Height is perceptual luminance: Halo's albedos carry their crevices dark and their edges light.
float height(vec2 uv, float bias) { return sqrt(dot(textureLod(albedo, uv, lod + bias).rgb, vec3(0.2126, 0.7152, 0.0722))); }
vec2 sobel(float step, float bias) {
  vec2 d = texel * step;
  float a = height(vUv + vec2(-d.x, -d.y), bias), b = height(vUv + vec2(0.0, -d.y), bias), c = height(vUv + vec2(d.x, -d.y), bias);
  float e = height(vUv + vec2(-d.x, 0.0), bias), f = height(vUv + vec2(d.x, 0.0), bias);
  float g = height(vUv + vec2(-d.x, d.y), bias), h = height(vUv + vec2(0.0, d.y), bias), i = height(vUv + vec2(d.x, d.y), bias);
  return vec2((c + 2.0 * f + i) - (a + 2.0 * e + g), (g + 2.0 * h + i) - (a + 2.0 * b + c)) / (8.0 * step);
}
void main() {
  // Fine grain plus broader forms from a blurrier, wider sample.
  vec2 slope = (sobel(1.0, 0.5) * 0.65 + sobel(3.0, 1.6) * 0.8) * strength * 18.0;
  // Keep the tilt below ~60 degrees so the unpacked z stays well away from zero.
  float len = length(slope);
  if (len > 1.6) slope *= 1.6 / len;
  vec3 n = normalize(vec3(-slope.x, -slope.y, 1.0));
  // glTF convention: +x along u, +y against v.
  color = vec4(n.x * 0.5 + 0.5, -n.y * 0.5 + 0.5, 0.0, 1.0);
}`,
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(mesh)
  return {scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material}
}

// ---- image checks (a few materials, 64x64 point-sampled reads) ----

const PROBE = 64
let canvas: CanvasRenderingContext2D | null = null
function pixels(texture: THREE.Texture, smooth = false): Uint8ClampedArray | null {
  const image = texture.image as CanvasImageSource | undefined
  if (!image) return null
  canvas ??= Object.assign(document.createElement('canvas'), {width: PROBE, height: PROBE}).getContext('2d', {willReadFrequently: true})
  if (!canvas) return null
  try {
    // Point sampling for the alpha and channel checks: filtering would blend a cut-out's edges.
    canvas.imageSmoothingEnabled = smooth
    canvas.clearRect(0, 0, PROBE, PROBE); canvas.drawImage(image, 0, 0, PROBE, PROBE)
    return canvas.getImageData(0, 0, PROBE, PROBE).data
  } catch { return null }
}
/** The occlusion map is only the albedo's red channel copied over. */
function sameRedChannel(occlusion: THREE.Texture, albedo: THREE.Texture): boolean {
  const a = pixels(occlusion)?.slice(), b = pixels(albedo)
  if (!a || !b) return false
  let error = 0
  for (let i = 0; i < a.length; i += 4) error += Math.abs(a[i] - b[i])
  return error / (a.length / 4) < 6
}
/** Alpha is a cut-out: nearly every texel fully in or fully out. */
function cutOut(albedo: THREE.Texture): boolean {
  const data = pixels(albedo)
  if (!data) return false
  let partial = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8 && data[i] < 248) partial++
  return partial / (data.length / 4) < .08
}
/** RMS luminance gradient per texel of the texture drawn at 64x64: how much relief it carries. */
function contrast(albedo: THREE.Texture): number | null {
  const data = pixels(albedo, true)
  if (!data) return null
  const luma = new Float32Array(PROBE * PROBE)
  for (let i = 0; i < luma.length; i++) luma[i] = (.2126 * data[i * 4] + .7152 * data[i * 4 + 1] + .0722 * data[i * 4 + 2]) / 255
  let sum = 0, count = 0
  for (let y = 1; y < PROBE - 1; y++) for (let x = 1; x < PROBE - 1; x++) {
    const i = y * PROBE + x, dx = (luma[i + 1] - luma[i - 1]) / 2, dy = (luma[i + PROBE] - luma[i - PROBE]) / 2
    sum += dx * dx + dy * dy; count++
  }
  return Math.sqrt(sum / count / 2)
}

/**
 * Cut-out foliage exported with black in its transparent texels: bilinear filtering and mipmaps blend that black into every
 * leaf edge, which reads as dark specks against a bright sky. Fill the transparent texels with the colour of the nearest
 * opaque ones (premultiplied blur, widening until everything is covered), once per texture, at load.
 */
const bled = new WeakSet<THREE.Texture>()
export function bleedCutout(texture: THREE.Texture): void {
  const image = texture.image as (CanvasImageSource & {width: number; height: number}) | undefined
  if (bled.has(texture) || !image?.width) return
  bled.add(texture)
  const w = image.width, h = image.height
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
  const g = canvas.getContext('2d', {willReadFrequently: true})
  if (!g) return
  g.drawImage(image, 0, 0)
  const data = g.getImageData(0, 0, w, h), px = data.data, n = w * h
  const r = new Float32Array(n), gr = new Float32Array(n), b = new Float32Array(n), a = new Float32Array(n)
  for (let i = 0; i < n; i++) { const al = px[i * 4 + 3] > 127 ? 1 : 0; a[i] = al; r[i] = px[i * 4] * al; gr[i] = px[i * 4 + 1] * al; b[i] = px[i * 4 + 2] * al }
  const blur = (src: Float32Array, rad: number) => {
    const tmp = new Float32Array(n), out = new Float32Array(n)
    for (let y = 0; y < h; y++) { let s = 0; for (let x = -rad; x <= rad; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))]
      for (let x = 0; x < w; x++) { tmp[y * w + x] = s; s += src[y * w + Math.min(w - 1, x + rad + 1)] - src[y * w + Math.max(0, x - rad)] } }
    for (let x = 0; x < w; x++) { let s = 0; for (let y = -rad; y <= rad; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
      for (let y = 0; y < h; y++) { out[y * w + x] = s; s += tmp[Math.min(h - 1, y + rad + 1) * w + x] - tmp[Math.max(0, y - rad) * w + x] } }
    return out
  }
  const filled = new Uint8Array(n)
  for (let i = 0; i < n; i++) filled[i] = a[i] ? 1 : 0
  for (const rad of [2, 6, 16, 48]) {
    const br = blur(r, rad), bg = blur(gr, rad), bb = blur(b, rad), ba = blur(a, rad)
    for (let i = 0; i < n; i++) if (!filled[i] && ba[i] > 0) { px[i * 4] = br[i] / ba[i]; px[i * 4 + 1] = bg[i] / ba[i]; px[i * 4 + 2] = bb[i] / ba[i]; filled[i] = 1 }
  }
  g.putImageData(data, 0, 0)
  texture.image = canvas
  texture.needsUpdate = true
}
