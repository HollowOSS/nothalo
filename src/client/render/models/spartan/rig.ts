import * as THREE from 'three'

/**
 * Owner: spartan piece. The skeleton the armour hangs on.
 *
 * Two things had to be true at once. The armour has to articulate — a Spartan that slides
 * around with locked legs reads as a prop, and that was the single loudest thing wrong with
 * the game. And a Spartan still has to cost four draw calls, because sixteen of them on screen
 * is the normal case, not the stress case.
 *
 * Parenting the armour pieces into a tree of Groups would have solved the first and destroyed
 * the second: every joint becomes its own mesh, so a Spartan goes from four calls to thirty-odd.
 * So the model is skinned instead. The joint hierarchy is real — bones are Object3Ds, nested
 * exactly as a rig should be, addressable by name — but the geometry stays merged into one
 * buffer per material and the GPU does the deformation. Four calls, articulated, and the elbows
 * and knees crease instead of tearing apart at the seam.
 *
 * Bind pose is deliberately NEUTRAL: legs straight, arms hanging. Every stance the Spartan is
 * ever seen in — the bladed weapon carry, the crouch, the tuck in mid-air — is produced by the
 * poser in `pose.ts`, not baked into the mesh. The stance in the reference frames is what the
 * idle pose puts it into, which is why walking out of that stance does not have to fight it.
 *
 * Axes, once, so nothing downstream has to guess:
 *   -Z is forward. +X is the Spartan's own RIGHT. +Y is up.
 * That matches the movement code, where a player at yaw travels along (-sin yaw, -cos yaw) and
 * the render object is spun by `rotation.y = yaw`. The old static Spartan faced +Z, which meant
 * every bot in the game was moonwalking; re-authoring the bind pose fixed that on the way past.
 */

export type BoneName =
  | 'root'
  | 'hips' | 'spine' | 'chest' | 'neck' | 'head'
  | 'shoulderL' | 'shoulderR'
  | 'upperArmL' | 'upperArmR'
  | 'elbowL' | 'elbowR'
  | 'forearmL' | 'forearmR'
  | 'handL' | 'handR'
  | 'thighL' | 'thighR'
  | 'kneeL' | 'kneeR'
  | 'shinL' | 'shinR'
  | 'footL' | 'footR'

interface BoneDef {
  parent: BoneName | null
  /** Rest position in model space, metres. */
  pos: readonly [number, number, number]
  /**
   * Where this bone's segment ends, for skin weighting. Vertices past either end of the
   * segment bleed onto the neighbouring bone so the joint creases instead of shearing.
   */
  tip?: readonly [number, number, number]
  /** Which bone takes the weight above this one's start. Skips zero-length pivots. */
  blendParent?: BoneName
  /** Which bone takes the weight past this one's tip. */
  blendChild?: BoneName
}

/** Mirror a right-side definition to the left. */
const mirror = (d: BoneDef, swap: Partial<Record<BoneName, BoneName>>): BoneDef => ({
  parent: (swap[d.parent as BoneName] ?? d.parent) as BoneName | null,
  pos: [-d.pos[0], d.pos[1], d.pos[2]],
  tip: d.tip ? [-d.tip[0], d.tip[1], d.tip[2]] : undefined,
  blendParent: swap[d.blendParent as BoneName] ?? d.blendParent,
  blendChild: swap[d.blendChild as BoneName] ?? d.blendChild,
})

const SWAP: Partial<Record<BoneName, BoneName>> = {
  shoulderR: 'shoulderL', upperArmR: 'upperArmL', elbowR: 'elbowL', forearmR: 'forearmL', handR: 'handL',
  thighR: 'thighL', kneeR: 'kneeL', shinR: 'shinL', footR: 'footL',
}

const R: Record<string, BoneDef> = {
  shoulderR: { parent: 'chest', pos: [0.150, 1.672, 0.005] },
  upperArmR: { parent: 'shoulderR', pos: [0.205, 1.655, 0.000], tip: [0.213, 1.335, -0.008], blendParent: 'shoulderR', blendChild: 'forearmR' },
  elbowR: { parent: 'upperArmR', pos: [0.213, 1.335, -0.008] },
  forearmR: { parent: 'elbowR', pos: [0.213, 1.335, -0.008], tip: [0.222, 1.085, 0.000], blendParent: 'upperArmR', blendChild: 'handR' },
  handR: { parent: 'forearmR', pos: [0.222, 1.085, 0.000], tip: [0.230, 0.965, 0.010], blendParent: 'forearmR' },
  thighR: { parent: 'hips', pos: [0.118, 1.020, 0.000], tip: [0.122, 0.600, 0.008], blendParent: 'hips', blendChild: 'shinR' },
  kneeR: { parent: 'thighR', pos: [0.122, 0.600, 0.008] },
  shinR: { parent: 'kneeR', pos: [0.122, 0.600, 0.008], tip: [0.124, 0.245, 0.000], blendParent: 'thighR', blendChild: 'footR' },
  footR: { parent: 'shinR', pos: [0.124, 0.245, 0.000], tip: [0.124, 0.020, -0.060], blendParent: 'shinR' },
}

export const BONES: Record<BoneName, BoneDef> = {
  root: { parent: null, pos: [0, 0, 0] },
  hips: { parent: 'root', pos: [0, 1.020, 0] },
  spine: { parent: 'hips', pos: [0, 1.200, 0] },
  chest: { parent: 'spine', pos: [0, 1.400, 0] },
  neck: { parent: 'chest', pos: [0, 1.700, 0] },
  head: { parent: 'neck', pos: [0, 1.805, 0] },
  shoulderR: R.shoulderR, upperArmR: R.upperArmR, elbowR: R.elbowR, forearmR: R.forearmR, handR: R.handR,
  thighR: R.thighR, kneeR: R.kneeR, shinR: R.shinR, footR: R.footR,
  shoulderL: mirror(R.shoulderR, SWAP), upperArmL: mirror(R.upperArmR, SWAP), elbowL: mirror(R.elbowR, SWAP),
  forearmL: mirror(R.forearmR, SWAP), handL: mirror(R.handR, SWAP),
  thighL: mirror(R.thighR, SWAP), kneeL: mirror(R.kneeR, SWAP), shinL: mirror(R.shinR, SWAP), footL: mirror(R.footR, SWAP),
}

/** Skeleton order. Parents come before children so one pass builds the tree. */
export const BONE_ORDER = Object.keys(BONES) as BoneName[]
const BONE_INDEX = new Map<BoneName, number>(BONE_ORDER.map((n, i) => [n, i]))

/** Rest position of a joint, in model space. */
export function restOf(name: BoneName): THREE.Vector3 {
  const p = BONES[name].pos
  return new THREE.Vector3(p[0], p[1], p[2])
}

export type Bones = Record<BoneName, THREE.Bone>

/** Build the joint tree in its bind pose. Every bone starts unrotated. */
export function buildSkeleton(): { bones: Bones; list: THREE.Bone[]; root: THREE.Bone } {
  const bones = {} as Bones
  const list: THREE.Bone[] = []
  for (const name of BONE_ORDER) {
    const def = BONES[name]
    const bone = new THREE.Bone()
    bone.name = name
    const parentPos = def.parent ? BONES[def.parent].pos : [0, 0, 0]
    bone.position.set(def.pos[0] - parentPos[0], def.pos[1] - parentPos[1], def.pos[2] - parentPos[2])
    bones[name] = bone
    list.push(bone)
    if (def.parent) bones[def.parent].add(bone)
  }
  return { bones, list, root: bones.root }
}

// -------------------------------------------------------------------------------------------
// Skin weighting.
//
// Every piece of geometry declares which joint it belongs to and gets weighted automatically:
// rigid to one bone, blended down a vertical chain for the torso, or blended along a limb's own
// axis so the vertices around a joint are shared with the neighbour. That last one is the whole
// trick — a band ±5 cm either side of a knee, weighted by distance along the shin's own axis,
// is what makes the knee bend rather than come apart.
// -------------------------------------------------------------------------------------------

export type SkinSpec =
  /** Welded to one joint. Helmets, pauldrons, boots: armour that never deforms. */
  | { kind: 'rigid'; bone: BoneName }
  /** Blended by height down a chain of joints. The torso and neck. */
  | { kind: 'chain'; chain: readonly BoneName[] }
  /** Blended along the bone's own axis, bleeding onto its neighbours at both ends. */
  | { kind: 'limb'; bone: BoneName; band?: number }

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Write skinIndex / skinWeight onto a part. Called before the parts are merged, so the merged
 * buffer carries per-vertex weights even though the joint each vertex belongs to was decided
 * one authored piece at a time.
 */
export function applySkin(geo: THREE.BufferGeometry, spec: SkinSpec): void {
  const pos = geo.getAttribute('position')
  const n = pos.count
  const si = new Uint16Array(n * 4)
  const sw = new Float32Array(n * 4)

  const write = (v: number, pairs: [number, number][]) => {
    let total = 0
    for (const p of pairs) total += p[1]
    if (total <= 0) {
      si[v * 4] = pairs[0]?.[0] ?? 0
      sw[v * 4] = 1
      return
    }
    for (let k = 0; k < Math.min(4, pairs.length); k++) {
      si[v * 4 + k] = pairs[k][0]
      sw[v * 4 + k] = pairs[k][1] / total
    }
  }

  if (spec.kind === 'rigid') {
    const i = BONE_INDEX.get(spec.bone)!
    for (let v = 0; v < n; v++) {
      si[v * 4] = i
      sw[v * 4] = 1
    }
  } else if (spec.kind === 'chain') {
    const ys = spec.chain.map((b) => BONES[b].pos[1])
    const ids = spec.chain.map((b) => BONE_INDEX.get(b)!)
    for (let v = 0; v < n; v++) {
      const y = pos.getY(v)
      if (y <= ys[0]) { write(v, [[ids[0], 1]]); continue }
      if (y >= ys[ys.length - 1]) { write(v, [[ids[ids.length - 1], 1]]); continue }
      let s = 0
      while (s < ys.length - 2 && y > ys[s + 1]) s++
      const t = clamp01((y - ys[s]) / Math.max(1e-6, ys[s + 1] - ys[s]))
      // Smoothstep so a plate crossing two joints does not kink at the boundary.
      const e = t * t * (3 - 2 * t)
      write(v, [[ids[s], 1 - e], [ids[s + 1], e]])
    }
  } else {
    const def = BONES[spec.bone]
    const self = BONE_INDEX.get(spec.bone)!
    const band = spec.band ?? 0.055
    const a = new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2])
    const tipDef = def.tip ?? def.pos
    const b = new THREE.Vector3(tipDef[0], tipDef[1], tipDef[2])
    const axis = b.clone().sub(a)
    const len = Math.max(1e-4, axis.length())
    axis.divideScalar(len)
    const up = def.blendParent ? BONE_INDEX.get(def.blendParent)! : self
    const down = def.blendChild ? BONE_INDEX.get(def.blendChild)! : self
    const v3 = new THREE.Vector3()
    for (let v = 0; v < n; v++) {
      v3.fromBufferAttribute(pos, v)
      const s = v3.clone().sub(a).dot(axis)
      const wUp = up === self ? 0 : clamp01(0.5 - s / (2 * band))
      const wDn = down === self ? 0 : clamp01(0.5 + (s - len) / (2 * band))
      const wSelf = Math.max(0, 1 - wUp - wDn)
      write(v, [[self, wSelf], [up, wUp], [down, wDn]])
    }
  }

  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4))
}
