import * as THREE from 'three'

/**
 * Mjolnir armour as painted metal, the way Halo 3 draws it: glossy olive (or team-coloured) paint
 * over steel, catching sharp highlights and the level's reflections, bare bright metal where the
 * paint has chipped off raised edges, and a matte black undersuit between the plates.
 *
 * The generated Spartan has one colour texture and nothing else, over a fragmented UV atlas, so
 * the surface is worked out from what is there, once per load:
 *
 *  - Which texels are painted plate, which are gold visor and which are undersuit comes from the
 *    colour itself (olive vs. near-black vs. orange), the same test the team recolour uses. It is
 *    done on the untinted texture, so a red or blue Spartan gets exactly the plates the olive one
 *    has. Packed into one small RGBA data texture with the paint's mottling (how much duller or
 *    glossier each texel is than the plate around it) and a chip pattern.
 *  - Where the edges are is geometry, not texture: the atlas's islands are cut arbitrarily, so an
 *    edge found in texture space would draw bright lines along every UV seam. Each vertex gets
 *    its convexity (how far its neighbours fall away below its tangent plane), which is high on
 *    the ridges and rims of plates, where paint wears first.
 *
 * The shader then costs one extra texture read and a few mixes per armour pixel; there is no
 * per-frame work. Without an environment map (the maps that light with lights only) the paint
 * stays mostly dielectric, since metal with nothing to reflect renders black.
 */
export interface ArmorSurface {
  /** R plate paint, G visor, B paint dullness (0.5 = average), A chip pattern. Linear data. */
  texture: THREE.Texture
  /** Average paint colour of the plates, linear: for solid-colour pieces worn with the armour. */
  paint: THREE.Color
}

type Source = CanvasImageSource & { width: number; height: number }
type Shader = { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }

const SIZE = 1024, LOW = 4, TILE = 256
/** `?noarmor` restores the old flat materials, for before/after comparisons. */
const NO_ARMOR = new URLSearchParams(location.search).has('noarmor')
const byImage = new WeakMap<object, ArmorSurface>()
const byContent = new Map<string, ArmorSurface>()

/** A few downsampled pixels: every viewmodel file embeds its own copy of the same texture. */
function fingerprint(image: Source): string {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 8
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, 8, 8)
  return `${image.width}x${image.height}:${Array.from(ctx.getImageData(0, 0, 8, 8).data).join(',')}`
}

/** Separable box blur with running sums (radius r, clamped edges), in place. */
function boxBlur(values: Float32Array, n: number, r: number, scratch: Float32Array) {
  const pass = (src: Float32Array, dst: Float32Array, step: number, line: number) => {
    for (let k = 0; k < n; k++) {
      const base = k * line
      let sum = src[base] * (r + 1)
      for (let i = 1; i <= r; i++) sum += src[base + Math.min(i, n - 1) * step]
      for (let i = 0; i < n; i++) {
        dst[base + i * step] = sum / (2 * r + 1)
        sum += src[base + Math.min(i + r + 1, n - 1) * step] - src[base + Math.max(i - r, 0) * step]
      }
    }
  }
  pass(values, scratch, 1, n)
  pass(scratch, values, n, 1)
}

/** Add tiling smooth value noise (lattice spacing `cell` texels, dividing `n`) to an n x n field. */
function addNoise(field: Float32Array, n: number, cell: number, amp: number, seed: number) {
  const g = n / cell, lattice = new Float32Array(g * g)
  let state = seed * 2654435761 >>> 0
  for (let i = 0; i < lattice.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; lattice[i] = state / 4294967296 }
  const fade = new Float32Array(cell)
  for (let i = 0; i < cell; i++) { const t = i / cell; fade[i] = t * t * (3 - 2 * t) }
  for (let y = 0; y < n; y++) {
    const j = (y / cell) | 0, v = fade[y - j * cell], row = j * g, next = ((j + 1) % g) * g
    for (let x = 0; x < n; x++) {
      const i = (x / cell) | 0, u = fade[x - i * cell], i1 = (i + 1) % g
      const top = lattice[row + i] + (lattice[row + i1] - lattice[row + i]) * u
      const bottom = lattice[next + i] + (lattice[next + i1] - lattice[next + i]) * u
      field[y * n + x] += (top + (bottom - top) * v) * amp
    }
  }
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** The surface maps for an armour colour texture. Cached: the viewmodels and players share one. */
export function armorSurface(map: THREE.Texture | null): ArmorSurface | null {
  if (!map || NO_ARMOR) return null
  const image = map.image as Source | undefined
  if (!image?.width) return null
  const hit = byImage.get(image)
  if (hit) return hit
  const key = fingerprint(image)
  const cached = byContent.get(key)
  if (cached) { byImage.set(image, cached); return cached }

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, SIZE, SIZE)
  const rgb = ctx.getImageData(0, 0, SIZE, SIZE).data
  const count = SIZE * SIZE, out = new Uint8Array(count * 4), lum = new Float32Array(count)
  // Low-frequency fields live on a grid a quarter the size: the plates' local mean brightness
  // (and how much plate each cell has, to normalise it) and the paint's broad blotching.
  const low = SIZE / LOW, cells = low * low
  const lightSum = new Float32Array(cells), plateSum = new Float32Array(cells)
  const paint = [0, 0, 0]
  let painted = 0
  for (let p = 0; p < count; p++) {
    const r = rgb[p * 4], g = rgb[p * 4 + 1], b = rgb[p * 4 + 2]
    // Gold visor: bright, warm, far more red than blue, green in between.
    if (r > 110 && r - b > 60) out[p * 4 + 1] = smooth(60, 110, r - b) * smooth(.3, .42, g / r) * (1 - smooth(.78, .9, g / r)) * smooth(110, 150, r) * 255 + .5
    // Olive paint (character.ts teamMap uses the same test to find what to recolour).
    if (g - b <= 6 || g <= r * .85) continue
    const m = smooth(0, 1, (g - b - 6) / 24) * smooth(0, 1, (g - r * .85) / 20)
    out[p * 4] = m * 255 + .5
    if (m < .05) continue
    const l = r * .3 + g * .59 + b * .11
    lum[p] = l
    const cell = ((p / SIZE / LOW) | 0) * low + (((p % SIZE) / LOW) | 0)
    lightSum[cell] += l * m; plateSum[cell] += m
    if (m > .9) { paint[0] += r; paint[1] += g; paint[2] += b; painted++ }
  }
  const scratch = new Float32Array(cells)
  boxBlur(lightSum, low, 3, scratch)
  boxBlur(plateSum, low, 3, scratch)
  const mean = lightSum.map((v, i) => plateSum[i] > 1e-3 ? v / plateSum[i] : 0)
  const blotch = new Float32Array(cells)
  addNoise(blotch, low, 16, .6, 1); addNoise(blotch, low, 4, .4, 2)
  // The chip pattern tiles every quarter of the atlas; its scattered islands hide the repeat.
  const chips = new Float32Array(TILE * TILE), tileMask = TILE - 1
  addNoise(chips, TILE, 4, .55, 3); addNoise(chips, TILE, 2, .25, 4); addNoise(chips, TILE, 16, .2, 5)
  const half = LOW / 2
  for (let y = 0; y < SIZE; y++) {
    // Bilinear lookups into the quarter grid, texel centres aligned.
    const fy = Math.min(low - 1, Math.max(0, (y - half + .5) / LOW)), j = Math.min(low - 2, fy | 0), v = fy - j
    for (let x = 0; x < SIZE; x++) {
      const p = y * SIZE + x
      let dull = .5, chip = chips[(y & tileMask) * TILE + (x & tileMask)]
      if (lum[p] > 0) {
        const fx = Math.min(low - 1, Math.max(0, (x - half + .5) / LOW)), i = Math.min(low - 2, fx | 0), u = fx - i, k = j * low + i
        const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v
        const around = mean[k] * w00 + mean[k + 1] * w10 + mean[k + low] * w01 + mean[k + low + 1] * w11
        const broad = blotch[k] * w00 + blotch[k + 1] * w10 + blotch[k + low] * w01 + blotch[k + low + 1] * w11
        // Each plate texel against the plate around it: darker patches are grime and read
        // duller, lighter ones are polished high points, and chip a little more.
        const detail = (lum[p] - around) / 40
        dull = .5 - detail * .6 + (broad - .5) * .55
        chip += Math.max(0, detail) * .25
      }
      out[p * 4 + 2] = Math.min(1, Math.max(0, dull)) * 255 + .5
      out[p * 4 + 3] = Math.min(1, Math.max(0, chip)) * 255 + .5
    }
  }
  const texture = new THREE.DataTexture(out, SIZE, SIZE, THREE.RGBAFormat)
  texture.colorSpace = THREE.NoColorSpace
  texture.flipY = map.flipY
  texture.wrapS = map.wrapS; texture.wrapT = map.wrapT
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4
  texture.needsUpdate = true
  const n = Math.max(painted, 1)
  const surface = { texture, paint: new THREE.Color().setRGB(paint[0] / n / 255, paint[1] / n / 255, paint[2] / n / 255, THREE.SRGBColorSpace) }
  byImage.set(image, surface)
  byContent.set(key, surface)
  return surface
}

/**
 * Per-vertex convexity, 0 on flat or hollow surface rising toward 1 on sharp outside edges, as
 * the `armorEdge` attribute. Vertices split along UV seams and hard edges are welded first, so
 * both sides of a seam agree. Once per geometry; `measure` false leaves it flat (no wear).
 */
export function addArmorEdges(geometry: THREE.BufferGeometry, measure = true): void {
  if (geometry.getAttribute('armorEdge')) return
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal')
  if (!position || !normal) return
  // Unmeasured still gets the attribute, all flat: a missing one reads whatever value the GL
  // context last left at that location.
  if (!measure) { geometry.setAttribute('armorEdge', new THREE.BufferAttribute(new Float32Array(position.count), 1)); return }
  const count = position.count
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!, q = box.getSize(new THREE.Vector3()).length() / 60000 || 1
  const weld = new Int32Array(count), ids = new Map<number, number>()
  const p = new Float32Array(count * 3), n = new Float32Array(count * 3)
  let welded = 0
  for (let i = 0; i < count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i)
    // Quantised to 1/60000 of the diagonal: three 16-bit cells fit one exact float key.
    const key = Math.round((x - box.min.x) / q) + Math.round((y - box.min.y) / q) * 65536 + Math.round((z - box.min.z) / q) * 4294967296
    let id = ids.get(key)
    if (id === undefined) { id = welded++; ids.set(key, id); p[id * 3] = x; p[id * 3 + 1] = y; p[id * 3 + 2] = z }
    weld[i] = id
    n[id * 3] += normal.getX(i); n[id * 3 + 1] += normal.getY(i); n[id * 3 + 2] += normal.getZ(i)
  }
  for (let id = 0; id < welded; id++) {
    const l = Math.hypot(n[id * 3], n[id * 3 + 1], n[id * 3 + 2]) || 1
    n[id * 3] /= l; n[id * 3 + 1] /= l; n[id * 3 + 2] /= l
  }
  const index = geometry.getIndex(), corners = index ? index.count : count
  const at = (k: number) => weld[index ? index.getX(k) : k]
  // Each edge seen from both ends: how far the other end drops below this end's tangent plane
  // (the sine of the angle), positive when the surface falls away, i.e. convex.
  const sum = new Float32Array(welded), seen = new Float32Array(welded)
  const edges = new Int32Array(corners * 2)
  let edgeCount = 0
  const edge = (a: number, b: number) => {
    const dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1], dz = p[b * 3 + 2] - p[a * 3 + 2], l = Math.hypot(dx, dy, dz)
    if (l < 1e-9) return
    sum[a] -= (n[a * 3] * dx + n[a * 3 + 1] * dy + n[a * 3 + 2] * dz) / l; seen[a]++
    sum[b] += (n[b * 3] * dx + n[b * 3 + 1] * dy + n[b * 3 + 2] * dz) / l; seen[b]++
    edges[edgeCount++] = a; edges[edgeCount++] = b
  }
  for (let k = 0; k + 2 < corners; k += 3) {
    const a = at(k), b = at(k + 1), c = at(k + 2)
    edge(a, b); edge(b, c); edge(c, a)
  }
  let convex = new Float32Array(welded)
  for (let id = 0; id < welded; id++) convex[id] = seen[id] ? sum[id] / seen[id] : 0
  // Relax twice over the neighbours: a generated mesh is lumpy at the scale of one triangle, and
  // the wear belongs on the plates' ridges, not on every bump.
  for (let pass = 0; pass < 2; pass++) {
    const next = convex.slice(), weight = new Float32Array(welded).fill(1)
    for (let e = 0; e < edgeCount; e += 2) {
      const a = edges[e], b = edges[e + 1]
      next[a] += convex[b]; weight[a]++
      next[b] += convex[a]; weight[b]++
    }
    for (let id = 0; id < welded; id++) next[id] /= weight[id]
    convex = next
  }
  const values = new Float32Array(count)
  // A right-angled edge measures about .35 before the relaxation spreads it; a plate's rim ends
  // up around .2 and above (the top few percent of vertices).
  for (let i = 0; i < count; i++) values[i] = Math.min(1, Math.max(0, convex[weld[i]] / .2))
  geometry.setAttribute('armorEdge', new THREE.BufferAttribute(values, 1))
}

/**
 * How much of the first-person arms' flat self-glow (their files carry the colour map as an
 * emissive map too) the undersuit and the painted plates keep. The rest of their brightness now
 * comes from real lighting: highlights and reflections are what make paint read as metal, and
 * a flat glow drowns them.
 */
export const ARMS_GLOW = [.15, .18] as const

/** The paint's metalness and the lift that pays back the diffuse light metal gives up. */
const PAINT = /* glsl */`
  #ifdef USE_ENVMAP
    const float paintMetal = .35, chipMetal = 1.;
  #else
    // Nothing to reflect: metal would render black. Keep the paint lit by its diffuse.
    const float paintMetal = .15, chipMetal = .55;
  #endif
  // Lift the paint by what the metal costs it, so a team colour in shade stays as readable as
  // it was on the old matte plates.
  const float lift = 1. / (1. - paintMetal * .7);
`

/** Paint, chips and undersuit, and how much of the first-person arms' flat glow each keeps. */
const ARMOR_FRAGMENT = /* glsl */`
{
  vec4 armor = texture2D(armorSurface, vMapUv);
  float plate = armor.r, visor = armor.g;
  // Paint wears off convex edges first, in chips: none on flat plate, a third of a sharp rim.
  float worn = plate * smoothstep(-.03, .03, armor.a - 1. + .4 * smoothstep(.4, 1., vArmorEdge));
${PAINT}
  vec3 steel = vec3(.32, .33, .34);
  // The undersuit a shade darker, so the plates stand off it.
  diffuseColor.rgb = mix(diffuseColor.rgb * mix(.7, lift, plate) * (1. + visor * .25), steel, worn);
  float paintRough = mix(.2, .5, armor.b);
  roughnessFactor = mix(mix(.68, paintRough, plate), .24, worn);
  roughnessFactor = mix(roughnessFactor, .12, visor);
  metalnessFactor = mix(mix(0., paintMetal, plate), chipMetal, worn);
  metalnessFactor = mix(metalnessFactor, .7, visor);
  totalEmissiveRadiance *= mix(armorGlow.x, armorGlow.y, max(plate, visor)) * (1. - worn);
}
`

/**
 * Add the armour surface to a Spartan material's shader. Call from inside the material's own
 * `onBeforeCompile` (it cannot own one: the arms and players already do, for their elbows and
 * shields). `glow` scales an emissive map, if there is one, on the undersuit and the plates.
 */
export function injectArmor(shader: Shader, surface: ArmorSurface, glow: readonly number[] = [1, 1]): void {
  shader.uniforms.armorSurface = { value: surface.texture }
  shader.uniforms.armorGlow = { value: new THREE.Vector2(glow[0], glow[1]) }
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float armorEdge;\nvarying float vArmorEdge;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvArmorEdge = armorEdge;')
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform sampler2D armorSurface;\nuniform vec2 armorGlow;\nvarying float vArmorEdge;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${ARMOR_FRAGMENT}`)
}

/**
 * A solid piece of armour worn with the textured arms (the back-of-hand plate): their average
 * paint colour and finish, glowing as much as the arms' painted plates do, so it reads as the
 * same plate rather than a separate part. `compile` chains another shader patch (the shields).
 */
export function paintedPlateMaterial(arms: THREE.MeshStandardMaterial, glow: number, compile?: (shader: Shader) => void): THREE.MeshStandardMaterial {
  const surface = armorSurface(arms.map)
  if (!surface) {
    const plain = new THREE.MeshStandardMaterial({ color: 0x9da2a6, metalness: .55, roughness: .42 })
    if (compile) plain.onBeforeCompile = shader => compile(shader)
    return plain
  }
  const physical = arms as THREE.MeshPhysicalMaterial
  const material = new THREE.MeshPhysicalMaterial({ color: surface.paint, roughness: .32, specularIntensity: physical.specularIntensity ?? 1, ior: physical.ior ?? 1.5 })
  if (physical.isMeshPhysicalMaterial) material.specularColor.copy(physical.specularColor)
  // The arms glow by their own colour map; the plate by the colour that map averages to.
  if (arms.emissiveMap) material.emissive.copy(surface.paint).multiply(arms.emissive).multiplyScalar(arms.emissiveIntensity * glow)
  material.onBeforeCompile = shader => {
    // Same paint as the arms' plates (see ARMOR_FRAGMENT), with nothing to reflect or not.
    shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
      {${PAINT}
        metalnessFactor = paintMetal;
        diffuseColor.rgb *= lift;
      }`)
    compile?.(shader)
  }
  material.customProgramCacheKey = () => `armor-plate:${compile ? 'chained' : 'plain'}`
  return material
}
