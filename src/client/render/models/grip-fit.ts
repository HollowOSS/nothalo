import * as THREE from 'three'
import type { ModelId } from '../../../shared/assets.ts'

/**
 * Hand-on-weapon corrections, layered over the authored Blender clips.
 *
 * The clips place each hand and the weapon separately, and several of them close the fingers
 * around a grip that is not quite where the fingers are: a trigger finger bent back over the
 * guard, a thumb through the frame, a support hand hovering off the pump. This does not move a
 * weapon or retime anything. Each entry corrects one joint of one hand, either as a small turn
 * in the joint's own frame on top of whatever the clip keys for it, or, for a joint the clip has
 * bent where no knuckle bends, as a plain hinge curl from the rig's straight bind pose.
 *
 * A correction only makes sense while the hand is actually on its grip, so each hand is weighed
 * every frame by how far it has moved from where it sits on the weapon at idle, measured against
 * the part it holds (the shotgun's forend slides, so the support hand is measured against that):
 * full strength at the grip, fading out over a few centimetres as the hand leaves it for a
 * magazine, a shell or a grenade, and back in as it returns.
 */

/** Radians, XYZ Euler, post-multiplied onto the joint's clip rotation. */
type Turn = readonly [number, number, number]
/** Radians of curl about the joint's hinge (+X closes toward the palm), from the bind pose. */
interface Hinge { readonly curl: number }

interface HandFit {
  /** Fit the curled middle-finger contact to an authored marker at idle. */
  readonly contact?: string
  /** Camera-space shoulder adjustment for a donor rig with a shorter support-hand reach. */
  readonly shoulderMove?: readonly [number,number,number]
  /** Name (or name prefix) of the weapon node this hand holds; the weapon body if omitted. */
  readonly anchor?: string
  /**
   * Metres to carry the wrist, along the camera's axes as they lie at idle (+x right, +y up,
   * -z forward). The offset rides the anchor, so a hand moved onto the pump stays on it however
   * the clip turns the gun. The arm reaches it with a two-bone solve that keeps the elbow in the
   * plane the clip put it in.
   */
  readonly move?: readonly [number, number, number]
  /**
   * Radians to swing the elbow about the shoulder-to-wrist line. The hand stays exactly where it
   * is; only the forearm's approach changes, which is how a wrist bent too far is straightened.
   */
  readonly swivel?: number
  readonly joints?: Readonly<Record<string, Turn | Hinge>>
}

export type WeaponFit = Partial<Record<'Right' | 'Left', HandFit>>

const FITS: Partial<Record<ModelId, WeaponFit>> = {
  shotgun: {
    // The clip sets the hand so high on the grip that the trigger finger sits level with the
    // receiver and can only stay out of it by bending back 40 degrees at the knuckle. A little
    // lower, it curls into the guard onto the trigger; the thumb closes round the grip's far side.
    Right: {
      move: [0, -.012, 0],
      joints: { Index1: [.55, 0, 0], Index2: { curl: .7 }, Index3: { curl: .45 }, Thumb1: [.3, 0, 0], Thumb2: [.25, 0, 0] },
    },
    // The pump hand is right, but reached with the wrist bent past 90 degrees; swinging the elbow
    // out a little straightens it without moving the hand off the forend.
    Left: { anchor: 'forend', swivel: .3 },
  },
  // Imported small arms use the pistol donor rig: remove the old sword-donor
  // Needler finger corrections and close around each weapon's open grip instead.
  needler: {Right:{move:[0,.072,-.045],joints:{Thumb1:[.2,0,0],Index1:[.12,0,0]}}},
  'plasma-pistol': {Right:{move:[0,.085,.055],joints:{Index1:[.15,0,0]}}},
  'plasma-rifle': {Right:{move:[0,.065,-.05],joints:{Index1:[.12,0,0]}}},
  smg: {Right:{move:[0,.012,-.06],joints:{Index1:[.2,0,0]}},Left:{contact:'anchor:foregrip',shoulderMove:[0,0,-.10],joints:Object.fromEntries(['Index','Middle','Ring','Pinky'].flatMap(f=>[.9,1.15,.65].map((curl,i)=>[f+(i+1),{curl}]))) }},
  'rocket-launcher': {
    // Both index fingers stuck straight out past their grips: the firing hand's goes into the
    // guard, the front hand's closes round the foregrip with the rest.
    Right: { joints: { Index1: [.63, 0, 0], Index2: [.04, 0, 0], Index3: [.76, 0, 0] } },
    Left: { joints: { Index1: [1.11, 0, 0], Index2: [.84, 0, 0], Index3: [.44, 0, 0] } },
  },
  magnum: {
    // The cupping hand's fingertips came out through the back of the grip, in view over the
    // firing hand's knuckles; their last two joints open enough to rest on the backstrap instead.
    Left: {
      joints: {
        Index2: [-.25, 0, 0], Index3: [-.45, 0, 0], Middle2: [-.25, 0, 0], Middle3: [-.45, 0, 0],
        Ring2: [-.3, 0, 0], Ring3: [-.45, 0, 0], Pinky2: [-.25, 0, 0], Pinky3: [-.45, 0, 0],
      },
    },
  },
  sniper: {
    // The grip is thin and the firing hand's fingertips went straight through it and out of its
    // left face, where the player can see them: curled tighter so they wrap it instead, and the
    // trigger finger eased back inside the guard.
    Right: {
      joints: {
        Index1: [-.2, 0, 0], Index3: [.4, 0, 0], Middle2: [.45, 0, 0], Middle3: [.45, 0, 0],
        Ring2: [.45, 0, 0], Ring3: [.45, 0, 0], Pinky2: [.35, 0, 0], Pinky3: [.35, 0, 0],
      },
    },
    // The fore hand's fingers hung two centimetres off the stock's far side.
    Left: {
      joints: {
        Index1: [.6, 0, 0], Middle1: [.45, 0, 0], Middle3: [.05, 0, 0], Ring1: [.4, 0, 0], Ring3: [-.08, 0, 0], Pinky3: [-.15, 0, 0],
      },
    },
  },
}

/** Hold weight: full inside `NEAR` of the idle grip, none past `FAR` (metres). */
const NEAR = .015, FAR = .06

export interface GripFit {
  /** Call after the clip pose is set and before anything that reads the hand (hand-rig twist). */
  apply(): void
}

function find(root: THREE.Object3D, name: string): THREE.Object3D | null {
  const clean = THREE.PropertyBinding.sanitizeNodeName(name)
  let found: THREE.Object3D | null = null
  root.traverse(node => {
    if (!found && (node.name === name || node.name.startsWith(clean) || node.userData.export_name === name)) found = node
  })
  return found
}

/** Each bone's rotation relative to its parent in the skin's bind pose. */
function bindRotations(root: THREE.Object3D): Map<THREE.Object3D, THREE.Quaternion> {
  const rotations = new Map<THREE.Object3D, THREE.Quaternion>()
  let skeleton: THREE.Skeleton | null = null
  root.traverse(node => { if (!skeleton && (node as THREE.SkinnedMesh).isSkinnedMesh) skeleton = (node as THREE.SkinnedMesh).skeleton })
  if (!skeleton) return rotations
  const { bones, boneInverses } = skeleton as THREE.Skeleton
  const world = new Map(bones.map((bone, i) => [bone as THREE.Object3D, boneInverses[i].clone().invert()]))
  const scratch = new THREE.Vector3()
  for (const bone of bones) {
    const parent = bone.parent && world.get(bone.parent)
    if (!parent) continue
    const local = parent.clone().invert().multiply(world.get(bone)!)
    const rotation = new THREE.Quaternion()
    local.decompose(scratch, rotation, new THREE.Vector3())
    rotations.set(bone, rotation)
  }
  return rotations
}

/**
 * Built with the idle pose in place: that is where each hand's grip is measured from. `fit`
 * replaces the weapon's table, for tools that solve or review one.
 */
export function fitGrips(root: THREE.Object3D, weapon: THREE.Object3D | null, id: ModelId, fit = FITS[id]): GripFit {
  // Review tools: `__noGripFit` shows the clips as authored, `__gripFits` tries a table live.
  const review = globalThis as { __noGripFit?: boolean; __gripFits?: Partial<Record<ModelId, WeaponFit>> }
  fit = review.__gripFits?.[id] ?? fit
  if (!fit || !weapon || review.__noGripFit) return { apply() {} }
  root.updateWorldMatrix(true, true)
  const bind = bindRotations(root)
  const x = new THREE.Vector3(1, 0, 0)
  type Joint = { bone: THREE.Object3D; turn?: THREE.Quaternion; pose?: THREE.Quaternion }
  interface Hand {
    hand: THREE.Object3D; fore: THREE.Object3D; upper: THREE.Object3D; anchor: THREE.Object3D
    rest: THREE.Vector3; move: THREE.Vector3 | null; shoulderMove: THREE.Vector3 | null; swivel: number; joints: Joint[]
  }
  const hands: Hand[] = []
  const rootRotation = root.getWorldQuaternion(new THREE.Quaternion())
  for (const side of ['Right', 'Left'] as const) {
    const entry = fit[side]
    const hand = root.getObjectByName(side + 'Hand')
    const fore = hand?.parent, upper = fore?.parent
    if (!entry || !hand || !fore || !upper) continue
    const anchor = (entry.anchor && find(weapon, entry.anchor)) || weapon
    const rest = anchor.worldToLocal(hand.getWorldPosition(new THREE.Vector3()))
    // The move, authored in the idle camera frame, re-expressed in the anchor's own frame.
    let move: THREE.Vector3 | null = null
    if (entry.move) {
      const world = new THREE.Vector3(...entry.move).applyQuaternion(rootRotation).multiplyScalar(root.getWorldScale(new THREE.Vector3()).x)
      move = anchor.worldToLocal(hand.getWorldPosition(new THREE.Vector3()).add(world)).sub(rest)
    }
    const joints = Object.entries(entry.joints ?? {}).flatMap(([name, fix]): Joint[] => {
      const bone = root.getObjectByName(side + name)
      if (!bone) return []
      if ('curl' in fix) {
        const base = bind.get(bone)
        return base ? [{ bone, pose: base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(x, fix.curl)) }] : []
      }
      return [{ bone, turn: new THREE.Quaternion().setFromEuler(new THREE.Euler(...fix)) }]
    })
    if(entry.contact){
      const marker=find(weapon,entry.contact),contacts=[1,2,3].map(i=>root.getObjectByName(`${side}Middle${i}`))
      if(marker&&contacts.every(Boolean)){
        const saved=joints.map(j=>j.bone.quaternion.clone())
        for(const j of joints){if(j.pose)j.bone.quaternion.copy(j.pose);else if(j.turn)j.bone.quaternion.multiply(j.turn)}
        root.updateWorldMatrix(true,true)
        const center=contacts.reduce((v,j)=>v.add(j!.getWorldPosition(new THREE.Vector3())),new THREE.Vector3()).multiplyScalar(1/3)
        const delta=marker.getWorldPosition(new THREE.Vector3()).sub(center)
        move=anchor.worldToLocal(hand.getWorldPosition(new THREE.Vector3()).add(delta)).sub(rest)
        joints.forEach((j,i)=>j.bone.quaternion.copy(saved[i]));root.updateWorldMatrix(true,true)
      }
    }
    const shoulderMove=entry.shoulderMove ? new THREE.Vector3(...entry.shoulderMove) : null
    hands.push({ hand, fore, upper, anchor, rest, move, shoulderMove, swivel: entry.swivel ?? 0, joints })
  }
  const at = new THREE.Vector3(), held = new THREE.Vector3(), scale = new THREE.Vector3()
  const scratch = new THREE.Quaternion(), identity = new THREE.Quaternion(), grip = new THREE.Quaternion()
  const parentTurn = new THREE.Quaternion(), boneTurn = new THREE.Quaternion()
  const shoulder = new THREE.Vector3(), elbow = new THREE.Vector3(), wrist = new THREE.Vector3(), target = new THREE.Vector3()
  const toTarget = new THREE.Vector3(), pole = new THREE.Vector3(), bent = new THREE.Vector3(), from = new THREE.Vector3(), to = new THREE.Vector3()
  // A clip that does not key a joint leaves whatever was there last frame, which here would be
  // last frame's correction; corrections would pile up frame on frame. Each joint this touches
  // remembers what the clip gave it and what it was left at, and is put back before the next pass
  // unless the clip has written it since.
  const kept = new Map<THREE.Object3D, { clip: THREE.Quaternion; left: THREE.Quaternion }>()
  const keptPositions=new Map(hands.filter(h=>h.shoulderMove).map(h=>[h.upper,{clip:h.upper.position.clone(),left:new THREE.Vector3(NaN,NaN,NaN)}]))
  const shoulderShift=new THREE.Vector3(),shoulderWorld=new THREE.Vector3()
  for (const h of hands) for (const bone of [h.upper, h.fore, h.hand, ...h.joints.map(j => j.bone)]) {
    kept.set(bone, { clip: new THREE.Quaternion(), left: new THREE.Quaternion(NaN, NaN, NaN, NaN) })
  }
  /** Turn `bone` by the world-space rotation `turn`, leaving its parent where it is. */
  const turnWorld = (bone: THREE.Object3D, turn: THREE.Quaternion) => {
    bone.getWorldQuaternion(boneTurn).premultiply(turn)
    bone.quaternion.copy(bone.parent!.getWorldQuaternion(parentTurn).invert().multiply(boneTurn))
    bone.updateWorldMatrix(false, true)
  }
  /** Two-bone reach: the upper arm swings the elbow within its current plane, the forearm aims at the target. */
  const reach = (h: Hand, goal: THREE.Vector3, swivel: number) => {
    h.upper.getWorldPosition(shoulder); h.fore.getWorldPosition(elbow); h.hand.getWorldPosition(wrist)
    const a = elbow.distanceTo(shoulder), b = wrist.distanceTo(elbow)
    toTarget.subVectors(goal, shoulder)
    const d = THREE.MathUtils.clamp(toTarget.length(), Math.abs(a - b) + 1e-4, a + b - 1e-4)
    toTarget.normalize()
    pole.subVectors(elbow, shoulder)
    pole.addScaledVector(toTarget, -pole.dot(toTarget))
    if (pole.lengthSq() < 1e-10) return
    pole.normalize()
    if (swivel) pole.applyAxisAngle(toTarget, swivel)
    const cos = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1)
    bent.copy(shoulder).addScaledVector(toTarget, a * cos).addScaledVector(pole, a * Math.sqrt(1 - cos * cos))
    turnWorld(h.upper, scratch.setFromUnitVectors(from.subVectors(elbow, shoulder).normalize(), to.subVectors(bent, shoulder).normalize()))
    h.fore.getWorldPosition(elbow); h.hand.getWorldPosition(wrist)
    turnWorld(h.fore, scratch.setFromUnitVectors(from.subVectors(wrist, elbow).normalize(), to.subVectors(goal, elbow).normalize()))
  }
  return {
    apply() {
      if (!hands.length) return
      for(const [bone,k] of keptPositions){if(bone.position.equals(k.left))bone.position.copy(k.clip);else k.clip.copy(bone.position)}
      for (const [bone, k] of kept) {
        if (bone.quaternion.equals(k.left)) bone.quaternion.copy(k.clip)
        else k.clip.copy(bone.quaternion)
      }
      root.updateWorldMatrix(true, true)
      for (const h of hands) {
        // In the viewmodel's own metres, whatever scale the camera rig gives it.
        const away = h.hand.getWorldPosition(at).distanceTo(h.anchor.localToWorld(held.copy(h.rest))) / root.getWorldScale(scale).x
        const weight = 1 - THREE.MathUtils.smoothstep(away, NEAR, FAR)
        if (weight <= 0) continue
        if (h.move || h.swivel) {
          // The hand keeps the clip's orientation in the world through the reach.
          h.hand.getWorldQuaternion(grip)
          if(h.shoulderMove){
            shoulderShift.copy(h.shoulderMove).applyQuaternion(root.getWorldQuaternion(scratch)).multiplyScalar(weight)
            h.upper.getWorldPosition(shoulderWorld).add(shoulderShift)
            h.upper.position.copy(h.upper.parent!.worldToLocal(shoulderWorld));h.upper.updateWorldMatrix(false,true)
          }
          // The move as the anchor carries it this frame, added to wherever the clip has the wrist.
          if (h.move) target.copy(h.rest).add(h.move).applyMatrix4(h.anchor.matrixWorld).sub(held).multiplyScalar(weight)
          else target.set(0, 0, 0)
          reach(h, target.add(at), h.swivel * weight)
          h.hand.quaternion.copy(h.fore.getWorldQuaternion(scratch).invert().multiply(grip))
        }
        for (const j of h.joints) {
          if (j.pose) j.bone.quaternion.slerp(j.pose, weight)
          else j.bone.quaternion.multiply(scratch.copy(identity).slerp(j.turn!, weight))
        }
      }
      for (const [bone, k] of kept) k.left.copy(bone.quaternion)
      for(const [bone,k] of keptPositions)k.left.copy(bone.position)
    },
  }
}
