import * as THREE from 'three'
import type { Bones, BoneName } from './rig.ts'
import { BONES } from './rig.ts'

/**
 * Owner: spartan piece. Procedural locomotion — the whole animation system, such as it is.
 *
 * There are no keyframes and no clips. Every pose in the game is computed from the same state
 * the simulation already keeps: velocity, whether the feet are down, whether the player is
 * crouched, and where they are looking. That is not a shortcut, it is the only way this stays
 * honest — a canned 2 m/s walk clip played back at 6.86 m/s is what foot-skating IS, and Halo
 * runs at 6.86 m/s most of the time.
 *
 * Three things are *derived* rather than tuned, and each one fixed a specific way the old rig
 * looked wrong:
 *
 *   1. STRIDE, from the leg. Pick how far a foot may travel while it is on the ground, advance
 *      the phase at exactly (contact length) / (speed x duty), and the planted foot then tracks
 *      backwards through the world at precisely the speed the body travels forwards. At any
 *      speed. No foot-skate, by construction, including at a sprint and including backpedalling.
 *
 *   2. DUTY FACTOR, from speed. A walk has both feet down at the ends of the step; a sprint has
 *      neither. Letting the fraction of the cycle a foot spends planted fall from 0.63 to 0.31
 *      is what buys a flight phase, and a run without a flight phase is a fast waddle.
 *
 *   3. HIP HEIGHT, from the feet. The pelvis is not bobbed on a sine — it is placed at the
 *      highest point from which BOTH legs can still reach their targets. That single line is
 *      what took the vertical oscillation from 22 cm of piston-bobbing down to about 8 cm, which
 *      is what a real runner does, and it lets the legs go straight at toe-off instead of the
 *      permanent 20-degree half-crouch the old sine-bob forced them into.
 *
 * What the reference frames insist on, and what this reproduces:
 *   - Nobody stands square. Right-handed shooters blade: left shoulder toward the target, right
 *     foot back. That is the base posture, not a pose the idle drifts into.
 *   - The right arm holds the weapon and does not swing. Only the left counter-swings — and only
 *     once they are running; at a walk the left hand comes back onto the foregrip, solved with a
 *     two-bone IK onto a point on the weapon so it lands ON the foregrip rather than near it.
 *   - The WEAPON aims, not the hands. The right wrist is solved last, from the direction the
 *     weapon has to point, so a rifle parented to the hand anchor comes out down-range to within
 *     a degree instead of broadside across the chest.
 *   - Aiming up leans the whole torso back. Split roughly 45/30/20 across chest, neck and head:
 *     all of it on the head is a bobblehead, all of it on the chest is a limbo dancer.
 */

/** Everything the poser needs. A `PlayerState` plus the two look angles satisfies it as-is. */
export interface SpartanMotion {
  vx: number
  vy: number
  vz: number
  onGround: boolean
  crouched: boolean
  /** Facing, radians. The same yaw the render object is spun by. */
  yaw: number
  /** Look pitch, radians, positive is up. */
  pitch: number
}

export interface RigState {
  phase: number
  air: number
  crouch: number
  speed: number
  clock: number
  /** Smoothed lean from acceleration, so a hard turn banks the body. */
  bank: number
  /** Smoothed aim pitch, so a mouse flick does not snap the spine. */
  aim: number
}

export interface SpartanRig {
  bones: Bones
  /**
   * Attach a weapon here. The weapon's own +Z (down-range, as every weapon in this game is
   * authored: see the profile extrusions in models/weapons.ts) lands on the Spartan's forward,
   * and its +Y stays up. `equipSpartan` in ../spartan.ts is the supported way to fill it.
   */
  handAnchor: THREE.Object3D
  /**
   * Where the LEFT hand goes: a point on the weapon, out along the barrel from the grip. Child
   * of the anchor, so equipping a weapon of a different length moves it and the support arm
   * follows without anything here knowing what a weapon is.
   */
  foregrip: THREE.Object3D
  state: RigState
  /** Set once the game drives this rig explicitly; disables the self-driving fallback. */
  driven: boolean
}

export function newRigState(): RigState {
  return { phase: 0, air: 0, crouch: 0, speed: 0, clock: 0, bank: 0, aim: 0 }
}

const TAU = Math.PI * 2
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Hip to ankle in the bind pose, straight. Every number in the gait is derived from it. */
const REACH = BONES.hips.pos[1] - BONES.footR.pos[1]
/** Height of the ankle joint when the sole is on the ground. */
const FOOT_Y = BONES.footR.pos[1]

const seg = (a: BoneName, b: BoneName): number => {
  const p = BONES[a].pos
  const q = BONES[b].pos
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}
const UPPER_ARM = seg('upperArmR', 'elbowR')
const FOREARM = seg('forearmR', 'handR')
const THIGH = seg('thighR', 'kneeR')
const SHIN = seg('shinR', 'footR')
/** Arm and leg segment pairs, so the solver is never handed the wrong limb's proportions. */
const ARM_SEG: readonly [number, number] = [UPPER_ARM, FOREARM]
const LEG_SEG: readonly [number, number] = [THIGH, SHIN]

/**
 * The longest a foot may travel while it is on the ground. Chosen so that at the instant of
 * heel strike the leading leg is *exactly* straight with the hips 9 cm below standing height —
 * i.e. it is the largest stride this particular leg can take without the pelvis collapsing.
 */
const CONTACT_MAX = 0.90
/** Split of that contact: the foot lands this far ahead of the hip and leaves the rest behind. */
const CONTACT_FRONT = 0.40

// Scratch. The poser runs on every visible Spartan every frame and allocates nothing.
const _m = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()
const _v = new THREE.Vector3()
const _d = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _qs = new THREE.Quaternion()
const _e = new THREE.Euler()
const _qa = new THREE.Quaternion()
const _ax = new THREE.Vector3()
const _ay = new THREE.Vector3()
const _az = new THREE.Vector3()
const _basis = new THREE.Matrix4()
const _gripInv = new THREE.Quaternion()
const SIDES = ['R', 'L'] as const
const DOWN = new THREE.Vector3(0, -1, 0)
const UP = new THREE.Vector3(0, 1, 0)
const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Y = new THREE.Vector3(0, 1, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)

interface Track { z: number; lift: number; pitch: number; absorb: number }
const _track: [Track, Track] = [
  { z: 0, lift: 0, pitch: 0, absorb: 0 },
  { z: 0, lift: 0, pitch: 0, absorb: 0 },
]
const _foot: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()]

/**
 * The weapon carry, authored as where the right WRIST goes rather than as joint angles, in
 * chest space. A hand position is something you can hold against a reference frame and argue
 * about; three Euler angles that happen to produce it are not. The arm is solved onto it, and
 * then the wrist is overridden so the weapon — not the hand — points where the Spartan aims.
 */
const CARRY = { x: 0.062, y: -0.010, z: -0.140, twist: 0.34 }

/**
 * Advance one rig. Pure: motion in, pose out. Knows nothing about health, teams, weapons or the
 * scene graph above it — the caller owns position and yaw, this owns everything below the hips.
 */
export function updateSpartanRig(root: THREE.Object3D, m: SpartanMotion, dt: number): void {
  const rig = root.userData.rig as SpartanRig | undefined
  if (!rig) return
  rig.driven = true
  poseRig(rig, m, dt)
}

export function poseRig(rig: SpartanRig, m: SpartanMotion, dt: number): void {
  const b = rig.bones
  const st = rig.state
  dt = Math.min(Math.max(dt, 0), 0.1)
  st.clock += dt

  // ---- read the motion -----------------------------------------------------------------
  const speed = Math.hypot(m.vx, m.vz)
  st.speed += (speed - st.speed) * (1 - Math.exp(-14 * dt))
  const sp = st.speed

  const sin = Math.sin(m.yaw)
  const cos = Math.cos(m.yaw)
  // Body-space velocity. Forward is (-sin, -cos) and right is (cos, -sin); see movement.ts.
  const fwd = -m.vx * sin - m.vz * cos
  const side = m.vx * cos - m.vz * sin
  const backing = fwd < -0.4 ? -1 : 1

  st.air += ((m.onGround ? 0 : 1) - st.air) * (1 - Math.exp(-13 * dt))
  st.crouch += ((m.crouched && m.onGround ? 1 : 0) - st.crouch) * (1 - Math.exp(-13 * dt))
  st.bank += (clamp01(Math.abs(side) / 5) * Math.sign(side) - st.bank) * (1 - Math.exp(-8 * dt))
  const wantAim = Math.max(-1.15, Math.min(1.15, m.pitch))
  st.aim += (wantAim - st.aim) * (1 - Math.exp(-16 * dt))
  const air = st.air
  const cr = st.crouch
  const pitch = st.aim

  // ---- gait geometry ---------------------------------------------------------------------
  // Contact length grows with speed and saturates at what this leg can actually sweep; the duty
  // factor falls with speed, which is what opens a flight phase; the period follows from the two
  // of them, and IS the no-skate condition: a foot on the ground for `duty` of a `period` while
  // travelling `contact` backwards through the body frame is travelling at exactly `sp`.
  const contact = Math.min(0.24 + 0.118 * sp, CONTACT_MAX) * (1 - 0.30 * cr)
  const duty = Math.max(0.31, Math.min(0.63, 0.63 - 0.047 * sp))
  const front = CONTACT_FRONT * contact
  const rear = contact - front
  // How far the ankle must lift by toe-off for the trailing leg to still reach the ground from
  // the hip height the LEADING leg dictates. Derived, so the two never fight.
  const hipAtStrike = Math.sqrt(Math.max(0.01, REACH * REACH - front * front))
  const toeLift = Math.max(0.02, hipAtStrike - Math.sqrt(Math.max(0.0025, REACH * REACH - rear * rear)))
  const period = Math.max(0.28, Math.min(1.2, contact / Math.max(0.30, sp * duty)))
  st.phase += (dt / period) * TAU * backing
  st.phase = ((st.phase % TAU) + TAU) % TAU

  // How much of the walk to mix in at all. Below a slow walk it fades to the idle stance.
  const gait = clamp01((sp - 0.12) / 1.0) * (1 - air)
  const swing = contact / CONTACT_MAX
  const ph = st.phase
  const c = Math.cos(ph)
  const s = Math.sin(ph)
  const u0 = ph / TAU

  // ---- foot placement, then the pelvis on top of it --------------------------------------
  // Targets first, hips second. The pelvis rides as high as it can while both legs still reach:
  // no bob constant anywhere, and therefore no way for the bob and the stride to disagree.
  //
  // The pelvis SWAY and YAW have to be settled before the reach test, not after: a 0.2 rad hip
  // yaw walks the hip sockets 2.4 cm fore and aft, which is easily enough to put a foot target
  // out of reach, and an out-of-reach target is a foot that stops tracking the ground — i.e. it
  // comes back as skate. Pose the pelvis' rotation first, measure the sockets through it, and
  // the drift stays at the millimetre level.
  const sway = 0.045 * s * gait
  const hipPitch = 0.10 * cr + 0.05 * air
  const hipYaw = -0.06 + 0.18 * swing * c * gait
  const hipRoll = -sway * 0.9
  const hipZ = 0.11 * cr - 0.02 * air
  b.hips.rotation.set(hipPitch, hipYaw, hipRoll)
  _q.setFromEuler(b.hips.rotation)

  let hipY = REACH
  for (let i = 0; i < 2; i++) {
    const sideKey = SIDES[i]
    const sgn = sideKey === 'R' ? 1 : -1
    // Right foot leads at phase zero; the left runs half a cycle behind it.
    const u = i === 0 ? u0 : (u0 + 0.5) % 1
    const tr = footTrack(_track[i], u, duty, front, contact, toeLift, swing)

    // Idle is bladed — right foot back, left forward, feet apart — and the crouch widens and
    // draws the feet in under the dropped hips. Both are just different foot placements.
    const idleZ = sgn > 0 ? 0.050 : -0.045
    const hipX = BONES[`thigh${sideKey}` as BoneName].pos[0]
    const restX = hipX * (1 + 0.22 * cr)
    // Root space: the solver takes its target in the hips' parent frame, so the ground stays put
    // underneath the pelvis however the pelvis bobs and sways over it.
    _foot[i].set(
      restX + sgn * 0.02 * gait,
      FOOT_Y + tr.lift * gait,
      lerp(idleZ, tr.z, gait) + (sgn > 0 ? 0.03 : -0.10) * cr,
    )

    // The reach constraint for this foot: the highest the hip joint can sit and still touch it,
    // measured to the actual socket, which the pelvis' own rotation has already moved.
    _v.set(hipX, 0, 0).applyQuaternion(_q)
    const dx = _foot[i].x - (sway + _v.x)
    const dz = _foot[i].z - (hipZ + _v.z)
    const allow = Math.sqrt(Math.max(0.0025, REACH * REACH - dx * dx - dz * dz)) - _v.y
      + (_foot[i].y - FOOT_Y) - 0.003
    // A little compliance through mid-stance, so the knee actually absorbs the step instead of
    // staying a rigid strut. Zero at heel strike and at toe-off, where the leg should be straight.
    hipY = Math.min(hipY, allow - 0.035 * gait * tr.absorb)
  }
  hipY = Math.max(REACH - 0.26, Math.min(REACH, hipY))

  const crouchDrop = -0.42 * cr
  b.hips.position.set(sway, FOOT_Y + hipY + crouchDrop, hipZ)

  // ---- legs --------------------------------------------------------------------------------
  const rise = clamp01((m.vy + 2) / 6)
  for (let i = 0; i < 2; i++) {
    const sideKey = SIDES[i]
    const sgn = sideKey === 'R' ? 1 : -1
    const thigh = b[`thigh${sideKey}` as BoneName]
    const knee = b[`knee${sideKey}` as BoneName]
    const kneeAngle = solveArm(b.hips, thigh, _foot[i], sgn * 0.06, _q, LEG_SEG, -1)

    // Airborne the feet have no ground to be placed on, so the tuck is authored as angles and
    // blended in over the solve. Harder on the way up than on the way down: a Spartan reaches
    // for the ground before it lands.
    if (air > 0.002) {
      const lead = sgn > 0 ? 1 : 0.55
      _e.set((0.18 + 0.85 * rise) * lead, 0, sgn * 0.10)
      _q.slerp(_q2.setFromEuler(_e), air)
      knee.rotation.x = lerp(kneeAngle, -(0.35 + 1.45 * rise) * lead, air)
    } else {
      knee.rotation.set(kneeAngle, 0, 0)
    }
    thigh.quaternion.copy(_q)
    b[`shin${sideKey}` as BoneName].rotation.set(0, 0, 0)

    // Keep the sole flat to the ground through stance and roll it through the step, by cancelling
    // whatever the hip and knee ended up doing rather than guessing an angle that undoes them.
    const footPitch = lerp(sgn > 0 ? 0.02 : -0.02, _track[i].pitch, gait) + lerp(0, 0.55, cr) + 0.40 * air
    _qa.copy(b.hips.quaternion).multiply(thigh.quaternion).multiply(_q2.setFromAxisAngle(AXIS_X, knee.rotation.x))
    b[`foot${sideKey}` as BoneName].quaternion.copy(_qa.invert()).multiply(_q2.setFromAxisAngle(AXIS_X, footPitch))
  }

  // ---- torso and head --------------------------------------------------------------------
  // Bladed carry, torso counter-rotating against the pelvis as the stride swings, and the aim
  // pitch split across three joints so the lean reads from a distance.
  const idleBreath = (1 - gait) * (1 - air) * (1 - cr * 0.6)
  const breathe = Math.sin(st.clock * 1.55) * idleBreath
  const lean = clamp01(sp / 7) * 0.11 * gait

  b.spine.rotation.set(0.10 * cr + breathe * 0.012 + lean * 0.4 + pitch * 0.10, -0.04 - 0.12 * swing * c * gait, -st.bank * 0.05)
  b.chest.rotation.set(
    pitch * 0.42 + 0.14 * cr + breathe * 0.022 - lean * 0.9 + 0.02 * air,
    -0.13 - 0.20 * swing * c * gait,
    -st.bank * 0.08,
  )
  b.neck.rotation.set(pitch * 0.28 - 0.10 * cr - breathe * 0.014, 0.10, 0)
  b.head.rotation.set(pitch * 0.20 - 0.06 * cr, 0.08, st.bank * 0.06)

  // Pauldrons ride the breath and lift a little when airborne.
  const shrug = breathe * 0.03 + air * 0.10
  b.shoulderR.rotation.set(0, 0, -shrug)
  b.shoulderL.rotation.set(0, 0, shrug)

  // ---- right arm: the weapon --------------------------------------------------------------
  // It does not swing. The wrist is PLACED by IK and then ORIENTED by the weapon: the hand ends
  // up wherever it has to be for a rifle held at that point to be pointing down-range at the aim
  // pitch. Solving it the other way round — pose the hand, hope the gun follows — is exactly how
  // the previous rig ended up with the muzzle out the right shoulder.
  const bounce = 0.030 * swing * Math.sin(2 * ph) * gait
  _v.set(
    CARRY.x - 0.02 * cr,
    CARRY.y + bounce + 0.02 * cr + pitch * 0.11,
    // The weapon is carried close at rest and pushed out as the Spartan moves or aims — which is
    // both what the reference frames show and what keeps the idle silhouette inside its spec.
    CARRY.z + 0.05 * cr - 0.055 * gait - Math.abs(pitch) * 0.05,
  )
  b.elbowR.rotation.set(solveArm(b.shoulderR, b.upperArmR, _v, CARRY.twist, _q, ARM_SEG), 0, 0)
  b.upperArmR.quaternion.copy(_q)
  b.forearmR.rotation.set(0, 0.10, 0)
  aimWeapon(rig, pitch, -0.055, 0.16 - 0.10 * cr)

  // ---- left arm: foregrip below a jog, counter-swing above it ------------------------------
  const swingMix = clamp01((sp - 2.6) / 2.8) * gait
  // Counter-swing pose: opposite the left leg, elbow tucked in against the ribs.
  _e.set(0.26 + 0.47 * swing * c * gait, 0.10, 0.16)
  _q.setFromEuler(_e)
  const swingElbow = 0.62 + 0.55 * clamp01(swing * c) + 0.30 * Math.max(0, s)

  // Support pose: two-bone IK onto the foregrip point on the weapon itself.
  gripTarget(rig, _v)
  const support = solveArm(b.shoulderL, b.upperArmL, _v, -0.55, _q2, ARM_SEG)
  b.upperArmL.quaternion.copy(_q2).slerp(_q, swingMix)
  b.elbowL.rotation.set(lerp(support, swingElbow, swingMix), 0, 0)
  b.forearmL.rotation.set(0, -0.25 + 0.25 * swingMix, 0)
  b.handL.rotation.set(-0.80 + 1.05 * swingMix, -0.25, 0.30)
}

/**
 * One foot's path through a cycle, in the body's own frame. `u` is 0 at heel strike; the foot is
 * on the ground while u < duty and in the air after, so a duty below 0.5 leaves a stretch of the
 * cycle with neither foot down, which is what a run is.
 */
function footTrack(
  out: Track,
  u: number,
  duty: number,
  front: number,
  contact: number,
  toeLift: number,
  amp: number,
): Track {
  if (u < duty) {
    // Stance. Linear, at exactly body speed — the whole point of the exercise. The heel rolls in
    // at the front and the ankle climbs through the second half as the Spartan goes up on the toe.
    const t = u / duty
    const off = Math.max(0, (t - 0.55) / 0.45)
    const hs = Math.max(0, 1 - t / 0.12)
    out.z = -front + contact * t
    out.lift = toeLift * off * off + 0.020 * hs * hs
    out.pitch = -0.85 * off * off + 0.12 * hs * hs
    const sn = Math.sin(Math.PI * t)
    out.absorb = sn * sn
    return out
  }
  // Swing: eased back to the front, over an arc that scales with how big the stride is.
  const w = (u - duty) / (1 - duty)
  const e = w * w * (3 - 2 * w)
  const iw = 1 - w
  out.z = (contact - front) - contact * e
  out.lift = toeLift * iw * iw + Math.sin(Math.PI * w) * (0.09 + 0.26 * amp) + 0.020 * w * w
  out.pitch = -0.85 * iw * iw + 0.12 * w * w
  out.absorb = 0
  return out
}

/**
 * Point the WEAPON, and let the wrist be whatever that costs.
 *
 * The hand anchor carries a fixed basis that turns the weapon's authored axes into the hand's,
 * so what this has to produce is a right-hand rotation R with
 *     (chain above the hand) x R x (anchor basis) == (the aim frame)
 * which is one inverse and two multiplies. Doing it this way means the grip is correct for any
 * arm pose the IK happens to land on, and it is checkable: the barrel's world direction is the
 * aim direction, to the precision of a quaternion.
 */
function aimWeapon(rig: SpartanRig, pitch: number, yawOff: number, roll: number): void {
  const b = rig.bones
  // Aim frame in model space: -Z is forward, +Y up.
  const cp = Math.cos(pitch)
  _az.set(Math.sin(yawOff) * cp, Math.sin(pitch), -Math.cos(yawOff) * cp).normalize()
  _ax.copy(UP).cross(_az).normalize()
  _ay.copy(_az).cross(_ax)
  _basis.makeBasis(_ax, _ay, _az)
  _q2.setFromRotationMatrix(_basis)
  // Cant the weapon about its own long axis: nobody carries a rifle dead level.
  _q2.multiply(_qs.setFromAxisAngle(AXIS_Z, roll))

  _qa.copy(b.hips.quaternion)
    .multiply(b.spine.quaternion)
    .multiply(b.chest.quaternion)
    .multiply(b.shoulderR.quaternion)
    .multiply(b.upperArmR.quaternion)
    .multiply(b.elbowR.quaternion)
    .multiply(b.forearmR.quaternion)
  _gripInv.copy(rig.handAnchor.quaternion).invert()
  b.handR.quaternion.copy(_qa.invert()).multiply(_q2).multiply(_gripInv)
}

/**
 * Where the left hand should land: the foregrip node hanging off the weapon anchor, expressed in
 * chest space by walking the right arm's own local matrices. No world-matrix pass, so posing a
 * Spartan never touches the scene graph above it.
 */
function gripTarget(rig: SpartanRig, out: THREE.Vector3): void {
  const b = rig.bones
  _m.identity()
  _m.multiply(mat(b.shoulderR))
  _m.multiply(mat(b.upperArmR))
  _m.multiply(mat(b.elbowR))
  _m.multiply(mat(b.forearmR))
  _m.multiply(mat(b.handR))
  _m.multiply(mat(rig.handAnchor))
  _m.multiply(mat(rig.foregrip))
  // The target is the WRIST, so back off from the foregrip along the forearm: the hand itself
  // reaches forward and up from there and closes on the handguard.
  out.set(0.02, -0.062, -0.078).applyMatrix4(_m)
}

function mat(o: THREE.Object3D): THREE.Matrix4 {
  o.updateMatrix()
  return o.matrix
}

/**
 * Analytic two-bone IK, in the shoulder's own space. Returns the elbow angle and writes the
 * upper-arm rotation. The limb's rest axis is -Y and the elbow bends about +X, so the upper arm
 * is the rotation onto the target swung back by the triangle's angle at the shoulder; `twist`
 * rolls the bend plane so the elbow finishes outboard and low instead of through the ribs.
 *
 * The extension clamp is deliberately tight (1.5 mm). It used to be 15 mm, which sounds like
 * nothing and is not: near full extension the knee angle is enormously sensitive to the last
 * millimetre, and 15 mm of slack put a permanent 20-degree bend in a leg that should be straight
 * at toe-off — the difference between a run and a crouched shuffle.
 */
function solveArm(
  shoulder: THREE.Bone,
  upper: THREE.Bone,
  targetChestSpace: THREE.Vector3,
  twist: number,
  outQ: THREE.Quaternion,
  segs: readonly [number, number],
  /** +1 bends the joint forward (elbows), -1 bends it back (knees). */
  bend: 1 | -1 = 1,
): number {
  shoulder.updateMatrix()
  _m2.copy(shoulder.matrix).invert()
  _d.copy(targetChestSpace).applyMatrix4(_m2).sub(upper.position)

  const a = segs[0]
  const c = segs[1]
  let L = _d.length()
  L = Math.min(Math.max(L, Math.abs(a - c) + 0.02), a + c - 0.0015)
  const alpha = Math.acos(Math.min(1, Math.max(-1, (a * a + L * L - c * c) / (2 * a * L))))
  const beta = Math.PI - Math.acos(Math.min(1, Math.max(-1, (a * a + c * c - L * L) / (2 * a * c))))

  _d.normalize()
  outQ.setFromUnitVectors(DOWN, _d)
  outQ.multiply(_qs.setFromAxisAngle(AXIS_Y, twist))
  outQ.multiply(_qs.setFromAxisAngle(AXIS_X, -alpha * bend))
  return beta * bend
}
