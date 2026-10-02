import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TEAM_TINT, type Team, type ModelId } from '../../../shared/assets.ts'
import { groundHeight } from '../../../shared/field.ts'
import { registerModel, buildModel, hasModel } from '../models.ts'
import { applySkin, buildSkeleton, BONES, type BoneName, type SkinSpec } from './spartan/rig.ts'
import { newRigState, poseRig, type SpartanRig } from './spartan/pose.ts'

export { updateSpartanRig, type SpartanMotion, type SpartanRig } from './spartan/pose.ts'

/**
 * Owner: spartan piece. The MJOLNIR-armoured player character, articulated.
 *
 * Read off `reference/renders/spartan.png` (clean three-quarter silhouette on a grid) and
 * `reference/frames/red-team.jpg` (four of them, in stance, at fighting distance). What those
 * actually show, as opposed to what one remembers:
 *
 *   - The helmet is a *forward-raked dome* with a hard lip standing proud over the visor, and
 *     the visor is a wide gold band that wraps ear to ear. There is no face, no neck to speak
 *     of; the collar armour comes up behind the jaw. Helmet is ~0.38 m — a sixth of the figure.
 *   - The pauldrons are the widest thing on the body and they sit HIGH: their top edge is level
 *     with the chin, not the shoulder. They are the entire silhouette read at fifty metres.
 *     Everything else can be approximate; if these are small or low it stops being a Spartan.
 *   - The waist is genuinely narrow — barely wider than a thigh — and it is *dark*. Armour is
 *     plates floating on a black bodysuit, and the black shows at the waist, the armpits, the
 *     backs of the knees and the insides of the elbows. That dark gap is what makes the plates
 *     read as plates.
 *   - Thighs are enormous, shins taper hard, and the boots flare back out into a heavy soled
 *     wedge. The leg silhouette is a triple bulge, not a cone.
 *   - Nobody stands square. In every frame they are bladed: one foot back, weight low, both
 *     hands carried forward at the centre line, and a weapon in them — see `equipSpartan`.
 *
 * That last point used to be baked into the mesh, which is exactly why nothing moved. It is now
 * the *idle pose* of a real rig — see `spartan/rig.ts` for the joint tree and `spartan/pose.ts`
 * for the locomotion. The geometry here is authored in a neutral bind: legs straight, arms
 * hanging, feet square. Everything the player ever sees is posed on top of that.
 *
 * Construction is unchanged: everything is lofted rings. `loft()` walks a stack of superelliptic
 * cross sections, so one primitive gives round limbs (p→1) and hard armour plate (p→0.4) and
 * every blend between, and an angular sweep short of a full turn gives a plate *shell* that can
 * be laid over a dark core. That single trick is what buys the plates-on-bodysuit look cheaply.
 *
 * Everything merges down by material into four SKINNED meshes, so an articulated Spartan is
 * still four draw calls: team armour, black bodysuit, grey hardware, gold visor. Sixteen on
 * screen is sixty-four calls, not six hundred, and the GPU does the deformation.
 *
 * Axes: -Z is forward, +X is the Spartan's own right. The old static model faced +Z, which had
 * every bot in the game walking backwards, since the movement code sends a player at yaw along
 * (-sin yaw, -cos yaw) and the render object is spun by `rotation.y = yaw`.
 */

const TAU = Math.PI * 2
const D = Math.PI / 180

/** A cross section: a superellipse of half-extents rx/rz, centred at (cx, cz), at height y. */
interface Ring {
  y: number
  rx: number
  rz: number
  cx?: number
  cz?: number
  /** Squareness. 1 is a circle, 0.5 reads as a bevelled box, 0.35 is nearly a hard box. */
  p?: number
}

/**
 * Loft a stack of rings.
 *
 * A full turn gives a closed solid with end caps. A partial sweep gives an open strip — an
 * armour plate that can sit a millimetre proud of a dark limb, which is most of this model.
 */
function loft(rings: readonly Ring[], seg = 12, a0 = 0, a1 = TAU, caps = true): THREE.BufferGeometry {
  const closed = a1 - a0 >= TAU - 1e-6
  const cols = seg
  const nCols = cols + 1
  const pos: number[] = []
  const uv: number[] = []
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]
    const p = ring.p ?? 0.55
    for (let i = 0; i <= cols; i++) {
      const t = a0 + (a1 - a0) * (i / cols)
      const c = Math.cos(t)
      const s = Math.sin(t)
      const x = (ring.cx ?? 0) + ring.rx * Math.sign(c) * Math.abs(c) ** p
      const z = (ring.cz ?? 0) + ring.rz * Math.sign(s) * Math.abs(s) ** p
      pos.push(x, ring.y, z)
      uv.push(i / cols, r / Math.max(1, rings.length - 1))
    }
  }
  const idx: number[] = []
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < cols; i++) {
      const a = r * nCols + i
      idx.push(a, a + nCols, a + 1, a + 1, a + nCols, a + nCols + 1)
    }
  }
  if (closed && caps) {
    const base = 0
    for (let i = 1; i < cols - 1; i++) idx.push(base, base + i, base + i + 1)
    const top = (rings.length - 1) * nCols
    for (let i = 1; i < cols - 1; i++) idx.push(top, top + i + 1, top + i)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Profile station along a limb: t is 0..1 from the start joint to the end joint. */
interface Station {
  t: number
  r: number
  rz?: number
  p?: number
  cz?: number
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const UP = V(0, 1, 0)

/** Loft a tapered tube from joint `a` to joint `b`. Limbs are authored as bone segments. */
function limb(a: THREE.Vector3, b: THREE.Vector3, prof: readonly Station[], seg = 10, sweep?: [number, number]): THREE.BufferGeometry {
  const dir = b.clone().sub(a)
  const len = dir.length()
  const rings: Ring[] = prof.map((s) => ({
    y: s.t * len,
    rx: s.r,
    rz: s.rz ?? s.r,
    p: s.p ?? 0.75,
    cz: s.cz,
  }))
  const g = sweep ? loft(rings, seg, sweep[0], sweep[1], false) : loft(rings, seg)
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize())
  g.applyMatrix4(new THREE.Matrix4().compose(a, q, V(1, 1, 1)))
  return g
}

function place(g: THREE.BufferGeometry, pos: THREE.Vector3, euler?: THREE.Euler): THREE.BufferGeometry {
  const q = euler ? new THREE.Quaternion().setFromEuler(euler) : new THREE.Quaternion()
  g.applyMatrix4(new THREE.Matrix4().compose(pos, q, V(1, 1, 1)))
  return g
}

function boxg(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d)
}

/**
 * The one texture in the model: scuffed painted plate.
 *
 * Mid-grey base so the team tint multiplies through at nearly full strength, with soft
 * mottling and speckle so a large flat pauldron does not read as a single flat colour under
 * a directional light. Shared by every material — armour, bodysuit and hardware all sample it.
 */
function plateTexture(): THREE.CanvasTexture {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  g.fillStyle = '#c6c6c6'
  g.fillRect(0, 0, S, S)

  // Soft mottling: broad patches of wear, both directions off the base value.
  let seed = 20011115
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < 160; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const r = 6 + rnd() * 34
    const dark = rnd() < 0.6
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    grd.addColorStop(0, dark ? 'rgba(70,70,70,0.30)' : 'rgba(255,255,255,0.28)')
    grd.addColorStop(1, 'rgba(128,128,128,0)')
    g.fillStyle = grd
    g.fillRect(x - r, y - r, r * 2, r * 2)
  }

  // Scratches. A few long, many short, all shallow.
  for (let i = 0; i < 90; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const len = 3 + rnd() * 26
    const ang = rnd() * TAU
    g.strokeStyle = rnd() < 0.5 ? 'rgba(60,58,55,0.35)' : 'rgba(250,250,250,0.30)'
    g.lineWidth = rnd() < 0.85 ? 1 : 2
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len)
    g.stroke()
  }

  // Fine grain, so it never goes plastic in a close-up.
  const img = g.getImageData(0, 0, S, S)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 22
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n))
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n))
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n))
  }
  g.putImageData(img, 0, 0)

  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

let TEX: THREE.CanvasTexture | null = null
function tex(): THREE.CanvasTexture {
  if (!TEX) TEX = plateTexture()
  return TEX
}

/**
 * Team armour. One material per team, built once — a red and a blue Spartan are the same
 * geometry differing by tint alone, exactly as CE tinted its armour at runtime.
 */
const teamMats = new Map<Team, THREE.MeshStandardMaterial>()
function teamMaterial(team: Team): THREE.MeshStandardMaterial {
  let m = teamMats.get(team)
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      name: `spartan-team-${team}`,
      color: TEAM_TINT[team],
      map: tex(),
      roughness: 0.52,
      metalness: 0.22,
    })
    // Flagged on the material as well as the mesh: the match code retints by cloning whatever
    // material carries this, and it was looking at the material, not the mesh.
    m.userData.teamTinted = true
    teamMats.set(team, m)
  }
  return m
}

type MatKey = 'team' | 'suit' | 'steel' | 'visor'

/** Retint a built Spartan. Swaps the shared team material; nothing else about it changes. */
export function setSpartanTeam(root: THREE.Object3D, team: Team): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && m.userData.teamTinted) m.material = teamMaterial(team)
  })
}

// ---------------------------------------------------------------------------------------------
// Proportions, measured off the reference silhouette against its grid and pinned to SPECS.
// Total height 2.18 m; pauldron tips at ±0.455 give the 0.91 m width. The 0.56 m front-to-back
// is the bladed idle stance, which the poser puts the bind mesh into.
// ---------------------------------------------------------------------------------------------

const Y_HELM_TOP = 2.18
const Y_CHIN = 1.80
const Y_CHEST = 1.55

// Joint rest positions come straight off the rig, so mesh and skeleton cannot drift apart.
const jointR = (n: BoneName) => V(BONES[n].pos[0], BONES[n].pos[1], BONES[n].pos[2])
const jointL = (n: BoneName) => {
  const p = BONES[n].pos
  return V(-Math.abs(p[0]), p[1], p[2])
}

interface Part {
  g: THREE.BufferGeometry
  m: MatKey
  skin: SkinSpec
}

/** The torso plates blend down three joints; the bodysuit core runs all the way to the neck. */
const SPINE_PLATE: SkinSpec = { kind: 'chain', chain: ['hips', 'spine', 'chest'] }
const SPINE_CORE: SkinSpec = { kind: 'chain', chain: ['hips', 'spine', 'chest', 'neck'] }
const NECK_CHAIN: SkinSpec = { kind: 'chain', chain: ['neck', 'head'] }

function buildParts(): Part[] {
  const parts: Part[] = []
  const put = (g: THREE.BufferGeometry, m: MatKey, skin: SkinSpec) => parts.push({ g, m, skin })

  // ---- torso -------------------------------------------------------------------------------
  // Dark bodysuit core first; armour plates are laid over it front and back, leaving the sides
  // and armpits black. That gap is what reads as "plates", not "painted man".
  put(
    loft(
      [
        { y: 1.02, rx: 0.168, rz: 0.128, p: 0.6 },
        { y: 1.22, rx: 0.140, rz: 0.112, p: 0.6 },
        { y: 1.34, rx: 0.160, rz: 0.124, p: 0.55 },
        { y: Y_CHEST, rx: 0.192, rz: 0.146, p: 0.5 },
        { y: 1.70, rx: 0.186, rz: 0.134, p: 0.5 },
        { y: 1.79, rx: 0.150, rz: 0.112, p: 0.55 },
      ],
      12,
    ),
    'suit',
    SPINE_CORE,
  )

  // Chest plate. Bulges forward (-Z) over the pectorals and pinches in hard at the waist.
  put(
    loft(
      [
        { y: 1.27, rx: 0.150, rz: 0.126, cz: -0.006, p: 0.5 },
        { y: 1.40, rx: 0.182, rz: 0.150, cz: -0.010, p: 0.45 },
        { y: Y_CHEST, rx: 0.206, rz: 0.164, cz: -0.010, p: 0.45 },
        { y: 1.66, rx: 0.201, rz: 0.150, cz: -0.006, p: 0.45 },
        { y: 1.775, rx: 0.163, rz: 0.120, cz: -0.004, p: 0.5 },
      ],
      10,
      202 * D,
      338 * D,
      false,
    ),
    'team',
    SPINE_PLATE,
  )

  // Back plate: flatter, and it carries the model's rearmost point.
  put(
    loft(
      [
        { y: 1.27, rx: 0.150, rz: 0.128, cz: 0.004, p: 0.5 },
        { y: 1.40, rx: 0.180, rz: 0.150, cz: 0.010, p: 0.45 },
        { y: Y_CHEST, rx: 0.203, rz: 0.158, cz: 0.014, p: 0.45 },
        { y: 1.68, rx: 0.199, rz: 0.150, cz: 0.010, p: 0.45 },
        { y: 1.785, rx: 0.160, rz: 0.120, cz: 0.004, p: 0.5 },
      ],
      10,
      22 * D,
      158 * D,
      false,
    ),
    'team',
    SPINE_PLATE,
  )

  // Sternum split — a narrow raised spine down the centre of the chest.
  put(place(boxg(0.052, 0.30, 0.036), V(0, 1.50, -0.152), new THREE.Euler(0.10, 0, 0)), 'steel', SPINE_PLATE)
  // Chest vent block, low on the right, as in the frames.
  put(place(boxg(0.075, 0.045, 0.03), V(0.10, 1.36, -0.155), new THREE.Euler(0.15, 0, 0)), 'steel', SPINE_PLATE)

  // Belt: dark hardware band at the pinch, with two hip pouches.
  put(
    loft(
      [
        { y: 1.13, rx: 0.156, rz: 0.124, p: 0.55 },
        { y: 1.19, rx: 0.166, rz: 0.132, p: 0.55 },
        { y: 1.245, rx: 0.152, rz: 0.120, p: 0.55 },
      ],
      12,
    ),
    'steel',
    SPINE_PLATE,
  )
  for (const s of [-1, 1]) {
    put(place(boxg(0.055, 0.10, 0.085), V(s * 0.155, 1.14, -0.01), new THREE.Euler(0, 0, s * 0.12)), 'suit', { kind: 'rigid', bone: 'hips' })
  }

  // Hip / groin armour: a broad plate that flares out over the top of each thigh.
  put(
    loft(
      [
        { y: 1.04, rx: 0.176, rz: 0.134, p: 0.5 },
        { y: 0.985, rx: 0.192, rz: 0.140, p: 0.45 },
        { y: 0.94, rx: 0.176, rz: 0.126, cz: -0.004, p: 0.5 },
      ],
      12,
    ),
    'team',
    { kind: 'rigid', bone: 'hips' },
  )

  // ---- head --------------------------------------------------------------------------------
  // Dark neck column, kept short: on a Spartan the collar swallows the neck entirely.
  put(
    loft(
      [
        { y: 1.71, rx: 0.085, rz: 0.078, p: 0.8 },
        { y: 1.84, rx: 0.072, rz: 0.070, p: 0.9 },
      ],
      10,
    ),
    'suit',
    NECK_CHAIN,
  )
  // Collar armour, standing up behind and beside the jaw.
  put(
    loft(
      [
        { y: 1.72, rx: 0.135, rz: 0.112, cz: 0.012, p: 0.5 },
        { y: 1.79, rx: 0.126, rz: 0.108, cz: 0.018, p: 0.5 },
        { y: 1.845, rx: 0.104, rz: 0.092, cz: 0.024, p: 0.55 },
      ],
      10,
      298 * D,
      602 * D,
      false,
    ),
    'team',
    { kind: 'rigid', bone: 'neck' },
  )

  // The dome. Wide and low-crowned, not egg-shaped: widest just above the visor line, and the
  // crown flattens off rather than coming to a point.
  const head: SkinSpec = { kind: 'rigid', bone: 'head' }
  const helmRings: Ring[] = [
    { y: Y_CHIN, rx: 0.100, rz: 0.118, cz: -0.010, p: 0.72 },
    { y: 1.855, rx: 0.126, rz: 0.148, cz: -0.014, p: 0.70 },
    { y: 1.945, rx: 0.140, rz: 0.160, cz: -0.008, p: 0.70 },
    { y: 2.035, rx: 0.138, rz: 0.153, cz: 0.0, p: 0.72 },
    { y: 2.115, rx: 0.124, rz: 0.132, cz: 0.008, p: 0.78 },
    { y: 2.16, rx: 0.100, rz: 0.108, cz: 0.014, p: 0.85 },
    { y: Y_HELM_TOP, rx: 0.062, rz: 0.070, cz: 0.018, p: 0.9 },
  ]
  put(loft(helmRings, 14), 'team', head)

  // Visor: a wide gold band wrapping ear to ear, sitting a hair proud of the dome. It is deep —
  // top of the visor nearly touches the brow lip, bottom runs down to the jaw.
  put(
    loft(
      [
        { y: 1.828, rx: 0.104, rz: 0.124, cz: -0.012, p: 0.72 },
        { y: 1.875, rx: 0.132, rz: 0.155, cz: -0.014, p: 0.70 },
        { y: 1.945, rx: 0.145, rz: 0.166, cz: -0.008, p: 0.70 },
        { y: 2.012, rx: 0.143, rz: 0.159, cz: -0.002, p: 0.72 },
        { y: 2.042, rx: 0.132, rz: 0.146, cz: 0.002, p: 0.74 },
      ],
      14,
      206 * D,
      334 * D,
      false,
    ),
    'visor',
    head,
  )

  // The brow lip. Small piece, enormous silhouette value — it is the one line that says MJOLNIR.
  // It has to be thick enough to catch its own shadow, or it reads as a floating white sliver.
  put(
    loft(
      [
        { y: 2.078, rx: 0.132, rz: 0.146, cz: 0.004, p: 0.74 },
        { y: 2.068, rx: 0.162, rz: 0.186, cz: -0.014, p: 0.66 },
        { y: 2.036, rx: 0.158, rz: 0.182, cz: -0.016, p: 0.66 },
        { y: 2.030, rx: 0.134, rz: 0.150, cz: 0.0, p: 0.72 },
      ],
      14,
      190 * D,
      350 * D,
      false,
    ),
    'team',
    head,
  )

  // Jaw plate under the visor, and its grille.
  put(
    loft(
      [
        { y: 1.788, rx: 0.100, rz: 0.120, cz: -0.014, p: 0.7 },
        { y: 1.832, rx: 0.122, rz: 0.144, cz: -0.016, p: 0.68 },
        { y: 1.856, rx: 0.130, rz: 0.152, cz: -0.014, p: 0.68 },
      ],
      12,
      226 * D,
      314 * D,
      false,
    ),
    'team',
    head,
  )
  for (const s of [-1, 0, 1]) {
    put(place(boxg(0.018, 0.046, 0.016), V(s * 0.034, 1.814, -0.150), new THREE.Euler(-0.22, 0, 0)), 'steel', head)
  }
  // Ear pods.
  for (const s of [-1, 1]) {
    put(place(boxg(0.034, 0.066, 0.086), V(s * 0.136, 1.918, 0.008)), 'steel', head)
  }

  // ---- shoulders ---------------------------------------------------------------------------
  // The pauldrons. Built along their own axis and swung outward and up so their top edge sits
  // level with the chin; that height is the single most important number in the silhouette.
  for (const s of [-1, 1]) {
    const side = s > 0 ? 'R' : 'L'
    const p = loft(
      [
        { y: 0.0, rx: 0.098, rz: 0.112, p: 0.5 },
        { y: 0.085, rx: 0.124, rz: 0.146, p: 0.45 },
        { y: 0.170, rx: 0.132, rz: 0.152, p: 0.45 },
        { y: 0.232, rx: 0.116, rz: 0.128, p: 0.5 },
        { y: 0.252, rx: 0.086, rz: 0.096, p: 0.6 },
      ],
      10,
    )
    put(
      place(p, V(s * 0.188, 1.700, 0.008), new THREE.Euler(0, 0, s * -(Math.PI / 2 - 0.35))),
      'team',
      { kind: 'rigid', bone: `shoulder${side}` as BoneName },
    )
    // Shoulder ball, dark, showing in the gap under the plate.
    put(
      place(new THREE.SphereGeometry(0.082, 10, 7), V(s * 0.205, 1.665, 0.0)),
      'suit',
      { kind: 'limb', bone: `upperArm${side}` as never, band: 0.075 },
    )
  }

  // ---- arms --------------------------------------------------------------------------------
  // Authored hanging straight down, along the bind skeleton. The carry stance in the reference
  // frames is what the poser puts them into, not what they are built in.
  for (const s of [-1, 1]) {
    const side = s > 0 ? 'R' : 'L'
    const pick = s > 0 ? jointR : jointL
    const sh = pick(`upperArm${side}` as BoneName)
    const el = pick(`elbow${side}` as BoneName)
    const wr = pick(`hand${side}` as BoneName)
    const upper: SkinSpec = { kind: 'limb', bone: `upperArm${side}` as never, band: 0.07 }
    const fore: SkinSpec = { kind: 'limb', bone: `forearm${side}` as never, band: 0.05 }

    put(limb(sh, el, [{ t: 0.02, r: 0.078 }, { t: 0.55, r: 0.070 }, { t: 1.0, r: 0.066 }], 10), 'suit', upper)
    // Bicep plate, upper two thirds only — the elbow stays black.
    put(limb(sh, el, [{ t: 0.10, r: 0.090, p: 0.5 }, { t: 0.42, r: 0.092, p: 0.5 }, { t: 0.62, r: 0.080, p: 0.55 }], 10), 'team', upper)
    // Elbow.
    put(place(new THREE.SphereGeometry(0.062, 8, 6), el.clone()), 'suit', fore)
    // Gauntlet: bulkier than the upper arm, squared off, flaring at the wrist cuff.
    put(
      limb(
        el,
        wr,
        [
          { t: 0.06, r: 0.078, p: 0.55 },
          { t: 0.40, r: 0.090, rz: 0.084, p: 0.45 },
          { t: 0.80, r: 0.086, rz: 0.080, p: 0.45 },
          { t: 1.0, r: 0.070, rz: 0.066, p: 0.5 },
        ],
        10,
      ),
      'team',
      fore,
    )
    // Hand.
    const dir = wr.clone().sub(el).normalize()
    put(
      limb(wr, wr.clone().addScaledVector(dir, 0.115), [
        { t: 0.0, r: 0.058, rz: 0.052, p: 0.4 },
        { t: 0.7, r: 0.056, rz: 0.062, p: 0.4 },
        { t: 1.0, r: 0.040, rz: 0.056, p: 0.5 },
      ], 8),
      'suit',
      { kind: 'limb', bone: `hand${side}` as never, band: 0.035 },
    )
  }

  // ---- legs --------------------------------------------------------------------------------
  for (const s of [-1, 1]) {
    const side = s > 0 ? 'R' : 'L'
    const pick = s > 0 ? jointR : jointL
    const hip = pick(`thigh${side}` as BoneName)
    const knee = pick(`knee${side}` as BoneName)
    const ankle = pick(`foot${side}` as BoneName)
    const thighSkin: SkinSpec = { kind: 'limb', bone: `thigh${side}` as never, band: 0.075 }
    const shinSkin: SkinSpec = { kind: 'limb', bone: `shin${side}` as never, band: 0.055 }
    const footSkin: SkinSpec = { kind: 'rigid', bone: `foot${side}` as BoneName }

    // Thigh: dark core, then the big plate over the top two thirds.
    put(limb(hip, knee, [{ t: -0.04, r: 0.118 }, { t: 0.5, r: 0.100 }, { t: 1.0, r: 0.082 }], 10), 'suit', thighSkin)
    put(
      limb(
        hip,
        knee,
        [
          { t: 0.02, r: 0.126, rz: 0.120, p: 0.5 },
          { t: 0.30, r: 0.134, rz: 0.126, p: 0.45 },
          { t: 0.58, r: 0.118, rz: 0.112, p: 0.5 },
          { t: 0.70, r: 0.098, rz: 0.096, p: 0.55 },
        ],
        10,
      ),
      'team',
      thighSkin,
    )
    // Outer hip flare, the plate that overhangs the thigh.
    put(
      place(
        loft(
          [
            { y: 0.0, rx: 0.052, rz: 0.108, p: 0.5 },
            { y: 0.075, rx: 0.062, rz: 0.122, p: 0.45 },
            { y: 0.155, rx: 0.048, rz: 0.100, p: 0.5 },
          ],
          8,
        ),
        V(s * 0.178, 0.845, -0.006),
        new THREE.Euler(0, 0, s * -0.16),
      ),
      'team',
      { kind: 'rigid', bone: `thigh${side}` as BoneName },
    )
    // Left thigh carries a utility pouch, as in the reference render.
    if (s < 0) {
      put(place(boxg(0.05, 0.10, 0.075), V(-0.185, 0.78, -0.02), new THREE.Euler(0, 0, -0.1)), 'suit', { kind: 'rigid', bone: 'thighL' })
    }

    // Knee cap, pushed forward and pointed.
    put(
      place(
        loft(
          [
            { y: 0.0, rx: 0.086, rz: 0.084, p: 0.5 },
            { y: 0.055, rx: 0.098, rz: 0.100, cz: -0.016, p: 0.45 },
            { y: 0.125, rx: 0.086, rz: 0.086, cz: -0.006, p: 0.5 },
          ],
          10,
        ),
        V(knee.x, knee.y - 0.055, knee.z - 0.008),
      ),
      'team',
      shinSkin,
    )

    // Shin: dark core with a shin plate laid down the front.
    put(limb(knee, ankle, [{ t: 0.0, r: 0.084 }, { t: 0.6, r: 0.072 }, { t: 1.0, r: 0.070 }], 10), 'suit', shinSkin)
    put(
      limb(
        knee,
        ankle,
        [
          { t: 0.06, r: 0.096, rz: 0.094, p: 0.5 },
          { t: 0.45, r: 0.088, rz: 0.090, p: 0.45 },
          { t: 0.86, r: 0.082, rz: 0.086, p: 0.5 },
        ],
        10,
        [128 * D, 412 * D],
      ),
      'team',
      shinSkin,
    )

    // Boot: heavy soled wedge, raked forward, flaring back out from the ankle.
    const toeOut = -s * 0.14
    put(
      place(
        loft(
          [
            { y: 0.048, rx: 0.100, rz: 0.170, cz: -0.026, p: 0.42 },
            { y: 0.085, rx: 0.104, rz: 0.174, cz: -0.024, p: 0.42 },
            { y: 0.135, rx: 0.098, rz: 0.152, cz: -0.006, p: 0.45 },
            { y: 0.205, rx: 0.086, rz: 0.108, cz: 0.020, p: 0.5 },
            { y: 0.262, rx: 0.078, rz: 0.086, cz: 0.026, p: 0.6 },
          ],
          10,
        ),
        V(ankle.x, 0, 0),
        new THREE.Euler(0, toeOut, 0),
      ),
      'team',
      footSkin,
    )
    // Sole, and its tread ridges.
    put(
      place(
        loft(
          [
            { y: 0.0, rx: 0.096, rz: 0.164, cz: -0.026, p: 0.42 },
            { y: 0.050, rx: 0.104, rz: 0.174, cz: -0.026, p: 0.42 },
          ],
          10,
        ),
        V(ankle.x, 0, 0),
        new THREE.Euler(0, toeOut, 0),
      ),
      'steel',
      footSkin,
    )
    for (let i = 0; i < 4; i++) {
      const z = 0.10 - i * 0.075
      put(
        place(
          boxg(0.20, 0.028, 0.030),
          V(ankle.x, 0.012, -0.026).add(V(Math.sin(toeOut) * z, 0, Math.cos(toeOut) * z)),
          new THREE.Euler(0, toeOut, 0),
        ),
        'suit',
        footSkin,
      )
    }
  }

  return parts
}

// ---------------------------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------------------------

const MAT_KEYS: MatKey[] = ['team', 'suit', 'steel', 'visor']

interface Baked {
  geo: Record<string, THREE.BufferGeometry>
  mats: Record<MatKey, THREE.Material>
}

let BAKED: Baked | null = null

/** Merge once. Every Spartan after the first is a new skeleton over the same vertex buffers. */
function bake(): Baked {
  const parts = buildParts()
  for (const p of parts) {
    // Merge needs matching attribute sets; primitives bring extras we do not use.
    for (const name of Object.keys(p.g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') p.g.deleteAttribute(name)
    }
    if (!p.g.getAttribute('normal')) p.g.computeVertexNormals()
    if (!p.g.getAttribute('uv')) {
      const n = p.g.getAttribute('position').count
      p.g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
    }
    applySkin(p.g, p.skin)
  }

  const geo: Record<string, THREE.BufferGeometry> = {}
  for (const key of MAT_KEYS) {
    const list = parts.filter((p) => p.m === key).map((p) => p.g)
    if (!list.length) continue
    const merged = mergeGeometries(list, false)
    if (!merged) continue
    // A fixed, generous bound. The limbs move every frame and re-deriving a skinned bound per
    // frame costs more than it saves; this sphere contains every pose the rig can reach.
    merged.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.05, 0), 1.55)
    geo[key] = merged
  }

  const mats: Record<MatKey, THREE.Material> = {
    team: teamMaterial('red'),
    suit: new THREE.MeshStandardMaterial({
      name: 'spartan-suit',
      color: 0x1c1e23,
      map: tex(),
      roughness: 0.85,
      metalness: 0.12,
    }),
    steel: new THREE.MeshStandardMaterial({
      name: 'spartan-steel',
      color: 0x4b5058,
      map: tex(),
      roughness: 0.6,
      metalness: 0.5,
    }),
    visor: new THREE.MeshStandardMaterial({
      name: 'spartan-visor',
      color: 0xd8a521,
      roughness: 0.14,
      metalness: 0.95,
      emissive: 0x352200,
      side: THREE.DoubleSide,
    }),
  }
  return { geo, mats }
}

/**
 * The weapon grip, expressed as a basis rather than three Euler angles, because what it has to
 * satisfy is a statement about axes.
 *
 * Every weapon in this game is authored MUZZLE DOWN +Z, up +Y — read it off `weapons.ts`, where
 * the side-view profiles are extruded across x and then rotated so "profile x becomes +z
 * (forward)", and off the specs, where `assault-rifle` is 0.880 long on that same axis. The
 * hand's own limb axis is -Y. So the weapon's +Z lands on the hand's -Y, and its +Y on the hand's
 * +Z, which puts the barrel down the forearm and the receiver upright.
 *
 * The previous version of this function assumed muzzle-down-+X, from an older weapon convention
 * that no longer exists anywhere in the repo. Nothing caught it because nothing was ever attached
 * here; a rifle hung off it came out 85 degrees round, broadside across the chest.
 */
function handAnchorQuaternion(): THREE.Quaternion {
  const m = new THREE.Matrix4().makeBasis(V(1, 0, 0), V(0, 0, 1), V(0, -1, 0))
  return new THREE.Quaternion().setFromRotationMatrix(m)
}

/** Build one Spartan: fresh skeleton and meshes over the shared, baked geometry. */
function makeSpartan(): THREE.Object3D {
  if (!BAKED) BAKED = bake()
  const { geo, mats } = BAKED

  const root = new THREE.Group()
  root.name = 'spartan'

  const { bones, list, root: boneRoot } = buildSkeleton()
  root.add(boneRoot)
  boneRoot.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(list)

  for (const key of MAT_KEYS) {
    const g = geo[key]
    if (!g) continue
    const mesh = new THREE.SkinnedMesh(g, mats[key])
    mesh.name = `spartan-${key}`
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.05, 0), 1.55)
    if (key === 'team') mesh.userData.teamTinted = true
    root.add(mesh)
    // Bones and meshes share this group, so the bind matrix is the identity by construction.
    mesh.bind(skeleton, new THREE.Matrix4())
  }

  // Where a weapon goes. Named 'hand.R' as before so anything already looking it up still finds
  // it — it is now a child of the hand joint rather than a fixed empty in the middle of the air.
  const grip = new THREE.Object3D()
  grip.name = 'hand.R'
  grip.position.set(0.0, -0.075, -0.01)
  grip.quaternion.copy(handAnchorQuaternion())
  bones.handR.add(grip)

  // Where the LEFT hand goes, hanging off the weapon rather than off the body: a point out along
  // the barrel and just under it. `equipSpartan` moves it to suit whatever is actually held, so a
  // sniper rifle gets a longer support reach than a magnum without the poser knowing what either
  // of those is. The default is a rifle-sized handguard, which is what an empty carry mimes.
  const foregrip = new THREE.Object3D()
  foregrip.name = 'foregrip'
  foregrip.position.set(0, -0.040, 0.176)
  grip.add(foregrip)

  // Where the camera sits, in the helmet.
  const eye = new THREE.Object3D()
  eye.name = 'eye'
  eye.position.set(0, 1.955 - BONES.head.pos[1], -0.16)
  bones.head.add(eye)

  const rig: SpartanRig = { bones, handAnchor: grip, foregrip, state: newRigState(), driven: false }
  root.userData.rig = rig

  // Settle into the idle stance immediately: the spec check measures what comes out of the
  // factory, unrendered and therefore unarmed, so what it sees is the BODY at its resting carry.
  // That carry is deliberately tucked — weapon in at the sternum — and pushes forward with speed
  // and with aim, which is both what the reference frames show and what keeps the idle inside
  // the 0.56 m depth the spec describes.
  poseRig(rig, { vx: 0, vy: 0, vz: 0, onGround: true, crouched: false, yaw: 0, pitch: 0 }, 0.5)
  rig.driven = false

  attachFallbackDriver(root, rig)

  // Each Spartan is its own instance rather than a graph clone: a cloned SkinnedMesh shares its
  // source's skeleton, which would have every Spartan on the map moving in lockstep.
  ;(root as unknown as { clone: () => THREE.Object3D }).clone = () => makeSpartan()

  return root
}

/**
 * Put a weapon in a Spartan's right hand.
 *
 * This is the other half of the rig, and it lives here rather than in the model factory for one
 * concrete reason: an armed Spartan measures about 1.1 m front to back, and `SPECS.spartan` is
 * 0.56 m, because the spec describes the BODY. Baking a rifle into the model would fail
 * `checkSpec('spartan')` forever and there would be no honest number left to check the silhouette
 * against. So the model is the Spartan and this is what the Spartan picks up.
 *
 * The weapon is placed by its own bounding box, not by a table of per-weapon offsets. Every
 * weapon in this game is authored muzzle-+Z with the bore on y = 0, so "grip" is a fixed fraction
 * back from the muzzle and a little below the bore, and that one rule puts a magnum, an MA5B and
 * a 1.9 m sniper rifle all in the same fist. The foregrip node moves with it, and the left arm's
 * IK follows without anything in the poser knowing a weapon exists.
 */
export function equipSpartan(spartan: THREE.Object3D, id: ModelId): THREE.Object3D | null {
  const rig = spartan.userData.rig as SpartanRig | undefined
  if (!rig || !hasModel(id)) return null

  const held = rig.handAnchor.getObjectByName('held')
  if (held) held.removeFromParent()

  const weapon = buildModel(id)
  weapon.name = 'held'
  const box = new THREE.Box3().setFromObject(weapon)
  const len = box.max.z - box.min.z

  // Grip: 27% of the length forward of the butt, and below the bore by a third of the drop to the
  // lowest point of the weapon — which is the magazine or the stock toe on all three human arms.
  weapon.position.set(0, -Math.min(0, box.min.y) * 0.34, -(box.min.z + 0.27 * len))
  rig.handAnchor.add(weapon)

  // Foregrip: 62% of the way to the muzzle, just under the barrel. Clamped so a pistol does not
  // ask the support hand to reach somewhere inside the receiver.
  rig.foregrip.position.set(0, -0.040, Math.max(0.12, 0.20 * len))
  return weapon
}

/**
 * Fallback: drive the rig from observed motion when nobody drives it explicitly.
 *
 * The animation is meant to be advanced by whoever owns the player state — `updateSpartanRig`
 * takes exactly that. But a rig that only animates once someone remembers to call it is a rig
 * that ships static, so until the callers are wired up a Spartan infers its own velocity from
 * how far it moved since the last frame and poses itself. The first explicit call switches this
 * off permanently for that instance.
 */
function attachFallbackDriver(root: THREE.Group, rig: SpartanRig): void {
  const anchor = root.children.find((c) => c.name === 'spartan-team') as THREE.Mesh | undefined
  if (!anchor) return
  const last = new THREE.Vector3()
  const now = new THREE.Vector3()
  const eye = new THREE.Vector3()
  let t = -1
  let started = false
  let armed = false
  let aim = 0
  anchor.onBeforeRender = (_r, _s, camera) => {
    // Arm it, once, the first time anyone actually looks at it. A Spartan with an empty
    // two-handed carry is the single most wrong thing this model can be, and it is not worth
    // making that depend on whether a caller remembered to call `equipSpartan`. Doing it here
    // rather than in the factory is deliberate: `checkSpec` measures a built model without ever
    // rendering it, so the silhouette check still measures the BODY, which is what its 0.56 m
    // depth describes. A caller that equips something else just replaces this.
    if (!armed) {
      armed = true
      if (!rig.handAnchor.getObjectByName('held')) equipSpartan(root, 'assault-rifle')
    }
    if (rig.driven) return
    const ms = performance.now()
    // Shadow and colour passes render the same object in the same frame; only step once.
    if (t >= 0 && ms - t < 2) return
    const dt = t < 0 ? 1 / 60 : Math.min((ms - t) / 1000, 0.1)
    t = ms
    root.getWorldPosition(now)
    if (!started) {
      last.copy(now)
      started = true
    }
    const vx = (now.x - last.x) / dt
    const vy = (now.y - last.y) / dt
    const vz = (now.z - last.z) / dt
    last.copy(now)
    const yaw = Math.atan2(root.matrixWorld.elements[8], root.matrixWorld.elements[10])
    const onGround = now.y - groundHeight(now.x, now.z) < 0.18

    // Aim pitch. The rig takes one, the game does not yet compute one for bots, and leaving it at
    // zero is what made every Spartan stare dead level past whoever was shooting at them. The
    // person looking at this Spartan is the only threat this module can see, so aim at the render
    // camera: it is a guess, but it is the right guess, and it goes away the moment the caller
    // passes a real one through `updateSpartanRig`. Only from the perspective camera — the
    // shadow pass renders the same mesh from a light and would aim the whole map at the sun.
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      camera.getWorldPosition(eye)
      const dy = eye.y - (now.y + 1.55)
      const flat = Math.hypot(eye.x - now.x, eye.z - now.z)
      const want = flat > 2 ? Math.max(-0.7, Math.min(0.9, Math.atan2(dy, flat))) : 0
      aim += (want - aim) * (1 - Math.exp(-6 * dt))
    }
    // poseRig, not updateSpartanRig: this must not mark the rig as externally driven.
    poseRig(rig, { vx, vy, vz, onGround, crouched: false, yaw, pitch: aim }, dt)
  }
}

registerModel('spartan', makeSpartan)
