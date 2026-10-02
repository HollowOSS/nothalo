import * as THREE from 'three'

/**
 * Two-bone inverse kinematics.
 *
 * Given where a hand should be, this works out the shoulder and elbow rotations that put it
 * there. That is the whole reason it exists: posing an arm by choosing joint angles and hoping
 * the hand lands somewhere useful is guesswork, and it does not converge. Choosing where the
 * hand goes and solving backwards is closed-form and lands exactly.
 *
 * The pole vector decides which way the elbow points. Two poses reach any given target — elbow
 * up or elbow down — and for a first-person view the difference is whether the arm crosses the
 * screen or stays in the corner.
 */

const _rootPos = new THREE.Vector3()
const _midPos = new THREE.Vector3()
const _tipPos = new THREE.Vector3()
const _toTarget = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _bendAxis = new THREE.Vector3()
const _elbowDir = new THREE.Vector3()
const _worldQuat = new THREE.Quaternion()
const _parentQuat = new THREE.Quaternion()
const _desired = new THREE.Quaternion()
const _bind = new THREE.Vector3()
const _pole = new THREE.Vector3()

export interface TwoBoneChain {
  root: THREE.Object3D
  mid: THREE.Object3D
  tip: THREE.Object3D
  /** Length root->mid and mid->tip, measured from the bind pose. */
  upper: number
  lower: number
  /**
   * Which way each bone points in its own space. Measured rather than assumed: exporters do not
   * agree on whether a bone runs along its local X, Y or Z, and guessing wrong silently produces
   * an arm that folds sideways.
   */
  rootAxis: THREE.Vector3
  midAxis: THREE.Vector3
}

/** Measure a chain's proportions and bone axes from its current (bind) pose. */
export function measureChain(root: THREE.Object3D, mid: THREE.Object3D, tip: THREE.Object3D): TwoBoneChain {
  root.updateWorldMatrix(true, true)
  root.getWorldPosition(_rootPos)
  mid.getWorldPosition(_midPos)
  tip.getWorldPosition(_tipPos)

  const upper = _rootPos.distanceTo(_midPos)
  const lower = _midPos.distanceTo(_tipPos)

  root.getWorldQuaternion(_worldQuat)
  const rootAxis = _midPos.clone().sub(_rootPos).applyQuaternion(_worldQuat.invert()).normalize()

  mid.getWorldQuaternion(_worldQuat)
  const midAxis = _tipPos.clone().sub(_midPos).applyQuaternion(_worldQuat.invert()).normalize()

  return { root, mid, tip, upper, lower, rootAxis, midAxis }
}

/**
 * Point a bone's own axis along a world-space direction.
 *
 * `boneAxis` is the direction of the bone's child in the bone's own frame, so the world rotation
 * that aims it is simply the one carrying that axis onto the target direction. Twist about the
 * axis is left arbitrary, which is correct for an arm — nothing downstream depends on it.
 */
function aimBone(bone: THREE.Object3D, boneAxis: THREE.Vector3, worldDir: THREE.Vector3): void {
  _bind.copy(worldDir).normalize()
  _desired.setFromUnitVectors(boneAxis, _bind)
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_parentQuat)
    bone.quaternion.copy(_parentQuat.invert().multiply(_desired))
  } else {
    bone.quaternion.copy(_desired)
  }
}

/**
 * Solve the chain so the tip reaches `target`, with the mid joint bending toward `pole`.
 *
 * Both are world-space points. An unreachable target is not an error — the arm simply straightens
 * toward it, which is what a real arm does and looks better than refusing to move.
 */
export function solveTwoBone(chain: TwoBoneChain, target: THREE.Vector3, pole: THREE.Vector3): void {
  const { root, mid, upper, lower, rootAxis, midAxis } = chain

  root.updateWorldMatrix(true, false)
  root.getWorldPosition(_rootPos)

  _toTarget.copy(target).sub(_rootPos)
  const reach = upper + lower
  // Never fully straight: a locked-out elbow makes the next frame's solve jump between the two
  // mirror solutions.
  const dist = Math.min(Math.max(_toTarget.length(), Math.abs(upper - lower) + 1e-4), reach - 1e-3)
  if (dist < 1e-5) return
  _toTarget.normalize()

  // Angle to swing the upper arm off the straight line to the target, from the law of cosines.
  const cosShoulder = (upper * upper + dist * dist - lower * lower) / (2 * upper * dist)
  const shoulderAngle = Math.acos(Math.min(1, Math.max(-1, cosShoulder)))

  // The bend plane is defined by the target and the pole; the elbow rotates within it.
  _pole.copy(pole).sub(_rootPos)
  _bendAxis.crossVectors(_toTarget, _pole)
  if (_bendAxis.lengthSq() < 1e-8) {
    // Pole colinear with the target: pick any perpendicular so the arm still bends somewhere.
    _bendAxis.set(0, 1, 0).cross(_toTarget)
    if (_bendAxis.lengthSq() < 1e-8) _bendAxis.set(1, 0, 0).cross(_toTarget)
  }
  _bendAxis.normalize()

  _elbowDir.copy(_toTarget).applyAxisAngle(_bendAxis, shoulderAngle)
  aimBone(root, rootAxis, _elbowDir)

  // With the upper arm placed, the forearm simply points at the target from the new elbow.
  root.updateWorldMatrix(false, true)
  mid.getWorldPosition(_midPos)
  _axis.copy(target).sub(_midPos)
  if (_axis.lengthSq() > 1e-8) aimBone(mid, midAxis, _axis)
  mid.updateWorldMatrix(false, true)
}
