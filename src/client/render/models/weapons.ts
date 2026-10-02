import { assetUrl } from '../../../shared/runtime-config.ts'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { registerModel } from '../models.ts'
import { SPECS, TEAM_TINT, type Team } from '../../../shared/assets.ts'

/**
 * Owner: the two human small arms. `magnum` (M6D) and `assault-rifle` (MA5B).
 *
 * Everything here is generated: polygons come out of extruded side profiles, cylinders and
 * boxes; every surface comes off a 2D canvas painted at load. Nothing is fetched, so there is
 * nothing to license.
 *
 * METHOD — a gun is a silhouette problem, and a gun's silhouette *is* its side view. So both
 * weapons are authored as polygons traced directly off the reference side profiles, in the
 * reference images' own pixel coordinates, and mapped into metres by one function per weapon:
 *
 *   `MG(x, y)` for reference/weapons/m6d-profile.png   (800x840, art bbox x 14..784, y 24..814)
 *   `AR(x, y)` for reference/weapons/ma5b-profile.png (1020x400, art bbox x 11..1007, y 20..377)
 *
 * That means the numbers below are *measurements*, not guesses, and anyone can check one with a
 * colour picker. It also means the outline a player reads at fifty metres is literally the list
 * of points in this file, editable as a drawing rather than as a pile of boxes.
 *
 * WHAT THE REFERENCE ACTUALLY SHOWS — none of which is what memory says:
 *
 * M6D (see also reference/weapons/M6D-BREAKDOWN.md).
 *   - The KFA-2 scope block is at the FRONT of the slide, over the muzzle, spanning roughly 3% to
 *     41% of the length back from the compensator. Putting it at the rear is the single error
 *     that stops a model reading as an M6D, and the previous pass here made exactly that error.
 *   - A big round bolt boss stands proud of the flank at about 18% of length, under the scope.
 *     It is one of only two details that read at a glance.
 *   - The REAR quarter of the slide steps *up* into a taller block carrying six chunky rounded
 *     cocking ribs. Chunky bars, not fine grooves.
 *   - The trigger guard is an enormous straight-limbed D, dropping further below the frame than
 *     the frame is tall.
 *   - Colour is desaturated blue-grey gunmetal with lighter raised edges, and the grip is dark
 *     reddish-brown stippled rubber — the only warm thing on the weapon.
 *
 * MA5B — this is not the Halo 3 MA5C, and the previous pass built an MA5C.
 *   - No large flat-topped ammo-counter housing and no carry handle. The top of the front half
 *     is a segmented heat shroud: a tapered wedge nose rising into three raised panels, with one
 *     small pale display let into its rear flank.
 *   - No prominent curved magazine in profile. The magazine is buried inside the receiver.
 *   - The pistol grip is CUT OUT OF THE BODY: a teardrop hole punched through the slab between
 *     the grip and the stock leg, which is why the outline is one continuous low black wedge.
 *   - Under the front half, a ribbed handguard with five vertical fins and one green status
 *     light; below the barrel, a second short flashlight tube.
 *   - Almost entirely matte near-black with subtly lighter raised edges. Length to height 3:1.
 *
 * Draw calls: every solid is merged into one buffer per material, so each weapon is six meshes
 * no matter how many greebles it grows.
 */

/* ------------------------------------------------------------------ surfaces */

/** Deterministic noise, so two builds of the same weapon are byte-identical. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

function paint(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  draw(cv.getContext('2d')!)
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

/**
 * Painted gun metal. Base colour, broad mottling, fine grain and a few long wear streaks.
 * `sheen` is the colour that wear rubs *through* to — the lighter edge highlight both weapons
 * need so a flat-shaded slab does not read as plastic.
 */
function metalSkin(base: string, sheen: string, grain: number, seed: number): THREE.CanvasTexture {
  return paint(256, 256, (x) => {
    const r = rng(seed)
    x.fillStyle = base
    x.fillRect(0, 0, 256, 256)
    for (let i = 0; i < 22; i++) {
      const rad = 10 + r() * 26
      const cx = r() * 256
      const cy = r() * 256
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad)
      g.addColorStop(0, `rgba(255,255,255,${0.006 + r() * 0.014})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      x.fillStyle = g
      x.fillRect(cx - rad, cy - rad, rad * 2, rad * 2)
    }
    const img = x.getImageData(0, 0, 256, 256)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const n = (r() - 0.5) * grain
      d[i] += n; d[i + 1] += n; d[i + 2] += n
    }
    x.putImageData(img, 0, 0)
    x.strokeStyle = sheen
    x.lineWidth = 1
    for (let i = 0; i < 30; i++) {
      const y = r() * 256
      x.globalAlpha = 0.05 + r() * 0.13
      x.beginPath()
      x.moveTo(r() * 256, y)
      x.lineTo(r() * 180 + 76, y + (r() - 0.5) * 3)
      x.stroke()
    }
    x.globalAlpha = 1
  })
}

/** The M6D's grip: dark reddish-brown rubber, stippled in a regular dotted lattice. */
function stippleSkin(): THREE.CanvasTexture {
  return paint(128, 128, (x) => {
    const r = rng(0x6d17)
    x.fillStyle = '#38231b'
    x.fillRect(0, 0, 128, 128)
    for (let i = 0; i < 900; i++) {
      x.fillStyle = `rgba(16,9,7,${0.10 + r() * 0.22})`
      x.fillRect(r() * 128, r() * 128, 1 + r() * 3, 1 + r() * 3)
    }
    // The lattice of moulded studs. A regular grid is what makes it read as grip and not as dirt,
    // and it has to stay fine — coarse studs turn the grip into camouflage.
    for (let gy = 0; gy < 128; gy += 5) {
      for (let gx = (gy / 5) % 2 ? 2.5 : 0; gx < 128; gx += 5) {
        x.fillStyle = 'rgba(126,92,74,0.26)'
        x.fillRect(gx + 1, gy + 1, 1.6, 1.6)
        x.fillStyle = 'rgba(10,6,4,0.40)'
        x.fillRect(gx + 2, gy + 2, 1.4, 1.4)
      }
    }
  })
}

/**
 * The MA5B's little pale display, at the rear of the heat shroud. Drawn as seven-segment bars
 * rather than typeset, because a font is a dependency and a rectangle is not.
 */
const SEGMENTS: Record<string, readonly number[]> = {
  //  a  b  c  d  e  f  g
  '0': [1, 1, 1, 1, 1, 1, 0],
  '3': [1, 1, 1, 1, 0, 0, 1],
  '6': [1, 0, 1, 1, 1, 1, 1],
}

function digit(x: CanvasRenderingContext2D, ch: string, ox: number, oy: number, w: number, h: number, t: number): void {
  const on = SEGMENTS[ch] ?? SEGMENTS['0']
  const bar = (i: number, bx: number, by: number, bw: number, bh: number) => {
    x.globalAlpha = on[i] ? 1 : 0.08
    x.fillRect(ox + bx, oy + by, bw, bh)
  }
  bar(0, t, 0, w - 2 * t, t)
  bar(1, w - t, t, t, h / 2 - t)
  bar(2, w - t, h / 2, t, h / 2 - t)
  bar(3, t, h - t, w - 2 * t, t)
  bar(4, 0, h / 2, t, h / 2 - t)
  bar(5, 0, t, t, h / 2 - t)
  bar(6, t, h / 2 - t / 2, w - 2 * t, t)
  x.globalAlpha = 1
}

function displaySkin(): THREE.CanvasTexture {
  return paint(128, 64, (x) => {
    x.fillStyle = '#0b1310'
    x.fillRect(0, 0, 128, 64)
    x.fillStyle = '#cfe6d2'
    digit(x, '6', 16, 12, 34, 40, 7)
    digit(x, '0', 58, 12, 34, 40, 7)
    for (let i = 0; i < 4; i++) {
      x.globalAlpha = i < 3 ? 1 : 0.12
      x.fillRect(100, 12 + i * 11, 14, 8)
    }
    x.globalAlpha = 1
  })
}

interface Kit {
  /** M6D body: desaturated blue-grey gunmetal. */
  gun: THREE.MeshStandardMaterial
  /** M6D raised masses — scope block, rear slide block, compensator. A shade lighter. */
  gunLite: THREE.MeshStandardMaterial
  /** M6D grip: dark reddish-brown stippled rubber. The only warm surface on either weapon. */
  grip: THREE.MeshStandardMaterial
  /** MA5B body: matte near-black. */
  body: THREE.MeshStandardMaterial
  /** MA5B raised edges — shroud seams, handguard fins, sight rail. Subtly lighter. */
  edge: THREE.MeshStandardMaterial
  /** Bare steel: barrels, trigger, pins. */
  steel: THREE.MeshStandardMaterial
  /** Self-lit glass: the M6D scope lens. */
  lens: THREE.MeshStandardMaterial
  /** The MA5B's one green status light. */
  green: THREE.MeshStandardMaterial
  /** The MA5B's pale display. Its own material because it carries its own image. */
  lcd: THREE.MeshStandardMaterial
  /** Team paint. Separate by contract — a red and a blue weapon differ by this alone. */
  tint: THREE.MeshStandardMaterial
}

let kit: Kit | null = null

/** Built once, shared by every weapon and every instance of one. */
function materials(): Kit {
  if (kit) return kit
  // ExtrudeGeometry lays out UVs in world units, so on weapon-sized parts a repeat of 1 stretches
  // one texel across the whole slide. These numbers are tuned to give roughly millimetre grain.
  const rep = (t: THREE.Texture, n: number) => {
    t.repeat.set(n, n)
    return t
  }
  kit = {
    gun: new THREE.MeshStandardMaterial({
      map: rep(metalSkin('#69718a', '#b6c0d4', 22, 0x2b41), 12),
      roughness: 0.44,
      metalness: 0.68,
    }),
    gunLite: new THREE.MeshStandardMaterial({
      map: rep(metalSkin('#838ca4', '#ccd4e4', 20, 0x51a3), 12),
      roughness: 0.40,
      metalness: 0.66,
    }),
    grip: new THREE.MeshStandardMaterial({ map: rep(stippleSkin(), 24), roughness: 0.94, metalness: 0.04 }),
    body: new THREE.MeshStandardMaterial({
      map: rep(metalSkin('#454a4d', '#8f959c', 16, 0x77c1), 12),
      roughness: 0.79,
      metalness: 0.30,
    }),
    edge: new THREE.MeshStandardMaterial({
      map: rep(metalSkin('#43484e', '#a4abb3', 14, 0x1d09), 12),
      roughness: 0.66,
      metalness: 0.36,
    }),
    steel: new THREE.MeshStandardMaterial({ color: 0x8d9299, roughness: 0.33, metalness: 0.92 }),
    lens: new THREE.MeshStandardMaterial({
      color: 0x0a1218, emissive: 0x4a9dc4, emissiveIntensity: 0.55, roughness: 0.15, metalness: 0,
    }),
    green: new THREE.MeshStandardMaterial({
      color: 0x0d2411, emissive: 0x4dff5a, emissiveIntensity: 1.6, roughness: 0.25, metalness: 0,
    }),
    lcd: (() => {
      const t = displaySkin()
      return new THREE.MeshStandardMaterial({
        map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.75, roughness: 0.3, metalness: 0,
      })
    })(),
    tint: new THREE.MeshStandardMaterial({ color: TEAM_TINT.blue, roughness: 0.62, metalness: 0.30 }),
  }
  kit.tint.name = 'team-tint'
  return kit
}

/**
 * Recolour a built weapon for a team. The tinted material is shared, so it is cloned on the way
 * past — a red rifle and a blue rifle are the same geometry and differ by this one colour.
 */
export function setWeaponTeam(root: THREE.Object3D, team: Team): void {
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

/* ------------------------------------------------------------------ geometry helpers */

type MatKey = keyof Kit
type Pt = readonly [number, number]

/** Geometry accumulated per material, merged into one buffer at the end. */
type Parts = Map<MatKey, THREE.BufferGeometry[]>

function add(parts: Parts, key: MatKey, geo: THREE.BufferGeometry): void {
  const list = parts.get(key)
  if (list) list.push(geo.toNonIndexed())
  else parts.set(key, [geo.toNonIndexed()])
  geo.dispose()
}

/**
 * A solid authored as its side view.
 *
 * `pts` is a closed polygon in (z forward, y up); it is extruded `width` across x and chamfered,
 * so the outline typed here is exactly the outline the player sees. `holes` punch through — the
 * MA5B's teardrop grip cutout is one polygon with one polygon removed, which is the honest
 * description of that shape.
 */
function profile(
  pts: readonly Pt[],
  width: number,
  holes: readonly (readonly Pt[])[] = [],
  bevel = 0.0025,
): THREE.BufferGeometry {
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
  const b = Math.min(bevel, width * 0.3)
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - 2 * b,
    bevelEnabled: b > 0,
    bevelSize: b,
    bevelOffset: 0,
    bevelThickness: b,
    bevelSegments: 1,
    curveSegments: 2,
  })
  // Lay the drawing down: profile x becomes +z (forward), extrusion depth becomes width in x.
  g.rotateY(-Math.PI / 2)
  g.translate(width / 2 - b, 0, 0)
  return g
}

/** A plain block, centred in x, spanning the given z and y ranges. */
function block(z0: number, z1: number, y0: number, y1: number, width: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(width, y1 - y0, z1 - z0)
  g.translate(0, (y0 + y1) / 2, (z0 + z1) / 2)
  return g
}

/** A tube lying along z: barrels, flashlights, lenses. */
function tube(z0: number, z1: number, r0: number, r1: number, y = 0, seg = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, z1 - z0, seg, 1, false)
  g.rotateX(Math.PI / 2)
  g.translate(0, y, (z0 + z1) / 2)
  return g
}

/** A rounded bar standing along y: one cocking serration. */
function ribY(z: number, y0: number, y1: number, r: number, seg = 6): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, y1 - y0, seg, 1, true)
  g.translate(0, (y0 + y1) / 2, z)
  return g
}

/** A rounded bar lying across x: a serration wrapping over the top of the slide. */
function ribX(z: number, y: number, half: number, r: number, seg = 6): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, half * 2, seg, 1, true)
  g.rotateZ(Math.PI / 2)
  g.translate(0, y, z)
  return g
}

/** Mirror a geometry to both flanks of the weapon. */
function pair(parts: Parts, key: MatKey, geo: THREE.BufferGeometry, x: number): void {
  const a = geo.clone()
  a.translate(x, 0, 0)
  add(parts, key, a)
  const b = geo.clone()
  b.translate(-x, 0, 0)
  add(parts, key, b)
  geo.dispose()
}

function assemble(parts: Parts, name: string): THREE.Group {
  const k = materials()
  const g = new THREE.Group()
  g.name = name
  for (const [key, list] of parts) {
    const merged = mergeGeometries(list, false)
    if (!merged) continue
    merged.computeVertexNormals()
    const m = new THREE.Mesh(merged, k[key])
    m.name = `${name}:${key}`
    m.castShadow = true
    m.receiveShadow = true
    g.add(m)
  }
  return g
}

/* ------------------------------------------------------------------ M6D magnum */

/**
 * Overall about 1 : 1 — the M6D is a *tall* pistol, and being too short is the second commonest
 * way to get it wrong after putting the scope on the back.
 *
 * MG maps reference/weapons/m6d-profile.png pixels to metres. In that image x = 784 is the butt
 * and x = 14 the muzzle (770 px of length); y = 24 is the scope crown and y = 814 the magazine
 * baseplate (790 px of height); y = 163 is the bore line, which is the model's y = 0. The scale
 * is taken from SPECS at build time rather than baked in, so the model tracks the spec instead
 * of drifting off it.
 */
const M_SIZE = SPECS['magnum'].size
const M_SX = M_SIZE[0] / 770
const M_SY = M_SIZE[2] / 790
const M_W = M_SIZE[1]

const MG = (x: number, y: number): Pt => [(784 - x) * M_SX - M_SIZE[0] * 0.42, (163 - y) * M_SY]

/** Trace a run of reference pixel coordinates into model space. */
const mg = (pts: readonly (readonly [number, number])[]): Pt[] => pts.map(([x, y]) => MG(x, y))

function magnum(): THREE.Object3D {
  const parts: Parts = new Map()

  // Widths are fractions of the spec width so the widest point of the weapon lands exactly on it.
  // On a pistol the widest point should be the optic, not the slide — that is part of why the M6D
  // reads as a hand cannon.
  const SLIDE = M_W * 0.78
  const SCOPE = M_W * 0.90
  const FRAME = M_W * 0.70

  // Slide, flat mid-section: a plain thin slab from behind the compensator to the rear block.
  add(parts, 'gun', profile(mg([
    [32, 88], [46, 74], [636, 74], [636, 190], [46, 190], [32, 176],
  ]), SLIDE))

  // Rear slide block. The rear quarter steps UP: taller than the mid-slide, chamfered at the
  // front-top and rear-top corners. This is the mass the cocking ribs live on.
  add(parts, 'gunLite', profile(mg([
    [612, 96], [636, 60], [752, 57], [784, 78], [784, 190], [612, 190],
  ]), SLIDE + M_W * 0.04))

  // Six chunky rounded cocking ribs across the rear block, wrapping over the top. Bars, not
  // grooves — at arm's length fine grooves vanish and these do not.
  for (let i = 0; i < 6; i++) {
    const z = MG(640 + i * 23, 0)[0]
    pair(parts, 'gunLite', ribY(z, MG(0, 178)[1], MG(0, 74)[1], M_W * 0.075), SLIDE / 2 + M_W * 0.02)
    add(parts, 'gunLite', ribX(z, MG(0, 62)[1], SLIDE / 2 + M_W * 0.03, M_W * 0.07))
  }

  // KFA-2 scope block: THE identifying feature, and it sits over the MUZZLE. A rounded-top loaf
  // riding the front 41% of the slide, low and notched at the front, crowned near 25% of length,
  // then falling away in a long rear chamfer to meet the slide top.
  add(parts, 'gunLite', profile(mg([
    [27, 62], [31, 40], [48, 27], [96, 24], [160, 24], [230, 31], [292, 48], [348, 74], [348, 84], [27, 84],
  ]), SCOPE))
  // Objective housing at the very front of the block, and the lens sunk into it.
  add(parts, 'gun', profile(mg([[22, 32], [50, 28], [50, 70], [22, 68]]), SCOPE - M_W * 0.14))
  add(parts, 'lens', tube(MG(24, 0)[0], MG(16, 0)[0], M_SY * 19, M_SY * 19, MG(0, 49)[1], 10))

  // Recoil compensator: three thin stepped plates projecting forward of the slide at three
  // heights, which is what the front 5% of this weapon actually is.
  add(parts, 'gunLite', profile(mg([[14, 74], [50, 74], [50, 92], [14, 92]]), SLIDE - M_W * 0.10))
  add(parts, 'gunLite', profile(mg([[14, 140], [56, 140], [56, 162], [14, 162]]), SLIDE - M_W * 0.04))
  add(parts, 'gun', profile(mg([[14, 226], [62, 226], [62, 252], [14, 252]]), FRAME))
  // The bore, below the objective — head-on the M6D shows two stacked circular openings.
  add(parts, 'steel', tube(MG(70, 0)[0], MG(18, 0)[0], M_SY * 33, M_SY * 33, MG(0, 150)[1], 10))

  // The bolt boss: a big raised cylindrical stud on the flank under the scope, at 18% of length
  // and 6.6% of length across. One of only two details that read at a glance, so it is modelled
  // proud rather than painted, and it is what sets the weapon's full width.
  pair(parts, 'gun', block(MG(214, 0)[0], MG(80, 0)[0], MG(0, 178)[1], MG(0, 80)[1], M_W * 0.04), SCOPE / 2)
  pair(parts, 'gunLite', tube(-M_W * 0.06, M_W * 0.06, M_SX * 26, M_SX * 26, 0, 12)
    .rotateY(Math.PI / 2).translate(0, MG(0, 132)[1], MG(152, 0)[0]), M_W * 0.44)

  // Frame / dust cover, below the slide the whole length, stepping down at the rear in three
  // shelves — that little staircase is clearly there in the reference and it breaks up the block.
  add(parts, 'gun', profile(mg([
    [14, 190], [784, 190], [784, 214], [758, 214], [758, 228], [700, 228], [700, 241], [640, 241],
    [640, 256], [62, 256], [14, 226],
  ]), FRAME))
  // Slide-stop panel on the frame flank, and the rear sight base let into the top of the slide.
  pair(parts, 'gunLite', block(MG(462, 0)[0], MG(392, 0)[0], MG(0, 224)[1], MG(0, 196)[1], M_W * 0.07), FRAME / 2)
  add(parts, 'gun', profile(mg([[520, 64], [576, 64], [576, 78], [520, 78]]), SLIDE - M_W * 0.2))

  // Trigger guard: an enormous straight-limbed D. The forward limb runs down and back; the
  // bottom bar sweeps back and up into the front of the grip. It drops further below the frame
  // than the frame is tall, and that is the outline's other giveaway.
  add(parts, 'gun', profile(mg([[140, 250], [184, 250], [242, 548], [200, 548]]), FRAME - M_W * 0.12))
  add(parts, 'gun', profile(mg([[198, 516], [452, 542], [452, 576], [196, 552]]), FRAME - M_W * 0.12))
  add(parts, 'steel', profile(mg([[294, 256], [322, 256], [316, 344], [298, 344]]), M_W * 0.25))

  // Grip: trapezoidal, deep front to back, raked back about 68 degrees, in stippled rubber.
  add(parts, 'grip', profile(mg([
    [360, 252], [612, 252], [620, 656], [462, 670], [408, 588], [374, 336],
  ]), FRAME + M_W * 0.06))

  // Magazine: a straight rectangular box out of the grip, no curve, dropping another quarter of
  // the weapon's height to a flat baseplate.
  add(parts, 'gun', profile(mg([[446, 588], [624, 588], [624, 792], [446, 792]]), FRAME + M_W * 0.02))
  add(parts, 'gunLite', profile(mg([[434, 776], [632, 776], [632, 814], [434, 814]]), FRAME))

  // Team paint: one small plate on each flank of the frame, above the trigger. Deliberately
  // small — the M6D's colour identity is the blue-grey, and a big colour panel destroys it.
  pair(parts, 'tint', block(MG(560, 0)[0], MG(478, 0)[0], MG(0, 244)[1], MG(0, 206)[1], M_W * 0.07), FRAME / 2)

  return assemble(parts, 'magnum')
}

/* ------------------------------------------------------------------ MA5B assault rifle */

/**
 * Long, low and about three times as long as it is tall.
 *
 * AR maps reference/weapons/ma5b-profile.png pixels to metres. In that image x = 1007 is the butt
 * and x = 11 the muzzle (996 px of length); y = 20 is the crown of the shroud and y = 377 the toe
 * of the stock (357 px of height); y = 124 is the bore line, which is the model's y = 0. As with
 * the M6D the scale comes from SPECS at build time.
 */
const A_SIZE = SPECS['assault-rifle'].size
const A_SX = A_SIZE[0] / 996
const A_SY = A_SIZE[2] / 357
const A_W = A_SIZE[1]

const AR = (x: number, y: number): Pt => [(1007 - x) * A_SX - A_SIZE[0] * 0.4045, (124 - y) * A_SY]

const ar = (pts: readonly (readonly [number, number])[]): Pt[] => pts.map(([x, y]) => AR(x, y))

function taperedShroud(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    const height = THREE.MathUtils.clamp((position.getY(i) - AR(0, 100)[1]) / (AR(0, 22)[1] - AR(0, 100)[1]), 0, 1)
    position.setX(i, position.getX(i) * (1 - 0.46 * height))
  }
  geometry.computeVertexNormals()
  return geometry
}

function assaultRifle(): THREE.Object3D {
  const parts: Parts = new Map()

  const BODY = A_W * 0.88
  const SHROUD = A_W * 1.5
  const GUARD = A_W * 0.84

  // Heat shroud and nose. One continuous upper mass: a wedge that starts as a blunt point around
  // the muzzle and climbs rearward to a flat crown, then drops vertically at the ejection port.
  // This wedge is what says MA5B rather than MA5C — there is no flat-topped counter housing and
  // no carry handle anywhere on this weapon.
  add(parts, 'body', taperedShroud(profile(ar([
    [45, 112], [64, 86], [176, 44], [392, 25], [524, 22], [534, 100], [150, 100],
  ]), SHROUD, [], 0.012)))
  // The nose's underside, tapering forward to the barrel.
  add(parts, 'body', profile(ar([
    [45, 112], [150, 100], [150, 196], [116, 190], [70, 152], [42, 126],
  ]), BODY - A_W * 0.08))
  // Three raised panel seams across the shroud: the segmentation is the whole point of it, and
  // the seams are the widest thing on the weapon.
  for (const [zx, zy] of [[262, 37], [348, 29], [434, 24]] as const) {
    add(parts, 'edge', block(AR(zx + 7, 0)[0], AR(zx - 7, 0)[0], AR(0, zy + 6)[1], AR(0, zy - 4)[1], A_W))
  }
  // The small pale display let into the rear flank of the shroud. Small — it is a status readout,
  // not the MA5C's billboard.
  pair(parts, 'lcd', block(AR(518, 0)[0], AR(484, 0)[0], AR(0, 76)[1], AR(0, 58)[1], A_W * 0.04), SHROUD / 2)

  // Receiver and stock: one long slab from the shroud back to the butt, with the pistol grip cut
  // out of it as a teardrop hole. The stock steps UP at the top and its underside sweeps down and
  // forward into the toe, so grip and stock are one mass with daylight punched through.
  add(parts, 'body', profile(
    ar([
      [150, 100], [760, 95], [764, 69], [924, 69], [962, 78], [1002, 88],
      [1002, 250], [976, 266], [930, 288], [858, 318], [800, 348], [752, 370],
      [716, 367], [688, 326], [666, 272], [656, 232], [654, 205],
      [592, 205], [150, 196],
    ]),
    BODY,
    [ar([[738, 212], [760, 218], [778, 254], [772, 290], [750, 304], [730, 280], [726, 238]])],
  ))
  // Raised side panel on the stock and a ribbed selector boss by the trigger — the two things
  // that keep a big black slab from reading as a brick.
  pair(parts, 'edge', block(AR(944, 0)[0], AR(788, 0)[0], AR(0, 194)[1], AR(0, 160)[1], A_W * 0.03), BODY / 2)
  pair(parts, 'edge', tube(-A_W * 0.05, A_W * 0.05, A_SY * 11, A_SY * 11, 0, 8)
    .rotateY(Math.PI / 2).translate(0, AR(0, 196)[1], AR(700, 0)[0]), BODY / 2)
  add(parts, 'steel', profile(ar([[686, 202], [712, 202], [708, 240], [690, 240]]), A_W * 0.16))

  pair(parts, 'edge', block(AR(560, 0)[0], AR(196, 0)[0], AR(0, 148)[1], AR(0, 132)[1], A_W * 0.03), BODY / 2)

  // Sight rail along the top of the receiver, with the short front nub standing off it.
  add(parts, 'edge', block(AR(762, 0)[0], AR(636, 0)[0], AR(0, 97)[1], AR(0, 86)[1], A_W * 0.30))
  add(parts, 'edge', block(AR(666, 0)[0], AR(640, 0)[0], AR(0, 97)[1], AR(0, 74)[1], A_W * 0.27))

  // Ribbed handguard under the front half: five rounded vertical fins and one green status light.
  add(parts, 'body', profile(ar([
    [150, 190], [592, 190], [582, 244], [430, 268], [216, 286], [156, 250],
  ]), GUARD))
  for (let i = 0; i < 5; i++) {
    const z = AR(212 + i * 58, 0)[0]
    pair(parts, 'edge', ribY(z, AR(0, 274)[1], AR(0, 198)[1], A_W * 0.14, 8), GUARD / 2 - A_W * 0.02)
  }
  pair(parts, 'green', tube(-A_W * 0.04, A_W * 0.04, A_SY * 9, A_SY * 9, 0, 8)
    .rotateY(Math.PI / 2).translate(0, AR(0, 202)[1], AR(428, 0)[0]), GUARD / 2)

  // Barrel, and the second short flashlight tube slung beneath it and running back into the
  // front of the handguard so it reads as part of the weapon rather than a floating stub.
  add(parts, 'steel', tube(AR(130, 0)[0], AR(11, 0)[0], A_SY * 15, A_SY * 14, 0, 10))
  add(parts, 'body', tube(AR(190, 0)[0], AR(64, 0)[0], A_SY * 21, A_SY * 20, AR(0, 216)[1], 10))
  add(parts, 'lens', tube(AR(69, 0)[0], AR(64, 0)[0], A_SY * 13, A_SY * 13, AR(0, 216)[1], 10))

  // Team paint: one plate on each flank of the stock, where a teammate's rifle is seen side-on.
  pair(parts, 'tint', block(AR(912, 0)[0], AR(846, 0)[0], AR(0, 246)[1], AR(0, 220)[1], A_W * 0.05), BODY / 2)

  const rifle = assemble(parts, 'assault-rifle')
  addCounter(rifle)
  return rifle
}

let generatedRifle: THREE.Group | null = null

export async function preloadGeneratedRifle(): Promise<void> {
  const gltf = await new GLTFLoader().loadAsync(assetUrl('/assets/weapons/assault-rifle.glb'))
  const model = gltf.scene
  model.rotation.y = Math.PI / 2
  model.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(model)
  const size = bounds.getSize(new THREE.Vector3())
  const scale = A_SIZE[0] / size.z
  const center = bounds.getCenter(new THREE.Vector3()).multiplyScalar(scale)
  model.scale.multiplyScalar(scale)
  model.position.sub(center)
  model.position.y -= 0.08
  model.position.z += A_SIZE[0] * 0.0955
  model.traverse(o => {
    if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true }
  })
  model.name = 'MA5B-side-profile'
  model.userData.source = assetUrl('/assets/weapons/assault-rifle.glb')
  // Keep import transforms below the viewmodel root, whose scale and rotation change.
  generatedRifle = new THREE.Group()
  generatedRifle.add(model)
  addCounter(generatedRifle)
  generatedRifle.userData.source = model.userData.source
}

function addCounter(rifle: THREE.Object3D): void {
  // The screen is inset in the back of the front shroud, facing the shooter.
  const display = new THREE.Mesh(new THREE.PlaneGeometry(A_W * 0.95, 0.066), new THREE.MeshBasicMaterial({color:0x54cfff}))
  const screenPosition = display.geometry.getAttribute('position')
  for (let i = 0; i < screenPosition.count; i++) {
    if (screenPosition.getY(i) > 0) screenPosition.setX(i, screenPosition.getX(i) * 0.55)
  }
  display.name = 'ammo-counter'
  display.position.set(0, AR(0, 61)[1], AR(537, 0)[0] - 0.020)
  display.rotation.y = Math.PI
  rifle.add(display)
}

registerModel('assault-rifle', () => new URLSearchParams(location.search).has('generated-rifle') && generatedRifle ? generatedRifle : assaultRifle())
registerModel('magnum', magnum)
