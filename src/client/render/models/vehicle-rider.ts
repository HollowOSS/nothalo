import * as THREE from 'three'
import { createSpartan } from './character.ts'
import { poseFingers } from './finger-pose.ts'
import { measureChain, solveTwoBone } from '../ik.ts'
import type { Team } from '../../../shared/assets.ts'
import type { VehicleKind, VehicleParts } from './authored-vehicles.ts'

export interface RiderMotion {
  dt: number; time: number; speed: number; steering: number
  entry: number; entryFrom: THREE.Vector3 | null
  exit: number; exitTo: THREE.Vector3 | null
}
export interface VehicleRider {
  object: THREE.Group
  pose(kind: VehicleKind, parts: VehicleParts, gunner: boolean, distance: number, motion: RiderMotion): void
  reset(): void
}

/** The existing generated Spartan, posed onto contact markers from the new Blender vehicles. */
export async function createVehicleRider(team: Team): Promise<VehicleRider> {
  const spartan = await createSpartan(team), object = new THREE.Group(), pelvis = new THREE.Group()
  object.name = 'vehicle-rider'; object.add(pelvis); pelvis.add(spartan.object)
  spartan.object.rotation.y = Math.PI
  const rifle = spartan.object.getObjectByName('rifle-aim-mount'); if (rifle) rifle.visible = false
  object.updateWorldMatrix(true, true)
  const find = (name: string) => {
    const found = object.getObjectByName(name)
    if (!found) throw new Error(`Vehicle rider requires generated Spartan bone ${name}`)
    return found
  }
  const hip = find('Hips'), hipAtRest = hip.getWorldPosition(new THREE.Vector3()), standingHipHeight = hipAtRest.y
  spartan.object.position.copy(hipAtRest).negate(); object.updateWorldMatrix(true, true)
  const bones: { bone: THREE.Object3D; rotation: THREE.Quaternion }[] = []
  object.traverse(b => { if ((b as THREE.Bone).isBone) bones.push({ bone: b, rotation: b.quaternion.clone() }) })
  const hands = (['Right', 'Left'] as const).map(side => {
    const wrist = find(`${side}Hand`), elbow = find(`${side}ForeArm`)
    const chain = measureChain(find(`${side}Arm`), elbow, wrist)
    const forward = find(`${side}Middle1`).getWorldPosition(new THREE.Vector3()).sub(wrist.getWorldPosition(new THREE.Vector3())).normalize()
    const across = find(`${side}Index1`).getWorldPosition(new THREE.Vector3()).sub(find(`${side}Pinky1`).getWorldPosition(new THREE.Vector3())).normalize()
    const normal = new THREE.Vector3().crossVectors(across, forward).normalize(); across.crossVectors(forward, normal).normalize()
    const frame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, forward, normal))
    const correction = frame.invert().multiply(wrist.getWorldQuaternion(new THREE.Quaternion()))
    const sign = Math.sign(wrist.getWorldPosition(new THREE.Vector3()).x) || (side === 'Right' ? -1 : 1)
    // Fit the curved fingers, not the wrist joint, to the physical handle centre.
    poseFingers(spartan.object, side); wrist.updateWorldMatrix(true, true)
    const contact = new THREE.Vector3()
    for (const index of [1, 2, 3]) contact.add(find(`${side}Middle${index}`).getWorldPosition(new THREE.Vector3()))
    contact.multiplyScalar(1 / 3).sub(wrist.getWorldPosition(new THREE.Vector3())).applyQuaternion(wrist.getWorldQuaternion(new THREE.Quaternion()).invert())
    return { side, chain, wrist, correction, contact, sign }
  })
  const feet = (['Right', 'Left'] as const).map(side => {
    const foot = find(`${side}Foot`)
    return { chain: measureChain(find(`${side}UpLeg`), find(`${side}Leg`), foot), foot,
      rotation: foot.getWorldQuaternion(new THREE.Quaternion()), sign: Math.sign(foot.getWorldPosition(new THREE.Vector3()).x) || 1 }
  })
  const target = new THREE.Vector3(), pole = new THREE.Vector3(), other = new THREE.Vector3(), offset = new THREE.Vector3()
  const seatPosition = new THREE.Vector3(), start = new THREE.Vector3(), previousSeat = new THREE.Vector3()
  const parentRotation = new THREE.Quaternion(), carrierRotation = new THREE.Quaternion(), desired = new THREE.Quaternion()
  const basis = new THREE.Matrix4(), across = new THREE.Vector3(), forward = new THREE.Vector3(), normal = new THREE.Vector3()
  let lastKind = '', seatBlend = 1, lastGunner = false, first = true
  const smooth = (t: number) => { t = THREE.MathUtils.clamp(t, 0, 1); return t * t * (3 - 2 * t) }
  const anchor = (parts: VehicleParts, name: string) => {
    const value = parts.anchors.get(name)
    if (!value) throw new Error(`Authored vehicle is missing contact ${name}`)
    return value
  }
  const paired = (parts: VehicleParts, prefix: string, sign: number) => {
    const a = anchor(parts, `${prefix}:left`), b = anchor(parts, `${prefix}:right`)
    // The exporter labels spatial sides; match the actual generated skeleton side to avoid crossed arms.
    a.getWorldPosition(target); b.getWorldPosition(other)
    // Compare in the rider's rotated frame. Hull-space sorting swaps the gunner's
    // left/right contacts when the turret turns past 90 degrees.
    object.worldToLocal(target); object.worldToLocal(other)
    return (target.x < other.x) === (sign < 0) ? a : b
  }
  return {
    object,
    reset() { first = true; lastKind = ''; seatBlend = 1 },
    pose(kind, parts, gunner, distance, motion) {
      const standing = kind === 'warthog' && gunner
      const passenger=kind==='mongoose'&&gunner
      spartan.setDetail(Math.max(13, distance))
      for (const rest of bones) rest.bone.quaternion.copy(rest.rotation)
      const seat = anchor(parts, standing || passenger ? 'anchor:seat:gunner' : kind === 'ghost' ? 'seat:driver' : 'anchor:seat:driver')
      seat.getWorldPosition(seatPosition); object.parent!.worldToLocal(seatPosition)
      if (!first && (lastGunner !== gunner || lastKind !== kind)) { previousSeat.copy(object.position); seatBlend = 0 }
      seatBlend = Math.min(1, seatBlend + motion.dt / .38)
      const entry = smooth(motion.entry), exit = smooth(motion.exit)
      object.position.copy(seatPosition)
      if (seatBlend < 1) object.position.lerpVectors(previousSeat, seatPosition, smooth(seatBlend))
      if (entry < 1) {
        if (motion.entryFrom) { start.copy(motion.entryFrom); start.y += standingHipHeight; object.parent!.worldToLocal(start) }
        else start.copy(seatPosition).add(offset.set(kind === 'ghost' ? -.9 : -.75, .12, 0))
        object.position.lerpVectors(start, object.position, entry)
        object.position.y += Math.sin(entry * Math.PI) * (kind==='mongoose'||kind==='chopper'?.18:.10)
      }
      if (exit > 0 && motion.exitTo) {
        start.copy(motion.exitTo); start.y += standingHipHeight; object.parent!.worldToLocal(start)
        object.position.lerp(start, exit); object.position.y += Math.sin(exit * Math.PI) * .10
      }
      object.rotation.set(0, passenger?Math.PI:standing ? parts.turret?.rotation.y ?? 0 : 0, 0)
      const contact = Math.min(entry, 1 - exit, smooth(seatBlend))
      const lean=kind==='ghost'?.84:kind==='chopper'?.45:kind==='mongoose'&&!passenger?.50:standing?.10:.24
      pelvis.rotation.set(lean * contact, 0,
        -motion.steering * Math.min(Math.abs(motion.speed) / 18, 1) * .035 * contact)
      pelvis.position.y = Math.sin(motion.time * (standing ? 2.3 : 1.8)) * .006 * contact
      // The Ghost's marker is at the seat centre; a Spartan sits toward its front lip.
      pelvis.position.z = kind==='ghost'?.12*contact:0
      object.updateWorldMatrix(true, true); object.getWorldQuaternion(carrierRotation)
      for (const { chain, foot, rotation, sign } of feet) {
        const marker = paired(parts, standing || passenger ? 'anchor:foot:gunner' : kind === 'ghost' ? 'foot' : 'anchor:foot:driver', sign)
        marker.getWorldPosition(target)
        object.localToWorld(start.set(sign * .18, -standingHipHeight + .12, .03))
        const mounting=(kind==='mongoose'||kind==='chopper')&&entry<1&&motion.entryFrom
        if(mounting){
          // Plant at the entry position, then step onto the vehicle. Previously both boots
          // travelled with the pelvis, making the rider slide sideways through the chassis.
          object.worldToLocal(other.copy(motion.entryFrom!))
          const near=sign===(Math.sign(other.x)||-1)
          const step=smooth((motion.entry-(near?.08:.35))/(near?.55:.6))
          start.set(sign*.18,.12,.03).applyQuaternion(carrierRotation).add(motion.entryFrom!)
          target.lerpVectors(start,target,step)
          target.y+=Math.sin(step*Math.PI)*(kind==='mongoose'&&!near?.8:.25)
        }else target.lerpVectors(start, target, contact)
        object.localToWorld(pole.set(sign * .36, -.16, .75))
        solveTwoBone(chain, target, pole)
        foot.parent!.getWorldQuaternion(parentRotation).invert()
        foot.quaternion.copy(parentRotation.multiply(desired.copy(carrierRotation).multiply(rotation)))
        foot.updateWorldMatrix(false, true)
      }
      for (const { side, chain, wrist, correction, contact: palm, sign } of hands) {
        const marker = paired(parts, standing || passenger ? 'anchor:turret-hand' : kind === 'ghost' ? 'hand' : 'anchor:hand:driver', sign)
        marker.getWorldPosition(target)
        if (kind === 'ghost') {
          across.set(0, 0, sign); forward.set(-sign, 0, 0); normal.set(0, -1, 0)
        } else {
          across.set(0, -sign, 0); forward.set(0, 0, 1); normal.set(-sign, 0, 0)
        }
        desired.setFromRotationMatrix(basis.makeBasis(across, forward, normal))
        // Gunner hands inherit pitch; driver contacts inherit the moving steering rim.
        const frameParent = standing ? parts.pitch ?? parts.turret! : kind === 'warthog' ? parts.steering ?? parts.object : parts.object
        frameParent.getWorldQuaternion(parentRotation)
        desired.premultiply(parentRotation).multiply(correction)
        target.sub(offset.copy(palm).applyQuaternion(desired))
        const handContact=(kind==='mongoose'||kind==='chopper')&&entry<1?smooth((motion.entry-.05)/.60):contact
        object.localToWorld(start.set(sign * .28, -.04, .20)); target.lerpVectors(start, target, handContact)
        object.localToWorld(pole.set(sign * .55, .08, kind === 'ghost' ? .42 : .08))
        solveTwoBone(chain, target, pole)
        wrist.parent!.getWorldQuaternion(parentRotation).invert()
        wrist.quaternion.copy(parentRotation.multiply(desired)); wrist.updateWorldMatrix(false, true)
        poseFingers(spartan.object, side, 0, 1 - handContact)
      }
      object.updateWorldMatrix(false, true); lastKind = kind; lastGunner = gunner; first = false
    },
  }
}
