import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { registerModel } from '../models.ts'

// The sniper used to live here as well, but that build was made against a broken reference
// render and has been superseded by models/sniper.ts. One id, one factory — registerModel now
// rejects a second, so import order can never silently pick a winner again.
import { TEAM_TINT } from '../../../shared/assets.ts'

/**
 * Owner: sniper-ghost piece. The S2 AM sniper rifle and the Covenant Ghost.
 *
 * Everything here is generated: geometry from primitives, lofts and hand-wound triangle
 * strips, textures painted onto a 2D canvas at load. Nothing is fetched.
 *
 * Read off `reference/renders/sniper.png` and `reference/renders/ghost.png`:
 *
 * SNIPER — the silhouette is almost entirely barrel. Muzzle brake, then two thirds of the
 * length as bare pencil barrel, then a compact receiver with a long scope sitting high over
 * it, then a rear housing that is visibly *lighter* than the front (slate blue-grey against
 * near-black) and a squared butt pad. A folded bipod is the only thing that gives the weapon
 * any width at all — 0.33 m across the feet, against a 0.08 m receiver.
 *
 * GHOST — a nose-down teardrop pod. Two prongs sweep forward and outboard off the flanks
 * with the plasma cannons hung on their tips, low and ahead of the pilot. Behind the seat two
 * big flat panels flare back, out and steeply *up*; those are what make it 3.6 m wide and
 * 2.2 m tall, and they carry the ringed Covenant glyph. No wheels, no straight lines on the
 * carapace, and the whole thing sits nose down.
 */

/* ------------------------------------------------------------------ textures */

/** Deterministic noise so two builds of the same model are byte-identical. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

function paint(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')!
  draw(ctx, size)
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  return t
}

/** Bead-blasted gun polymer: flat, very slightly speckled, with a few long machining lines. */
function gunSkin(): THREE.CanvasTexture {
  return paint(256, (c, s) => {
    c.fillStyle = '#2b2e32'
    c.fillRect(0, 0, s, s)
    const r = rng(0x51ce)
    for (let i = 0; i < 9000; i++) {
      const v = 0.5 + r() * 0.5
      c.fillStyle = `rgba(${v > 0.8 ? 255 : 0},${v > 0.8 ? 255 : 0},${v > 0.8 ? 255 : 0},0.06)`
      c.fillRect(r() * s, r() * s, 1, 1)
    }
    c.strokeStyle = 'rgba(255,255,255,0.05)'
    c.lineWidth = 1
    for (let i = 0; i < 40; i++) {
      const y = r() * s
      c.beginPath(); c.moveTo(0, y); c.lineTo(s, y + (r() - 0.5) * 6); c.stroke()
    }
    // A handful of worn edges, so the black does not read as plastic.
    c.strokeStyle = 'rgba(190,200,210,0.10)'
    for (let i = 0; i < 14; i++) {
      const x = r() * s, y = r() * s
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + r() * 40 - 20, y + r() * 10 - 5); c.stroke()
    }
  })
}

/** Cold gunmetal for barrel and scope tube: darker, tighter, faintly banded. */
function metalSkin(): THREE.CanvasTexture {
  return paint(256, (c, s) => {
    const g = c.createLinearGradient(0, 0, 0, s)
    g.addColorStop(0, '#3a3f45'); g.addColorStop(0.5, '#22262a'); g.addColorStop(1, '#33383e')
    c.fillStyle = g
    c.fillRect(0, 0, s, s)
    const r = rng(0x2f19)
    for (let i = 0; i < 6000; i++) {
      c.fillStyle = `rgba(255,255,255,${r() * 0.05})`
      c.fillRect(r() * s, r() * s, 1, 1)
    }
    for (let i = 0; i < 70; i++) {
      const x = r() * s
      c.strokeStyle = `rgba(0,0,0,${0.05 + r() * 0.08})`
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, s); c.stroke()
    }
  })
}

/** Covenant carapace: mottled aubergine with magenta bloom and dark lacquer striations. */
function carapaceSkin(): THREE.CanvasTexture {
  return paint(256, (c, s) => {
    c.fillStyle = '#4a3757'
    c.fillRect(0, 0, s, s)
    const r = rng(0x9a17)
    for (let i = 0; i < 220; i++) {
      const x = r() * s, y = r() * s, rad = 8 + r() * 46
      const g = c.createRadialGradient(x, y, 0, x, y, rad)
      const warm = r() > 0.45
      g.addColorStop(0, warm ? 'rgba(140,74,120,0.30)' : 'rgba(36,24,48,0.34)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      c.fillStyle = g
      c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill()
    }
    // Lacquer flow lines — the CE Covenant plates always read as painted, not machined.
    for (let i = 0; i < 60; i++) {
      const y = r() * s
      c.strokeStyle = `rgba(20,12,30,${0.05 + r() * 0.12})`
      c.lineWidth = 0.5 + r() * 2.5
      c.beginPath()
      c.moveTo(0, y)
      c.bezierCurveTo(s * 0.3, y + (r() - 0.5) * 30, s * 0.7, y + (r() - 0.5) * 30, s, y + (r() - 0.5) * 14)
      c.stroke()
    }
    for (let i = 0; i < 26; i++) {
      const y = r() * s
      c.strokeStyle = `rgba(214,180,226,${0.05 + r() * 0.09})`
      c.lineWidth = 0.5 + r()
      c.beginPath(); c.moveTo(0, y); c.lineTo(s, y + (r() - 0.5) * 10); c.stroke()
    }
  })
}

/** The dark alloy the Covenant hangs its guns and undercarriage off. */
function alloySkin(): THREE.CanvasTexture {
  return paint(256, (c, s) => {
    c.fillStyle = '#24202c'
    c.fillRect(0, 0, s, s)
    const r = rng(0x77b3)
    for (let i = 0; i < 7000; i++) {
      c.fillStyle = `rgba(${r() > 0.5 ? 200 : 0},${r() > 0.5 ? 200 : 210},255,${r() * 0.06})`
      c.fillRect(r() * s, r() * s, 1, 1)
    }
    for (let i = 0; i < 34; i++) {
      const y = r() * s
      c.fillStyle = `rgba(10,8,14,${0.2 + r() * 0.3})`
      c.fillRect(0, y, s, 1 + r() * 3)
    }
  })
}

/* ------------------------------------------------------------------ geometry helpers */

type Bag = Map<string, THREE.BufferGeometry[]>

function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g
  for (const k of Object.keys(out.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv') out.deleteAttribute(k)
  }
  return out
}

function add(bag: Bag, key: string, g: THREE.BufferGeometry): void {
  let a = bag.get(key)
  if (!a) { a = []; bag.set(key, a) }
  a.push(flat(g))
}

/** Box placed by centre, with optional Euler rotation applied before the translate. */
function box(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  if (rx) g.rotateX(rx)
  if (ry) g.rotateY(ry)
  if (rz) g.rotateZ(rz)
  g.translate(x, y, z)
  return g
}

/** Cylinder lying along +Z (the axis everything in this file points down). */
function tube(
  rTop: number, rBot: number, len: number,
  x: number, y: number, z: number,
  seg = 12,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1)
  g.rotateX(Math.PI / 2)
  g.translate(x, y, z)
  return g
}

/** Cylinder spanning two arbitrary points — bipod legs, handlebars, prong spars. */
function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 8): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a)
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg, 1)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize())
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q))
  g.translate(a.x + d.x / 2, a.y + d.y / 2, a.z + d.z / 2)
  return g
}

/** Mirror across X, flipping triangle winding so the copy is not inside-out. */
function mirrorX(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = flat(src.clone())
  const attrs = ['position', 'normal', 'uv'].map((k) => g.attributes[k] as THREE.BufferAttribute | undefined)
  const pos = attrs[0]!
  const nor = attrs[1]
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, -pos.getX(i))
    if (nor) nor.setX(i, -nor.getX(i))
  }
  for (const a of attrs) {
    if (!a) continue
    const arr = a.array as Float32Array
    for (let t = 0; t < a.count; t += 3) {
      for (let k = 0; k < a.itemSize; k++) {
        const i1 = (t + 1) * a.itemSize + k
        const i2 = (t + 2) * a.itemSize + k
        const tmp = arr[i1]; arr[i1] = arr[i2]; arr[i2] = tmp
      }
    }
    a.needsUpdate = true
  }
  return g
}

function raw(positions: number[], uvs: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.computeVertexNormals()
  return g
}

function assemble(bag: Bag, mats: Record<string, THREE.Material>): THREE.Group {
  const group = new THREE.Group()
  for (const [key, list] of bag) {
    const merged = mergeGeometries(list, false)
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, mats[key])
    mesh.name = key
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }
  return group
}

/* ------------------------------------------------------------------ shared materials */

/**
 * Team-tinted surfaces are their own material so a red Ghost and a blue Ghost differ by one
 * colour and nothing else. Named 'team' so anything walking the tree can find and retint it.
 */
function teamMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: TEAM_TINT.red,
    emissive: TEAM_TINT.red,
    emissiveIntensity: 0.45,
    roughness: 0.5,
    metalness: 0.2,
  })
  m.name = 'team'
  return m
}

/* ------------------------------------------------------------------ sniper */

const S_LEN = 1.93
const S_FRONT = S_LEN / 2      // +0.965
const S_BACK = -S_LEN / 2      // -0.965
const BORE = 0.150             // barrel centreline height above the grip's heel

/* ------------------------------------------------------------------ ghost */

interface Station { z: number; cy: number; hw: number; hu: number; hd: number }

/**
 * Lofted hull. Stations run nose-first (z descending) so a quad wound (si, si+1, i, i+1)
 * comes out facing outward without a normal flip.
 *
 * `i0`..`i1` select an arc of the ring, so the same station list yields a purple upper shell
 * and a dark lower shell that share their seam vertices exactly.
 */
function loft(st: Station[], seg: number, i0: number, i1: number, capNose: boolean, capTail: boolean): THREE.BufferGeometry {
  const pos: number[] = []
  const uvs: number[] = []
  const P = (si: number, i: number): [number, number, number] => {
    const s = st[si]
    const th = (i / seg) * Math.PI * 2
    const c = Math.cos(th), sn = Math.sin(th)
    const x = s.hw * Math.sign(c) * Math.pow(Math.abs(c), 0.78)
    const y = s.cy + (sn >= 0 ? s.hu * Math.pow(sn, 0.90) : -s.hd * Math.pow(-sn, 0.68))
    return [x, y, s.z]
  }
  const push = (p: [number, number, number], u: number, v: number) => {
    pos.push(p[0], p[1], p[2]); uvs.push(u, v)
  }
  const n = st.length
  for (let si = 0; si < n - 1; si++) {
    for (let i = i0; i < i1; i++) {
      const a = P(si, i), b = P(si + 1, i), c = P(si + 1, i + 1), d = P(si, i + 1)
      const u0 = i / seg, u1 = (i + 1) / seg, v0 = si / (n - 1), v1 = (si + 1) / (n - 1)
      push(a, u0, v0); push(b, u0, v1); push(c, u1, v1)
      push(a, u0, v0); push(c, u1, v1); push(d, u1, v0)
    }
  }
  if (capNose) {
    const ctr: [number, number, number] = [0, st[0].cy, st[0].z]
    for (let i = i0; i < i1; i++) {
      push(ctr, 0.5, 0.5); push(P(0, i), 0, 0); push(P(0, i + 1), 1, 0)
    }
  }
  if (capTail) {
    const ctr: [number, number, number] = [0, st[n - 1].cy, st[n - 1].z]
    for (let i = i0; i < i1; i++) {
      push(ctr, 0.5, 0.5); push(P(n - 1, i + 1), 1, 1); push(P(n - 1, i), 0, 1)
    }
  }
  return raw(pos, uvs)
}

const G_LEN = 4.27
const G_NOSE = 1.55          // hull tip; the cannon barrels reach out past it
const G_TIP = G_LEN / 2      // 2.135 — cannon muzzles forward, wing trailing edge aft

/** Where the wing plane goes: root on the flank, tip out and steeply up. */
const WING_ROOT = new THREE.Vector3(0.42, 0.36, 0)
const WING_SPAN = new THREE.Vector3(1.40, 1.74, -0.10)

/**
 * Wing outline in (u, v): u runs aft along the hull, v runs out along WING_SPAN.
 * Wound counter-clockwise, which puts the front face on the outboard side of the panel.
 */
const WING_OUTLINE: readonly (readonly [number, number])[] = [
  [0.20, 0.00], [1.55, 0.00], [1.78, 0.58], [1.96, 1.22],
  [2.135, 2.174], [1.02, 2.174], [0.60, 1.42], [0.40, 0.58],
]

function wingPanel(thickness: number): THREE.BufferGeometry {
  const span = WING_SPAN.clone()
  const spanLen = span.length()
  const sDir = span.clone().normalize()
  const uDir = new THREE.Vector3(0, 0, -1)
  const nDir = new THREE.Vector3().crossVectors(uDir, sDir).normalize()
  const t = thickness / 2
  const at = (p: readonly [number, number], sign: number): [number, number, number] => {
    const v = Math.min(p[1], spanLen)
    const q = WING_ROOT.clone()
      .addScaledVector(uDir, p[0])
      .addScaledVector(sDir, v)
      .addScaledVector(nDir, sign * t)
    return [q.x, q.y, q.z]
  }
  const pos: number[] = []
  const uvs: number[] = []
  const uv = (p: readonly [number, number]): [number, number] => [p[0] / 2.2, p[1] / 2.2]
  const push = (p: [number, number, number], c: [number, number]) => {
    pos.push(p[0], p[1], p[2]); uvs.push(c[0], c[1])
  }
  const N = WING_OUTLINE.length
  for (let i = 1; i < N - 1; i++) {
    const a = WING_OUTLINE[0], b = WING_OUTLINE[i], c = WING_OUTLINE[i + 1]
    // Outboard face (+n): keep the CCW order. Inboard face: reverse it.
    push(at(a, 1), uv(a)); push(at(b, 1), uv(b)); push(at(c, 1), uv(c))
    push(at(a, -1), uv(a)); push(at(c, -1), uv(c)); push(at(b, -1), uv(b))
  }
  for (let i = 0; i < N; i++) {
    const a = WING_OUTLINE[i], b = WING_OUTLINE[(i + 1) % N]
    push(at(a, 1), uv(a)); push(at(a, -1), uv(a)); push(at(b, -1), uv(b))
    push(at(a, 1), uv(a)); push(at(b, -1), uv(b)); push(at(b, 1), uv(b))
  }
  return raw(pos, uvs)
}

/** Place a flat disc on the outboard face of the wing, at outline coords (u, v). */
function wingDisc(rIn: number, rOut: number, u: number, v: number, lift: number): THREE.BufferGeometry {
  const sDir = WING_SPAN.clone().normalize()
  const uDir = new THREE.Vector3(0, 0, -1)
  const nDir = new THREE.Vector3().crossVectors(uDir, sDir).normalize()
  const g = new THREE.RingGeometry(rIn, rOut, 20, 1)
  const m = new THREE.Matrix4().makeBasis(uDir, sDir, nDir)
  g.applyMatrix4(m)
  const p = WING_ROOT.clone().addScaledVector(uDir, u).addScaledVector(sDir, v).addScaledVector(nDir, lift)
  g.translate(p.x, p.y, p.z)
  return g
}

function buildGhost(): THREE.Object3D {
  const bag: Bag = new Map()

  /* --- hull. Nose low and pinched, belly swelling under the pilot, tail lifted. --- */
  const st: Station[] = [
    { z: G_NOSE, cy: 0.30, hw: 0.07, hu: 0.05, hd: 0.05 },
    { z: 1.20, cy: 0.31, hw: 0.30, hu: 0.15, hd: 0.15 },
    { z: 0.68, cy: 0.36, hw: 0.47, hu: 0.27, hd: 0.26 },
    { z: 0.12, cy: 0.44, hw: 0.56, hu: 0.35, hd: 0.35 },
    { z: -0.44, cy: 0.52, hw: 0.57, hu: 0.40, hd: 0.38 },
    { z: -0.96, cy: 0.58, hw: 0.51, hu: 0.39, hd: 0.35 },
    { z: -1.46, cy: 0.62, hw: 0.38, hu: 0.31, hd: 0.27 },
    { z: -1.86, cy: 0.65, hw: 0.14, hu: 0.13, hd: 0.11 },
  ]
  const SEG = 14
  add(bag, 'skin', loft(st, SEG, 0, SEG / 2, true, true))
  add(bag, 'dark', loft(st, SEG, SEG / 2, SEG, true, true))

  /* --- dorsal spine ridge, the raised centre line down the carapace. --- */
  add(bag, 'skin', box(0.14, 0.10, 1.30, 0, 0.87, -0.05, -0.10))
  add(bag, 'dark', box(0.05, 0.05, 1.10, 0, 0.93, -0.10, -0.10))

  /* --- keel blade under the nose. Nothing else on the vehicle is this sharp. --- */
  add(bag, 'dark', box(0.16, 0.22, 1.10, 0, 0.18, 0.72, -0.16))
  add(bag, 'dark', box(0.10, 0.13, 0.55, 0, 0.10, 1.18, -0.20))

  /* --- cockpit: recessed seat pan, backrest, and the two handlebar arms. --- */
  add(bag, 'dark', box(0.52, 0.07, 0.62, 0, 0.83, -0.70))
  add(bag, 'skin', box(0.56, 0.40, 0.10, 0, 0.98, -1.06, -0.18))
  add(bag, 'dark', box(0.40, 0.06, 0.34, 0, 0.94, -0.28, -0.30))

  /* --- everything below is built on the right and mirrored, so the two halves cannot drift. --- */
  const right: [string, THREE.BufferGeometry][] = []
  const R = (k: string, g: THREE.BufferGeometry) => right.push([k, g])

  // Handlebar: up out of the console and forward to a grip.
  R('dark', strut(new THREE.Vector3(0.16, 0.94, -0.34), new THREE.Vector3(0.34, 1.00, -0.02), 0.035, 6))
  R('dark', strut(new THREE.Vector3(0.34, 1.00, -0.02), new THREE.Vector3(0.40, 0.94, 0.26), 0.045, 6))

  /* --- forward prong. Sweeps out and down off the flank; the cannon hangs on its tip. --- */
  const root = new THREE.Vector3(0.44, 0.50, 0.35)
  const elbow = new THREE.Vector3(0.72, 0.42, 1.05)
  const muzzle = new THREE.Vector3(0.84, 0.36, 1.62)
  R('skin', strut(root, elbow, 0.155, 8))
  R('skin', strut(elbow, muzzle, 0.135, 8))
  R('dark', strut(root.clone().setY(root.y - 0.10), elbow.clone().setY(elbow.y - 0.09), 0.09, 6))
  // Faired shoulder where the prong leaves the hull.
  R('skin', box(0.30, 0.34, 0.44, 0.46, 0.50, 0.32, 0, 0.22, -0.16))

  /* --- plasma cannon pod. Boxy, canted outboard, twin barrels reaching to the model's nose. --- */
  const pod = new THREE.Group()
  R('dark', box(0.30, 0.26, 0.52, 0.86, 0.34, 1.66, 0, -0.10, 0.06))
  R('dark', box(0.34, 0.12, 0.40, 0.86, 0.46, 1.60, 0, -0.10, 0.06))
  R('skin', box(0.24, 0.16, 0.30, 0.84, 0.50, 1.44, 0, -0.10, 0.06))
  for (const dy of [0.08, -0.06]) {
    const bx = 0.885
    R('dark', tube(0.048, 0.055, 0.50, bx, 0.34 + dy, 1.90, 8))
    R('glow', tube(0.040, 0.040, 0.035, bx, 0.34 + dy, G_TIP - 0.020, 8))
  }
  void pod

  /* --- rear wing panel plus its dark leading rim and the ringed team glyph. --- */
  R('skin', wingPanel(0.085))
  R('dark', wingDisc(0.0, 0.30, 1.42, 1.32, 0.052))
  R('team', wingDisc(0.20, 0.30, 1.42, 1.32, 0.060))
  R('team', wingDisc(0.0, 0.06, 1.42, 1.32, 0.060))

  /* --- engine housing and vent at the wing root. --- */
  R('dark', box(0.26, 0.30, 0.46, 0.40, 0.62, -1.42, 0, -0.10, 0.10))
  R('glow', tube(0.10, 0.10, 0.04, 0.40, 0.62, -1.64, 10))

  /* --- lift vents along the underside; the blue wash under a hovering Ghost. --- */
  for (const z of [0.55, 0.00, -0.60]) {
    R('glow', box(0.22, 0.02, 0.30, 0.30, 0.075, z))
  }

  for (const [k, g] of right) {
    add(bag, k, g)
    add(bag, k, mirrorX(g))
  }

  const carapace = carapaceSkin()
  const alloy = alloySkin()
  const mats: Record<string, THREE.Material> = {
    skin: new THREE.MeshStandardMaterial({ map: carapace, color: 0xb9a4cf, roughness: 0.42, metalness: 0.22 }),
    dark: new THREE.MeshStandardMaterial({ map: alloy, color: 0x8f8aa2, roughness: 0.55, metalness: 0.62 }),
    glow: new THREE.MeshStandardMaterial({
      color: 0x0d2233, emissive: 0x69d2ff, emissiveIntensity: 1.7, roughness: 0.3, metalness: 0,
    }),
    team: teamMaterial(),
  }

  const g = assemble(bag, mats)
  g.name = 'ghost'

  // Sit the lowest point on the deck: the viewer, and the game, both put y=0 on the ground.
  const bb = new THREE.Box3().setFromObject(g)
  g.position.y = -bb.min.y
  const out = new THREE.Group()
  out.name = 'ghost'
  out.add(g)
  for(const side of [-1,1]){const tip=new THREE.Object3D();tip.name=side<0?'muzzle:left':'muzzle:right';tip.position.set(side*.885,.42,2.15);g.add(tip)}
  return out
}

registerModel('ghost', buildGhost)
