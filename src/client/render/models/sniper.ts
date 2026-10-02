import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { registerModel } from '../models.ts'
import { SPECS, TEAM_TINT, type Team } from '../../../shared/assets.ts'

/**
 * The S2 AM sniper rifle, rebuilt to the corrected spec.
 *
 * WHY THIS FILE EXISTS. The sniper was first authored in `sniper-ghost.ts` against
 * `reference/renders/sniper.png`, and that render is broken — open it and you see a handful of
 * rig marker spheres and no weapon at all. Everything measured off it was wrong: the bipod came
 * out deployed (0.36 m across against a 0.095 m spec), the scope came out as a low flat block
 * rather than the enormous cylinder the weapon is known for, and the whole thing was 21% short
 * on height. Rather than reach into a file another piece owns, this module re-registers `sniper`
 * and `registry.ts` imports it last, so this factory wins.
 *
 * WHAT IT HAS TO READ AS, from SPECS: long and slab-sided, nearly all barrel, a very large
 * cylindrical scope on tall mounts over the receiver, a squared muzzle brake at the end, dark
 * grey-green. 5.75 : 1 and close to two metres — an anti-materiel rifle in 14.5x114mm, so it
 * should look like a rifle a Spartan needs both hands and a bipod for.
 *
 * The scope is the read. It is the widest AND the tallest thing on the weapon, it is a cylinder
 * not a box, and it stands clear of the receiver on two visibly tall mounts with daylight under
 * it between them. Get that and the silhouette is unmistakable at any range; miss it and this is
 * a black stick.
 *
 * Everything is generated: primitives, extruded side profiles, and one canvas-painted texture.
 */

/* ------------------------------------------------------------------ surface */

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

/** Dark grey-green parkerised finish: flat, faintly speckled, with a few long machining lines. */
function skin(base: string, sheen: string, seed: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 256
  const x = cv.getContext('2d')!
  const r = rng(seed)
  x.fillStyle = base
  x.fillRect(0, 0, 256, 256)
  const img = x.getImageData(0, 0, 256, 256)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 18
    d[i] += n; d[i + 1] += n; d[i + 2] += n
  }
  x.putImageData(img, 0, 0)
  x.strokeStyle = sheen
  x.lineWidth = 1
  for (let i = 0; i < 26; i++) {
    const y = r() * 256
    x.globalAlpha = 0.04 + r() * 0.1
    x.beginPath()
    x.moveTo(r() * 256, y)
    x.lineTo(r() * 200 + 56, y + (r() - 0.5) * 3)
    x.stroke()
  }
  x.globalAlpha = 1
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.repeat.set(10, 10)
  t.anisotropy = 4
  return t
}

interface Kit {
  /** Receiver, stock, furniture: dark grey-green. The bulk of the weapon. */
  hull: THREE.MeshStandardMaterial
  /** Raised edges and rails, a shade lighter, so a two-metre slab is not one flat tone. */
  edge: THREE.MeshStandardMaterial
  /** The scope body and muzzle brake: near-black, distinctly darker than the hull. */
  black: THREE.MeshStandardMaterial
  /** Barrel and pins. */
  steel: THREE.MeshStandardMaterial
  /** Scope glass. */
  lens: THREE.MeshStandardMaterial
  /** Team paint. Separate material by contract. */
  tint: THREE.MeshStandardMaterial
}

let kit: Kit | null = null

function materials(): Kit {
  if (kit) return kit
  kit = {
    hull: new THREE.MeshStandardMaterial({ map: skin('#3c443d', '#98a396', 0x31af), roughness: 0.74, metalness: 0.32 }),
    edge: new THREE.MeshStandardMaterial({ map: skin('#4d574d', '#a9b4a6', 0x7b02), roughness: 0.62, metalness: 0.38 }),
    black: new THREE.MeshStandardMaterial({ map: skin('#23262a', '#8b9196', 0x1d4c), roughness: 0.66, metalness: 0.42 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x7f858a, roughness: 0.35, metalness: 0.9 }),
    lens: new THREE.MeshStandardMaterial({
      color: 0x0a1410, emissive: 0x63c8a8, emissiveIntensity: 0.7, roughness: 0.15, metalness: 0,
    }),
    tint: new THREE.MeshStandardMaterial({ color: TEAM_TINT.blue, roughness: 0.6, metalness: 0.3 }),
  }
  kit.tint.name = 'team-tint'
  return kit
}

/* ------------------------------------------------------------------ helpers */

type MatKey = keyof Kit
type Pt = readonly [number, number]
type Parts = Map<MatKey, THREE.BufferGeometry[]>

function add(parts: Parts, key: MatKey, geo: THREE.BufferGeometry): void {
  const list = parts.get(key)
  if (list) list.push(geo.toNonIndexed())
  else parts.set(key, [geo.toNonIndexed()])
  geo.dispose()
}

/** A solid authored as its side view in (z forward, y up), extruded across the width. */
function profile(pts: readonly Pt[], width: number, holes: readonly (readonly Pt[])[] = []): THREE.BufferGeometry {
  const trace = (p: readonly Pt[], path: THREE.Shape | THREE.Path) => {
    path.moveTo(p[0][0], p[0][1])
    for (let i = 1; i < p.length; i++) path.lineTo(p[i][0], p[i][1])
    path.closePath()
  }
  const shape = new THREE.Shape()
  trace(pts, shape)
  for (const h of holes) {
    const path = new THREE.Path()
    trace(h, path)
    shape.holes.push(path)
  }
  const b = Math.min(0.003, width * 0.3)
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - 2 * b, bevelEnabled: true, bevelSize: b, bevelOffset: 0,
    bevelThickness: b, bevelSegments: 1, curveSegments: 2,
  })
  g.rotateY(-Math.PI / 2)
  g.translate(width / 2 - b, 0, 0)
  return g
}

function block(z0: number, z1: number, y0: number, y1: number, width: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(width, y1 - y0, z1 - z0)
  g.translate(0, (y0 + y1) / 2, (z0 + z1) / 2)
  return g
}

function tube(z0: number, z1: number, r0: number, r1: number, y = 0, seg = 12): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, z1 - z0, seg, 1, false)
  g.rotateX(Math.PI / 2)
  g.translate(0, y, (z0 + z1) / 2)
  return g
}

function pair(parts: Parts, key: MatKey, geo: THREE.BufferGeometry, x: number): void {
  const a = geo.clone(); a.translate(x, 0, 0); add(parts, key, a)
  const b = geo.clone(); b.translate(-x, 0, 0); add(parts, key, b)
  geo.dispose()
}

export function setSniperTeam(root: THREE.Object3D, team: Team): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    const mat = m.material as THREE.MeshStandardMaterial | undefined
    if (m.isMesh && mat?.name === 'team-tint') {
      const own = mat.clone()
      own.color.setHex(TEAM_TINT[team])
      m.material = own
    }
  })
}

/* ------------------------------------------------------------------ the rifle */

const SIZE = SPECS['sniper'].size
const LEN = SIZE[0]
const W = SIZE[1]
const H = SIZE[2]

/**
 * Datum: y = 0 is the bore, z = 0 the middle of the receiver, +z toward the muzzle. Everything
 * below is a fraction of the spec length, width and height, so this model tracks the spec rather
 * than drifting off it the way the last one did.
 */
function sniper(): THREE.Object3D {
  const parts: Parts = new Map()

  const MUZZLE = LEN * 0.548     // +1.04 m at spec length
  const BUTT = -LEN * 0.452      // -0.86 m
  const SCOPE_R = W * 0.485      // the scope is the widest thing on the weapon
  const SCOPE_Y = H * 0.339      // ... and, with its mounts, the tallest
  const FLOOR = SCOPE_Y + SCOPE_R - H  // the bottom of the pistol grip closes the height out

  // Receiver: a long flat-sided slab. Nearly all of this weapon is barrel, so the receiver has
  // to stay shallow or the proportion goes wrong immediately.
  add(parts, 'hull', profile([
    [-LEN * 0.16, 0.055], [LEN * 0.105, 0.055], [LEN * 0.115, 0.030],
    [LEN * 0.115, -0.048], [-LEN * 0.16, -0.058],
  ], W * 0.74))
  // Fore-end under the barrel, with three cooling slots cut down its flank.
  add(parts, 'hull', profile([
    [LEN * 0.06, 0.048], [LEN * 0.225, 0.040], [LEN * 0.225, -0.026], [LEN * 0.06, -0.050],
  ], W * 0.66))
  for (let i = 0; i < 3; i++) {
    const z = LEN * (0.085 + i * 0.045)
    pair(parts, 'black', block(z, z + LEN * 0.028, -0.014, 0.020, 0.004), W * 0.33)
  }

  // Barrel: a long pencil with a heavier chamber sleeve at the back, and the squared muzzle
  // brake at the end. The brake is a box, not a cone — that squared-off tip is part of the read.
  add(parts, 'steel', tube(LEN * 0.10, MUZZLE - LEN * 0.055, 0.019, 0.0155, 0, 12))
  add(parts, 'hull', tube(LEN * 0.10, LEN * 0.30, 0.027, 0.025, 0, 12))
  add(parts, 'black', profile([
    [MUZZLE - LEN * 0.070, 0.038], [MUZZLE, 0.038], [MUZZLE, -0.038], [MUZZLE - LEN * 0.070, -0.038],
  ], W * 0.70))
  for (let i = 0; i < 2; i++) {
    const z = MUZZLE - LEN * (0.056 - i * 0.026)
    pair(parts, 'steel', block(z, z + LEN * 0.012, -0.020, 0.020, 0.005), W * 0.35)
  }

  // THE SCOPE. A very large cylinder standing clear of the receiver on two tall mounts, with a
  // wider objective bell at the front. This is the whole silhouette.
  add(parts, 'black', tube(-LEN * 0.115, LEN * 0.100, SCOPE_R * 0.86, SCOPE_R * 0.86, SCOPE_Y, 14))
  add(parts, 'black', tube(LEN * 0.100, LEN * 0.170, SCOPE_R * 0.86, SCOPE_R, SCOPE_Y, 14))
  add(parts, 'black', tube(-LEN * 0.150, -LEN * 0.115, SCOPE_R * 0.70, SCOPE_R * 0.86, SCOPE_Y, 14))
  add(parts, 'lens', tube(LEN * 0.166, LEN * 0.172, SCOPE_R * 0.82, SCOPE_R * 0.82, SCOPE_Y, 14))
  add(parts, 'lens', tube(-LEN * 0.153, -LEN * 0.149, SCOPE_R * 0.56, SCOPE_R * 0.56, SCOPE_Y, 14))
  // Elevation turret on top, and the two tall mounts with daylight between them.
  add(parts, 'edge', tube(-0.012, 0.012, SCOPE_R * 0.34, SCOPE_R * 0.34, 0, 10).rotateX(Math.PI / 2)
    .translate(0, SCOPE_Y + SCOPE_R * 0.86, -LEN * 0.010))
  add(parts, 'black', block(-LEN * 0.102, -LEN * 0.066, 0.050, SCOPE_Y - SCOPE_R * 0.62, W * 0.38))
  add(parts, 'black', block(LEN * 0.042, LEN * 0.078, 0.050, SCOPE_Y - SCOPE_R * 0.62, W * 0.38))

  // Pistol grip, trigger guard and trigger, hung under the back of the receiver.
  add(parts, 'hull', profile([
    [-LEN * 0.150, -0.050], [-LEN * 0.098, -0.050], [-LEN * 0.112, FLOOR], [-LEN * 0.166, FLOOR],
  ], W * 0.42))
  add(parts, 'hull', profile(
    [[-LEN * 0.102, -0.046], [-LEN * 0.030, -0.046], [-LEN * 0.030, -0.098], [-LEN * 0.102, -0.098]],
    W * 0.36,
    [[[-LEN * 0.094, -0.054], [-LEN * 0.038, -0.054], [-LEN * 0.038, -0.090], [-LEN * 0.094, -0.090]]],
  ))
  add(parts, 'steel', profile([
    [-LEN * 0.082, -0.050], [-LEN * 0.066, -0.050], [-LEN * 0.072, -0.086], [-LEN * 0.086, -0.086],
  ], 0.010))

  // Magazine: a straight box ahead of the grip, no curve.
  add(parts, 'hull', profile([
    [-LEN * 0.058, -0.048], [LEN * 0.006, -0.048], [LEN * 0.010, FLOOR * 0.74], [-LEN * 0.054, FLOOR * 0.74],
  ], W * 0.50))

  // Stock: a slab running back from the receiver to a squared butt pad, with a raised cheek
  // rest along the top. Slab-sided is the brief, so it stays a slab.
  add(parts, 'hull', profile([
    [-LEN * 0.170, 0.048], [-LEN * 0.150, 0.048], [-LEN * 0.150, -0.052], [-LEN * 0.300, -0.048],
    [BUTT + LEN * 0.014, -0.034], [BUTT + LEN * 0.014, 0.042], [-LEN * 0.170, 0.042],
  ], W * 0.58))
  add(parts, 'edge', profile([
    [-LEN * 0.196, 0.074], [-LEN * 0.320, 0.074], [BUTT + LEN * 0.030, 0.062], [BUTT + LEN * 0.030, 0.042],
    [-LEN * 0.196, 0.042],
  ], W * 0.50))
  add(parts, 'black', profile([
    [BUTT + LEN * 0.018, 0.064], [BUTT + LEN * 0.018, -0.038], [BUTT, -0.032], [BUTT, 0.058],
  ], W * 0.60))

  // Bipod, FOLDED back along the underside of the fore-end. Deployed it would be four times the
  // weapon's width, which is exactly the mistake this rebuild exists to undo.
  pair(parts, 'black', block(LEN * 0.075, LEN * 0.215, -0.062, -0.052, 0.008), W * 0.30)
  pair(parts, 'black', block(LEN * 0.200, LEN * 0.228, -0.066, -0.046, 0.012), W * 0.30)

  // Team paint: a plate on each flank of the stock.
  pair(parts, 'tint', block(-LEN * 0.310, -LEN * 0.238, -0.022, 0.014, 0.004), W * 0.30)

  // CE's rear optic is a wide electronic display housing, rather than an eyepiece tube.
  add(parts, 'black', block(-LEN * 0.17, -LEN * 0.12, SCOPE_Y - SCOPE_R * 0.78, SCOPE_Y + SCOPE_R * 0.78, W * 1.36))
  const k = materials()
  const g = new THREE.Group()
  g.name = 'sniper'
  for (const [key, list] of parts) {
    const merged = mergeGeometries(list, false)
    if (!merged) continue
    merged.computeVertexNormals()
    const m = new THREE.Mesh(merged, k[key])
    m.name = `sniper:${key}`
    m.castShadow = true
    m.receiveShadow = true
    g.add(m)
  }
  const canvas = document.createElement('canvas'); canvas.width=256; canvas.height=128
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='#03170c';ctx.fillRect(0,0,256,128)
  ctx.strokeStyle='#116533';ctx.lineWidth=1
  for(let y=12;y<120;y+=8){ctx.beginPath();ctx.moveTo(8,y);ctx.lineTo(248,y);ctx.stroke()}
  ctx.strokeStyle='#5bf66c';ctx.lineWidth=3;ctx.beginPath()
  for(let x=12;x<244;x++){const y=65+Math.sin(x*.13)*5+Math.sin(x*.039)*9;if(x===12)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke()
  ctx.fillStyle='#55ff70';ctx.font='14px monospace';ctx.fillText('IR  •  READY',14,23);ctx.fillRect(124,91,8,15)
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace
  const display=new THREE.Mesh(new THREE.PlaneGeometry(W*1.10,SCOPE_R*1.12),new THREE.MeshBasicMaterial({map:texture,toneMapped:false}))
  display.name='sniper-ir-display';display.position.set(0,SCOPE_Y,-LEN*.171);display.rotation.y=Math.PI;g.add(display)
  return g
}

registerModel('sniper', sniper)
