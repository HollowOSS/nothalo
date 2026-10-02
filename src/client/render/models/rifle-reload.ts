import * as THREE from 'three'

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
const smooth = (t: number) => { t = THREE.MathUtils.clamp(t, 0, 1); return t * t * (3 - 2 * t) }
const ramp = (t: number, a: number, b: number) => smooth((t - a) / (b - a))
const world = (o: THREE.Object3D) => o.getWorldPosition(v())
const rotation = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion())

/** Monotone cubic through the keys: velocity carries through the strike key instead of
 * stopping on it, and nothing overshoots. Column 0 is normalized time. */
function hermite(keys: readonly (readonly number[])[], u: number, c: number) {
  let k = 0
  while (k < keys.length - 2 && u > keys[k + 1][0]) k++
  const slope = (i: number) => (keys[i + 1][c] - keys[i][c]) / (keys[i + 1][0] - keys[i][0])
  const tangent = (i: number) => {
    if (i === 0 || i === keys.length - 1) return 0
    const a = slope(i - 1), b = slope(i)
    return a * b <= 0 ? 0 : 2 / (1 / a + 1 / b)
  }
  const h = keys[k + 1][0] - keys[k][0], t = THREE.MathUtils.clamp((u - keys[k][0]) / h, 0, 1), t2 = t * t, t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * keys[k][c] + (t3 - 2 * t2 + t) * h * tangent(k)
    + (3 * t2 - 2 * t3) * keys[k + 1][c] + (t3 - t2) * h * tangent(k + 1)
}

/** Rifle melee over RIFLE_MELEE.duration; contact (.22 s) is u = .338. Columns: u; rifle
 * pitch/yaw/roll about a point between the hands; camera-space shift; how far the wrists straighten
 * toward the forearm; chest turn. */
const MELEE_KEYS = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  // Cock back and right.
  [.11, .05, -.2, -.07, .03, -.01, .025, .13, -.03],
  // Contact: most of the way across, still accelerating through the target.
  [.338, .08, 1.0, .58, -.19, -.02, -.02, .72, .16],
  // Follow-through: muzzle off the left edge, forearm across the bottom of the view.
  [.50, -.08, 1.42, .85, -.29, 0, .06, .90, .22],
  [.62, -.08, 1.35, .80, -.27, 0, .06, .85, .20],
  [.86, 0, .28, .22, -.05, 0, .01, .18, .04],
  [1, 0, 0, 0, 0, 0, 0, 0, 0],
] as const
/** The chest's vertical turning axis, camera-space: just behind the eye. */
const SPINE = v(.05, 0, .12)

/** Reconstruct the Halo 3 reload phases on each asset's own arm rig.
 * Reference: Hectorlo's MCC reload showcase, 00:19 AR / 00:22 BR.
 * These are authored poses, not extracted Bungie animation data. Build once at load time;
 * playback uses ordinary tracks, without per-frame IK or changes to gameplay timers.
 */
function rifleActionClip(root: THREE.Object3D, id: 'assault-rifle' | 'battle-rifle', idle: THREE.AnimationClip,
                         duration: number, action: 'reload' | 'melee'): THREE.AnimationClip {
  const find = (name: string) => {
    let found: THREE.Object3D | undefined
    root.traverse(o => { if (o.name === name || o.userData.export_name === name) found ??= o })
    if (!found) throw new Error(`${id} reload: missing ${name}`)
    return found
  }
  const mixer = new THREE.AnimationMixer(root)
  mixer.clipAction(idle).play(); mixer.update(0)
  root.updateWorldMatrix(true, true)
  const rest: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }[] = []
  root.traverse(o => rest.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }))
  mixer.stopAllAction(); mixer.uncacheRoot(root)
  const reset = () => {
    for (const { o, p, q, s } of rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s) }
    root.updateWorldMatrix(true, true)
  }
  reset()
  const ar = id === 'assault-rifle'
  const weapon = find(`held-weapon:${id}`), mag = find(ar ? 'magazine' : 'br-magazine')
  const bolt = find(ar ? 'charging-handle' : 'br-bolt')
  const grip = find('anchor:grip'), foregrip = find('anchor:foregrip'), socket = find('anchor:magazine')
  const weaponPosition = world(weapon), weaponRotation = rotation(weapon), pivot = world(grip)
  const midHands = pivot.clone().lerp(world(foregrip), .65)
  const magazinePosition = mag.position.clone(), boltPosition = bolt.position.clone()
  const arm = (side: string) => {
    const upper = find(side + 'Arm'), fore = find(side + 'ForeArm'), hand = find(side + 'Hand')
    const palm = () => [1, 2, 3].map(i => world(find(side + 'Middle' + i))).reduce((a, b) => a.add(b), v()).divideScalar(3)
    const handQ = rotation(hand), shoulder = world(upper), elbow = world(fore), wrist = world(hand)
    const anchor = world(side === 'Right' ? grip : foregrip)
    return { upper, fore, hand, palm, handQ, shoulder, elbow, foreQ: rotation(fore),
      forearm: wrist.clone().sub(elbow).normalize(), handAxis: v(0, 1, 0).applyQuaternion(handQ),
      gripOffset: palm().sub(anchor), l1: shoulder.distanceTo(elbow), l2: elbow.distanceTo(wrist) }
  }
  const arms = [arm('Right'), arm('Left')]
  const setWorldRotation = (o: THREE.Object3D, q: THREE.Quaternion) => {
    o.quaternion.copy(rotation(o.parent!).invert().multiply(q)); o.updateWorldMatrix(false, true)
  }
  const pointBone = (bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3) => {
    const origin = world(bone), from = world(child).sub(origin).normalize(), to = target.clone().sub(origin).normalize()
    setWorldRotation(bone, new THREE.Quaternion().setFromUnitVectors(from, to).multiply(rotation(bone)))
  }
  const solve = (a: ReturnType<typeof arm>, target: THREE.Vector3, q: THREE.Quaternion, pole = a.elbow) => {
    const offset = a.palm().sub(world(a.hand)).applyQuaternion(rotation(a.hand).invert())
    const wrist = target.clone().sub(offset.applyQuaternion(q))
    const shoulder = world(a.upper)
    const delta = wrist.clone().sub(shoulder), d = delta.length()
    if (d >= a.l1 + a.l2 || d <= Math.abs(a.l1 - a.l2)) throw new Error(`${id}: unreachable ${action} ${a.hand.name}: ${d.toFixed(3)} / ${(a.l1+a.l2).toFixed(3)}m; shoulder=${shoulder.toArray()} wrist=${wrist.toArray()}`)
    const axis = delta.divideScalar(d), along = (a.l1 * a.l1 - a.l2 * a.l2 + d * d) / (2 * d)
    const center = shoulder.clone().addScaledVector(axis, along)
    const radial = pole.clone().sub(center); radial.addScaledVector(axis, -radial.dot(axis)).normalize()
    const elbow = center.addScaledVector(radial, Math.sqrt(Math.max(0, a.l1 * a.l1 - along * along)))
    pointBone(a.upper, a.fore, elbow); pointBone(a.fore, a.hand, wrist); setWorldRotation(a.hand, q)
  }
  // Melee arms: the shoulder rides the turning chest, and of the elbows that reach the rifle
  // the solver takes the one nearest to turning the forearm with the gun (eased straighter
  // by `straighten`), so the wrist keeps close to its idle bend through the swing.
  const swing = (a: ReturnType<typeof arm>, target: THREE.Vector3, turn: THREE.Quaternion, straighten: number, wanted: THREE.Vector3) => {
    const q = turn.clone().multiply(a.handQ)
    const offset = a.palm().sub(world(a.hand)).applyQuaternion(rotation(a.hand).invert())
    const wrist = target.clone().sub(offset.applyQuaternion(q))
    const lean = new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(a.forearm, a.handAxis), straighten)
    const fq = turn.clone().multiply(lean), ideal = a.forearm.clone().applyQuaternion(fq)
    // The shoulder may shrug or reach up to 10 cm off the chest to let the elbow follow.
    const pole = wrist.clone().addScaledVector(ideal, -a.l2)
    const give = pole.clone().add(wanted.clone().sub(pole).setLength(a.l1)).sub(wanted).clampLength(0, .10)
    const reach = wanted.clone().add(give).sub(wrist)
    const d = THREE.MathUtils.clamp(reach.length(), Math.abs(a.l1 - a.l2) + .02, a.l1 + a.l2 - .01)
    const shoulder = wrist.clone().add(reach.setLength(d))
    const axis = shoulder.clone().sub(wrist).normalize().negate(), along = (a.l1 * a.l1 - a.l2 * a.l2 + d * d) / (2 * d)
    const center = shoulder.clone().addScaledVector(axis, along)
    const radial = pole.sub(center)
    radial.addScaledVector(axis, -radial.dot(axis)).normalize()
    const elbow = center.addScaledVector(radial, Math.sqrt(Math.max(0, a.l1 * a.l1 - along * along)))
    a.upper.position.copy(a.upper.parent!.worldToLocal(shoulder)); a.upper.updateWorldMatrix(false, true)
    pointBone(a.upper, a.fore, elbow)
    const actual = wrist.clone().sub(elbow).normalize()
    setWorldRotation(a.fore, new THREE.Quaternion().setFromUnitVectors(ideal, actual).multiply(fq).multiply(a.foreQ))
    setWorldRotation(a.hand, q)
  }
  const fingers = ['Index', 'Middle', 'Ring', 'Pinky'].flatMap(f => [find(`Left${f}2`), find(`Left${f}3`)])
  const nodes = [weapon, mag, bolt, ...arms.flatMap(a => [a.upper, a.fore, a.hand]), ...fingers]
  const values = nodes.map(() => ({ position: [] as number[], quaternion: [] as number[], scale: [] as number[] }))
  // The rapid melee turnover needs denser keys to keep interpolated wrist and gun
  // transforms together. Reload sampling stays unchanged.
  const times: number[] = [], frames = Math.ceil(duration * (action === 'melee' ? 120 : 60))
  for (let frame = 0; frame <= frames; frame++) {
    reset()
    const u = frame / frames
    if (frame > 0 && frame < frames && action === 'melee') {
      // Halo 3 (MCC all-weapons showcase YaTxXqQksIA 2:17 AR / 2:56 BR): a flat backhand
      // swing. The rifle turns between the hands until the muzzle points off the left edge, rolling
      // its top toward the left as the right forearm sweeps across the bottom of the view;
      // it holds there for the follow-through, then swings back. Both hands stay on.
      const pose = MELEE_KEYS[0].slice(1).map((_, i) => hermite(MELEE_KEYS, u, i + 1))
      const [pitch, yaw, roll, x, y, z, straighten, torso] = pose
      const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'))
      // Turn between the hands so neither one has to whip round the other.
      const wp = weaponPosition.clone().sub(midHands).applyQuaternion(turn).add(midHands).add(v(x, y, z))
      weapon.position.copy(weapon.parent!.worldToLocal(wp))
      setWorldRotation(weapon, turn.clone().multiply(weaponRotation))
      root.updateWorldMatrix(true, true)
      // The chest turns into the swing under a still camera, carrying both shoulders.
      const twist = new THREE.Quaternion().setFromAxisAngle(v(0, 1, 0), torso)
      const chest = (p: THREE.Vector3) => p.clone().sub(SPINE).applyQuaternion(twist).add(SPINE).add(v(x, 0, z).multiplyScalar(.5))
      swing(arms[0], world(grip).add(arms[0].gripOffset.clone().applyQuaternion(turn)), turn, straighten, chest(arms[0].shoulder))
      swing(arms[1], world(foregrip).add(arms[1].gripOffset.clone().applyQuaternion(turn)), turn, straighten, chest(arms[1].shoulder))
    } else if (frame > 0 && frame < frames) {
      const grab = ar ? .26 : .09, removed = ar ? .42 : .25, seated = ar ? .64 : .54
      const curl = .38 * ramp(u, .015, grab) * (1 - ramp(u, .855, .98))
      for (const finger of fingers) finger.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(v(1, 0, 0), curl))
      const tilt = ramp(u, 0, ar ? .20 : .13) * (1 - ramp(u, .86, 1))
      const seatKick = ramp(u, seated - .045, seated) * (1 - ramp(u, seated, seated + .06))
      const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        (ar ? 1.08 : 1.15) * tilt + .035 * seatKick, .10 * tilt, (ar ? -.32 : -.42) * tilt, 'YXZ'))
      const shift = v(.025 * tilt, .045 * tilt + .006 * seatKick, .025 * tilt)
      const wp = weaponPosition.clone().sub(pivot).applyQuaternion(turn).add(pivot).add(shift)
      weapon.position.copy(weapon.parent!.worldToLocal(wp))
      setWorldRotation(weapon, turn.clone().multiply(weaponRotation))
      // Pull clear, lower below view for the unseen exchange, then seat the replacement.
      // Reuse the prop off-screen; never visibly teleport it or scale it away.
      const out = ramp(u, grab, removed) * (1 - ramp(u, seated - .15, seated))
      const down = v(0, -.055 * out, 0).applyQuaternion(turn).add(v(-.035 * out, -.20 * out, .045 * out))
      const magWorld = mag.parent!.localToWorld(magazinePosition.clone()).add(down)
      mag.position.copy(mag.parent!.worldToLocal(magWorld))
      const pull = ramp(u, .76, .82) * (1 - ramp(u, .82, .855))
      const rear = v(0, 0, .032 * pull).applyQuaternion(turn)
      bolt.position.copy(bolt.parent!.worldToLocal(bolt.parent!.localToWorld(boltPosition.clone()).add(rear)))
      root.updateWorldMatrix(true, true)
      solve(arms[0], world(grip).add(arms[0].gripOffset.clone().applyQuaternion(turn)), turn.clone().multiply(arms[0].handQ))
      const home = world(foregrip).add(arms[1].gripOffset.clone().applyQuaternion(turn))
      const feed = world(socket).add(down).add(v(-.035, -.018, .01).applyQuaternion(turn))
      // BR bolt origin is the model root; its mesh bounds locate the physical handle.
      const handle = ar ? world(find('anchor:charging-handle')).add(rear) : new THREE.Box3().setFromObject(bolt).getCenter(v())
      handle.add(v(-.045, -.006, 0).applyQuaternion(turn))
      let left: THREE.Vector3
      if (u < grab) left = home.clone().lerp(feed, ramp(u, .015, grab))
      else if (u < seated + .035) left = feed
      else if (u < .76) left = feed.clone().lerp(handle, ramp(u, seated + .035, .76))
      else if (u < .855) left = handle
      else left = handle.clone().lerp(home, ramp(u, .855, .98))
      solve(arms[1], left, turn.clone().multiply(arms[1].handQ))
    }
    times.push(u * duration)
    nodes.forEach((o, i) => { values[i].position.push(...o.position); values[i].quaternion.push(...o.quaternion); values[i].scale.push(...o.scale) })
  }
  reset()
  return new THREE.AnimationClip(action, duration, nodes.flatMap((o, i) => [
    new THREE.VectorKeyframeTrack(`${o.name}.position`, times, values[i].position),
    new THREE.QuaternionKeyframeTrack(`${o.name}.quaternion`, times, values[i].quaternion),
    new THREE.VectorKeyframeTrack(`${o.name}.scale`, times, values[i].scale),
  ]))
}

export function rifleReload(root: THREE.Object3D, id: 'assault-rifle' | 'battle-rifle', idle: THREE.AnimationClip, duration: number) {
  return rifleActionClip(root, id, idle, duration, 'reload')
}

export function rifleMelee(root: THREE.Object3D, id: 'assault-rifle' | 'battle-rifle', idle: THREE.AnimationClip, duration: number) {
  return rifleActionClip(root, id, idle, duration, 'melee')
}
