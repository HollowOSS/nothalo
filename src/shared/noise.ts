/**
 * Deterministic value noise for the terrain piece.
 *
 * Everything about Blood Gulch's floor — the mounds, the braided sand, the rock grain —
 * comes out of these few functions, so the map is identical for every client without
 * shipping a single heightmap asset.
 */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Reversed edges are allowed and give a falling ramp; several callers rely on that. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

export const mix = (a: number, b: number, t: number): number => a + (b - a) * t

function hash2(ix: number, iy: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

/** Value noise in [0,1]. */
export function noise2(x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(x0, y0)
  const b = hash2(x0 + 1, y0)
  const c = hash2(x0, y0 + 1)
  const d = hash2(x0 + 1, y0 + 1)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

export function fbm(x: number, y: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  let fx = x
  let fy = y
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(fx, fy)
    norm += amp
    amp *= 0.5
    fx *= 2.03
    fy *= 2.01
  }
  return sum / norm
}

/** Signed fbm in [-1,1]. */
export const sfbm = (x: number, y: number, octaves: number): number => fbm(x, y, octaves) * 2 - 1

/**
 * Lattice-wrapping variants. Procedural textures have to tile seamlessly or the ground
 * shows a grid of repeats at grazing angles, which is exactly where the player looks.
 */
function wrap(i: number, period: number): number {
  const m = i % period
  return m < 0 ? m + period : m
}

export function tileNoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const xa = wrap(x0, period) + seed
  const xb = wrap(x0 + 1, period) + seed
  const ya = wrap(y0, period)
  const yb = wrap(y0 + 1, period)
  const a = hash2(xa, ya)
  const b = hash2(xb, ya)
  const c = hash2(xa, yb)
  const d = hash2(xb, yb)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** fbm over a texture of `period` cells; each octave keeps wrapping so the tile is seamless. */
export function tileFbm(
  u: number,
  v: number,
  period: number,
  octaves: number,
  seed = 0,
  stretch = 1,
): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  let p = period
  for (let i = 0; i < octaves; i++) {
    sum += amp * tileNoise(u * p * stretch, v * p, Math.max(1, Math.round(p)), seed + i * 977)
    norm += amp
    amp *= 0.5
    p *= 2
  }
  return sum / norm
}

/** Small deterministic PRNG for scatter placement. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 374761393) >>> 0
    s = (s << 13) | (s >>> 19)
    return (Math.imul(s, 2654435761) >>> 0) / 4294967295
  }
}
