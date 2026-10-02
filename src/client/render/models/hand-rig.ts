import * as THREE from 'three'
import { ARMS_GLOW, paintedPlateMaterial } from './armor-surface.ts'
import { injectShieldRim, firstPersonShieldFlash, FIRST_PERSON_SHIELD_WASH } from './character.ts'

/**
 * Two fixes to the Spartan first-person arms, applied once per viewmodel instance at load.
 *
 * 1. Forearm twist. The rig has no twist bone: when a clip turns the hand about the forearm
 *    (every grip does, to meet a handle), the glove rotates with the hand while the sleeve stays
 *    put, and the few centimetres of skin between them wring into a thin twisted neck. Real
 *    forearms spread that turn along their length. Each forearm gets a twist bone at its own
 *    origin; the sleeve's forearm weights are shared into it in proportion to how far along the
 *    forearm each vertex is (none at the elbow, all at the wrist), and every frame the twist
 *    bone takes the hand's current turn about the forearm axis. The hand, its grip and every
 *    finger are untouched; only the sleeve now follows them.
 *
 * 2. The back-of-hand armour plate Halo 3's Mjolnir glove has (a raised plate from the wrist to
 *    the knuckles with two round sockets, painted like the rest of the armour; YaTxXqQksIA 4:32,
 *    the M41's front hand). It is built to each hand's own knuckle span and thickness, in the
 *    hand bone's rest space, and rides the hand bone rigidly, the way a hard plate does.
 */
export interface HandRig {
  /** Call after the pose for this frame is set (mixer, clip layers). */
  apply(): void
  dispose(): void
}

const SIDES = ['Left', 'Right'] as const

function boneIndex(skeleton: THREE.Skeleton, name: string) {
  return skeleton.bones.findIndex(b => b.name === name)
}

/** Bind-pose world (skeleton-space) matrix of bone i. */
function bindWorld(skeleton: THREE.Skeleton, i: number) {
  return skeleton.boneInverses[i].clone().invert()
}

export function rigHands(root: THREE.Object3D, skins: THREE.SkinnedMesh[], plateClearance = 0): HandRig {
  root.updateWorldMatrix(true, true)
  const arms = skins.filter(s => s.skeleton.bones.some(b => b.name === 'LeftForeArm' || b.name === 'RightForeArm'))
  const twists: { hand: THREE.Bone; bone: THREE.Bone; axis: THREE.Vector3; handBind: THREE.Quaternion }[] = []
  const plates: THREE.Mesh[] = []
  const skeleton = arms[0]?.skeleton
  if (!skeleton || (globalThis as { __noHandRig?: boolean }).__noHandRig) return { apply() {}, dispose() {} }

  // --- 1. twist bones -------------------------------------------------------------------------
  const bones = skeleton.bones.slice(), inverses = skeleton.boneInverses.map(m => m.clone())
  const added: { side: typeof SIDES[number]; fore: number; hand: number; index: number; length: number; axis: THREE.Vector3 }[] = []
  for (const side of SIDES) {
    const fore = boneIndex(skeleton, side + 'ForeArm'), hand = boneIndex(skeleton, side + 'Hand')
    if (fore < 0 || hand < 0) continue
    const foreBone = skeleton.bones[fore], handBone = skeleton.bones[hand] as THREE.Bone
    // Twist axis: from the forearm's origin to the wrist, in forearm space (bind pose).
    const handInFore = bindWorld(skeleton, fore).invert().multiply(bindWorld(skeleton, hand))
    const wrist = new THREE.Vector3().setFromMatrixPosition(handInFore)
    const length = wrist.length()
    if (length < 1e-5) continue
    const twist = new THREE.Bone()
    twist.name = side + 'ForeArmTwist'
    foreBone.add(twist)
    bones.push(twist)
    // Same bind transform as the forearm: the twist bone sits at its origin, unrotated.
    inverses.push(skeleton.boneInverses[fore].clone())
    const axis = wrist.clone().divideScalar(length)
    added.push({ side, fore, hand, index: bones.length - 1, length, axis })
    const handBind = new THREE.Quaternion().setFromRotationMatrix(handInFore)
    twists.push({ hand: handBone, bone: twist, axis, handBind })
  }
  if (added.length) {
    const next = new THREE.Skeleton(bones, inverses)
    for (const skin of arms) {
      const geometry = skin.geometry
      // Geometry is shared by every instance of this weapon; share its weights once.
      if (!geometry.userData.forearmTwist) {
        geometry.userData.forearmTwist = true
        const position = geometry.attributes.position, skinIndex = geometry.attributes.skinIndex, skinWeight = geometry.attributes.skinWeight
        const v = new THREE.Vector3(), local = new THREE.Vector3()
        for (const a of added) {
          const toFore = skeleton.boneInverses[a.fore]
          for (let k = 0; k < position.count; k++) {
            let slot = -1, free = -1
            for (let j = 0; j < 4; j++) {
              if (skinIndex.getComponent(k, j) === a.fore && skinWeight.getComponent(k, j) > 0) slot = j
              else if (skinWeight.getComponent(k, j) === 0 && free < 0) free = j
            }
            if (slot < 0) continue
            // How far along the forearm this vertex sits, 0 at the elbow to 1 at the wrist.
            v.fromBufferAttribute(position, k).applyMatrix4(skin.bindMatrix)
            local.copy(v).applyMatrix4(toFore)
            const t = THREE.MathUtils.smoothstep(local.dot(a.axis) / a.length, .05, .95)
            if (t <= 0) continue
            const w = skinWeight.getComponent(k, slot)
            if (free >= 0) {
              skinWeight.setComponent(k, slot, w * (1 - t))
              skinIndex.setComponent(k, free, a.index)
              skinWeight.setComponent(k, free, w * t)
            } else if (t > .5) {
              skinIndex.setComponent(k, slot, a.index)
            }
          }
        }
        skinIndex.needsUpdate = true
        skinWeight.needsUpdate = true
      }
      skin.bind(next, skin.bindMatrix)
    }
    skeleton.dispose()
  }

  // --- 2. back-of-hand plates --------------------------------------------------------------------
  const skin = arms[0]
  // Painted like the glove's own armour, glowing and flashing with the arms (armor-surface.ts).
  const material = paintedPlateMaterial(skin.material as THREE.MeshStandardMaterial, ARMS_GLOW[1],
    shader => injectShieldRim(shader, firstPersonShieldFlash, FIRST_PERSON_SHIELD_WASH))
  const socketMaterial = new THREE.MeshStandardMaterial({ color: 0x23262a, metalness: .3, roughness: .6 })
  for (const side of SIDES) {
    const hand = skin.skeleton.bones.find(b => b.name === side + 'Hand')
    const index = skin.skeleton.bones.find(b => b.name === side + 'Index1')
    const pinky = skin.skeleton.bones.find(b => b.name === side + 'Pinky1')
    const middle = skin.skeleton.bones.find(b => b.name === side + 'Middle1')
    if (!hand || !index || !pinky || !middle) continue
    // Knuckles in the hand's own space (child rest positions do not animate).
    const knuckle = middle.position.clone(), lateral = pinky.position.clone().sub(index.position)
    const reach = knuckle.length(), width = lateral.length()
    if (reach < 1e-4 || width < 1e-4) continue
    const along = knuckle.clone().normalize()
    lateral.addScaledVector(along, -lateral.dot(along)).normalize()
    const back = new THREE.Vector3().crossVectors(along, lateral).normalize()
    // The rig's fingers close toward the palm when turned about their own +X (checked in
    // Blender on both hands), so the palm is the way the middle finger's next knuckle moves
    // under a small +X turn of its base joint; the plate goes on the other side.
    const next = skin.skeleton.bones.find(b => b.name === side + 'Middle2')
    if (!next) continue
    // Measured at the joint's rest, not the current pose: a tight fist turns this past 90 degrees.
    const palmward = new THREE.Vector3(1, 0, 0).cross(next.position)
    if (palmward.dot(back) > 0) back.negate()
    // Thickness of the glove's back: furthest hand-weighted vertex along `back`, over the plate.
    const handIndex = skin.skeleton.bones.indexOf(hand)
    const position = skin.geometry.attributes.position, skinIndex = skin.geometry.attributes.skinIndex, skinWeight = skin.geometry.attributes.skinWeight
    const toHand = skin.skeleton.boneInverses[handIndex]
    const posedToHand = hand.matrixWorld.clone().invert()
    if (plateClearance) skin.skeleton.update()
    const v = new THREE.Vector3()
    let height = 0
    for (let k = 0; k < position.count; k++) {
      let w = 0
      for (let j = 0; j < 4; j++) if (skinIndex.getComponent(k, j) === handIndex) w += skinWeight.getComponent(k, j)
      if (w < (plateClearance ? .25 : .6)) continue
      if (plateClearance) skin.getVertexPosition(k, v).applyMatrix4(skin.matrixWorld).applyMatrix4(posedToHand)
      else v.fromBufferAttribute(position, k).applyMatrix4(skin.bindMatrix).applyMatrix4(toHand)
      const u = v.dot(along) / reach
      if (u < .3 || u > 1.05 || Math.abs(v.dot(lateral)) > width * .6) continue
      height = Math.max(height, v.dot(back))
    }
    // Allow the fitted glove to flex beneath its rigid plate without surfacing through it.
    height += plateClearance
    // Plate outline in (u along the hand, w across it), metres in hand space.
    const len = reach * .7, wide = width * 1.02, narrow = width * .78
    const shape = new THREE.Shape()
    const r = Math.min(len, narrow) * .18
    shape.moveTo(-narrow / 2 + r, 0)
    shape.lineTo(narrow / 2 - r, 0)
    shape.quadraticCurveTo(narrow / 2, 0, narrow / 2 + (wide - narrow) * .1, r)
    shape.lineTo(wide / 2, len - r * 1.4)
    shape.quadraticCurveTo(wide / 2, len, wide / 2 - r * 1.4, len)
    shape.lineTo(-wide / 2 + r * 1.4, len)
    shape.quadraticCurveTo(-wide / 2, len, -wide / 2, len - r * 1.4)
    shape.lineTo(-narrow / 2 - (wide - narrow) * .1, r)
    shape.quadraticCurveTo(-narrow / 2, 0, -narrow / 2 + r, 0)
    // Two round sockets, side by side, two thirds of the way to the knuckles.
    const socket = wide * .13
    for (const s of [-1, 1]) {
      const hole = new THREE.Path()
      hole.absarc(s * wide * .22, len * .6, socket, 0, Math.PI * 2, true)
      shape.holes.push(hole)
    }
    const thick = width * .08
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: thick * .35, bevelSize: thick * .45, bevelSegments: 2, curveSegments: 10 })
    // Curve the plate over the back of the hand (lower at the sides), then map (x, y, z) -> hand space.
    const p = geometry.attributes.position
    const basis = new THREE.Matrix4().makeBasis(lateral, along, back)
    const start = reach * .3
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k)
      const drop = (x / (wide / 2)) ** 2 * width * .12
      v.set(x, y + start, z + height - drop).applyMatrix4(basis)
      p.setXYZ(k, v.x, v.y, v.z)
    }
    geometry.computeVertexNormals()
    const plate = new THREE.Mesh(geometry, material)
    plate.name = side + 'HandPlate'
    // The sockets' dark cups, set just below the plate surface.
    const cups = new THREE.CylinderGeometry(socket, socket * .8, thick * .6, 16)
    for (const s of [-1, 1]) {
      const cup = new THREE.Mesh(cups, socketMaterial)
      cup.position.set(s * wide * .22, start + len * .6, height + thick * .3).applyMatrix4(basis)
      cup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), back)
      plate.add(cup)
    }
    plate.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.frustumCulled = false; m.castShadow = m.receiveShadow = false; m.userData.noShadow = true } })
    hand.add(plate)
    plates.push(plate)
  }

  const delta = new THREE.Quaternion(), twist = new THREE.Quaternion(), inverseBind = new THREE.Quaternion()
  return {
    apply() {
      for (const t of twists) {
        // The hand's turn from its bind pose, in forearm space; keep only the part about the axis.
        delta.copy(t.hand.quaternion).multiply(inverseBind.copy(t.handBind).invert())
        const d = t.axis.x * delta.x + t.axis.y * delta.y + t.axis.z * delta.z
        twist.set(t.axis.x * d, t.axis.y * d, t.axis.z * d, delta.w)
        if (twist.lengthSq() < 1e-12) twist.identity(); else twist.normalize()
        t.bone.quaternion.copy(twist)
      }
    },
    dispose() {
      material.dispose(); socketMaterial.dispose()
      for (const plate of plates) plate.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose() })
    },
  }
}
