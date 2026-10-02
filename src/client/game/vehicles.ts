import * as THREE from 'three'
import {RIDER_TIMING} from '../../shared/presentation.ts'
import type { Team } from '../../shared/assets.ts'
import {
  VEHICLE_SPAWNS, spawnVehicleState, stepVehicle, warthogSuspensionSamples, aimTurret as aimTurretState, IDLE_VEHICLE_INPUT,
  type VehicleKind, type VehicleState, type VehicleInput, type Seat,
} from '../../shared/vehicle-sim.ts'
import { createVehicleRider, type VehicleRider, type RiderMotion } from '../render/models/vehicle-rider.ts'
import { loadAuthoredVehicle, poseVehicleTurret, type AuthoredVehicle } from '../render/models/authored-vehicles.ts'
import { VehicleBuffer, type VehiclePose } from '../net/remote.ts'
import { VEHICLE_BOOSTING } from '../../shared/protocol.ts'
import { steeringLimit } from '../../shared/vehicle-physics.ts'
import { VehicleFx, type EngineFxState } from '../render/vehicle-fx.ts'
import { createMuzzleFlash } from '../render/models/muzzle-flash.ts'

/**
 * The vehicles as the player sees them.
 *
 * Physics lives in `src/shared/vehicle-sim.ts` and runs here for the vehicle you drive, offline
 * or as a prediction the server confirms. Everything else in this file is presentation: the
 * authored Blender models and their LODs, wheels and turret, the rider posed on each seat, and
 * where a vehicle nobody here is driving gets drawn between snapshots.
 */

export type Vehicle = {
  id: number
  kind: VehicleKind
  team: Team
  object: THREE.Object3D
  /** The shared simulation state. The object follows it; nothing moves the object directly. */
  state: VehicleState
  turret: THREE.Object3D | null
  wheels: THREE.Object3D[]
  model: AuthoredVehicle | null
  wheelAngle: number
  barrelAngle: number
  barrelSpeed: number
  firing: boolean
  shots: number
  /** Occupants by player id, 0 for an empty seat. Online only; offline the local player is implied. */
  driver: number
  gunner: number
  /** Snapshot interpolation for vehicles someone else is driving. */
  buffer: VehicleBuffer
  pose: VehiclePose
  /** Riders posed on seats other people occupy. */
  seatRiders: Map<Seat, VehicleRider>
  seatMotion: RiderMotion
  seatTeams: Map<Seat, Team>
  /** The Warthog chain gun's muzzle flash (on the vehicle root, so it shows at every detail level), and how long it has left. */
  turretFlash: THREE.Mesh | null
  flashTime: number
  flashLife: number
}

const steeringAxis = new THREE.Vector3(0, .912, .410).normalize()
const authoredSteeringAxis = new THREE.Vector3()
/** The chain gun's flash is the rifles' flash (muzzle-flash.ts) scaled for a three-barrel gun seen from across a field. */
const TURRET_FLASH = 3.2
/** Drawn front-wheel angle at full lock (radians), and the cockpit wheel's turn to match. */
const WHEEL_LOCK = .55, STEERING_WHEEL_LOCK = .9

export class Vehicles {
  private readonly suspensionRest=new WeakMap<THREE.Object3D,{y:number;offset:number}>()
  readonly all: Vehicle[] = []
  readonly ready: Promise<void>
  private active: Vehicle | null = null
  private readonly riders = new Map<Team, VehicleRider>()
  private readonly loadingRiders = new Map<string, Promise<void>>()
  private readonly motion: RiderMotion = { dt: 0, time: 0, speed: 0, steering: 0, entry: 1, entryFrom: null, exit: 0, exitTo: null }
  private exitDone: (() => void) | null = null
  private readonly inverse = new THREE.Quaternion()
  /** Ghost boost plumes, Banshee engines, contrails and sparks. */
  private fx: VehicleFx | null = null
  private readonly fxState: EngineFxState = { maneuver: false, speed: 0, driven: false, vx: 0, vy: 0, vz: 0 }
  get occupied(): Vehicle | null { return this.active }
  set occupied(vehicle: Vehicle | null) {
    if (this.active === vehicle) return
    if (this.active) this.active.firing = false
    for (const rider of this.riders.values()) { rider.object.visible = false; rider.reset() }
    this.active = vehicle; this.motion.entry = 0; this.motion.exit = 0; this.motion.entryFrom = null; this.motion.exitTo = null; this.exitDone = null
  }
  get isExiting(): boolean { return this.exitDone !== null }
  enter(vehicle: Vehicle, from: THREE.Vector3): void { this.occupied = vehicle; this.motion.entryFrom = from.clone() }
  beginExit(to: THREE.Vector3, complete: () => void): boolean {
    if (!this.active || this.isExiting) return false
    this.motion.exit = 0; this.motion.exitTo = to.clone(); this.exitDone = complete; this.active.firing = false
    return true
  }
  constructor(scene: THREE.Scene, enabled = true) {
    if (!enabled) { this.ready=Promise.resolve(); return }
    this.fx = new VehicleFx(scene)
    const pending: Promise<void>[] = []
    for (const spawn of VEHICLE_SPAWNS) {
      const object = new THREE.Group(); object.name = `vehicle:${spawn.kind}`
      const state = spawnVehicleState(spawn)
      const v: Vehicle = {
        id: spawn.id, kind: spawn.kind, team: spawn.team, object, state, turret: null, wheels: [], model: null,
        wheelAngle: 0, barrelAngle: 0, barrelSpeed: 0, firing: false, shots: 0, driver: 0, gunner: 0,
        buffer: new VehicleBuffer(),
        pose: { x: state.x, y: state.y, z: state.z, yaw: state.yaw, pitch: 0, roll: 0, turretYaw: 0, turretPitch: 0, speed: 0, driver: 0, gunner: 0, flags: 0 },
        seatRiders: new Map(), seatTeams: new Map(), turretFlash: null, flashTime: 0, flashLife: .05,
        seatMotion: { dt: 0, time: 0, speed: 0, steering: 0, entry: 1, entryFrom: null, exit: 0, exitTo: null },
      }
      this.syncObject(v)
      object.visible = false; scene.add(object); this.all.push(v)
      pending.push(loadAuthoredVehicle(spawn.kind).then(model => {
        v.model = model; v.turret = model.parts.turret; v.wheels = model.parts.wheels
        if (v.kind === 'warthog') { const flash = createMuzzleFlash('warthog'); flash.name = 'warthog-turret-flash'; flash.visible = false; object.add(flash); v.turretFlash = flash }
        object.add(model.object); object.visible = true
      }).catch(error => console.error(`Could not load newly authored ${spawn.kind}`, error)))
    }
    this.ready = Promise.all(pending).then(() => {})
  }
  byId(id: number): Vehicle | undefined { return this.all[id] }
  nearest(p: THREE.Vector3): Vehicle | undefined {
    let found: Vehicle | undefined, distance = 25
    for (const v of this.all) { const d = v.object.position.distanceToSquared(p); if (v.model && d < distance) { found = v; distance = d } }
    return found
  }
  /** Where the object sits and how it leans, from the simulation state. */
  syncObject(v: Vehicle): void {
    v.object.position.set(v.state.x, v.state.y, v.state.z)
    if(v.state.physicsReady)v.object.quaternion.set(v.state.qx??0,v.state.qy??0,v.state.qz??0,v.state.qw??1)
    else v.object.rotation.set(-v.state.pitch, v.state.yaw + Math.PI, v.state.roll, 'YXZ')
  }
  /** Drive this vehicle by one input for `dt` seconds through the shared simulation. */
  drive(v: Vehicle, input: VehicleInput, dt: number): void {
    stepVehicle(v.kind, v.state, this.isExiting ? { ...input, coast: true } : input, dt)
    this.syncObject(v)
  }
  /** Nobody is driving: roll to a stop, settle, level out. */
  coast(v: Vehicle, dt: number): void {
    stepVehicle(v.kind, v.state, IDLE_VEHICLE_INPUT, dt)
    this.syncObject(v)
  }
  /** Where the network says a vehicle is, a tenth of a second ago. */
  applyRemote(v: Vehicle, pose: VehiclePose): void {
    const s = v.state
    s.x = pose.x; s.y = pose.y; s.z = pose.z
    s.yaw = pose.yaw; s.pitch = pose.pitch; s.roll = pose.roll
    const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(-pose.pitch,pose.yaw+Math.PI,pose.roll,'YXZ'))
    s.qx=q.x;s.qy=q.y;s.qz=q.z;s.qw=q.w;s.physicsReady=true
    s.pvx=-Math.sin(pose.yaw)*pose.speed;s.pvy=0;s.pvz=-Math.cos(pose.yaw)*pose.speed
    s.avx=0;s.avy=0;s.avz=0;s.wheelTravel=undefined;s.physicsRemainder=0
    s.turretYaw = pose.turretYaw; s.turretPitch = pose.turretPitch
    s.maneuver = (pose.flags & VEHICLE_BOOSTING) !== 0 ? .15 : 0
    s.speed = pose.speed
    s.impactSeq=pose.impactSeq??0;s.impactSpeed=pose.impactSpeed??0
    v.driver = pose.driver; v.gunner = pose.gunner
    if (v !== this.active) v.firing = (pose.flags & 1) !== 0
    this.syncObject(v)
  }
  aimTurret(v: Vehicle, yaw: number, pitch: number): void {
    if (!v.model?.parts.turret) return
    aimTurretState(v.state, yaw, pitch)
    this.applyRig(v)
  }
  setFiring(v: Vehicle, held: boolean): void { v.firing = held && !this.isExiting }
  /** Where the next round leaves. For the Warthog's chain gun every call is one round: it steps to the next barrel and lights the flash. */
  muzzlePosition(v: Vehicle, side: boolean, target: THREE.Vector3): THREE.Vector3 {
    const name = v.kind === 'ghost' || v.kind === 'banshee' || v.kind === 'chopper' ? side ? 'muzzle:left' : 'muzzle:right' : `anchor:muzzle:${v.shots++ % 3}`
    const anchor = v.model?.parts.anchors.get(name) ?? v.model?.parts.anchors.get('anchor:muzzle')
    if (!anchor) throw new Error(`${v.kind} is missing its authored muzzle marker`)
    if (v.turretFlash) {
      // each round rolls and resizes the flash, so the gun's stutter never repeats a frame
      v.turretFlash.userData.shot?.(); v.flashTime = v.flashLife = (v.turretFlash.userData.life as number | undefined) ?? .05
      this.placeTurretFlash(v, 1)
    }
    return anchor.getWorldPosition(target)
  }
  /** The flash at the centre of the barrel cluster, pointing down the barrels (it turns with their spin), faded to `k` of its life. */
  private placeTurretFlash(v: Vehicle, k: number): void {
    const flash = v.turretFlash, anchor = v.model?.parts.anchors.get('anchor:muzzle')
    if (!flash || !anchor) return
    v.object.updateWorldMatrix(true, true)
    flash.position.copy(v.object.worldToLocal(anchor.getWorldPosition(this.flashAt)))
    flash.quaternion.copy(v.object.getWorldQuaternion(this.inverse).invert()).multiply(anchor.getWorldQuaternion(this.flashTurn))
    flash.scale.setScalar(TURRET_FLASH); flash.userData.fade?.(k)
    flash.visible = k > 0
  }
  private readonly flashAt = new THREE.Vector3()
  private readonly flashTurn = new THREE.Quaternion()
  /** The Banshee's centreline gun. Throws if asked of anything else, which would be a wiring bug. */
  fuelRodPosition(v: Vehicle, target: THREE.Vector3): THREE.Vector3 {
    const anchor = v.model?.parts.anchors.get('muzzle:fuelrod')
    if (!anchor) throw new Error(`${v.kind} has no fuel rod muzzle`)
    return anchor.getWorldPosition(target)
  }
  muzzleDirection(v: Vehicle, target: THREE.Vector3): THREE.Vector3 {
    const part = v.model?.parts.pitch ?? v.turret ?? v.object
    return target.set(0, 0, 1).applyQuaternion(part.getWorldQuaternion(this.inverse)).normalize()
  }
  private applyRig(v: Vehicle): void {
    if (!v.model) return
    // The physics lock shrinks with speed (9 degrees at a sprint), which reads as no steering at all from the
    // chase camera. Draw the wheels at the fraction of that lock in use, like Halo's wheels swinging hard over.
    const turn = THREE.MathUtils.clamp(v.state.steering / steeringLimit(v.kind, v.state.speed), -1, 1)
    for (const parts of v.model.levels) {
      if (!parts) continue
      poseVehicleTurret(parts, v.state.turretYaw, v.state.turretPitch, v.barrelAngle)
      for (const wheel of parts.wheels) wheel.rotation.x = v.wheelAngle
      for (const wheel of parts.steeringWheels) wheel.rotation.y = turn * WHEEL_LOCK
      if (parts.steering) {
        const axis = parts.steering.userData.rotationAxis
        parts.steering.quaternion.setFromAxisAngle(Array.isArray(axis)
          ? authoredSteeringAxis.fromArray(axis).normalize() : steeringAxis, -turn * STEERING_WHEEL_LOCK)
      }
    }
  }
  /** Run each frame, including on foot, for LODs, hover, wheel spin and barrel coast-down. */
  updatePresentation(dt: number, cameraPosition: THREE.Vector3): void {
    const h = Math.min(Math.max(dt, 0), .1); this.motion.dt = h; this.motion.time += h
    this.fx?.begin(h, cameraPosition)
    if (this.active) {
      this.motion.entry = Math.min(1, this.motion.entry + h / RIDER_TIMING.enter)
      if (this.exitDone) this.motion.exit = Math.min(1, this.motion.exit + h / RIDER_TIMING.exit)
    }
    for (const v of this.all) {
      if (!v.model) continue
      v.model.setDetail(cameraPosition.distanceTo(v.object.position))
      v.barrelSpeed = THREE.MathUtils.damp(v.barrelSpeed, v.firing ? Math.PI * 2 * 10 / 3 : 0, v.firing ? 18 : 7, h)
      if (v.barrelSpeed < .01 && !v.firing) v.barrelSpeed = 0
      v.barrelAngle = (v.barrelAngle + v.barrelSpeed * h) % (Math.PI * 2)
      const horizontal=Math.hypot(v.state.pvx??0,v.state.pvz??0)
      const wheelSpeed=Math.abs(v.state.speed)>.05?v.state.speed:horizontal
      v.wheelAngle = (v.wheelAngle + wheelSpeed * h / (v.model.wheelRadius || .72)) % (Math.PI * 2)
      if(v.kind==='ghost'){
        const boostPulse=v.state.maneuver>0 ? 3.2 + Math.sin(this.motion.time*34)*.8 : 1
        v.model.object.traverse(node=>{
          if(node.name!=='glow'&&!node.name.toLowerCase().includes('plasma'))return
          const mesh=node as THREE.Mesh
          const material=Array.isArray(mesh.material)?mesh.material[0]:mesh.material
          if(material instanceof THREE.MeshStandardMaterial)material.emissiveIntensity=(mesh.userData.boostGlowBase??1.7)*boostPulse
        })
      }
      v.model.object.position.y = v.model.groundOffset + (v.kind === 'ghost' ? Math.sin(this.motion.time * 2.4 + v.object.position.x) * .025 : 0)
      if(this.fx&&(v.kind==='ghost'||v.kind==='banshee')){
        const f=this.fxState
        f.maneuver=v.state.maneuver>0; f.speed=v.state.speed; f.driven=!!v.driver||v===this.active
        f.vx=v.state.pvx??0; f.vy=v.state.pvy??0; f.vz=v.state.pvz??0
        if(v.kind==='ghost')this.fx.ghost(v.model.object,f,h); else this.fx.banshee(v.model.object,f,h)
      }
      if(v.kind==='warthog'||v.kind==='mongoose'||v.kind==='chopper'){
        const suspension=v.kind==='warthog'?warthogSuspensionSamples(v.state):{offsets:[]}
        for(const parts of v.model.levels){
          if(!parts)continue
          parts.wheels.forEach((wheel,i)=>{
            let rest=this.suspensionRest.get(wheel)
            if(!rest){rest={y:wheel.position.y,offset:0};this.suspensionRest.set(wheel,rest)}
            rest.offset=v.state.wheelTravel?.[i]??suspension.offsets[i]??0
            wheel.position.y=rest.y+rest.offset
          })
        }
      }
      this.applyRig(v)
      if (v.turretFlash && (v.flashTime > 0 || v.turretFlash.visible)) {
        v.flashTime = Math.max(0, v.flashTime - h)
        this.placeTurretFlash(v, v.flashTime / v.flashLife)
      }
    }
    this.fx?.end()
    if (this.exitDone && this.motion.exit >= 1) { const done = this.exitDone; this.exitDone = null; done() }
  }
  /** Call after turret aiming, so palms follow its real pitch and steering transforms. */
  updateRider(team: Team, gunner: boolean, cameraPosition: THREE.Vector3): void {
    const v = this.active; if (!v?.model) return
    // The Banshee's pilot is sealed inside the hull, as in CE; there is nothing to pose.
    if (v.kind === 'banshee') { for (const other of this.riders.values()) other.object.visible = false; return }
    const rider = this.riders.get(team)
    if (!rider) {
      const key = `local:${team}`
      if (!this.loadingRiders.has(key)) this.loadingRiders.set(key, createVehicleRider(team).then(r => { this.riders.set(team, r) }).catch(error => console.error('Could not load generated Spartan vehicle rider', error)))
      return
    }
    for (const other of this.riders.values()) other.object.visible = other === rider
    if (rider.object.parent !== v.object) { v.object.add(rider.object); rider.reset() }
    this.motion.speed = v.state.speed; this.motion.steering = v.state.steering
    rider.pose(v.kind, v.model.parts, gunner, cameraPosition.distanceTo(v.object.position), this.motion)
  }
  /**
   * Other people on this vehicle's seats. `teams` names who is in each seat, or omits it for
   * empty; the local player's own seat is left to `updateRider`.
   */
  updateSeatRiders(v: Vehicle, teams: Partial<Record<Seat, Team>>, cameraPosition: THREE.Vector3, dt: number): void {
    const m = v.seatMotion
    m.dt = Math.min(Math.max(dt, 0), .1); m.time += m.dt
    m.entry = Math.min(1, m.entry + m.dt / RIDER_TIMING.enter)
    m.speed = v.state.speed; m.steering = v.state.steering
    for (const seat of ['driver', 'gunner'] as const) {
      const team = teams[seat]
      const rider = v.seatRiders.get(seat)
      if (!team || v.kind === 'banshee' || !v.model) {
        if (rider) rider.object.visible = false
        v.seatTeams.delete(seat)
        continue
      }
      if (v.seatTeams.get(seat) !== team) {
        // A new occupant: rebuild the rider in their colours and play the climb-in.
        if (rider) { rider.object.visible = false; v.seatRiders.delete(seat) }
        v.seatTeams.set(seat, team)
        m.entry = 0
        const key = `${v.id}:${seat}:${team}`
        if (!this.loadingRiders.has(key)) {
          this.loadingRiders.set(key, createVehicleRider(team).then(r => {
            this.loadingRiders.delete(key)
            if (v.seatTeams.get(seat) !== team) return
            v.seatRiders.set(seat, r); v.object.add(r.object); r.reset()
          }).catch(error => console.error('Could not load generated Spartan vehicle rider', error)))
        }
        continue
      }
      if (!rider) continue
      rider.object.visible = true
      rider.pose(v.kind, v.model.parts, seat === 'gunner', cameraPosition.distanceTo(v.object.position), m)
    }
  }
}
