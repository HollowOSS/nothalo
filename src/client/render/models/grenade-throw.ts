import * as THREE from 'three'

/** One gameplay clock for the hand release, held prop and projectile event. */
export const GRENADE_THROW = { release: .27, duration: .65 } as const
const v = (x=0,y=0,z=0) => new THREE.Vector3(x,y,z)
const world = (o:THREE.Object3D) => o.getWorldPosition(v())
const rotation = (o:THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion())
const ramp = (t:number,a:number,b:number) => { const u=THREE.MathUtils.clamp((t-a)/(b-a),0,1);return u*u*(3-2*u) }

/** Halo 3-style left-handed overhead cast, solved on the existing arms without stretching.
 * The original clip supplies the closed/open finger poses and prop-to-hand attachment only.
 * Shoulders stay at the edge of the frame; the elbow never swings across the reticle.
 * Reference: Dude Gamer, Halo 3 Fire Bomb Grenade, 00:03-00:04 (same left-hand cast).
 */
export function grenadeThrowClip(root:THREE.Object3D,id:string,idle:THREE.AnimationClip,original:THREE.AnimationClip):THREE.AnimationClip {
  const find=(name:string)=>{let found:THREE.Object3D|undefined;root.traverse(n=>{if(n.name===name||n.userData.export_name===name)found??=n});if(!found)throw Error(`${id} grenade: missing ${name}`);return found}
  const left={upper:find('LeftArm'),fore:find('LeftForeArm'),hand:find('LeftHand')}
  const right={upper:find('RightArm'),fore:find('RightForeArm'),hand:find('RightHand')}
  const prop=find('held-grenade')
  let weapon:THREE.Object3D|undefined
  root.traverse(n=>{if(/^(held-weapon|H3[_ ]held[_ ]weapon)/i.test(n.name))weapon??=n})
  if(!weapon)throw Error(`${id} grenade: missing held weapon`)
  const fingers:THREE.Object3D[]=[]
  root.traverse(n=>{if(/^Left(Thumb|Index|Middle|Ring|Pinky)[123]$/.test(n.name))fingers.push(n)})
  const mixer=new THREE.AnimationMixer(root)
  const ready=mixer.clipAction(idle);ready.play();mixer.update(0);root.updateWorldMatrix(true,true)
  const rest:{o:THREE.Object3D;p:THREE.Vector3;q:THREE.Quaternion;s:THREE.Vector3}[]=[]
  root.traverse(o=>rest.push({o,p:o.position.clone(),q:o.quaternion.clone(),s:o.scale.clone()}))
  const reset=()=>{for(const {o,p,q,s} of rest){o.position.copy(p);o.quaternion.copy(q);o.scale.copy(s)}root.updateWorldMatrix(true,true)}
  const arm=(a:typeof left)=>({...a,shoulder:world(a.upper),elbow:world(a.fore),wrist:world(a.hand),q:rotation(a.hand),l1:world(a.upper).distanceTo(world(a.fore)),l2:world(a.fore).distanceTo(world(a.hand))})
  const L=arm(left),R=arm(right),wp=world(weapon),wq=rotation(weapon)
  const fingerRest=fingers.map(n=>n.quaternion.clone())
  mixer.stopAllAction();reset()
  const cast=mixer.clipAction(original);cast.play();cast.time=.16;mixer.update(0);root.updateWorldMatrix(true,true)
  const closed=fingers.map(n=>n.quaternion.clone()),closedQ=rotation(left.hand)
  const attachment=new THREE.Matrix4().copy(left.hand.matrixWorld).invert().multiply(prop.matrixWorld)
  // Some older clips key the prop in a different frame from their hand. Repair that
  // offset from the closed fingers instead of carrying a floating grenade into the cast.
  if(new THREE.Vector3().setFromMatrixPosition(attachment).length()>.12){
    const palm=[1,2,3].map(i=>world(find('LeftMiddle'+i))).reduce((a,b)=>a.add(b),v()).divideScalar(3)
    attachment.setPosition(left.hand.worldToLocal(palm))
  }
  cast.time=.34;mixer.update(0);root.updateWorldMatrix(true,true)
  const open=fingers.map(n=>n.quaternion.clone()),openQ=rotation(left.hand)
  const fingerDirection=world(find('LeftMiddle1')).sub(world(left.hand)).normalize()
  openQ.premultiply(new THREE.Quaternion().setFromUnitVectors(fingerDirection,v(.25,-.18,-1).normalize()))
  mixer.stopAllAction();mixer.uncacheRoot(root);reset()
  const setQ=(o:THREE.Object3D,q:THREE.Quaternion)=>{o.quaternion.copy(rotation(o.parent!).invert().multiply(q));o.updateWorldMatrix(false,true)}
  const point=(bone:THREE.Object3D,child:THREE.Object3D,target:THREE.Vector3)=>{
    const at=world(bone),from=world(child).sub(at).normalize(),to=target.clone().sub(at).normalize()
    setQ(bone,new THREE.Quaternion().setFromUnitVectors(from,to).multiply(rotation(bone)))
  }
  const solve=(a:ReturnType<typeof arm>,target:THREE.Vector3,q:THREE.Quaternion,pole:THREE.Vector3)=>{
    const shoulder=world(a.upper),axis=target.clone().sub(shoulder)
    const d=THREE.MathUtils.clamp(axis.length(),Math.abs(a.l1-a.l2)+.001,a.l1+a.l2-.003)
    axis.normalize();const wrist=shoulder.clone().addScaledVector(axis,d)
    const along=(a.l1*a.l1-a.l2*a.l2+d*d)/(2*d),center=shoulder.clone().addScaledVector(axis,along)
    const radial=pole.clone().sub(center);radial.addScaledVector(axis,-radial.dot(axis)).normalize()
    const elbow=center.addScaledVector(radial,Math.sqrt(Math.max(0,a.l1*a.l1-along*along)))
    point(a.upper,a.fore,elbow);point(a.fore,a.hand,wrist);setQ(a.hand,q)
  }
  const nodes=[weapon,prop,left.upper,left.fore,left.hand,right.upper,right.fore,right.hand,...fingers]
  const values=nodes.map(()=>({p:[] as number[],q:[] as number[],s:[] as number[]}))
  const times:number[]=[]
  const keys:[number,THREE.Vector3][]=[
    [0,L.wrist],[.09,v(-.29,-.31,-.28)],[.18,v(-.36,-.025,-.24)],
    [GRENADE_THROW.release,v(-.28,.035,-.47)],[.33,v(-.25,.015,-.53)],
    [.44,v(-.33,-.27,-.32)],[.55,v(-.12,-.32,-.39)],[GRENADE_THROW.duration,L.wrist],
  ]
  // Include the exact release key as well as 120 Hz samples.
  const sampleTimes=[...new Set([...Array.from({length:79},(_,i)=>i/120),GRENADE_THROW.release])].sort((a,b)=>a-b)
  for(const t of sampleTimes){
    reset()
    if(t>0&&t<GRENADE_THROW.duration){
      const carry=ramp(t,0,.13)*(1-ramp(t,.39,GRENADE_THROW.duration))
      const turn=new THREE.Quaternion().setFromEuler(new THREE.Euler(-.10*carry,.09*carry,-.08*carry))
      const shift=v(.065*carry,-.055*carry,.025*carry),pivot=R.wrist
      weapon.position.copy(weapon.parent!.worldToLocal(wp.clone().sub(pivot).applyQuaternion(turn).add(pivot).add(shift)))
      setQ(weapon,turn.clone().multiply(wq))
      solve(R,R.wrist.clone().add(shift),turn.clone().multiply(R.q),R.elbow)
      let k=0;while(t>keys[k+1][0])k++
      const target=keys[k][1].clone().lerp(keys[k+1][1],ramp(t,keys[k][0],keys[k+1][0]))
      const grab=ramp(t,.03,.12),release=ramp(t,GRENADE_THROW.release-.025,GRENADE_THROW.release+.035),recover=ramp(t,.43,GRENADE_THROW.duration)
      const handQ=L.q.clone().slerp(closedQ,grab).slerp(openQ,release).slerp(L.q,recover)
      fingers.forEach((n,i)=>n.quaternion.copy(fingerRest[i]).slerp(closed[i],grab).slerp(open[i],release).slerp(fingerRest[i],recover))
      solve(L,target,handQ,v(-.47,-.38,-.25))
      const local=new THREE.Matrix4().copy(prop.parent!.matrixWorld).invert().multiply(left.hand.matrixWorld).multiply(attachment)
      local.decompose(prop.position,prop.quaternion,prop.scale)
      // Draw the prop while the hand is below/left of view, never materialize it on the gun.
      if(t<.085)prop.scale.multiplyScalar(.0001)
    }
    root.updateWorldMatrix(true,true);times.push(t)
    nodes.forEach((n,i)=>{values[i].p.push(...n.position);values[i].q.push(...n.quaternion);values[i].s.push(...n.scale)})
  }
  reset()
  return new THREE.AnimationClip('grenade',GRENADE_THROW.duration,nodes.flatMap((n,i)=>[
    new THREE.VectorKeyframeTrack(`${n.name}.position`,times,values[i].p),
    new THREE.QuaternionKeyframeTrack(`${n.name}.quaternion`,times,values[i].q),
    new THREE.VectorKeyframeTrack(`${n.name}.scale`,times,values[i].s),
  ]))
}
