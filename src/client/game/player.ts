import type { HitPose } from '../../shared/hitboxes.ts'
import { travelHeading } from '../../shared/gait.ts'
import type {BulletImpact} from '../../shared/bullet-impact.ts'
import * as THREE from 'three'
import { step, spawnState, eyeHeight, type PlayerInput, type PlayerState } from '../../shared/movement.ts'
import { VITALS, MOVE } from '../../shared/constants.ts'
import { type Team, type ModelId } from '../../shared/assets.ts'
import { spawnRagdoll, applyRagdollBulletImpact } from '../render/ragdolls.ts'
import { createSpartan, type SpartanInstance } from '../render/models/character.ts'
import { buildModel as buildProp } from '../render/models.ts'
import { loadAuthoredWeapon, hasAuthoredWeapon, type AuthoredWeapon } from '../render/models/authored-weapons.ts'

/**
 * A player: the simulation state, the shields and health on top of it, and the Spartan other
 * people see.
 *
 * The local player runs the same `step` the server will run, which is what lets the camera move
 * the instant a key goes down instead of waiting a round trip.
 */

export class Player {
  readonly state: PlayerState
  readonly object = new THREE.Group()
  /** The skinned body; the wearer sees a separate closed lower-body mesh. */
  private character: SpartanInstance | null = null
  private deathShot?:BulletImpact
  private corpse?:THREE.Object3D
  private deathShotApplied=false

  animationHz = 60
  private animationTime = 0

  /** Full shield strength: zero in a mode without shields (SWAT). */
  maxShield: number = VITALS.shield
  shield = VITALS.shield
  health = VITALS.health
  /** Local-only counters used by the scoreboard when playing against bots. */
  kills = 0
  deaths = 0
  /** Seconds since last damage, for the recharge delay. */
  private sinceHit = Infinity
  /** One-shot cues for world-space shield feedback; consumed once each by Match per frame. */
  private shieldHitFlag = false
  private shieldPopFlag = false
  private shieldChargedFlag = false
  private shieldRechargeFlag = false
  /** Shield + health lost since Match last asked, and whether it killed: drives the pain/death vocals. */
  private hurtTaken = { amount: 0, health: 0, killed: false }
  private wasRecharging = false

  /** Smoothed for rendering: the sim snaps to ground, the camera should not. */
  private renderY: number
  private renderEyeHeight: number = MOVE.eyeHeight
  /** World models for whatever this player is holding, built on first use and toggled after. */
  private readonly props = new Map<ModelId, THREE.Object3D>()
  /** The authored ones, kept so their level of detail can follow the viewer's distance. */
  private readonly authoredProps = new Map<ModelId, AuthoredWeapon>()
  private heldModel: ModelId = 'assault-rifle'

  constructor(readonly id: string, readonly team: Team, x: number, z: number, visible = true, firstPerson = false) {
    this.state = spawnState(x, z)
    this.renderY = this.state.y

    if (visible) {
      // The character is skinned and loads asynchronously; the player exists immediately and
      // simply has no body for the first frames. Nothing else depends on it being there.
      void createSpartan(team, firstPerson).then((c) => {
        this.character = c
        this.object.add(c.object)
        // Only other people's Spartans carry a visible weapon: your own hands and gun come from
        // the viewmodel, and a second rifle hanging off the body just intersects it.
        if (!firstPerson) this.showProp(this.heldModel)
        for(const holder of this.leftProps.values())c.attach(holder,true)
        c.setOffhandModel(this.offhandModel)
      })
    }
  }

  private offhandModel:ModelId|null=null
  private readonly leftProps=new Map<ModelId,THREE.Group>()
  setOffhandModel(model:ModelId|null):void {
    if(this.offhandModel===model)return
    this.offhandModel=model;this.character?.setOffhandModel(model)
    for(const [id,object] of this.leftProps)object.visible=id===model
    if(model&&!this.leftProps.has(model)){
      const holder=new THREE.Group();holder.name=`offhand:${model}`;this.leftProps.set(model,holder);this.character?.attach(holder,true)
      void loadAuthoredWeapon(model).then(weapon=>holder.add(weapon.object)).catch(error=>console.warn('Offhand model unavailable',error))
    }
  }

  /** Put a different weapon in the hands. Remote players change it as their snapshot says. */
  setWeaponModel(model: ModelId): void {
    if (model === this.heldModel) return
    this.heldModel = model
    this.character?.setWeaponModel(model)
    if (this.character) this.showProp(model)
  }

  /**
   * Put a weapon in the hand. The authored world model is the same mesh the holder sees in
   * first person, so a rocket launcher across the canyon is the rocket launcher you carry; the
   * procedural model from the registry is the fallback if that file will not load.
   */
  private showProp(model: ModelId): void {
    let prop = this.props.get(model)
    if (!prop) {
      const holder = new THREE.Group()
      holder.name = `held:${model}`
      this.props.set(model, holder)
      this.character?.attach(holder)
      if (hasAuthoredWeapon(model)) {
        void loadAuthoredWeapon(model).then(weapon => {
          holder.add(weapon.object)
          this.authoredProps.set(model, weapon)
          if(this.heldModel===model)this.character?.setWeaponModel(model)
        }).catch(error => {
          console.warn(`Falling back to the procedural ${model} world model`, error)
          holder.add(buildProp(model))
        })
      } else {
        holder.add(buildProp(model))
      }
      prop = holder
    }
    for (const [id, p] of this.props) p.visible = id === model
  }

  muzzlePosition(out:THREE.Vector3,left=false):THREE.Vector3 {
    const prop=left&&this.offhandModel?this.leftProps.get(this.offhandModel):this.props.get(this.heldModel)
    const anchor=prop?.getObjectByName('anchor:muzzle')
    return anchor?anchor.getWorldPosition(out):this.eye(out)
  }

  get alive(): boolean {
    return this.health > 0
  }

  /** How far up or down this Spartan aims, as last posed: part of where its hit shapes are. */
  private aimPitch = 0

  /** What the hit shapes are posed from — the same four things the server poses them from. */
  hitPose(): HitPose {
    const s = this.state, yaw = this.object.rotation.y
    return {
      x: s.x, y: s.y, z: s.z, yaw, pitch: this.aimPitch, crouched: s.crouched,
      speed: s.onGround ? Math.hypot(s.vx, s.vz) : 0, heading: travelHeading(s.vx, s.vz, yaw),
      phase: this.character?.gait.phase ?? 0, backward: this.character?.gait.backward ?? false,
    }
  }

  advance(input: PlayerInput): void {
    const grounded = this.state.onGround
    step(this.state, input)
    if (grounded && !this.state.onGround && this.state.vy > 0) this.character?.play('jump')
    if (this.state.fallDamage > 0) this.damage(this.state.fallDamage)

    this.updateVitals(input.dt)

    // Ease the visual height toward the simulated one so walking over small bumps does not
    // jolt the camera, while a real fall still reads as a fall.
    const k = 1 - Math.exp(-18 * input.dt)
    this.renderY += (this.state.y - this.renderY) * k
    if (Math.abs(this.state.y - this.renderY) > 1.2) this.renderY = this.state.y

    const targetEyeHeight = this.state.crouched ? MOVE.eyeHeight * 0.62 : MOVE.eyeHeight
    this.renderEyeHeight += (targetEyeHeight - this.renderEyeHeight) * (1 - Math.exp(-16 * input.dt))

    this.object.position.set(this.state.x, this.renderY, this.state.z)
    this.object.rotation.y = input.yaw

    // Blend locomotion by the speed the simulation actually produced, so the clip rate matches
    // the distance covered and the feet do not skate.
    this.animationTime += input.dt
    if (this.animationTime + 1e-6 >= 1 / this.animationHz) {
      this.character?.update(
        Math.hypot(this.state.vx, this.state.vz),
        this.state.onGround,
        this.state.crouched,
        this.animationTime,
        this.state.vx,
        this.state.vz,
      )
      this.animationTime = 0
    }
  }

  /**
   * Drive this player from the network rather than from input. The position is the server's
   * word interpolated a tenth of a second back; velocity is derived from it so the walk cycle
   * still matches the ground covered.
   */
  applyRemote(x: number, y: number, z: number, yaw: number, pitch: number, onGround: boolean, crouched: boolean, dt: number, gait?: { phase: number; backward: boolean }): void {
    const s = this.state
    if (dt > 1e-4) {
      const vx = (x - s.x) / dt, vz = (z - s.z) / dt
      // Smooth the derived velocity; snapshot spacing makes the raw one lumpy.
      const k = 1 - Math.exp(-12 * dt)
      s.vx += (vx - s.vx) * k
      s.vz += (vz - s.vz) * k
      s.vy = (y - s.y) / dt
    }
    s.x = x; s.y = y; s.z = z
    s.onGround = onGround
    s.crouched = crouched

    const k = 1 - Math.exp(-18 * dt)
    this.renderY += (this.state.y - this.renderY) * k
    if (Math.abs(this.state.y - this.renderY) > 1.2) this.renderY = this.state.y
    this.object.position.set(s.x, this.renderY, s.z)
    this.object.rotation.y = yaw
    this.character?.aim(pitch)
    this.aimPitch = pitch

    this.animationTime += dt
    if (this.animationTime + 1e-6 >= 1 / this.animationHz) {
      // The stride is the server's: drawn there, the legs are where its hit shapes have them.
      this.character?.update(Math.hypot(s.vx, s.vz), s.onGround, s.crouched, this.animationTime, s.vx, s.vz, gait)
      this.animationTime = 0
    }
  }

  /**
   * Vitals as the server reports them. A drop plays the flinch, reaching zero leaves a corpse,
   * and coming back from zero resets the body for the respawn. Returns true if this hurt.
   */
  applyVitals(shield: number, health: number): boolean {
    const before = this.shield + this.health
    const wasAlive = this.alive
    const hurt = shield + health < before - 0.01
    if (hurt) this.sinceHit = 0
    if (hurt && wasAlive) this.noteHurt(before - shield - health, this.health - health, health <= 0)
    this.noteShield(shield)
    this.shield = shield
    this.health = health
    if (wasAlive && !this.alive) this.leaveCorpse()
    else if (hurt && this.alive) this.character?.play('hit')
    else if (!wasAlive && this.alive) { this.deathShot=undefined;this.corpse=undefined;this.deathShotApplied=false;this.character?.reset(); if (this.character) this.character.object.visible = true; this.animationTime = 0 }
    return hurt
  }

  /** Move without simulating: a respawn, or the first position the server hands us. */
  place(x: number, y: number, z: number): void {
    this.state.x = x; this.state.y = y; this.state.z = z
    this.state.vx = this.state.vy = this.state.vz = 0
    this.renderY = y
    this.object.position.set(x, y, z)
  }

  /** Shared by walking and vehicle occupancy; recharge is independent of locomotion. */
  updateVitals(dt: number): void {
    if (!this.alive) return
    this.sinceHit += dt
    const recharging = this.sinceHit >= VITALS.shieldRechargeDelay && this.shield < this.maxShield
    // Halo 3 flares the armour when the shield starts coming back, not only when it is struck.
    if (recharging && !this.wasRecharging) this.shieldRechargeFlag = true
    this.wasRecharging = recharging
    if (recharging) {
      const next = Math.min(this.maxShield, this.shield + VITALS.shield / VITALS.shieldRechargeTime * dt)
      this.noteShield(next)
      this.shield = next
    }
  }

  /**
   * Compares the shield value about to be applied against the current one, so every write path
   * (a networked snapshot, a local damage/melee hit, or the recharge tick) reports the same three
   * one-shot cues: took shield damage, shields just popped, shields just topped back up. Match
   * polls and consumes these once a frame to place the world-space flash and sound.
   */
  private noteShield(next: number): void {
    if (next < this.shield - 0.01) {
      this.shieldHitFlag = true
      if (this.shield > 0 && next <= 0) this.shieldPopFlag = true
    } else if (this.maxShield > 0 && next >= this.maxShield - 0.01 && this.shield < this.maxShield - 0.01) {
      this.shieldChargedFlag = true
    }
  }

  /** Consumed once per frame by Match to trigger the shield-hit ping at this player's position. */
  consumeShieldHit(): boolean { const flag = this.shieldHitFlag; this.shieldHitFlag = false; return flag }
  /** Consumed once per frame by Match to trigger the shield-break flash/sound at this player. */
  consumeShieldPop(): boolean { const flag = this.shieldPopFlag; this.shieldPopFlag = false; return flag }
  private noteHurt(amount: number, health: number, killed: boolean): void {
    this.hurtTaken.amount += amount; this.hurtTaken.health += Math.max(0, health); this.hurtTaken.killed ||= killed
  }
  /** Damage taken since the last call (null if none), consumed once per frame by Match for the vocals. */
  consumeHurt(): { amount: number; health: number; killed: boolean } | null {
    const taken = this.hurtTaken
    if (taken.amount <= 0 && !taken.killed) return null
    this.hurtTaken = { amount: 0, health: 0, killed: false }
    return taken
  }
  /** Consumed once per frame by Match; only played back for the local player's own shields. */
  consumeShieldCharged(): boolean { const flag = this.shieldChargedFlag; this.shieldChargedFlag = false; return flag }
  /** The moment the shield begins refilling, which Halo 3 marks with its own flare. */
  consumeShieldRecharge(): boolean { const flag = this.shieldRechargeFlag; this.shieldRechargeFlag = false; return flag }
  /**
   * Halo 3's low-shield alarm: it sounds while the shield sits under a quarter and falls silent
   * the moment the shield starts refilling, so the beeping is also the countdown to recharge.
   */
  get shieldAlarm(): boolean {
    return this.alive && this.maxShield > 0 && this.shield < this.maxShield * .25 && this.sinceHit < VITALS.shieldRechargeDelay
  }

  aim(pitch: number): void { this.character?.aim(pitch); this.aimPitch = pitch }
  fire(left=false,muzzleFlash=true): void { this.character?.fire(left,muzzleFlash) }
  /** A reload, melee strike or grenade throw, drawn on the body in third person. */
  action(kind: 'reload' | 'melee' | 'throw', seconds: number): void { this.character?.action(kind, seconds) }
  /** What the guns in hand show on the body: rounds (the needler's crystals) and a plasma pistol's charge. */
  setWeaponState(ammo: number, charge: number, left = false): void { this.character?.setAmmo(ammo, left); this.character?.setCharge(charge, left) }
  /** Light this player's shields across their silhouette; above 1 reads as the shield failing. */
  shieldFlash(strength: number): void { this.character?.shieldFlash(strength) }

  setDetail(distance: number): void {
    this.character?.setDetail(distance)
    this.authoredProps.get(this.heldModel)?.setDetail(distance)
  }

  /** Anything alive on the weapon they are holding: a sword's plasma, so far. */
  animateWeapon(dt: number): void {
    this.authoredProps.get(this.heldModel)?.animate(dt)
  }

  animateDeath(dt: number): void {
    if (this.character?.object.visible) this.character.update(0, true, false, dt)
  }

  setThirdPerson(enabled: boolean): void {
    this.character?.setFirstPerson(!enabled)
    // your own Spartan never built its world weapon (the viewmodel stood in for it): build it the first time you see yourself
    if (enabled && this.character && !this.props.has(this.heldModel)) this.showProp(this.heldModel)
  }

  private leaveCorpse(impulse?:THREE.Vector3, impact?:BulletImpact): void {
    if (!this.character || !this.object.parent) return
    const shot=impact??this.deathShot
    this.character.setFirstPerson(false)
    this.corpse=spawnRagdoll(this.character.object, this.object.parent, new THREE.Vector3(this.state.vx, this.state.vy, this.state.vz).add(impulse??new THREE.Vector3()),shot)
    this.deathShotApplied=!!shot;this.deathShot=undefined
    this.character.object.visible = false
  }

  /** Shields take it first, then health. Returns true if this killed them. */
  damage(amount: number, impulse?:THREE.Vector3, impact?:BulletImpact): boolean {
    this.sinceHit = 0
    const wasAlive = this.alive
    if (wasAlive) this.character?.play('hit')
    const toShield = Math.min(this.shield, amount)
    this.noteShield(this.shield - toShield)
    this.shield -= toShield
    const rest = amount - toShield
    const healthBefore = this.health
    if (rest > 0) this.health = Math.max(0, this.health - rest)
    if (wasAlive) this.noteHurt(toShield + healthBefore - this.health, healthBefore - this.health, !this.alive)
    if (wasAlive && !this.alive) this.leaveCorpse(impulse,impact)
    return this.health <= 0
  }

  receiveDeathImpact(impact:BulletImpact):void {
    if(this.deathShotApplied)return
    if(this.alive)this.deathShot=impact
    else if(this.corpse)this.deathShotApplied=applyRagdollBulletImpact(this.corpse,impact)
  }

  respawn(x: number, z: number): void {
    this.deathShot=undefined;this.corpse=undefined;this.deathShotApplied=false
    this.animationTime = 0
    this.character?.reset()
    if (this.character) this.character.object.visible = true
    Object.assign(this.state, spawnState(x, z, this.state.map))
    this.renderY = this.state.y
    this.renderEyeHeight = MOVE.eyeHeight
    this.shield = this.maxShield
    this.health = VITALS.health
    this.sinceHit = Infinity
    this.shieldHitFlag = this.shieldPopFlag = this.shieldChargedFlag = this.shieldRechargeFlag = false
    this.hurtTaken = { amount: 0, health: 0, killed: false }
    this.wasRecharging = false
  }

  /** What the death camera circles: the corpse's hips while it lasts, else where they fell. */
  deathFocus(out = new THREE.Vector3()): THREE.Vector3 {
    let hips: THREE.Object3D | undefined
    this.corpse?.traverse(o => { if (!hips && (o as THREE.Bone).isBone && /Hips/i.test(o.name)) hips = o })
    if (hips) return hips.getWorldPosition(out)
    return out.set(this.state.x, this.renderY + 0.9, this.state.z)
  }

  /** Where the camera sits, and where shots come from. */
  eye(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.state.x, this.renderY + this.renderEyeHeight, this.state.z)
  }

  /** True eye height off the simulation, for the server and for hit resolution. */
  simEye(): number {
    return eyeHeight(this.state)
  }
}
