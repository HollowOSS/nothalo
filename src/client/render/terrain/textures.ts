/**
 * Every terrain texture is generated here at load time. Nothing is fetched: the canyon's
 * look is grass/sand/rock ratios and noise frequencies, which are cheaper to ship as code
 * than as megabytes of PNG, and they stay editable.
 */
import * as THREE from 'three'
import { clamp01, fbm, mix, sfbm, smoothstep, tileFbm } from '../../../shared/noise.ts'
import { FLOOR_HALF_X, FLOOR_HALF_Z, sandMask } from '../../../shared/field.ts'

type RGB = readonly [number, number, number]

// Sampled off `reference/frames/ridge-overlook.png` and divided back through the sun
// term, so these are albedos that land on the frame's numbers once lit, not eyeballed
// swatches: grass #4e5a25, sand core #f7ac62, ledge rock #ab5a2c.
const GRASS_DARK: RGB = [52, 70, 24]
const GRASS_LIGHT: RGB = [108, 126, 46]
const SAND_DARK: RGB = [169, 109, 63]
const SAND_LIGHT: RGB = [232, 167, 100]
const GRAVEL: RGB = [248, 182, 108]
const ROCK: RGB = [188, 100, 48]
const ROCK_DARK: RGB = [118, 58, 30]

function lerp3(a: RGB, b: RGB, t: number): [number, number, number] {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]
}

function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 8
  t.needsUpdate = true
  return t
}

export interface GroundSampler {
  height(x: number, z: number): number
  /** 0 flat, 1 vertical. */
  slope(x: number, z: number): number
}

/**
 * One big albedo map painted across the whole canyon floor in world space. It carries the
 * macro story — where the grass is, where the sand braids run, where the ground turns to
 * rock — and a tiled grain texture supplies the close-up detail the macro map is too
 * coarse to hold.
 */
export function makeGroundMap(s: GroundSampler): THREE.DataTexture {
  const W = 1024
  const H = 2048
  const data = new Uint8Array(W * H * 4)
  for (let j = 0; j < H; j++) {
    const z = -FLOOR_HALF_Z + ((j + 0.5) / H) * FLOOR_HALF_Z * 2
    for (let i = 0; i < W; i++) {
      const x = -FLOOR_HALF_X + ((i + 0.5) / W) * FLOOR_HALF_X * 2
      const sand = sandMask(x, z)
      const grain = fbm(x / 2.6 + 40, z / 2.6 - 17, 3)
      const mid = fbm(x / 7.5 - 22, z / 7.5 + 31, 3)
      const blotch = fbm(x / 21 - 5, z / 21 + 9, 2)

      // The grass is nearly one colour in the frames; only a light grain breaks it up.
      // Big soft blotches were what made ours read as airbrushed rather than turf.
      let c = lerp3(GRASS_DARK, GRASS_LIGHT, clamp01(0.24 + 0.72 * grain + 0.34 * (blotch - 0.5)))
      // Tracks are brightest along their spine, which is what makes them read as worn
      // ground rather than as a stencil laid over the grass.
      const sc = lerp3(SAND_DARK, SAND_LIGHT, clamp01(0.02 + 0.34 * grain + 0.42 * mid + 0.55 * sand))
      // Path edges fray: pushing the mask through noise keeps them from reading as contours.
      const sMix = clamp01((sand - 0.46) * 2.4 + 0.5 + 0.6 * (grain - 0.5))
      c = lerp3(c as RGB, sc as RGB, sMix)

      // High ground bakes off to gravel, steep ground is bare rock.
      const y = s.height(x, z)
      // Gravel on the high shelf: coarse, high-contrast speckle rather than flat tan.
      // The shelf is not clean sand: it is broken caprock, so the gravel carries dark
      // chips at the grain scale and pale scoured patches at the mid scale.
      const chip = fbm(x / 1.35 - 61, z / 1.35 + 12, 2)
      const gv = lerp3(
        [146, 88, 50],
        GRAVEL,
        clamp01(-0.05 + 0.62 * mid + 0.5 * (grain - 0.5) + 0.5 * (chip - 0.5) + 0.35 * (blotch - 0.5)),
      )
      c = lerp3(c as RGB, gv as RGB, smoothstep(13.5, 19, y) * 0.85)
      const rock = lerp3(ROCK_DARK, ROCK, clamp01(0.2 + 1.2 * grain))
      c = lerp3(c as RGB, rock as RGB, smoothstep(0.40, 0.66, s.slope(x, z)))

      const o = (j * W + i) * 4
      data[o] = c[0]
      data[o + 1] = c[1]
      data[o + 2] = c[2]
      data[o + 3] = 255
    }
  }
  const t = dataTexture(data, W, H, true)
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  return t
}

/** Fine multiplicative grain, tiled every few metres over the ground. Mean is ~1. */
export function makeGroundGrain(): THREE.DataTexture {
  const N = 256
  const data = new Uint8Array(N * N * 4)
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / N
      const v = j / N
      const n = tileFbm(u, v, 16, 4, 31)
      // A second, streaky octave reads as clumps of grass rather than TV static.
      const clump = tileFbm(u, v, 6, 2, 511, 3)
      // A third, near-pixel octave: without it the ground under the player's feet is a
      // smooth wash, because the macro map only carries a texel every 23 cm.
      const speck = tileFbm(u, v, 64, 2, 907)
      const g = clamp01(0.40 + 0.66 * n + 0.22 * (clump - 0.5) + 0.20 * (speck - 0.5))
      const b = Math.round(255 * g)
      const o = (j * N + i) * 4
      data[o] = b
      data[o + 1] = b
      data[o + 2] = b
      data[o + 3] = 255
    }
  }
  return dataTexture(data, N, N, false)
}

/** Normal map from the same grain field, so the fine light break-up matches the albedo. */
export function makeGroundNormal(): THREE.DataTexture {
  const N = 256
  const hgt = new Float32Array(N * N)
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      hgt[j * N + i] = tileFbm(i / N, j / N, 16, 4, 31)
    }
  }
  const data = new Uint8Array(N * N * 4)
  const strength = 2.4
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const l = hgt[j * N + ((i - 1 + N) % N)]
      const r = hgt[j * N + ((i + 1) % N)]
      const d = hgt[((j - 1 + N) % N) * N + i]
      const u = hgt[((j + 1) % N) * N + i]
      let nx = (l - r) * strength
      let ny = (d - u) * strength
      const nz = 1
      const inv = 1 / Math.hypot(nx, ny, nz)
      nx *= inv
      ny *= inv
      const o = (j * N + i) * 4
      data[o] = Math.round((nx * 0.5 + 0.5) * 255)
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      data[o + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255)
      data[o + 3] = 255
    }
  }
  return dataTexture(data, N, N, false)
}

/**
 * Cliff rock: horizontal strata crossed by vertical erosion streaks. The cliff mesh is UV
 * unwrapped in metres, so one tile of this is a fixed patch of wall and the streaks always
 * run vertically no matter which way the wall faces.
 */
export function makeRockTexture(): THREE.DataTexture {
  const N = 1024
  const data = new Uint8Array(N * N * 4)
  for (let j = 0; j < N; j++) {
    const v = j / N
    for (let i = 0; i < N; i++) {
      const u = i / N
      // Strata: bands running across the wall, warped so they are not dead straight.
      // Strata are a quiet undertone; the loud feature is broad vertical erosion.
      // Strata carry the wall: in the frames the rock is banded horizontally at roughly
      // 4 m and those bands read from across the canyon. Vertical streaks sit on top of
      // them, fine and dry, rather than being the whole story as they were before.
      const warp = tileFbm(u, v, 3, 3, 77, 2) - 0.5
      const band = (v * 9 + warp * 3.2) % 1
      const strata = 0.5 + 0.5 * Math.cos(band * Math.PI * 2)
      const coarse = (v * 3 + (tileFbm(u, v, 2, 2, 303, 2) - 0.5) * 2.4) % 1
      const beds = 0.5 + 0.5 * Math.cos(coarse * Math.PI * 2)
      const streak = tileFbm(u, v, 6, 5, 211, 5)
      // Hard, narrow erosion channels. The soft smears we had before read as blur; the
      // reference's wall is cut by dark near-black grooves with definite edges.
      const chan = 1 - smoothstep(0.0, 0.1, Math.abs(tileFbm(u, v, 2, 3, 131, 4) - 0.5))
      const chan2 = 1 - smoothstep(0.0, 0.05, Math.abs(tileFbm(u, v, 5, 3, 419, 5) - 0.5))
      const broad = tileFbm(u, v, 2, 2, 41, 2)
      const fine = tileFbm(u, v, 32, 3, 55)
      const val = clamp01(
        0.36 + 0.13 * strata + 0.17 * beds + 0.30 * (streak - 0.5) + 0.26 * (broad - 0.5) + 0.16 * (fine - 0.5) -
          0.15 * chan -
          0.08 * chan2,
      )
      const c = lerp3([88, 34, 15], [228, 138, 62], val)
      const o = (j * N + i) * 4
      data[o] = c[0]
      data[o + 1] = c[1]
      data[o + 2] = c[2]
      data[o + 3] = 255
    }
  }
  return dataTexture(data, N, N, true)
}

/** Mottled grey for the loose boulders. */
export function makeRockySurface(): THREE.DataTexture {
  const N = 256
  const data = new Uint8Array(N * N * 4)
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / N
      const v = j / N
      const n = tileFbm(u, v, 8, 4, 613)
      const crack = 1 - smoothstep(0.02, 0.11, Math.abs(tileFbm(u, v, 4, 3, 88) - 0.5))
      const g = clamp01(0.45 + 0.55 * n - 0.28 * crack)
      const o = (j * N + i) * 4
      data[o] = Math.round(255 * g * 1.0)
      data[o + 1] = Math.round(255 * g * 0.96)
      data[o + 2] = Math.round(255 * g * 0.88)
      data[o + 3] = 255
    }
  }
  return dataTexture(data, N, N, true)
}

/** Shared by the floor: multiply in tiled grain so the coarse macro map does not read flat. */
export function applyGrain(
  mat: THREE.MeshStandardMaterial,
  grain: THREE.Texture,
  metresPerTile: number,
  amount: number,
  key: string,
): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrain = { value: grain }
    shader.uniforms.uGrainScale = { value: 1 / metresPerTile }
    shader.uniforms.uGrainAmount = { value: amount }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainWorld;\nvarying float vTerrainSteep;')
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nvTerrainSteep = 1.0 - abs(normalize(objectNormal).y);',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vTerrainWorld;\nvarying float vTerrainSteep;\nuniform sampler2D uGrain;\nuniform float uGrainScale;\nuniform float uGrainAmount;',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        // Flat ground gets a top-down grain; anything steep enough to be bare rock gets the
        // same noise projected sideways and stretched, which reads as erosion striation.
        float steep = smoothstep(0.30, 0.62, vTerrainSteep);
        vec2 flatUv = vTerrainWorld.xz * uGrainScale;
        vec2 wallUv = vec2((vTerrainWorld.x + vTerrainWorld.z) * uGrainScale * 0.9,
                           vTerrainWorld.y * uGrainScale * 0.22);
        float g = mix(texture2D(uGrain, flatUv).r, texture2D(uGrain, wallUv).r, steep);
        diffuseColor.rgb *= 1.0 + (uGrainAmount + 0.5 * steep) * (g - 0.5);`,
      )
  }
  mat.customProgramCacheKey = () => key
}

/** Exported for the props scatter, which wants the same fine variation as the ground. */
export const groundTint = (x: number, z: number): number => 0.85 + 0.3 * sfbm(x / 30, z / 30, 2)
