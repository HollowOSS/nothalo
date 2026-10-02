import * as THREE from 'three'
import {measureChain,type TwoBoneChain} from './ik.ts'

export interface RifleLimb extends TwoBoneChain {
  rootRest:THREE.Quaternion
  midRest:THREE.Quaternion
  tipRest:THREE.Quaternion
}

/** Preserve each armour joint's authored roll while swinging it toward an IK target. */
export function measureRifleLimb(root:THREE.Object3D,mid:THREE.Object3D,tip:THREE.Object3D):RifleLimb {
  return {...measureChain(root,mid,tip),rootRest:root.quaternion.clone(),midRest:mid.quaternion.clone(),tipRest:tip.quaternion.clone()}
}

const rootPosition=new THREE.Vector3(),midPosition=new THREE.Vector3()
const targetDirection=new THREE.Vector3(),poleDirection=new THREE.Vector3(),bendAxis=new THREE.Vector3(),elbowDirection=new THREE.Vector3()
const currentDirection=new THREE.Vector3(),worldRotation=new THREE.Quaternion(),parentRotation=new THREE.Quaternion(),swing=new THREE.Quaternion()

function aimWithoutTwisting(bone:THREE.Object3D,axis:THREE.Vector3,direction:THREE.Vector3):void {
  bone.getWorldQuaternion(worldRotation)
  currentDirection.copy(axis).applyQuaternion(worldRotation).normalize()
  swing.setFromUnitVectors(currentDirection,direction.clone().normalize())
  worldRotation.premultiply(swing)
  if(bone.parent)bone.quaternion.copy(bone.parent.getWorldQuaternion(parentRotation).invert().multiply(worldRotation))
  else bone.quaternion.copy(worldRotation)
}

/** A fresh bind-relative solve prevents unkeyed arms accumulating twist across frames. */
export function poseRifleLimb(chain:RifleLimb,target:THREE.Vector3,pole:THREE.Vector3):void {
  const {root,mid,tip,upper,lower,rootAxis,midAxis}=chain
  root.quaternion.copy(chain.rootRest);mid.quaternion.copy(chain.midRest);tip.quaternion.copy(chain.tipRest)
  root.updateWorldMatrix(true,true);root.getWorldPosition(rootPosition)
  targetDirection.copy(target).sub(rootPosition)
  const distance=THREE.MathUtils.clamp(targetDirection.length(),Math.abs(upper-lower)+.0001,upper+lower-.001)
  if(distance<.00001)return
  targetDirection.normalize()
  const angle=Math.acos(THREE.MathUtils.clamp((upper*upper+distance*distance-lower*lower)/(2*upper*distance),-1,1))
  poleDirection.copy(pole).sub(rootPosition);bendAxis.crossVectors(targetDirection,poleDirection)
  if(bendAxis.lengthSq()<1e-8){bendAxis.set(0,1,0).cross(targetDirection);if(bendAxis.lengthSq()<1e-8)bendAxis.set(1,0,0).cross(targetDirection)}
  bendAxis.normalize();elbowDirection.copy(targetDirection).applyAxisAngle(bendAxis,angle)
  aimWithoutTwisting(root,rootAxis,elbowDirection)
  root.updateWorldMatrix(false,true);mid.getWorldPosition(midPosition)
  elbowDirection.copy(target).sub(midPosition)
  if(elbowDirection.lengthSq()>1e-8)aimWithoutTwisting(mid,midAxis,elbowDirection)
  mid.updateWorldMatrix(false,true)
}

/** Replace the generated idle's metre-wide lunge with a planted, slightly staggered stance. */
export function makeRifleIdle(inner:THREE.Object3D):THREE.AnimationClip|null {
  const hips=inner.getObjectByName('Hips')
  const legs=['Left','Right'].map(side=>{
    const root=inner.getObjectByName(`${side}UpLeg`),mid=inner.getObjectByName(`${side}Leg`),tip=inner.getObjectByName(`${side}Foot`)
    return root&&mid&&tip?{side,chain:measureRifleLimb(root,mid,tip)}:null
  })
  if(!hips?.parent||legs.some(leg=>!leg))return null
  inner.updateWorldMatrix(true,true)
  const saved=new Map<THREE.Object3D,{position:THREE.Vector3;quaternion:THREE.Quaternion}>()
  const remember=(bone:THREE.Object3D)=>saved.set(bone,{position:bone.position.clone(),quaternion:bone.quaternion.clone()})
  remember(hips)
  const targets=legs.map(leg=>{
    const {chain,side}=leg!;for(const bone of [chain.root,chain.mid,chain.tip])remember(bone)
    const position=chain.tip.getWorldPosition(new THREE.Vector3()),quaternion=chain.tip.getWorldQuaternion(new THREE.Quaternion())
    // inner has already been turned to the game's -Z forward. Work in its parent's frame.
    const local=inner.parent!.worldToLocal(position.clone());local.z+=side==='Left'?-.08:.08
    return {position:inner.parent!.localToWorld(local),quaternion}
  })
  const hipWorld=hips.getWorldPosition(new THREE.Vector3());hipWorld.y-=.055
  hips.position.copy(hips.parent.worldToLocal(hipWorld));hips.updateWorldMatrix(false,true)
  for(let i=0;i<legs.length;i++){
    const {chain}=legs[i]!,target=targets[i]
    const pole=inner.parent!.worldToLocal(target.position.clone());pole.y+=.55;pole.z-=.55
    poseRifleLimb(chain,target.position,inner.parent!.localToWorld(pole))
    chain.tip.quaternion.copy(chain.tip.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(target.quaternion))
  }
  const tracks:THREE.KeyframeTrack[]=[]
  for(const [bone] of saved){
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`,[0,4],[...bone.quaternion.toArray(),...bone.quaternion.toArray()]))
    if(bone===hips)tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`,[0,4],[...bone.position.toArray(),...bone.position.toArray()]))
  }
  for(const [bone,rest] of saved){bone.position.copy(rest.position);bone.quaternion.copy(rest.quaternion)}
  inner.updateWorldMatrix(true,true)
  return new THREE.AnimationClip('rifle-idle',4,tracks)
}

/** A torso layer independent of the donor idle's large, opposing pelvis rotation. */
export function makeRifleBreathing(inner:THREE.Object3D):THREE.AnimationClip {
  const names=['Spine02','Spine01','Spine','LeftShoulder','RightShoulder','neck','Head','head_end','headfront']
  const tracks:THREE.KeyframeTrack[]=[]
  inner.updateWorldMatrix(true,true)
  const right=new THREE.Vector3(1,0,0).applyQuaternion(inner.parent!.getWorldQuaternion(new THREE.Quaternion()))
  for(const name of names){
    const bone=inner.getObjectByName(name);if(!bone)continue
    const rest=bone.getWorldQuaternion(new THREE.Quaternion()),parent=bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert()
    const values:number[]=[]
    for(const offset of [0,.006,0,-.006,0]){
      const pose=bone.quaternion.clone()
      if(name==='Spine')pose.copy(parent).multiply(new THREE.Quaternion().setFromAxisAngle(right,.025+offset).multiply(rest))
      values.push(...pose.toArray())
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`,[0,1,2,3,4],values))
  }
  return new THREE.AnimationClip('rifle-breathing',4,tracks)
}
