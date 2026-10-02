import * as THREE from 'three'

/**
 * Procedural legs laid over the locomotion clips, after the mixer has posed them each frame.
 *
 * Directional stepping. The walk, run and crouch clips only ever step forward. Each foot's travel relative to the
 * hips (where the clip puts it, minus where it sits on average over the cycle) is turned to the direction the body
 * is actually moving and the leg is re-solved to reach it, so a strafe steps sideways, a backpedal steps back and
 * anything in between steps along its own line; the clip still decides when a foot lifts and how high. Sideways the
 * stride shortens (the gait speeds up to match, see `strideScale`), the swinging foot crosses in front of the planted
 * one instead of through it, the feet and knees turn part of the way toward the travel line and the pelvis twists
 * with them while the chest stays square to the aim.
 *
 * Ground contact. Each foot is lowered onto the floor under it (stairs, slopes, a ledge the capsule overhangs), the
 * pelvis drops as far as the lower foot needs, and the knee re-bends to suit: the clip's feet were authored on flat
 * ground at the capsule's height.
 *
 * Everything is recomputed from the clip's pose every frame (the mixer rewrites the leg bones each update), so none
 * of it accumulates. Costs two floor queries and two analytic two-bone solves per character.
 */
/** Highest surface under (x, z) at or below y, and (optionally) its upward normal. */
export type FloorQuery = (x: number, z: number, y: number, normal?: THREE.Vector3) => number

export interface LegDrive {
  /** Travel direction in the body's own frame: 0 forward, +pi/2 to its right, +-pi straight back. */
  heading: number
  /** Stepping as a backpedal rather than a walk, when the authority says (shared/gait.ts): its hit shapes assume the same. */
  backward?: boolean
  /** 0 standing still .. 1 walking or running: how much the heading reshapes the stride. */
  moving: number
  /** Feet on a floor (not jumping, falling or dead): lets them be placed on it. */
  grounded: boolean
  /** World floor height under (x, z), searching down from y; writes the surface normal into `normal` when it can. */
  floor: FloorQuery | null
  /** World height the clips' feet stand at (the player's feet), which the floor is measured against. */
  base: number
  /** How far the chest is turned toward the body's right by a weapon stance (radians; see tp-holds.json): the pelvis stays within
   * TWIST_LIMIT of it, so the spine never twists further than a person's can. */
  chest?: number
  /** The stance's bladed pelvis at rest (radians toward the right): a rifleman stands with the hips turned off the line of fire. */
  blade?: number
  /** 0..1 how crouched: the stance widens to about shoulder width with the toes turned out and the knees tracking over them. */
  crouch?: number
  /** The middle of each foot's stride in the clips now playing (body frame; left, right), from `strideCenters`. Without it the
   * middle is estimated as the running average of where the clip puts the feet, which takes seconds to settle. */
  centers?: readonly [THREE.Vector3, THREE.Vector3]
  dt: number
}

/** The most the pelvis, and the feet with it, turn away from where the chest faces (radians): a person's spine twists about this far. */
export const TWIST_LIMIT = Math.PI / 4
/** Closest the two ankles come, and the two knees, metres: a boot's width and a knee's, so the legs never pass through each other. */
const ANKLE_GAP = .2, KNEE_GAP = .12
/** Crouched: each ankle's distance out from the pelvis's centre line (m) and the toes' turn outward (radians). */
const CROUCH_HALF_WIDTH = .2, CROUCH_TOE_OUT = .3
/** A human hip, radians, measured from the thigh hanging straight down in the pelvis's own frame: how far it swings forward (flexion)
 * and back (extension), out to its own side (abduction) and across the body (adduction); and how far the knee may turn off the pelvis's
 * forward about the thigh (hip rotation). A target beyond them is not reached: the foot falls short rather than the joint dislocating. */
const HIP = { flex: 115 * Math.PI / 180, extend: 25 * Math.PI / 180, abduct: 40 * Math.PI / 180, adduct: 18 * Math.PI / 180, rotate: 35 * Math.PI / 180 }
/** How fast the stride may swing round to a new direction of travel, rad/s: a person turning on the move pivots over a few steps. */
const TURN_RATE = 5
/** How far the hips turn toward a line of travel `off` radians from straight ahead (or straight back): all the way along a diagonal,
 * up to the twist limit at 45 deg, then back to a squarer 20 deg for a pure sidestep, which is a shuffle across the hips, not a walk
 * on twisted ones (twisting all the way sent the knees out sideways: bow-legged). */
export function hipTurn(off: number): number {
  const a = Math.abs(off), knee = TWIST_LIMIT, square = 20 * Math.PI / 180
  return Math.sign(off) * (a <= knee ? a : Math.max(square * .3, knee - (a - knee) / (Math.PI / 4) * (knee - square)))
}

interface Leg {
  up: THREE.Object3D; knee: THREE.Object3D; foot: THREE.Object3D
  upper: number; lower: number
  /** Running average of where the clip puts this ankle (body frame): the middle of its stride. */
  center: THREE.Vector3 | null
  /** Where the clip itself puts the ankle this frame (body frame). */
  clip: THREE.Vector3
  /** Smoothed height of the floor under this foot relative to `base`, and its smoothed normal. */
  ground: number; normal: THREE.Vector3
  target: THREE.Vector3; footRotation: THREE.Quaternion
}

const UP = new THREE.Vector3(0, 1, 0)
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

export interface LegIK {
  apply(drive: LegDrive): void
  /** How long a stride is this frame relative to the clip's (a step across the pelvis is shorter): scales the gait's cadence. */
  readonly stride: number
  /** Stepping as a backpedal (with hysteresis about a sidestep, or as the authority says). */
  readonly backward: boolean
  /** Put back the pose the clips gave before the last apply(). Call it before the mixer updates: three.js only writes a property whose
   * animated value changed, so a held stance would otherwise keep last frame's solved legs and every solve would build on the last. */
  restore(): void
  reset(): void
}

export function createLegIK(root: THREE.Object3D, inner: THREE.Object3D): LegIK | null {
  const bone = (name: string) => inner.getObjectByName(name) ?? null
  const hips = bone('Hips'), spine = bone('Spine02')
  const make = (side: 'Left' | 'Right'): Leg | null => {
    const up = bone(`${side}UpLeg`), knee = bone(`${side}Leg`), foot = bone(`${side}Foot`)
    if (!up || !knee || !foot) return null
    return { up, knee, foot, upper: 0, lower: 0, center: null, ground: 0, normal: new THREE.Vector3(0, 1, 0), clip: new THREE.Vector3(), target: new THREE.Vector3(), footRotation: new THREE.Quaternion() }
  }
  const legs = [make('Left'), make('Right')]
  if (!hips?.parent || legs.some(l => !l)) return null
  const [left, right] = legs as Leg[]
  const touched = [hips, spine, left.up, left.knee, left.foot, right.up, right.knee, right.foot].filter((b): b is THREE.Object3D => !!b)
  const saved = touched.map(() => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }))
  let solved = false
  root.updateWorldMatrix(true, true)
  // World transforms are read straight from matrixWorld, which apply() keeps current (getWorldPosition and friends re-derive the
  // whole parent chain on every call, which was most of this module's cost).
  const at = (o: THREE.Object3D, out = new THREE.Vector3()) => out.setFromMatrixPosition(o.matrixWorld)
  const scratchP = new THREE.Vector3(), scratchS = new THREE.Vector3()
  const worldRotation = (o: THREE.Object3D, out: THREE.Quaternion) => { o.matrixWorld.decompose(scratchP, out, scratchS); return out }
  const toRoot = new THREE.Matrix4()
  for (const leg of [left, right]) { leg.upper = at(leg.up).distanceTo(at(leg.knee)); leg.lower = at(leg.knee).distanceTo(at(leg.foot)) }
  // the ankle's height above the soles when standing (bind pose), to tell a planted foot from a lifted one
  const standing = root.worldToLocal(at(left.foot)).y

  const hip = new THREE.Vector3(), kneeAt = new THREE.Vector3(), ankle = new THREE.Vector3(), local = new THREE.Vector3(), toward = new THREE.Vector3()
  const pole = new THREE.Vector3(), bend = new THREE.Vector3(), want = new THREE.Vector3(), upWorld = new THREE.Vector3()
  const q = new THREE.Quaternion(), qw = new THREE.Quaternion(), qp = new THREE.Quaternion(), yaw = new THREE.Quaternion(), bodyYaw = new THREE.Quaternion()
  const spineWorld = new THREE.Quaternion(), surface = new THREE.Vector3(), tilt = new THREE.Quaternion(), none = new THREE.Quaternion()
  let heading = 0, drop = 0, enabled = 0, pelvisNow = 0, clipTwistAvg = 0, backward = false, stride = 1, air = 0
  const footForward = new THREE.Vector3(), hipF = new THREE.Vector3(), hipOut = new THREE.Vector3()

  /** Turn `bone` in world space so the point now at `from` lands on `to`, about the bone's own origin. */
  const swing = (b: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) => {
    at(b, toward); from.sub(toward); to = to.clone().sub(toward)
    if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return
    q.setFromUnitVectors(from.normalize(), to.normalize())
    worldRotation(b, qw).premultiply(q)
    b.quaternion.copy(worldRotation(b.parent!, qp).invert().multiply(qw))
    b.updateMatrixWorld(true)
  }
  const setWorldRotation = (b: THREE.Object3D, rotation: THREE.Quaternion) => {
    b.quaternion.copy(worldRotation(b.parent!, qp).invert().multiply(rotation))
    b.updateMatrixWorld(true)
  }

  return {
    get stride() { return stride },
    get backward() { return backward },
    restore() {
      if (!solved) return
      touched.forEach((b, i) => { b.position.copy(saved[i].position); b.quaternion.copy(saved[i].quaternion) })
      solved = false
    },
    reset() { this.restore(); air = 0; pelvisNow = 0; backward = false; stride = 1; left.center = right.center = null; left.ground = right.ground = 0; left.normal.set(0, 1, 0); right.normal.set(0, 1, 0); drop = 0; enabled = 0 },
    apply(d) {
      if (solved) this.restore()
      touched.forEach((b, i) => { saved[i].position.copy(b.position); saved[i].quaternion.copy(b.quaternion) })
      solved = true
      const k = 1 - Math.exp(-12 * d.dt)
      enabled += ((d.grounded ? 1 : 0) - enabled) * k
      root.updateWorldMatrix(true, true); toRoot.copy(root.matrixWorld).invert()
      // the body's own turn about the vertical (the first-person body also leans back; that lean is not a heading)
      if (root.parent) worldRotation(root.parent, bodyYaw); else bodyYaw.identity()
      upWorld.copy(UP)
      // heading: follow the travel direction the short way round, and only while there is travel to follow
      // kept in +-pi (it goes round and round), eased and rate limited: a bot that reverses on the spot does not swing its planted feet
      // round in two frames
      if (d.moving > .05) heading = wrap(heading + THREE.MathUtils.clamp(wrap(d.heading - heading) * (1 - Math.exp(-10 * d.dt)), -TURN_RATE * d.dt, TURN_RATE * d.dt))
      // body frame: +x right, -z forward. rot() turns a vector so straight ahead points `a` to the right.
      const rot = (x: number, z: number, a: number, out: THREE.Vector3) => out.set(x * Math.cos(a) - z * Math.sin(a), 0, x * Math.sin(a) + z * Math.cos(a))
      // Walking forwards or backpedalling, with hysteresis so a strafe along the 90 degree line does not flip the hips to and fro. The
      // pelvis (and the stance with it) turns toward the travel line as a walk or a backpedal would, but never past the spine's twist
      // (TWIST_LIMIT from the chest, which faces the aim); the stride runs along the travel line itself, so what is left of the turn is
      // taken as a diagonal step across the pelvis.
      const off = Math.abs(heading)
      if (d.backward !== undefined) backward = d.backward
      else if (backward ? off < 1.2 : off > 1.94) backward = !backward
      const line = backward ? wrap(heading - Math.sign(heading || 1) * Math.PI) : heading
      // at rest the hips blade as the weapon stance has them; on the move they turn toward the line of travel
      const chest = d.chest ?? 0
      // the limit is on the pelvis's whole twist from the chest. The clip swings the pelvis ~9 deg each stride; the limit is held against that
      // swing's average (against the swing itself, a limit in force pulled the hips to and fro every step), and the target eases in
      at(left.up, hip).applyMatrix4(toRoot); at(right.up, kneeAt).applyMatrix4(toRoot)
      const clipTwist = Math.atan2(kneeAt.z - hip.z, kneeAt.x - hip.x) * (right.center && left.center && right.center.x < left.center.x ? -1 : 1)
      clipTwistAvg += (clipTwist - clipTwistAvg) * (1 - Math.exp(-d.dt / .6))
      const pelvisWant = THREE.MathUtils.clamp(THREE.MathUtils.lerp(d.blade ?? 0, hipTurn(line), d.moving), chest - TWIST_LIMIT - clipTwistAvg, chest + TWIST_LIMIT - clipTwistAvg)
      pelvisNow += (pelvisWant - pelvisNow) * (1 - Math.exp(-7 * d.dt))
      const pelvis = pelvisNow, rel = wrap(heading - pelvis)
      // steps across the hips are shorter, and backpedalling ones shorter still (a person steps back in short steps, the hip only extends ~25 deg)
      const scale = stride = THREE.MathUtils.lerp(1, (1 - .28 * Math.abs(Math.sin(rel))) * (1 - .35 * THREE.MathUtils.smoothstep(-Math.cos(rel), 0, 1)), d.moving)
      // a step back or across the pelvis lifts the foot much less than the run's heel-kick: the kick would come up in front of the body
      // on a backpedal, and on a strafe it swings the trailing foot up behind the planted leg, where the knees meet
      const lift = Math.max(.35, 1 - d.moving * (.6 * (1 - Math.cos(rel)) / 2 + .45 * Math.abs(Math.sin(rel))))
      // feet and knees point along the pelvis and a little toward a sidestep (continuous all the way round: a sign flip at 90 degrees
      // used to snap the knees across), never backwards, never past the twist limit
      const footYaw = -(pelvis + .2 * Math.sin(rel) * d.moving), pelvisYaw = -pelvis
      const crouch = d.crouch ?? 0

      for (const leg of [left, right]) {
        at(leg.foot, ankle); local.copy(ankle).applyMatrix4(toRoot)
        if (!leg.center) leg.center = local.clone()
        const given = d.centers?.[leg === left ? 0 : 1]
        if (given) leg.center.copy(given)
        // else the stride's middle drifts to where the clip keeps this foot on average (over several cycles: a run cycle is under a
        // second, and a shorter average rode the stride and swung the whole pattern with it)
        else if (d.moving > .3) { const c = 1 - Math.exp(-d.dt / 2.5); leg.center.x += (local.x - leg.center.x) * c; leg.center.z += (local.z - leg.center.z) * c }
        leg.clip.copy(local)
        leg.target.set(local.x - leg.center.x, local.y, local.z - leg.center.z)   // the clip's travel from the stride's middle
        worldRotation(leg.foot, leg.footRotation)
      }
      const mx = (left.center!.x + right.center!.x) / 2, mz = (left.center!.z + right.center!.z) / 2
      // the stance turns with the pelvis about the pelvis's own pivot (the Hips bone), or the feet slide sideways against the hips
      at(hips, hip).applyMatrix4(toRoot); const px = hip.x, pz = hip.z
      const ax = Math.cos(pelvis), az = Math.sin(pelvis)
      const side = Math.sign(left.center!.x - right.center!.x) || -1
      for (const leg of [left, right]) {
        rot(leg.center!.x - px, leg.center!.z - pz, pelvis, bend); bend.x += px - mx; bend.z += pz - mz   // the stance, turned with the pelvis
        rot(leg.target.x * scale, leg.target.z * scale, heading, pole)          // the stride, turned to the travel line
        leg.target.set(mx + bend.x + pole.x, standing + Math.max(0, leg.target.y - standing) * lift + Math.min(0, leg.target.y - standing), mz + bend.z + pole.z)
        // standing still (or slowing to a stop) the clip's own stance stands: re-aiming only applies as far as there is travel
        leg.target.lerpVectors(leg.clip, leg.target, d.moving)
      }
      // crouched, the feet go out to about shoulder width (the crouch clip keeps them nearly in line)
      if (crouch > .01) for (const leg of [left, right]) {
        const s = leg === left ? side : -side, lateral = (leg.target.x - px) * ax + (leg.target.z - pz) * az
        const want = CROUCH_HALF_WIDTH - s * lateral
        if (want > 0) { leg.target.x += ax * s * want * crouch; leg.target.z += az * s * want * crouch }
      }
      // each foot keeps to its own side of the pelvis (a leg crossing the midline carries its thigh through the other one)
      for (const leg of [left, right]) {
        const s = leg === left ? side : -side, lateral = (leg.target.x - px) * ax + (leg.target.z - pz) * az
        const short = .08 - s * lateral
        if (short > 0) { leg.target.x += ax * s * short; leg.target.z += az * s * short }
      }
      // and never through each other: the ankles stay a boot's width apart, the swinging one giving way
      {
        let dx = left.target.x - right.target.x, dz = left.target.z - right.target.z
        const apart = Math.hypot(dx, dz)
        if (apart < ANKLE_GAP) {
          // straight out to their own sides if they coincide
          if (apart < 1e-3) { dx = ax * side; dz = az * side } else { dx /= apart; dz /= apart }
          // the higher (swinging) foot gives way, shared out smoothly as the two pass the same height (a hard switch popped a foot 20 cm)
          const wl = THREE.MathUtils.smoothstep(left.target.y - right.target.y, -.06, .06), gap = ANKLE_GAP - apart
          left.target.x += dx * gap * wl; left.target.z += dz * gap * wl
          right.target.x -= dx * gap * (1 - wl); right.target.z -= dz * gap * (1 - wl)
        }
      }

      // in the air the knees draw up, one leg leading (the clips have no jump: the standing pose floated), and let down again on landing
      air += ((d.grounded ? 0 : 1) - air) * (1 - Math.exp(-(d.grounded ? 14 : 9) * d.dt))
      if (air > .01) {
        rot(0, -1, pelvis, bend)                                            // forward along the pelvis
        for (const leg of [left, right]) {
          const lead = leg === left ? 1 : -.35
          leg.target.y += air * (.3 + .08 * lead)
          leg.target.x += bend.x * .14 * lead * air; leg.target.z += bend.z * .14 * lead * air
        }
      }
      // floor under each foot, relative to the height the clip's feet stand at
      let low = 0
      for (const leg of [left, right]) {
        want.copy(leg.target).applyMatrix4(root.matrixWorld)
        let g = 0
        surface.set(0, 1, 0)
        if (d.floor && enabled > .01) {
          const y = d.floor(want.x, want.z, d.base + .6, surface)
          g = Number.isFinite(y) ? THREE.MathUtils.clamp(y - d.base, -.55, .45) : 0
          if (surface.y < 0) surface.negate()
        }
        const s = 1 - Math.exp(-18 * d.dt)
        leg.ground += (g - leg.ground) * s
        leg.normal.lerp(surface, s).normalize()
        low = Math.min(low, leg.ground * enabled)
      }
      // stepping across the pelvis sits a touch lower on softer knees, the athletic shuffle Halo 3's Spartans strafe in
      low -= .02 * Math.abs(Math.sin(rel)) * d.moving * enabled
      drop += (low - drop) * (1 - Math.exp(-14 * d.dt))

      // pelvis: down as far as the lower foot needs, twisted toward the travel line; the chest stays square to the aim
      if (spine) worldRotation(spine, spineWorld)
      at(hips, want); want.y += drop
      hips.position.copy(hips.parent!.worldToLocal(want))
      if (pelvisYaw) { yaw.setFromAxisAngle(upWorld, pelvisYaw); worldRotation(hips, qw).premultiply(yaw); setWorldRotation(hips, qw) }
      else hips.updateMatrixWorld(true)
      if (spine) setWorldRotation(spine, spineWorld)

      // the planted leg first; the swinging one then gives way if its knee would pass through the planted one's
      const order = left.target.y > right.target.y ? [right, left] : [left, right]
      let firstKnee: THREE.Vector3 | null = null
      for (const leg of order) {
        // each foot's own turn: the stride's, and crouched, toes out (the left foot's to the left: + about up) with the knee following
        yaw.setFromAxisAngle(upWorld, footYaw + (leg === left ? 1 : -1) * CROUCH_TOE_OUT * crouch)
        want.copy(leg.target).applyMatrix4(root.matrixWorld); want.y += leg.ground * enabled
        at(leg.up, hip); at(leg.knee, kneeAt); at(leg.foot, ankle)
        // bend plane: the knee goes over the toes (the foot's forward, and up for a leg reaching forward), never out to the side (bow-legged)
        // and never backwards, whatever the clip's knee was doing before its foot was moved
        toward.copy(want).sub(hip); const reach = toward.length()
        if (reach < 1e-4) continue
        toward.divideScalar(reach)
        footForward.set(0, 0, -1).applyQuaternion(bodyYaw).applyQuaternion(yaw)
        pole.copy(footForward).addScaledVector(upWorld, .3)
        pole.addScaledVector(toward, -pole.dot(toward))
        if (pole.lengthSq() < 1e-8) pole.copy(footForward)
        pole.normalize()
        // rigid bones: the foot falls short rather than anything stretching, and the knee neither locks straight nor folds past ~140 deg
        const dist = THREE.MathUtils.clamp(reach, Math.sqrt(leg.upper * leg.upper + leg.lower * leg.lower - 2 * leg.upper * leg.lower * Math.cos(.7)), (leg.upper + leg.lower) * .995)
        const along = (leg.upper * leg.upper - leg.lower * leg.lower + dist * dist) / (2 * dist)
        const out = Math.sqrt(Math.max(0, leg.upper * leg.upper - along * along))
        bend.copy(hip).addScaledVector(toward, along).addScaledVector(pole, out)
        if (firstKnee && out > 1e-3) {
          // the knee can sit anywhere on a circle about the hip-ankle line: turn it round that circle away from the other knee, by as much
          // as they are too close (smoothly: no stepping), out to the side and forward only and never past the hip's rotation
          const centre = hip.clone().addScaledVector(toward, along), away = bend.clone().sub(firstKnee)
          away.addScaledVector(toward, -away.dot(toward))
          const short = THREE.MathUtils.smoothstep(KNEE_GAP - bend.distanceTo(firstKnee), 0, KNEE_GAP * .6)
          if (short > 0 && away.lengthSq() > 1e-8) {
            away.normalize(); const axis = toward.clone(), sign = Math.sign(pole.clone().cross(away).dot(axis)) || 1
            pole.applyAxisAngle(axis, sign * short * HIP.rotate).normalize()
            bend.copy(centre).addScaledVector(pole, out)
          }
        }
        // the hip's own range: flexion/extension and abduction/adduction of the thigh in the pelvis's frame
        {
          hipF.set(0, 0, -1).applyQuaternion(bodyYaw).applyAxisAngle(upWorld, pelvisYaw)
          hipOut.set(leg === left ? side : -side, 0, 0)   // its own outside (side: +1 when the left leg is at +x).applyQuaternion(bodyYaw).applyAxisAngle(upWorld, pelvisYaw)
          const t = bend.clone().sub(hip).normalize(), down = -t.dot(upWorld)
          const flex = Math.atan2(t.dot(hipF), down), abd = Math.asin(THREE.MathUtils.clamp(t.dot(hipOut), -1, 1))
          const f2 = THREE.MathUtils.clamp(flex, -HIP.extend, HIP.flex), a2 = THREE.MathUtils.clamp(abd, -HIP.adduct, HIP.abduct)
          if (f2 !== flex || a2 !== abd) {
            // the whole leg turns about the hip as one piece, knee bend kept: the foot falls short of a target the hip cannot reach
            // (turning only the thigh and aiming the shin at the old target bent the knee backwards)
            const t2 = hipF.clone().multiplyScalar(Math.sin(f2) * Math.cos(a2)).addScaledVector(hipOut, Math.sin(a2)).addScaledVector(upWorld, -Math.cos(f2) * Math.cos(a2)).normalize()
            const r = new THREE.Quaternion().setFromUnitVectors(t, t2)
            bend.sub(hip).applyQuaternion(r).add(hip); want.sub(hip).applyQuaternion(r).add(hip)
          }
        }
        swing(leg.up, kneeAt, bend)
        firstKnee = at(leg.knee, new THREE.Vector3())
        at(leg.foot, ankle); swing(leg.knee, ankle, want)
        // the foot keeps the clip's roll off the heel and toe, turned with the knee; a planted foot also lies on the slope under it,
        // as far as an ankle goes (25 deg), and a lifted one eases back to the clip's own angle
        qw.copy(leg.footRotation).premultiply(yaw)
        const planted = enabled * (1 - THREE.MathUtils.smoothstep(leg.target.y - standing, .03, .14))
        if (planted > .01 && leg.normal.y < .9999) {
          surface.copy(leg.normal); const lean = Math.acos(THREE.MathUtils.clamp(surface.y, -1, 1)), max = .44
          if (lean > max) { surface.y = 0; surface.normalize().multiplyScalar(Math.sin(max)); surface.y = Math.cos(max) }
          tilt.setFromUnitVectors(upWorld, surface); qw.premultiply(none.identity().slerp(tilt, planted))
        }
        setWorldRotation(leg.foot, qw)
      }
    },
  }
}
