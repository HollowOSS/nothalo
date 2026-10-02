import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TEAM_TINT, type ModelId, type Team } from '../../../shared/assets.ts'

/**
 * Owner: the first-person arms — a pair of MJOLNIR forearms and hands wrapped around whatever
 * the player is holding.
 *
 * Three things live here, and they are all in service of the same illusion:
 *
 *  1. A rig table. Every weapon says where its grip and its foregrip are, so a hand lands on a
 *     pistol grip and on a rifle handguard without either being hardcoded. A weapon model can
 *     override the table by carrying `userData.anchors` or child objects named `anchor:grip` /
 *     `anchor:foregrip`, so the weapon author owns the truth when they want to.
 *  2. The hands themselves. Armoured gauntlet, back-of-hand plate, four articulated fingers of
 *     three phalanges each plus a thumb, posed by wrapping them around a cylinder at build time
 *     and baking the result — so the wrap is real geometry rather than a mitten, and it still
 *     costs one draw call per material. The trigger finger is kept live in its own group,
 *     because it is the only finger anybody watches.
 *  3. Part extraction. The weapon models merge everything into one buffer per material, which is
 *     right for the world model and useless for animation, so a slide or a magazine is cut back
 *     out of the merged buffer by bounding box. Nothing in weapons.ts has to change for a slide
 *     to cycle, and if a weapon is re-authored and a region catches nothing, the part simply
 *     does not move.
 *
 * Only mid-forearm forward is modelled: everything behind that is off-camera at any FOV a person
 * would play at, and an upper arm you cannot see is triangles you paid for and lost.
 */

/* ------------------------------------------------------------------ rig */

export type Vec3 = readonly [number, number, number]
export interface Box3ish {
  readonly min: Vec3
  readonly max: Vec3
}

/**
 * How one hand meets one weapon, in shooter space: +z down the barrel, +y up, +x the shooter's
 * right. That is the mirror of the weapon models' own x — with the muzzle pointing away from the
 * camera and up still up, a model's +x lands on the left of the screen — so the anchors below are
 * written the way a person would describe them and flipped once, in `buildArms`.
 */
export interface HandAnchor {
  /** Where the middle of the grip the hand closes around sits. */
  readonly pos: Vec3
  /** Hand orientation. The hand is authored around a grip that runs along its local +Y. */
  readonly euler: Vec3
  /** Direction from the wrist back towards the elbow. Weapon space, normalised on use. */
  readonly forearm: Vec3
  /** Half-width of the thing being held, across the palm. The fingers close on to it. */
  readonly grip: number
  /** Half-depth of it, front to back. A pistol grip is deeper than it is wide; default 1.3x. */
  readonly depth?: number
  /** `cup` opens the fingers so the support hand can close over the firing hand instead. */
  readonly pose?: 'wrap' | 'cup'
  /**
   * How fat the glove is, independent of what it is closed around. MJOLNIR gauntlets are
   * enormous — in CE the glove reads about the size of the pistol's whole receiver — so the
   * meat of the hand is scaled up while the wrap radius stays honest to the grip. Anywhere the
   * two disagree the gun sinks into the fist, which is what makes the hand read as holding it
   * instead of hovering beside it. Default 1.
   */
  readonly bulk?: number
  /**
   * Multiplies the rig's forearm length for this hand alone. The firing arm on a pistol is
   * almost entirely behind the receiver from the shooter's own eye, so it gets a stub; the
   * support arm is the one that has to leave the bottom of the frame convincingly.
   */
  readonly arm?: number
}

export interface MovingPart {
  /**
   * A named object in an authored model. Preferred over cutting triangles out by region: the
   * Blender files already group a pump or a bolt as its own object, and a box drawn round one
   * inevitably takes a slice of the barrel behind it with it.
   */
  readonly node?: string
  readonly region: Box3ish
  /** Travel direction and distance, weapon space, at full extension. */
  readonly throw: Vec3
  /**
   * Restrict the cut to these material meshes, by the suffix weapons.ts names them with
   * (`magnum:gun`, `magnum:grip`, ...). A box alone cannot separate a magazine from the grip it
   * sits inside; a box plus "the metal one, not the rubber one" can.
   */
  readonly only?: readonly string[]
}

/** Where the whole assembly sits in front of the eye, per weapon. */
export interface Hold {
  /** Viewmodel scale. A rifle is three times a pistol's length and cannot be shown at its size. */
  readonly scale: number
  /** Rest position of the model origin in camera space, and where it goes on aiming down sights. */
  readonly hip: Vec3
  readonly ads: Vec3
  /** Cant at the hip: rolled in towards the centreline, radians. */
  readonly cant: Vec3
  /**
   * Metres of forearm rendered behind the wrist, in world units — not model units, so a rifle
   * held at half a pistol's scale still gets an arm of the same apparent thickness.
   *
   * This wants to be small. CE renders *no* forearm: in the reference shots the glove's topmost
   * pixel is 72% of the way down the frame and the arm has already left through the bottom edge
   * within a hand's width of the wrist. A third of a metre of arm — which is what an anatomically
   * honest forearm would be — puts two planks up the middle of the screen and turns the
   * silhouette from "a gun" into "an M". Default 0.10.
   */
  readonly forearm?: number
}

export interface WeaponRig {
  readonly hold: Hold
  readonly right: HandAnchor
  readonly left: HandAnchor
  /** Where the trigger sits, so the index finger reaches for it rather than a guessed point. */
  readonly trigger: Vec3
  /** The reciprocating mass: a pistol slide, a rifle's bolt, a shotgun's forend. */
  readonly slide?: MovingPart
  /**
   * Seconds for one full open-and-shut of that mass. Left out, it follows the rate of fire,
   * which is right for a self-loading action and wrong for one a hand works: a pump stroke is
   * about a second whatever the gun's cadence, and at nine cycles a second it is a twitch.
   */
  readonly cycleSeconds?: number
  /** The magazine, which leaves during a reload. */
  readonly mag?: MovingPart
  /** Seconds a full reload takes. */
  readonly reload: number
}

/**
 * Measured off the weapon models in weapons.ts: the magnum's grip runs from (-0.068, -0.032)
 * down to (-0.124, -0.185) in its side profile, which is a 20 degree rake, and the MA5B's
 * handguard is the box from z 0.205 to 0.455 about the bore line. Those two facts are the whole
 * of the placement problem.
 */
const RIGS: Partial<Record<ModelId, WeaponRig>> = {
  'battle-rifle': {
    hold:{scale:.46,hip:[.19,-.205,-.71],ads:[0,-.12,-.45],cant:[.03,.08,-.06],forearm:.09},
    right:{pos:[0,-.09,-.12],euler:[-Math.PI/2,0,0],forearm:[.12,-1.5,-.35],grip:.032},
    left:{pos:[0,-.054,.30],euler:[0,0,Math.PI/2],forearm:[-.2,-1.5,-.4],grip:.045},
    trigger:[0,-.078,-.07],reload:2.4,
    mag:{node:'br-magazine',region:{min:[0,0,0],max:[0,0,0]},throw:[0,-.35,-.03]},
    slide:{node:'br-bolt',region:{min:[0,0,0],max:[0,0,0]},throw:[0,0,-.07]},
  },
  needler:{
    hold:{scale:.46,hip:[.21,-.24,-.72],ads:[0,-.15,-.45],cant:[.03,.08,-.09],forearm:.08},
    right:{pos:[0,-.08,-.17],euler:[-Math.PI/2,0,0],forearm:[.1,-1.5,-.4],grip:.035},
    left:{pos:[-.02,-.12,.19],euler:[0,0,Math.PI/2],forearm:[-.2,-1.5,-.4],grip:.05},
    trigger:[0,-.10,-.04],reload:2,
  },
  'gravity-hammer':{
    hold:{scale:.42,hip:[.22,-.30,-.95],ads:[.31,-.30,-.67],cant:[-.12,-.15,-.28],forearm:.12},
    right:{pos:[0,-.37,0],euler:[-Math.PI/2,0,0],forearm:[.2,-.9,-.6],grip:.045},
    left:{pos:[0,.18,0],euler:[-Math.PI/2,0,0],forearm:[-.5,-1,-.5],grip:.045},
    trigger:[0,-.37,0],reload:0,
  },
  // M6D. Its grip is a near-vertical trapezoid from y -0.033 down to -0.186, deep front to back;
  // the trigger sits 0.07 forward of the grip's centre, and the magazine is the box below y
  // -0.156 that is metal where the grip above it is rubber.
  magnum: {
    hold: {
      scale: 0.84, hip: [0.125, -0.155, -0.52], ads: [0, -0.150, -0.42],
      cant: [0.02, 0.075, -0.10], forearm: 0.070,
    },
    // The firing hand is almost entirely behind the receiver from the shooter's own eye, so it is
    // built for the two or three knuckles that clear the frame's right edge and nothing else.
    right: { pos: [0, -0.070, -0.010], euler: [-Math.PI / 2, 0, 0], forearm: [0.05, -1.60, -0.30], grip: 0.023, depth: 0.044, bulk: 1.10, arm: 0.85 },
    // The support hand is the one the shooter actually sees: it closes over the firing hand
    // rather than round the grip, so its wrap radius is a fist's, not a grip's, and its palm
    // stands proud of the weapon's left edge as the dark glove the reference shows.
    left: {
      pos: [-0.006, -0.094, -0.010], euler: [-Math.PI / 2, 0, 0.12],
      forearm: [-0.10, -1.60, -0.30], grip: 0.031, depth: 0.042, bulk: 1.55,
    },
    trigger: [0.060, -0.050, 0],
    slide: {
      region: { min: [-0.06, -0.005, -0.14], max: [0.06, 0.09, 0.19] },
      throw: [0, 0, -0.026],
      only: ['gun', 'gunLite', 'lens', 'tint'],
    },
    mag: {
      region: { min: [-0.05, -0.30, -0.080], max: [0.05, -0.156, 0.010] },
      throw: [0, -0.30, -0.01],
      only: ['gun', 'gunLite'],
    },
    reload: 1.9,
  },
  // MA5B. The grip is the teardrop cut-out in the stock, so the fingers go through the hole and
  // the palm sits behind the strap; the support hand takes the ribbed handguard at z 0.21. Its
  // magazine is inside the receiver and never shows, so the reload uses the spare in the hand.
  'assault-rifle': {
    hold: {
      scale: 0.46, hip: [0.20, -0.205, -0.50], ads: [0, -0.105, -0.40],
      cant: [0.06, 0.09, -0.09], forearm: 0.085,
    },
    right: { pos: [0, -0.122, -0.130], euler: [-Math.PI / 2, 0, 0], forearm: [0.12, -1.50, -0.34], grip: 0.032, depth: 0.036, bulk: 1.10, arm: 0.85 },
    left: { pos: [0, -0.094, 0.205], euler: [0, 0, Math.PI / 2], forearm: [-0.16, -1.50, -0.32], grip: 0.038, depth: 0.042, bulk: 1.45 },
    trigger: [-0.086, -0.075, 0],
    reload: 2.1,
  },
  'rocket-launcher': {
    hold: {scale:0.48,hip:[0.16,-0.16,-0.48],ads:[0,-0.10,-0.44],cant:[0.01,0.07,-0.06],forearm:0.09},
    right: {pos:[0,-0.20,-0.27],euler:[-Math.PI/2,0,0],forearm:[0.12,-1.5,-0.4],grip:0.032,depth:0.045},
    left: {pos:[0,-0.12,0.26],euler:[0,0,Math.PI/2],forearm:[-0.16,-1.5,-0.4],grip:0.075,depth:0.06},
    trigger:[0,-0.15,-0.2],reload:3.5,
  },
  // The M90 is held like the rifle but is longer and heavier, so it rides lower and further
  // back; the support hand takes the sliding forend at z 0.204 rather than a fixed handguard.
  shotgun: {
    hold: {
      scale: 0.40, hip: [0.15, -0.150, -0.52], ads: [0, -0.100, -0.42],
      cant: [0.05, 0.09, -0.09], forearm: 0.085,
    },
    right: { pos: [0, -0.096, -0.186], euler: [-Math.PI / 2, 0, 0], forearm: [0.12, -1.50, -0.34], grip: 0.032, depth: 0.038, bulk: 1.10, arm: 0.85 },
    left: { pos: [0, -0.048, 0.204], euler: [0, 0, Math.PI / 2], forearm: [-0.16, -1.50, -0.32], grip: 0.040, depth: 0.044, bulk: 1.45 },
    trigger: [-0.086, -0.070, 0],
    // The forend is its own object in the authored file, so the pump is the whole assembly —
    // flashlight, finger scallops and amber button together — rather than a box cut out of a
    // merged mesh. Footage puts the stroke at about a second, which is also this gun's whole
    // rate of fire: you can shoot it exactly as fast as you can work it.
    slide: {
      node: 'forend',
      region: { min: [-0.05, -0.10, 0.06], max: [0.05, 0.01, 0.42] },
      throw: [0, 0, -0.088],
    },
    cycleSeconds: 0.85,
    reload: 2.8,
  },
  // The sword is held crosswise in one hand at the hilt's waist, so there is no support hand
  // on it at all — the left hand sits clear, and the blades run out past the bottom of frame.
  'energy-sword': {
    hold: {
      scale: 0.34, hip: [0.17, -0.150, -0.40], ads: [0.10, -0.120, -0.36],
      cant: [0.10, 0.16, -0.20], forearm: 0.075,
    },
    right: { pos: [0, 0, 0], euler: [-Math.PI / 2, 0, 0], forearm: [0.14, -1.40, -0.30], grip: 0.034, depth: 0.050, bulk: 1.15, arm: 0.80 },
    left: { pos: [-0.10, -0.170, -0.120], euler: [0, 0, Math.PI / 2], forearm: [-0.20, -1.50, -0.30], grip: 0.040, depth: 0.040, bulk: 1.35 },
    trigger: [0, -0.030, 0],
    reload: 0,
  },
  sniper: {
    hold: {
      scale: 0.46, hip: [0.14, -0.168, -0.50], ads: [0, -0.098, -0.40],
      cant: [0.02, 0.09, -0.08], forearm: 0.085,
    },
    right: { pos: [0, -0.112, -0.185], euler: [-Math.PI / 2, 0, 0], forearm: [0.12, -1.50, -0.34], grip: 0.030, depth: 0.042, bulk: 1.10, arm: 0.85 },
    left: { pos: [0, -0.056, 0.168], euler: [0, 0, Math.PI / 2], forearm: [-0.16, -1.50, -0.32], grip: 0.050, depth: 0.046, bulk: 1.45 },
    trigger: [-0.100, -0.080, 0],
    reload: 2.4,
  },
}

/** Fallback for a weapon with no entry: hold it by the back third, under the bore line. */
function genericRig(model: THREE.Object3D): WeaponRig {
  const box = new THREE.Box3().setFromObject(model)
  const back = box.min.z + (box.max.z - box.min.z) * 0.28
  const fore = box.min.z + (box.max.z - box.min.z) * 0.72
  const low = box.min.y * 0.55
  return {
    hold: { scale: 0.6, hip: [0.12, -0.150, -0.52], ads: [0, -0.092, -0.42], cant: [0.02, 0.08, -0.09], forearm: 0.09 },
    right: { pos: [0, low, back], euler: [0.2, 0, 0], forearm: [0.12, -1.50, -0.34], grip: 0.028, depth: 0.040, bulk: 1.10, arm: 0.85 },
    left: { pos: [0, low * 0.4, fore], euler: [Math.PI / 2, 0, 0], forearm: [-0.16, -1.50, -0.32], grip: 0.046, depth: 0.040, bulk: 1.45 },
    trigger: [back + 0.04, low * 0.75, 0],
    reload: 2.0,
  }
}

/**
 * The rig for a weapon. A model may publish its own anchors — `userData.anchors = { grip, foregrip }`
 * as `{ pos, euler }`, or empty child objects named `anchor:grip` and `anchor:foregrip` — and those
 * win over the table, so the hands follow the gun if the gun moves.
 */
export function rigFor(id: ModelId, model: THREE.Object3D): WeaponRig {
  const imported:Partial<Record<ModelId,{right:Vec3;left:Vec3}>>={
    smg:{right:[0,-.072,-.027],left:[0,-.08,.165]},
    'plasma-pistol':{right:[0,-.015,-.082],left:[0,-.065,-.08]},
    'plasma-rifle':{right:[0,-.04,-.025],left:[0,-.09,-.025]},
    needler:{right:[0,-.022,-.024],left:[0,-.08,-.024]},
  }
  const original=RIGS[id]??(['smg','plasma-pistol','plasma-rifle'].includes(id)?RIGS.magnum!:genericRig(model))
  const fit=imported[id]
  const base=fit?{...original,right:{...original.right,pos:fit.right},left:{...original.left,pos:fit.left}}:original
  const override = readAnchors(model)
  if (!override.right && !override.left) return base
  return {
    ...base,
    right: override.right ? { ...base.right, ...override.right } : base.right,
    left: override.left ? { ...base.left, ...override.left } : base.left,
  }
}

type AnchorPatch = { pos?: Vec3; euler?: Vec3 }

function readAnchors(model: THREE.Object3D): { right?: AnchorPatch; left?: AnchorPatch } {
  const out: { right?: AnchorPatch; left?: AnchorPatch } = {}
  const data = model.userData?.anchors as { grip?: AnchorPatch; foregrip?: AnchorPatch } | undefined
  if (data?.grip) out.right = data.grip
  if (data?.foregrip) out.left = data.foregrip
  model.traverse((o) => {
    const patch: AnchorPatch = {
      pos: [o.position.x, o.position.y, o.position.z],
      euler: [o.rotation.x, o.rotation.y, o.rotation.z],
    }
    // Blender appends numeric suffixes when several imported assets share anchor names.
    if (o.name === 'anchor:grip' || o.name.startsWith('anchor:grip.')) out.right = patch
    if (o.name === 'anchor:foregrip' || o.name.startsWith('anchor:foregrip.')) out.left = patch
  })
  return out
}

/* ------------------------------------------------------------------ part extraction */

/**
 * Cut the triangles inside `region` out of a merged model and hand them back as their own group,
 * so they can be animated. The rest of the model is rebuilt without them.
 *
 * By triangle centroid, which is what makes it stable: a slide's outer faces all sit well inside
 * the box even when its bottom face lies exactly on the boundary.
 */
export function extractPart(root: THREE.Object3D, spec: MovingPart): THREE.Group | null {
  const box = new THREE.Box3(
    new THREE.Vector3(...spec.region.min),
    new THREE.Vector3(...spec.region.max),
  )
  const group = new THREE.Group()
  group.name = 'moving-part'
  const c = new THREE.Vector3()
  let found = false

  const meshes: THREE.Mesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && m.geometry) meshes.push(m)
  })

  for (const mesh of meshes) {
    if (spec.only && !spec.only.some((k) => mesh.name.endsWith(`:${k}`))) continue
    const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry
    const pos = geo.attributes.position
    const tris = pos.count / 3
    const take = new Uint8Array(tris)
    let taken = 0
    for (let t = 0; t < tris; t++) {
      const i = t * 3
      c.set(
        (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3,
        (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3,
        (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3,
      )
      if (box.containsPoint(c)) {
        take[t] = 1
        taken++
      }
    }
    if (taken === 0 || taken === tris) {
      if (taken === tris) {
        // The whole mesh moves. Reparent it rather than rebuilding it.
        mesh.removeFromParent()
        group.add(mesh)
        found = true
      }
      continue
    }
    const moving = subset(geo, take, 1, taken)
    const staying = subset(geo, take, 0, tris - taken)
    mesh.geometry.dispose()
    mesh.geometry = staying
    const part = new THREE.Mesh(moving, mesh.material)
    part.name = `${mesh.name}:moving`
    part.castShadow = false
    group.add(part)
    found = true
  }

  if (!found) return null
  root.add(group)
  return group
}

/** Rebuild a non-indexed geometry from the triangles whose flag matches `want`. */
function subset(geo: THREE.BufferGeometry, flags: Uint8Array, want: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  for (const name of Object.keys(geo.attributes)) {
    const src = geo.attributes[name] as THREE.BufferAttribute
    const size = src.itemSize
    const dst = new Float32Array(count * 3 * size)
    let w = 0
    for (let t = 0; t < flags.length; t++) {
      if (flags[t] !== want) continue
      for (let v = 0; v < 3; v++) {
        const i = (t * 3 + v) * size
        for (let k = 0; k < size; k++) dst[w++] = (src.array as ArrayLike<number>)[i + k]
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(dst, size))
  }
  return out
}

/* ------------------------------------------------------------------ armour surfaces */

/**
 * The same mid-grey scuffed plate the Spartan body uses, so first and third person agree: the
 * team tint multiplies through it at nearly full strength, and the mottling stops a gauntlet
 * held 40 cm from the camera reading as flat plastic.
 */
function plateTexture(): THREE.CanvasTexture {
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  g.fillStyle = '#c6c6c6'
  g.fillRect(0, 0, S, S)
  let seed = 20011115
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < 90; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const r = 4 + rnd() * 22
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    grd.addColorStop(0, rnd() < 0.6 ? 'rgba(64,64,64,0.32)' : 'rgba(255,255,255,0.28)')
    grd.addColorStop(1, 'rgba(128,128,128,0)')
    g.fillStyle = grd
    g.fillRect(x - r, y - r, r * 2, r * 2)
  }
  for (let i = 0; i < 70; i++) {
    const x = rnd() * S
    const y = rnd() * S
    const len = 2 + rnd() * 16
    const ang = rnd() * Math.PI * 2
    g.strokeStyle = rnd() < 0.5 ? 'rgba(56,54,52,0.38)' : 'rgba(250,250,250,0.30)'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len)
    g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.repeat.set(3, 3)
  t.anisotropy = 4
  return t
}

let TEX: THREE.CanvasTexture | null = null
function tex(): THREE.CanvasTexture {
  if (!TEX) TEX = plateTexture()
  return TEX
}

type MatKey = 'plate' | 'suit' | 'steel'

/**
 * Materials are per-team and built once. The plate carries the name weapons.ts looks for, so a
 * team swap applied to the held weapon retints the arms with it and nothing gets out of step.
 */
const matCache = new Map<Team, Record<MatKey, THREE.MeshStandardMaterial>>()
function materials(team: Team): Record<MatKey, THREE.MeshStandardMaterial> {
  let m = matCache.get(team)
  if (!m) {
    m = {
      plate: new THREE.MeshStandardMaterial({
        name: 'team-tint',
        color: TEAM_TINT[team],
        map: tex(),
        roughness: 0.5,
        metalness: 0.24,
      }),
      suit: new THREE.MeshStandardMaterial({ color: 0x1a1c21, map: tex(), roughness: 0.86, metalness: 0.1 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x494e56, map: tex(), roughness: 0.55, metalness: 0.55 }),
    }
    matCache.set(team, m)
  }
  return m
}

/* ------------------------------------------------------------------ geometry helpers */

type Parts = Map<MatKey, THREE.BufferGeometry[]>

function put(parts: Parts, key: MatKey, geo: THREE.BufferGeometry): void {
  const list = parts.get(key)
  const g = geo.index ? geo.toNonIndexed() : geo
  if (list) list.push(g)
  else parts.set(key, [g])
}

function meshes(parts: Parts, team: Team, name: string): THREE.Mesh[] {
  const mats = materials(team)
  const out: THREE.Mesh[] = []
  for (const [key, list] of parts) {
    const merged = mergeGeometries(list, false)
    if (!merged) continue
    merged.computeVertexNormals()
    const m = new THREE.Mesh(merged, mats[key])
    m.name = `${name}:${key}`
    m.castShadow = false
    m.receiveShadow = false
    out.push(m)
  }
  return out
}

const UP = new THREE.Vector3(0, 1, 0)

/** A tapered link between two points: a finger bone, a forearm, a wrist. */
function link(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, seg = 8): THREE.BufferGeometry {
  const len = a.distanceTo(b)
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false)
  const q = new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize())
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)))
  return g
}

/**
 * An armour plate: a slab of size (w across, t thick, l long) laid at `centre` with its thickness
 * along `out` and its length along `along`. Plates are how a tube of finger becomes a gauntlet.
 */
function plate(centre: THREE.Vector3, out: THREE.Vector3, along: THREE.Vector3, w: number, t: number, l: number): THREE.BufferGeometry {
  const z = along.clone().normalize()
  const y = out.clone().addScaledVector(z, -out.dot(z)).normalize()
  const x = new THREE.Vector3().crossVectors(y, z)
  const g = new THREE.BoxGeometry(w, t, l)
  const m = new THREE.Matrix4().makeBasis(x, y, z)
  m.setPosition(centre)
  g.applyMatrix4(m)
  return g
}

/** An axis-aligned block in hand space, for the bulk of the palm and the cuff. */
function slab(cx: number, cy: number, cz: number, w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.18)
  g.translate(cx, cy, cz)
  return g
}

/* ------------------------------------------------------------------ the hand */

/**
 * A hand is authored around a grip that runs up its local +Y through the origin. `s` is +1 for
 * the right hand and -1 for the left; every x is multiplied by it, which mirrors the hand
 * without mirroring any winding.
 *
 * Fingers are laid on an arc rather than chained by angle, because chaining gets the wrap wrong
 * the moment the grip changes size: joint j sits at radius R_j and bearing phi_j about the grip
 * axis, with phi 0 out at the knuckle side and phi 180 folded round to the far side, and R
 * closing in a little each joint so the fingertips tuck under instead of orbiting. Feed it a
 * fatter grip and the same hand opens out around it, which is exactly what a hand does.
 */
interface HandPose {
  readonly s: 1 | -1
  readonly grip: number
  readonly depth: number
  readonly open: boolean
  /** Multiplies the meat of the hand — palm, cuff, finger thickness — but not the wrap radius. */
  readonly bulk: number
}

/** Knuckle heights up the grip: index at the top, little finger at the bottom. */
const FINGER_Y = [0.048, 0.019, -0.010, -0.038]

/**
 * A point on the wrap at bearing `phi` and clearance `pad`, at height `y`.
 *
 * The wrap is an ellipse, not a circle, because no grip is round: a pistol grip is half again as
 * deep as it is wide, and a hand closed on a circle of its width leaves the fingertips hanging in
 * the air past the front of it.
 */
function arc(s: number, ax: number, az: number, pad: number, phi: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(s * (ax + pad) * Math.cos(phi), y, (az + pad) * Math.sin(phi))
}

/**
 * One finger: three phalanges between four joints on the arc. The proximal bone carries a
 * gauntlet plate on its back and the two beyond it carry smaller steel ones, so the finger has
 * armour where a real one has armour and none where it has to bend.
 */
function finger(
  parts: Parts,
  s: number,
  y: number,
  ax: number,
  az: number,
  pads: readonly number[],
  phis: readonly number[],
  thickness: number,
): void {
  for (let i = 0; i < 3; i++) {
    const a = arc(s, ax, az, pads[i], phis[i], y)
    const b = arc(s, ax, az, pads[i + 1], phis[i + 1], y)
    const r = thickness * (1 - i * 0.18)
    put(parts, 'suit', link(a, b, r, r * 0.90, 12))
    const mid = a.clone().add(b).multiplyScalar(0.5)
    const out = new THREE.Vector3(mid.x, 0, mid.z).normalize()
    // The knuckle plate stands proud on the proximal bone and lies flush further out, so a row of
    // four hard edges catches the light where the fingers bend and nowhere else. Dark steel, not
    // team colour: four tinted knuckles turned towards the eye become one flat painted band, and
    // in CE the shooter's own glove is the darkest thing on screen.
    put(parts, 'steel', plate(
      mid.clone().addScaledVector(out, r * (i === 0 ? 0.86 : 0.66)),
      out,
      b.clone().sub(a),
      r * (i === 0 ? 1.55 : 1.30),
      r * (i === 0 ? 0.7 : 0.40),
      a.distanceTo(b) * (i === 0 ? 0.9 : 0.8),
    ))
  }
}

const D = Math.PI / 180

/**
 * Build one hand. Returns the static merged meshes plus the trigger finger, which is left live in
 * its own group pivoted at its knuckle so it can be pulled.
 */
export function buildHand(pose: HandPose, team: Team): { group: THREE.Group; trigger: THREE.Group } {
  const { s, grip: g } = pose
  const dep = pose.depth
  const k = pose.bulk
  const parts: Parts = new Map()
  const group = new THREE.Group()
  group.name = 'hand'

  // Palm against the grip, back-of-hand plate over it, and a thin ridge across the knuckles.
  // Every block starts at the wrap radius and grows outward, so bulking the glove never opens a
  // gap between the palm and the thing it is holding — it only ever piles more glove on the
  // outside, where the shooter can see it.
  // The palm has to stay *inside* the knuckle row. Build it any thicker than the radius the
  // fingers ride on and it swallows them, and a hand with no visible knuckles is a mitten —
  // which is exactly what a slab of glove wider than its own fingers looks like from behind.
  const KNUCKLE = 0.030 * k
  put(parts, 'suit', slab(s * (g + KNUCKLE * 0.50), 0.000, -0.006, KNUCKLE * 1.00, 0.100 * k, 0.056 * k))
  // Two narrow back-of-hand plates rather than one wide one. A single slab of team colour on the
  // side of the hand facing the shooter is the loudest shape in the frame and reads as a painted
  // board; split down the middle with the dark undersuit showing through, it reads as armour.
  for (const zc of [-0.018, 0.010]) {
    put(parts, 'plate', slab(s * (g + KNUCKLE * 0.92), 0.014 * k, zc * k, 0.009 * k, 0.062 * k, 0.014 * k))
  }
  // Heel of the hand, filling the corner behind the grip so the palm is not a floating slab.
  put(parts, 'suit', slab(s * (g + KNUCKLE * 0.36), -0.030 * k, -0.030 * k, KNUCKLE * 0.86, 0.048 * k, 0.028 * k))
  // Wrist cuff: a flared collar where the gauntlet meets the hand.
  put(parts, 'suit', slab(s * (g + KNUCKLE * 0.44), 0.052 * k, -0.012, KNUCKLE * 0.94, 0.022 * k, 0.046 * k))
  // Split into two bands with the undersuit showing between them. One plate across the whole
  // wrist is a single unbroken quad turned towards the eye — the flattest, brightest shape the
  // viewmodel can produce, and it reads as a painted board laid on the gun rather than as a cuff.
  for (const zc of [-0.014, 0.012]) {
    put(parts, 'plate', slab(s * (g + KNUCKLE * 0.46), 0.066 * k, zc * k, KNUCKLE * 0.90, 0.013 * k, 0.015 * k))
  }

  // Fingers. A closed fist wraps about 175 degrees of the grip; the support hand on a pistol is
  // cupping the firing hand rather than closing on anything, so it stays open.
  //
  // The proximal bone is deliberately fat and deliberately plated: it is the one segment of the
  // finger the shooter can see past the weapon, so the row of four knuckles is the only thing
  // that separates "a hand wrapped round the grip" from "a mitten". Everything past the first
  // joint disappears round the front of the grip and is built thin to match.
  const phis = pose.open
    ? [-30 * D, 22 * D, 62 * D, 94 * D]
    : [-30 * D, 46 * D, 108 * D, 156 * D]
  // Pads are fractions of the knuckle radius: the first joint rides on the outside of the palm,
  // where the shooter can see it, and the arc closes in from there so the fingertips tuck under
  // the grip instead of orbiting it.
  for (let i = 1; i < 4; i++) {
    const t = (0.0166 - i * 0.0012) * k
    const pads = [1.00, 0.82, 0.52, 0.26].map((r) => r * KNUCKLE + t * 0.5)
    finger(parts, s, FINGER_Y[i] * k, g, dep, pads, phis.map((p, j) => p + (j > 0 ? (i - 2) * 0.05 : 0)), t)
  }

  // Thumb: two phalanges laid up the front of the grip, over the middle finger.
  const tRoot = new THREE.Vector3(s * (g + KNUCKLE * 0.70), 0.050 * k, -0.026 * k)
  const t1 = tRoot.clone().add(new THREE.Vector3(-s * 0.014 * k, -0.028 * k, 0.040 * k))
  const t2 = t1.clone().add(new THREE.Vector3(-s * 0.026 * k, -0.014 * k, 0.020 * k))
  put(parts, 'suit', link(tRoot, t1, 0.017 * k, 0.015 * k, 7))
  put(parts, 'suit', link(t1, t2, 0.015 * k, 0.012 * k, 7))
  put(parts, 'plate', plate(
    tRoot.clone().add(t1).multiplyScalar(0.5).addScaledVector(new THREE.Vector3(s, 0.5, 0).normalize(), 0.012 * k),
    new THREE.Vector3(s, 0.5, 0),
    t1.clone().sub(tRoot),
    0.024 * k,
    0.008 * k,
    0.034 * k,
  ))

  for (const m of meshes(parts, team, 'hand')) group.add(m)

  // The trigger finger, live: reaching forward rather than wrapped, and pulled by rotating the
  // whole group about the grip axis — the same axis the wrap was authored on.
  const trigger = new THREE.Group()
  trigger.name = 'trigger-finger'
  const knuckle = arc(s, g, dep, KNUCKLE, -30 * D, FINGER_Y[0] * k)
  trigger.position.copy(knuckle)
  const tp: Parts = new Map()
  const reach = [-30 * D, 14 * D, 48 * D, 76 * D]
  const pads = [1.00, 1.02, 0.84, 0.58].map((r) => r * KNUCKLE)
  const local: Parts = new Map()
  finger(local, s, FINGER_Y[0] * k, g, dep, pads, reach, 0.0166 * k)
  // Re-origin the finger on its own knuckle so the group's rotation is a knuckle rotation.
  for (const [key, list] of local) for (const geo of list) {
    geo.translate(-knuckle.x, -knuckle.y, -knuckle.z)
    put(tp, key, geo)
  }
  for (const m of meshes(tp, team, 'index')) trigger.add(m)
  group.add(trigger)

  return { group, trigger }
}

/* ------------------------------------------------------------------ the arm */

/**
 * Forearm from mid-forearm to wrist: a tapered tube in the undersuit with three gauntlet plates
 * over its back and a bevelled elbow-side cap, built straight into weapon space so the arm can
 * be aimed at the shooter independently of how the wrist is rolled.
 */
function buildForearm(wrist: THREE.Vector3, dir: THREE.Vector3, len: number, k: number, team: Team): THREE.Mesh[] {
  const parts: Parts = new Map()
  const d = dir.clone().normalize()
  const a = wrist.clone().addScaledVector(d, -0.010)
  // Overshoot the requested length by half again. What is asked for is how much arm should be on
  // screen; the rest runs on past the bottom edge so the arm is cut off by the frame rather than
  // ending in a visible stump, which is the difference between "a hand coming in from below" and
  // "a severed forearm floating in the air".
  const b = wrist.clone().addScaledVector(d, len * 2.2)
  // The arm is only a shade thicker than the wrist it leaves. It does not get a share of the
  // glove's bulk — a fat glove is Spartan armour, a fat forearm is a tree trunk up the screen.
  // Narrower than the glove it leaves, and tapering *inward* as it recedes. An arm that flares
  // wider than the hand reads as a tree trunk with a hand stuck on the end of it.
  const r0 = 0.019 * (0.55 + 0.45 * k)
  put(parts, 'suit', link(a, b, r0, r0 * 0.90, 10))
  // Ribbed bands rather than a flat vambrace. A slab of team colour hung off the side of the arm
  // sits face-on to the shooter's eye and becomes the brightest, flattest shape in the frame —
  // louder than the gun. Rings read as armour from every angle and from none of them read as a
  // painted board, and in CE what the shooter actually sees beside the weapon is a dark glove.
  const rib = a.clone().lerp(b, 0.22)
  put(parts, 'steel', link(
    rib.clone().addScaledVector(d, -0.007), rib.clone().addScaledVector(d, 0.007), r0 * 1.10, r0 * 1.06, 10,
  ))
  // Cuff ring at the wrist, so the join to the glove reads as a join and not a seam.
  put(parts, 'steel', link(
    a.clone().addScaledVector(d, -0.010), a.clone().addScaledVector(d, 0.014),
    r0 * 1.16, r0 * 1.22, 10,
  ))
  return meshes(parts, team, 'forearm')
}

/* ------------------------------------------------------------------ assembly */

/**
 * The spare magazine the support hand brings up on a reload. Authored here rather than cut from
 * the weapon because most weapons do not model the magazine they are being fed — the MA5B's lives
 * inside its receiver and never shows — and a hand that goes down empty and comes back empty
 * reads as a shrug rather than a reload.
 */
export function buildSpareMag(size: Vec3, team: Team): THREE.Group {
  const parts: Parts = new Map()
  const [w, h, d] = size
  put(parts, 'suit', slab(0, 0, 0, w, h, d))
  put(parts, 'suit', slab(0, -h / 2 - 0.004, 0, w * 1.15, 0.008, d * 1.1))
  put(parts, 'plate', slab(0, h * 0.16, d / 2 + 0.003, w * 0.55, h * 0.3, 0.005))
  const g = new THREE.Group()
  g.name = 'spare-mag'
  for (const m of meshes(parts, team, 'spare-mag')) g.add(m)
  g.visible = false
  return g
}

export interface Arms {
  /** Parent this to the weapon model so the hands inherit its transform exactly. */
  readonly group: THREE.Group
  readonly rightArm: THREE.Group
  readonly leftArm: THREE.Group
  readonly rightHand: THREE.Group
  readonly leftHand: THREE.Group
  /** The fresh magazine in the support hand; only shown mid-reload. */
  readonly spareMag: THREE.Group
  /** Curl for the trigger finger, 0 relaxed, 1 pulled. */
  setTrigger(pull: number): void
  /** Open the fingers when releasing a grip or throwing, without moving the forearm. */
  setRelease?(right: number, left: number): void
}

/**
 * Both arms, posed on to one weapon's rig. The right hand takes the grip with its index finger
 * on the trigger; the left takes the foregrip, which on a pistol is the firing hand itself and
 * on a rifle is the handguard — the difference is entirely in the rig, not here.
 */
export function buildArms(rig: WeaponRig, team: Team): Arms {
  const group = new THREE.Group()
  group.name = 'arms'
  // Model units of forearm. The rig asks in world metres and divides through by the hold scale,
  // so a rifle shown at half a pistol's size still gets an arm of the same apparent length.
  const armLength = (rig.hold.forearm ?? 0.10) / rig.hold.scale

  // Shooter space to model space: mirror x, and with it every rotation that is not about x.
  const make = (anchor: HandAnchor, hand: 'right' | 'left', name: string) => {
    const s: 1 | -1 = hand === 'right' ? -1 : 1
    const euler = new THREE.Euler(anchor.euler[0], -anchor.euler[1], -anchor.euler[2])
    const pos = new THREE.Vector3(-anchor.pos[0], anchor.pos[1], anchor.pos[2])
    const arm = new THREE.Group()
    arm.name = name
    // The glove is authored in model units but worn by a person, so it has to come out the same
    // size on screen whatever the weapon is shrunk to. A rifle shown at 0.46 and a pistol at 0.84
    // would otherwise be held by hands differing by a factor of two, and on the rifle the hands
    // simply disappear behind the receiver. Normalise against the pistol, which is where the
    // numbers in the table were tuned; the wrap radius stays honest to the grip either way, so
    // the fingertips still close on the real thing and only the meat of the glove scales.
    const bulk = (anchor.bulk ?? 1) * (0.84 / rig.hold.scale)
    const built = buildHand(
      { s, grip: anchor.grip, depth: anchor.depth ?? anchor.grip * 1.3, open: anchor.pose === 'cup', bulk },
      team,
    )
    built.group.position.copy(pos)
    built.group.rotation.copy(euler)
    arm.add(built.group)

    // The wrist in weapon space: where the hand's cuff ended up once the hand was rotated.
    const wrist = new THREE.Vector3(s * (anchor.grip + 0.024 * bulk), 0.062 * bulk, -0.030 * bulk)
      .applyEuler(euler).add(pos)
    const dir = new THREE.Vector3(-anchor.forearm[0], anchor.forearm[1], anchor.forearm[2])
    for (const m of buildForearm(wrist, dir, armLength * (anchor.arm ?? 1), bulk, team)) arm.add(m)
    group.add(arm)
    return { arm, hand: built.group, trigger: built.trigger }
  }

  const right = make(rig.right, 'right', 'arm-right')
  const left = make(rig.left, 'left', 'arm-left')
  // The support hand is a hand, not a prop: hide its trigger finger rather than leaving a finger
  // pointing at nothing.
  left.trigger.visible = false

  // The spare sits in the support hand's palm, where the grip it is cupping would be.
  const spare = buildSpareMag([0.030, 0.11, 0.052], team)
  spare.position.set(-rig.left.pos[0], rig.left.pos[1], rig.left.pos[2])
  spare.rotation.set(rig.left.euler[0], -rig.left.euler[1], -rig.left.euler[2])
  left.arm.add(spare)

  return {
    group,
    spareMag: spare,
    rightArm: right.arm,
    leftArm: left.arm,
    rightHand: right.hand,
    leftHand: left.hand,
    setTrigger(pull: number) {
      right.trigger.rotation.y = -0.34 * Math.min(1, Math.max(0, pull))
    },
  }
}
