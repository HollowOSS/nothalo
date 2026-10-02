/**
 * The canyon walls, and the skyline standing behind them.
 *
 * Blood Gulch's wall is not a wall: it is a chain of separate flat-topped mesas whose
 * tops sit at clearly different heights, joined by hard vertical corner facets, so the
 * skyline steps in rectangles instead of waving. Everything here is therefore built out
 * of one primitive — an extruded polygonal block with a battered face and a dead flat
 * lid — placed three deep so the canyon reads with distance rather than as a lid.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CLIFF_HEIGHT } from '../../../shared/map.ts'
import { mix, noise2, rng, sfbm, smoothstep } from '../../../shared/noise.ts'
import { groundHeight, rimRadius } from '../../../shared/field.ts'

interface P2 {
  x: number
  z: number
}

/**
 * Radial profile of a mesa face: height as a fraction of the block, and metres outward
 * from the footprint. Near-vertical with a flared foot and a single hard chamfer under
 * the lid — the reference's mesas break at the top edge, they do not round over.
 */
const FACE: readonly { t: number; d: number }[] = [
  { t: 0.0, d: -9.5 },
  { t: 0.1, d: -4.6 },
  { t: 0.24, d: -1.6 },
  { t: 0.5, d: 0.0 },
  { t: 0.74, d: 0.8 },
  { t: 0.9, d: 1.5 },
  { t: 0.962, d: 1.7 },
  { t: 1.0, d: 1.8 },
]

interface Block {
  poly: P2[]
  top: number
  bottom: number
  seed: number
  /** 0 = near rock in full colour, 1 = washed all the way to the far dust tone. */
  dust: number
  /** Metres of face relief. Near walls get gullies; far ones stay clean silhouettes. */
  relief: number
}

/** Outward unit normal per polygon vertex, from the two edges meeting there. */
function outwards(poly: P2[]): P2[] {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    area += a.x * b.z - b.x * a.z
  }
  const sign = area > 0 ? 1 : -1
  const edge: P2[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const l = Math.hypot(dx, dz) || 1
    edge.push({ x: (dz / l) * sign, z: (-dx / l) * sign })
  }
  const out: P2[] = []
  for (let i = 0; i < poly.length; i++) {
    const p = edge[(i - 1 + poly.length) % poly.length]
    const n = edge[i]
    const x = p.x + n.x
    const z = p.z + n.z
    const l = Math.hypot(x, z) || 1
    out.push({ x: x / l, z: z / l })
  }
  return out
}

const DUST: readonly [number, number, number] = [0.72, 0.63, 0.55]

/**
 * Face tint, multiplied onto the rock texture. Carries the vertical story — dark in the
 * talus, full colour up the face, a pale warm cap band under the rim — plus the slow
 * horizontal strata and the per-mesa hue jump that keeps two neighbours from matching.
 */
function tint(t: number, y: number, seed: number, dust: number): [number, number, number] {
  const foot = 0.66 + 0.34 * smoothstep(0.0, 0.34, t)
  const cap = smoothstep(0.68, 0.99, t)
  const strata = 1 + 0.06 * Math.sin(y * 0.21 + seed * 2.7) + 0.04 * Math.sin(y * 0.77 - seed)
  const hue = 0.88 + 0.3 * noise2(seed * 13.7, 4.1)
  const k = foot * strata * hue
  let r = k * mix(1.0, 1.1, cap)
  let g = k * mix(0.88, 1.06, cap)
  let b = k * mix(0.7, 0.9, cap)
  if (dust > 0) {
    const w = 1.15 * dust
    r = mix(r, DUST[0] * 1.3, w)
    g = mix(g, DUST[1] * 1.3, w)
    b = mix(b, DUST[2] * 1.3, w)
  }
  return [r, g, b]
}

const TILE = 22

/** One mesa: faceted vertical sides swept along the footprint, and a flat lid on top. */
function buildBlock(b: Block): THREE.BufferGeometry {
  // Emit every footprint clockwise in XZ so side and cap normals face outward.
  const area = b.poly.reduce((sum, a, i) => {
    const c = b.poly[(i + 1) % b.poly.length]
    return sum + a.x * c.z - c.x * a.z
  }, 0)
  if (area > 0) b = { ...b, poly: [...b.poly].reverse() }
  const n = outwards(b.poly)
  const rows = FACE.length
  const pos: number[] = []
  const uv: number[] = []
  const col: number[] = []
  const idx: number[] = []
  /** Top ring, in emit order, so the lid can be sewn from exactly the face's own verts. */
  const lid: number[] = []
  const H = b.top - b.bottom

  for (let e = 0; e < b.poly.length; e++) {
    const a = b.poly[e]
    const c = b.poly[(e + 1) % b.poly.length]
    const na = n[e]
    const nc = n[(e + 1) % b.poly.length]
    const len = Math.hypot(c.x - a.x, c.z - a.z)
    const cols = Math.max(1, Math.min(12, Math.round(len / 11)))
    // Each edge owns its vertices, so neighbouring facets meet at a hard corner instead
    // of averaging into a smooth curve — the whole point of building the wall as blocks.
    const base = pos.length / 3
    for (let i = 0; i <= cols; i++) {
      const f = i / cols
      const px = mix(a.x, c.x, f)
      const pz = mix(a.z, c.z, f)
      const nx = mix(na.x, nc.x, f)
      const nz = mix(na.z, nc.z, f)
      const nl = Math.hypot(nx, nz) || 1
      const ux = nx / nl
      const uz = nz / nl
      const arc = Math.hypot(px - b.poly[0].x, pz - b.poly[0].z) + e * 37
      for (let j = 0; j < rows; j++) {
        const t = FACE[j].t
        const y = b.bottom + t * H
        // Gullies bite the exposed face and die out at the talus and at the rim, so the
        // top edge stays a clean horizontal line.
        const bite = Math.sin(Math.PI * t) ** 0.7 * (1 - smoothstep(0.8, 0.96, t))
        // World-space relief gives duplicated edge endpoints identical positions.
        const ero =
          b.relief * bite * (1.0 * sfbm((px + pz * 0.73) / 21 + b.seed, y / 70, 2) + 0.34 * sfbm((pz - px * 0.61) / 7 - b.seed, y / 26, 2))
        const d = FACE[j].d + ero
        pos.push(px + ux * d, y, pz + uz * d)
        uv.push((arc + b.seed * 11) / TILE, y / TILE)
        const c3 = tint(t, y, b.seed, b.dust)
        col.push(c3[0], c3[1], c3[2])
      }
      lid.push(base + i * rows + (rows - 1))
    }
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows - 1; j++) {
        const p = base + i * rows + j
        const q = p + rows
        idx.push(p, q, p + 1, p + 1, q, q + 1)
      }
    }
  }

  // Lid: a fan from the footprint centre over the face's own top ring. Dead flat, which
  // is what makes the silhouette read as a mesa rather than a hill.
  let cx = 0
  let cz = 0
  for (const p of b.poly) {
    cx += p.x / b.poly.length
    cz += p.z / b.poly.length
  }
  const centre = pos.length / 3
  const ct = tint(1, b.top, b.seed, b.dust)
  pos.push(cx, b.top, cz)
  uv.push(cx / TILE, cz / TILE)
  col.push(ct[0] * 1.06, ct[1] * 1.06, ct[2] * 1.06)
  for (let i = 0; i < lid.length; i++) {
    const a = lid[i]
    const c = lid[(i + 1) % lid.length]
    idx.push(centre, a, c)
  }
  // The lid reuses face vertices whose normals belong to the wall; duplicating them for
  // the cap would double the vertex count for a surface the player mostly sees edge-on.

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

const RIM_N = 1536

interface Rim {
  x: Float32Array
  z: Float32Array
  arc: Float32Array
  total: number
}

function rimTable(): Rim {
  const x = new Float32Array(RIM_N + 1)
  const z = new Float32Array(RIM_N + 1)
  const arc = new Float32Array(RIM_N + 1)
  for (let i = 0; i <= RIM_N; i++) {
    const a = (i / RIM_N) * Math.PI * 2
    const r = rimRadius(a)
    x[i] = Math.cos(a) * r
    z[i] = Math.sin(a) * r
    if (i > 0) arc[i] = arc[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1])
  }
  return { x, z, arc, total: arc[RIM_N] }
}

function atArc(t: Rim, s: number): P2 {
  const w = ((s % t.total) + t.total) % t.total
  let lo = 0
  let hi = RIM_N
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (t.arc[m] <= w) lo = m
    else hi = m
  }
  const f = (w - t.arc[lo]) / Math.max(1e-6, t.arc[hi] - t.arc[lo])
  return { x: mix(t.x[lo], t.x[hi], f), z: mix(t.z[lo], t.z[hi], f) }
}

/**
 * The wall itself: the rim walked in 55-105 m frontages, each becoming one mesa whose top
 * jumps 15-25 m against its neighbours and whose foot steps in or out, so the two meet at
 * a vertical corner rather than blending.
 */
function wallBlocks(): Block[] {
  const rim = rimTable()
  const rand = rng(20030315)
  const spans: number[] = []
  let sum = 0
  while (sum < rim.total) {
    const s = 55 + rand() * 50
    spans.push(s)
    sum += s
  }
  const k = rim.total / sum
  const out: Block[] = []
  let s0 = 0
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i] * k
    const s1 = s0 + span
    // Alternate the height band so no two neighbours land close together; the reference's
    // skyline is a run of tall/short/tall slabs, never a gentle ramp.
    const swing = i % 2 === 0 ? 0.0 : 0.26
    const top = CLIFF_HEIGHT * (0.6 + swing + 0.2 * noise2(i * 5.31 + 2.2, 7.7))
    // Biased outward: a block that steps too far in reads as a ramp across the floor.
    const push = (noise2(i * 3.77 + 21.5, 8.5) - 0.32) * 15
    const facets = 3 + Math.floor(rand() * 3)
    const front: P2[] = []
    // Cover the inward face profile and erosion at both ends of adjacent blocks.
    const overlap = 18
    for (let f = 0; f <= facets; f++) {
      const s = mix(s0 - overlap, s1 + overlap, f / facets)
      const p = atArc(rim, s)
      const l = Math.hypot(p.x, p.z)
      const jit = push + (noise2(i * 9.1 + f * 2.3, 1.4) - 0.5) * 5
      front.push({ x: p.x * (1 + jit / l), z: p.z * (1 + jit / l) })
    }
    let bottom = Infinity
    for (const p of front) bottom = Math.min(bottom, groundHeight(p.x, p.z))
    // The plateau behind: without it the mesa is a fin and the sky shows through its lid.
    const back: P2[] = []
    for (let f = front.length - 1; f >= 0; f--) {
      const p = front[f]
      const l = Math.hypot(p.x, p.z)
      back.push({ x: p.x * (1 + 150 / l), z: p.z * (1 + 150 / l) })
    }
    out.push({
      poly: front.concat(back),
      top,
      bottom: bottom - 16,
      seed: i * 1.37 + 0.4,
      dust: 0,
      relief: 5.5,
    })
    s0 = s1
  }
  return out
}

/** A free-standing mesa: an n-gon footprint, so its sides are flat plates meeting hard. */
function standalone(cx: number, cz: number, r: number, sides: number, rand: () => number): P2[] {
  const spin = rand() * Math.PI * 2
  const poly: P2[] = []
  for (let i = 0; i < sides; i++) {
    const a = spin + (i / sides) * Math.PI * 2
    const rr = r * (0.62 + rand() * 0.62)
    poly.push({ x: cx + Math.cos(a) * rr, z: cz + Math.sin(a) * rr })
  }
  return poly
}

/**
 * Two ranks of mesas stepping back behind the wall. They carry the canyon's depth: each
 * rank is smaller in relief, paler, and washed further toward the dust tone, which is the
 * only cue that says "kilometres" once the near wall has topped out.
 */
function backdropBlocks(): Block[] {
  const rand = rng(90210)
  const out: Block[] = []
  // Block counts fall off with distance. The near rank does the visible silhouette work; the
  // far ranks are haze-flattened bands where neighbouring blocks overlap anyway, so halving
  // them costs nothing you can see and this mesh was a fifth of the scene's triangles.
  const ranks = [
    { n: 22, r0: 120, r1: 250, w: 55, h: 0.95, dust: 0.22, relief: 2.2 },
    { n: 12, r0: 300, r1: 560, w: 165, h: 1.45, dust: 0.4, relief: 0 },
    { n: 8, r0: 640, r1: 1050, w: 330, h: 2.2, dust: 0.56, relief: 0 },
  ]
  let seed = 40
  for (const k of ranks) {
    for (let i = 0; i < k.n; i++) {
      const a = ((i + rand() * 0.75) / k.n) * Math.PI * 2
      // Sit each rank outside the rim in its own direction, so the ends of the long canyon
      // get their backdrop pushed out as far as the sides do.
      const r = rimRadius(a) + k.r0 + rand() * (k.r1 - k.r0)
      const cx = Math.cos(a) * r
      const cz = Math.sin(a) * r
      const w = k.w * (0.7 + rand() * 0.8)
      const top = CLIFF_HEIGHT * k.h * (0.62 + rand() * 0.7)
      out.push({
        poly: standalone(cx, cz, w, 4 + Math.floor(rand() * 3), rand),
        top,
        bottom: -30 - rand() * 40,
        seed: (seed += 1.31),
        dust: k.dust,
        relief: k.relief,
      })
    }
  }
  return out
}

function mergeBlocks(blocks: Block[]): THREE.BufferGeometry {
  const g = mergeGeometries(blocks.map(buildBlock), false)
  g.computeVertexNormals()
  return g
}

/**
 * Rock is lit from one side only, so the shaded faces would go to near-black under a
 * physical ambient. A flat sky-bounce term lifts them to the dusty grey-brown the frames
 * show without touching the sunlit faces, which keeps the lit/shade spread at the ~2x the
 * reference has instead of collapsing it by brightening everything.
 */
function skyBounce(mat: THREE.MeshStandardMaterial, fill: THREE.Vector3, key: string): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFill = { value: fill }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uFill;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uFill;',
      )
  }
  mat.customProgramCacheKey = () => key
}

export function buildCliffRing(rock: THREE.Texture): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    map: rock,
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
  })
  skyBounce(mat, new THREE.Vector3(0.021, 0.026, 0.022), 'cliff-near')
  const mesh = new THREE.Mesh(mergeBlocks(wallBlocks()), mat)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.name = 'cliffs'
  return mesh
}

export function buildDistantMesas(rock: THREE.Texture): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    map: rock,
    color: 0xd8ac82,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    fog: true,
  })
  skyBounce(mat, new THREE.Vector3(0.062, 0.050, 0.034), 'cliff-far')
  const mesh = new THREE.Mesh(mergeBlocks(backdropBlocks()), mat)
  mesh.name = 'distant-mesas'
  return mesh
}
