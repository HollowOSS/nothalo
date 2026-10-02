import * as THREE from 'three'
type Joint = {bone: THREE.Object3D; rest: THREE.Quaternion; finger: string; index: number}
const cache = new WeakMap<THREE.Object3D, Map<string, Joint[]>>()
const thumb = [0.5, 0.8, 0.5], curled = [0.9, 1.15, 0.65], index = [0.55, 0.85, 0.5]
/** Cache the Blender joints once; apply bind-relative rotations without hierarchy searches. */
export function poseFingers(root: THREE.Object3D, side: 'Right' | 'Left', pull = 0, release = 0): void {
  let hands = cache.get(root)
  if (!hands) { hands = new Map(); cache.set(root, hands) }
  let joints = hands.get(side)
  if (!joints) {
    joints = []
    for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (let i = 0; i < 3; i++) {
      const bone = root.getObjectByName(`${side}${finger}${i + 1}`)
      if (bone) joints.push({bone, rest:bone.quaternion.clone(), finger, index:i})
    }
    hands.set(side, joints)
  }
  for (const joint of joints) {
    const trigger = joint.finger === 'Index' && side === 'Right'
    let angle = (joint.finger === 'Thumb' ? thumb : trigger ? index : curled)[joint.index]
    if (trigger) angle += pull * (joint.index === 0 ? 0.18 : joint.index === 1 ? 0.22 : 0)
    joint.bone.quaternion.copy(joint.rest)
    joint.bone.rotateX(angle * (1 - THREE.MathUtils.clamp(release, 0, 1) * .95))
  }
}
