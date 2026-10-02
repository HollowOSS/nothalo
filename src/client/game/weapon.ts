import {createMuzzleFlash,createMuzzleSmoke,type MuzzleSmoke} from '../render/models/muzzle-flash.ts'
import {createShellCasings,type ShellCasings} from '../render/models/shell-casings.ts'
import {SMALL_ARM_HOLD,FRAMING_SMALL_ARMS} from '../../shared/presentation.ts'
import {newCharge,cancelCharge,stepCharge,PLASMA_CHARGE} from '../../shared/plasma-charge.ts'
import { GRENADE_THROW } from '../render/models/grenade-throw.ts'
import { WEAPON_FX } from './weapon-fx.ts'
import * as THREE from 'three'
import { DEBUG_HOOKS } from '../debug/build-flags.ts'
import { RIFLE_MELEE, SHOTGUN_RELOAD, SWAP_READY } from '../../shared/loadout.ts'
import { WEAPONS, type WeaponSpec } from '../../shared/constants.ts'
import { buildModel } from '../render/models.ts'
import { setWeaponTeam } from '../render/models/weapons.ts'
import { extractPart, rigFor, type Arms, type WeaponRig } from '../render/models/viewmodel.ts'
import { collectPlasma, flickerPlasma } from '../render/models/plasma.ts'
import { createSwordIgniteFx, type SwordIgniteFx } from '../render/models/sword-ignite-fx.ts'
import { buildSpartanArms } from '../render/models/spartan-arms.ts'
import { loadAnimatedViewmodel, tintViewmodelArms, type AnimatedViewmodel, type ViewmodelAction } from '../render/models/animated-viewmodel.ts'
import type { ModelId, Team } from '../../shared/assets.ts'

/**
 * A held weapon: the viewmodel, the pair of hands on it, its firing cadence, and the recoil,
 * cycling and reload that make pulling the trigger feel like something happened.
 *
 * Hitscan for now. CE's magnum and sniper really are hitscan; the plasma weapons are not, and
 * they will need projectiles when they arrive.
 *
 * The whole assembly — gun, slide, magazine, both arms — hangs off one group, so every motion
 * below is either a transform on that group (recoil, bob, aim) or a transform on a part of it
 * (slide, magazine, support hand, trigger finger). Nothing is animated by rebuilding geometry.
 */

export interface WeaponSlot {
  readonly id: ModelId
  readonly spec: WeaponSpec
  ammo: number
  reserve: number
}

/**
 * Viewmodel placement. At a 70 degree FOV the view is only ~0.48 m tall half a metre out, so a
 * 0.3 m pistol held at arm's length fills most of the screen. Real viewmodels cheat: they sit
 * further out and smaller than the world model, and nobody notices.
 *
 * Held slightly right of centre and canted in, which is where CE puts it: the shooter's own
 * shoulder is on the right, so a two-handed hold pulls the weapon towards the middle rather than
 * sitting square in front of the eye. The numbers are per weapon and live on the rig, because a
 * metre-long rifle and a 30 cm pistol cannot share one scale or one offset.
 */

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)
/** Smooth 0->1->0 hump used for anything that leaves and comes back. */
const hump = (u: number): number => {
  const t = clamp01(u)
  return Math.sin(Math.PI * t) ** 1.4
}
interface MeleeLayer {
  /** Scales the shared arc. */
  readonly strength: number
  /** A constant shift held through the melee, for a weapon whose swing starts off-centre. */
  readonly hold?: readonly [number, number, number]
  /** Scales only the sideways travel, to bring a swing that ends wide back toward the middle. */
  readonly lateral?: number
}

const MELEE_LAYER: Partial<Record<ModelId, MeleeLayer>> = {
  magnum: { strength: .5 },
  // Its own clip starts the gun low and left and carries it wide, so the hold lifts it toward
  // the middle and the sideways travel is cut to land the strike nearer the centre of the view.
  shotgun: { strength: .45, hold: [.055, .04, 0], lateral: .3 },
  sniper: { strength: .34 },
  'rocket-launcher': { strength: .3 },
}

/**
 * Halo 3 holds its rifles larger in frame than these rigs sit: in MCC idle footage at the same
 * 16:9 frame the AR's ammo counter is ~1.7x as wide as ours and the BR's scope ~3x (a narrower
 * default FOV accounts for ~1.15x of that), and the stock runs off the bottom right as if
 * shouldered, where ours ended on screen. Scaling the whole rig about the eye changes nothing
 * on screen, so `enlarge` about the grip is the same picture as sliding the rig toward the eye
 * along the line to the grip. `shoulder` then draws it back along its own bore, metres, until
 * the butt leaves the frame at 16:9 and at phone-wide 2.2:1. Arms, hands and animation all
 * move with it; the first-person pass's own near plane lets the stock run past the eye.
 */
const SHIFT = new THREE.Vector3()
const RIFLE_HOLD: Partial<Record<ModelId, { enlarge: number; shoulder: number; shift?: readonly [number, number, number]; turn?: readonly [number, number, number] }>> = {
  'assault-rifle': { enlarge: 1.3, shoulder: .07 },
  'battle-rifle': { enlarge: 1.3, shoulder: .07 },
  // Small arms are true-proportion (.48 hands, .48 guns: docs/fps-scale.md), so on screen they are only as big as
  // their framing makes them. Fitted to Halo 2/3 gameplay stills (reference/fps-rig/gameplay).
}

/**
 * Per-round recoil laid over the authored fire clip (which is one generic 5 degree kick for most guns and next to nothing
 * for the AR). Two damped springs kicked once per round: the main one lifts the muzzle about the wrist and shoves the gun
 * toward the eye, the lateral one rolls and yaws it to alternating sides. One shot snaps up in ~30-50 ms and settles
 * with a slight overshoot, which is what reads as weight; automatic fire builds into a sustained buzz. `pitch`, `roll`,
 * `yaw` (radians) and `back` (metres) are the peak of one round; lower `hz` is a heavier, slower recovery.
 */
const RECOIL_FEEL: Partial<Record<ModelId, { pitch: number; back: number; roll: number; yaw: number; hz: number; damping: number }>> = {
  magnum: { pitch: .035, back: .012, roll: .012, yaw: .004, hz: 6, damping: .5 },
  'assault-rifle': { pitch: .028, back: .012, roll: .006, yaw: .007, hz: 6.5, damping: .5 },
  'battle-rifle': { pitch: .022, back: .009, roll: .005, yaw: .003, hz: 7, damping: .5 },
  smg: { pitch: .006, back: .004, roll: .004, yaw: .007, hz: 9, damping: .55 },
  needler: { pitch: .008, back: .004, roll: .003, yaw: .004, hz: 8, damping: .55 },
  'plasma-pistol': { pitch: .015, back: .006, roll: .006, yaw: .003, hz: 6, damping: .5 },
  'plasma-rifle': { pitch: .008, back: .004, roll: .003, yaw: .005, hz: 8, damping: .55 },
  shotgun: { pitch: .05, back: .028, roll: .02, yaw: .006, hz: 4.5, damping: .42 },
  sniper: { pitch: .09, back: .04, roll: .025, yaw: .008, hz: 4, damping: .4 },
  'rocket-launcher': { pitch: .045, back: .06, roll: .012, yaw: .005, hz: 3.5, damping: .45 },
}
/** Velocity that makes a spring at rest peak at exactly 1: its first maximum is v/w * exp(-z/sqrt(1-z^2) * atan(sqrt(1-z^2)/z)). */
const kickImpulse = (hz: number, damping: number): number => {
  const w = 2 * Math.PI * hz, s = Math.sqrt(1 - damping * damping)
  return w / Math.exp(-damping / s * Math.atan2(s, damping))
}

const span = (u: number, a: number, b: number): number => {
  const t = clamp01((u - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/**
 * Switching weapons, timed from Halo 3 MCC footage (nqNqanJbNjA 0:24-0:30, YaTxXqQksIA 1:25/2:42):
 * the old gun drops off the bottom right in well under a quarter second, the screen stays empty
 * for a beat while the new one comes up from below (`raise` is when it starts to show), and it
 * swings in from the bottom right edge, big and close with its muzzle pointing across the view,
 * carries a little high and settles as the support hand takes the foregrip. Halo 3 takes ~0.65 s from the button to a settled gun; here the new gun may fire
 * SWAP_READY (0.45 s) after the swap, so the whole move is compressed to fit that window rather
 * than letting the animation hold up the shot.
 */
const SWITCH = { lower: .12, raise: .22, ready: SWAP_READY } as const
/** Energy sword draw: it comes up as a bare hilt, the wrist cocks back, a flick of the hand fires the blade out of the
 * hilt (`burst` .. `burst+extend`, overshooting a little before it settles), and the hand rocks forward with it.
 * In Halo 3 the blade is fully out within one video frame of the hilt reaching the top, then shivers and settles
 * (reference/fps-rig/sword-draw), so the burst is nearly instant and the rest of the time is settling. */
const IGNITE = { cock: .10, burst: .30, extend: .06, total: .72, pivotZ: -.05 } as const
/**
 * Where the switch carries the weapon, as offsets at the far end of each move. `cam*` turn the
 * assembly about the eye (radians; ~0.0105 moves it 1% of the screen height), `hand*` turn it
 * about the right hand (pitch + is nose up, roll + is counter-clockwise), `near` brings it toward
 * the eye in metres. Exported so the review tools can tune it live.
 */
export const SWITCH_POSE = {
  lower: { camPitch: -.6, camYaw: -.2, handPitch: .2, handYaw: .3, handRoll: -.2, near: 0 },
  draw: { camPitch: -.35, camYaw: -.4, handPitch: .2, handYaw: .45, handRoll: .15, near: .1 },
  /** Carried past the rest pose at the top of the raise. */
  overshoot: { camPitch: .05, handPitch: .04, near: .06 },
}

export class HeldWeapon {
  private chargeOrb:THREE.Sprite|null=null
  /** Muzzle smoke puffs (ballistic guns) and the fill light's resting state, which each shot kicks (updateMuzzleFx). */
  private smoke:MuzzleSmoke|null=null
  /** Spent cases from the ejection port (ballistic guns), and where that port is in the gun's own frame. */
  private casings:ShellCasings|null=null
  private port:{node:THREE.Object3D;at:THREE.Vector3}|null=null
  private readonly fillHome=new THREE.Vector3()
  private fillBase={intensity:0,color:new THREE.Color()}
  /** Seconds the trigger has been held for a charge; drives the overcharge tremor. */
  private chargeClock=0
  readonly charge=newCharge()
  chargeTrigger(held:boolean,pressed:boolean,dt:number):0|1|2{return stepCharge(this.charge,held,pressed,dt,this.canFire,this.slot.ammo)}
  cancelCharge():void{cancelCharge(this.charge);this.chargeOrb?.scale.setScalar(0)}
  private dualHand: 'left' | 'right' | null = null
  private framing: { base: THREE.Vector3; baseQ: THREE.Quaternion; at: THREE.Vector3; bore: THREE.Vector3 } | null = null
  /** Place the authored rig for the current hold (single or dual), about its grip. */
  private applyFraming(): void {
    const vm = this.authored, f = this.framing, id = this.slot.id
    if (!vm || !f) return
    // an entry fitted to reference footage (FRAMING_SMALL_ARMS, which also covers rifles once fitted) wins over the old rifle defaults
    const single = FRAMING_SMALL_ARMS[id] ?? RIFLE_HOLD[id]
    const hold = (this.dualHand && FRAMING_SMALL_ARMS[id]?.dual) || single
    const o = vm.object
    o.position.copy(f.base); o.quaternion.copy(f.baseQ)
    if (hold) {
      o.position.addScaledVector(f.at, 1 / hold.enlarge - 1).addScaledVector(f.bore, -hold.shoulder)
      if (hold.turn) {
        // Present the gun the way the reference does: turn the whole rig about the grip, which stays where it is.
        const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(hold.turn[0], hold.turn[1], hold.turn[2], 'YXZ'))
        o.quaternion.premultiply(turn)
        o.position.addScaledVector(f.at, 1).sub(f.at.clone().applyQuaternion(turn))
      }
      if (hold.shift) o.position.add(SHIFT.set(...hold.shift))
    }
    let hand: THREE.Object3D | null = null
    o.traverse(node => { if (!hand && node.name === 'RightHand') hand = node })
    if (hand) { this.object.updateWorldMatrix(true, true); this.object.worldToLocal((hand as THREE.Object3D).getWorldPosition(this.handPivot)) }
  }
  setDualHand(hand:'left'|'right'|null):void {const changed=this.dualHand!==hand;this.dualHand=hand;if(changed)this.applyFraming();if(['magnum','smg','plasma-pistol','plasma-rifle','needler'].includes(this.slot.id))this.fill.position.x=hand?-.09:.5;this.authored?.setOneHanded(!!hand||['plasma-pistol','plasma-rifle','needler'].includes(this.slot.id));this.object.scale.x=hand==='left'?-1:1}
  readonly object = new THREE.Group()
  readonly ready: Promise<void>
  private authored: AnimatedViewmodel | null = null
  private authoredIdle = 0
  /** Plasma materials on this weapon, if it has any. An energy blade is never still. */
  private plasma: ReturnType<typeof collectPlasma> = []
  private plasmaClock = 0
  private grenadeKind: 'frag' | 'plasma' = 'frag'
  private flashAnchor: THREE.Object3D | null = null
  private cooldown = 0
  private burstRemaining = 0
  get continuingBurst():boolean {return this.burstRemaining>0 && this.slot.ammo>0}
  get isMeleeWeapon():boolean {return this.isBlade || this.slot.id==='gravity-hammer'}
  private shellCount = 0
  private shellEnd = Infinity
  private shellCancel = false
  private shellInterrupted = false
  private meleeTime = -1
  private meleeImpact = false
  private throwTime = -1
  private throwRelease = false
  private readonly heldGrenade = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({color:0x68714a,roughness:.65}))
  private readonly weaponPivot = new THREE.Group()
  private readonly pivotRest = new THREE.Vector3()
  private readonly assembly = new THREE.Group()
  private readonly debug: Record<string, unknown>
  private pumpContact = false
  private flashTime = 0
  private readonly flash:ReturnType<typeof createMuzzleFlash>
  private readonly tubes: THREE.Object3D | undefined
  private readonly muzzle = new THREE.Object3D()

  /** This weapon's own fill light, riding the viewmodel. */
  private fill!: THREE.PointLight
  private recoil = 0
  /** RECOIL_FEEL springs: main (x, v) and lateral (lx, lv) displacement and velocity, and rounds fired for the side. */
  private kick = { x: 0, v: 0, lx: 0, lv: 0, n: 0 }
  private bob = 0
  private drawTime = -1
  /** Energy sword only: seconds since the hilt was raised; the blade bursts out of it part-way through (IGNITE). */
  private igniteTime = -1
  private blade: {node:THREE.Object3D;z:number}[]|null = null
  private igniteFx: SwordIgniteFx | null = null
  private lowerTime = -1
  /** The right hand at rest in camera space; switch and bob rotations turn the gun about it. */
  private readonly handPivot = new THREE.Vector3()
  private counter: {ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture; last: number} | null = null
  private idle = Math.random() * 100
  private aim = 0
  private readonly rest = new THREE.Vector3()

  /** 1 the instant a round goes off, decaying to 0 as the action closes. */
  private cycle = 0
  private cycleRate = 12
  /** Absolute time into the authored firing clip, or -1 when the shot pose is complete. */
  private fireTime = -1
  /** Seconds elapsed into a reload, or -1 when there is none. */
  private reloading = -1

  private readonly rig: WeaponRig
  private arms: Arms | null = null
  /** Object3D rather than Group: an authored moving part may be any node in the file. */
  private readonly slide: THREE.Object3D | null
  private readonly mag: THREE.Object3D | null
  private readonly slideThrow = new THREE.Vector3()
  private readonly magThrow = new THREE.Vector3()
  private readonly leftRest = new THREE.Vector3()
  private readonly hip = new THREE.Vector3()
  private readonly ads = new THREE.Vector3()
  private readonly cant = new THREE.Euler()

  slot: WeaponSlot

  constructor(id: ModelId, specKey: keyof typeof WEAPONS, team: Team = 'red') {
    this.slot = { id, spec: WEAPONS[specKey], ammo: WEAPONS[specKey].magazine, reserve: WEAPONS[specKey].reserve }
    const mesh = buildModel(id)
    this.tubes=mesh.getObjectByName("rocket-tubes")
    const tips: Partial<Record<ModelId, number[]>> = {magnum:[0,0.0045,0.1535], "assault-rifle":[0,0,0.52404], sniper:[0,0,1.0412], "rocket-launcher":[-0.115,0.065,0.625], shotgun:[0,0,0.6018], "energy-sword":[0,0,1.2], "battle-rifle":[0,.0396,.665], needler:[0,-.021,.40]}
    this.flash=createMuzzleFlash(id)
    this.muzzle.name = "anchor:muzzle"
    this.muzzle.position.fromArray(tips[id] ?? [0,0,0.5])
    mesh.add(this.muzzle)
    this.flash.position.z=.05;this.flash.scale.setScalar(0);this.muzzle.add(this.flash)

    setWeaponTeam(mesh, team)
    const display = mesh.getObjectByName('ammo-counter') as THREE.Mesh | undefined
    if (display) {
      const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = id==='battle-rifle'?64:192
      const ctx = canvas.getContext('2d')!
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
      display.material = new THREE.MeshBasicMaterial({map:texture, toneMapped:false})
      this.counter = {ctx,texture,last:-1}
    }
    this.rig = rigFor(id, mesh)

    // Cut the moving parts back out of the merged weapon before anything else is parented to it,
    // so the extraction only ever sees weapon geometry.
    // An authored model names its moving parts, so take the object whole where one exists and
    // fall back to cutting it out of the merged mesh where it does not.
    const movingPart = (part: typeof this.rig.slide): THREE.Object3D | null => {
      if (!part) return null
      const named = part.node ? mesh.getObjectByName(part.node) : null
      return named ?? extractPart(mesh, part)
    }
    this.slide = movingPart(this.rig.slide)
    this.mag = movingPart(this.rig.mag)
    if (this.rig.slide) this.slideThrow.set(...this.rig.slide.throw)
    if (this.rig.mag) this.magThrow.set(...this.rig.mag.throw)

    // Viewmodels are authored as world models: turn it down-range and shrink it for the hand.
    // A model's +z is its muzzle, so a half turn puts the muzzle away from the camera.
    // A separate grip pivot lets the pistol spin independently of its hands on recovery.
    this.pivotRest.set(-this.rig.right.pos[0], this.rig.right.pos[1], this.rig.right.pos[2])
    this.weaponPivot.name = 'weapon-grip-pivot'
    this.weaponPivot.position.copy(this.pivotRest)
    mesh.position.sub(this.pivotRest)
    this.weaponPivot.add(mesh)
    this.assembly.add(this.weaponPivot)
    this.heldGrenade.name = 'held-grenade'
    this.heldGrenade.scale.setScalar(.042 / this.rig.hold.scale)
    this.heldGrenade.visible = false
    this.assembly.add(this.heldGrenade)
    this.assembly.rotation.y = Math.PI
    this.assembly.scale.setScalar(this.rig.hold.scale)
    this.assembly.visible = false
    this.object.add(this.assembly)

    // The viewmodel rides the camera, so scene lights rake across it at whatever angle the
    // player happens to face. Give it its own light so it reads the same everywhere.
    // Only the weapon in hand keeps its light on (see lower/draw): the first-person pass then
    // always sees exactly one light, so switching never needs a newly compiled shader variant.
    const fill = this.fill = new THREE.PointLight(0xfff0dc, 2.4, 4, 1.4)
    fill.position.set(0.5, 0.6, 0.9)
    if (id === 'shotgun') { fill.position.set(-.35,.5,-.1); fill.intensity=3.4; fill.distance=2 }
    this.object.add(fill)
    this.fillBase={intensity:fill.intensity,color:fill.color.clone()};this.fillHome.copy(fill.position)
    this.smoke=createMuzzleSmoke(id);if(this.smoke)this.object.add(this.smoke.group)
    this.casings=createShellCasings(id);if(this.casings)this.object.add(this.casings.object)
    // A handle on the pieces, so the viewmodel can be measured from outside rather than argued
    // about: toggle the arms or the gun off, screenshot, and diff to matte either one out.
    this.debug = {
      backend: 'loading-blender',
      arms: null,
      weapon: mesh,
      fire: () => this.fire(),
      switchPose: SWITCH_POSE,
      reload: () => { this.slot.ammo = 0; this.reload() },
      pose: () => ({
        pos: this.object.position.toArray(),
        rot: this.object.rotation.toArray().slice(0, 3),
        recoil: this.recoil,
        reloading: this.reloading,
        meleeTime: this.meleeTime,
        throwTime: this.throwTime,
        drawTime: this.drawTime,
        lowerTime: this.lowerTime,
        backend: this.authored ? 'blender' : this.debug.backend,
      }),
    }
    if (DEBUG_HOOKS) (window as unknown as Record<string, unknown>).__viewmodel = this.debug
    this.hip.set(...this.rig.hold.hip)
    this.ads.set(...this.rig.hold.ads)
    this.cant.set(...this.rig.hold.cant)
    this.object.position.copy(this.hip)
    this.rest.copy(this.hip)
    this.handPivot.copy(this.hip)
    this.ready = loadAnimatedViewmodel(id).then(viewmodel => {
      this.authored = viewmodel
      tintViewmodelArms(viewmodel.object, team)
      viewmodel.setOneHanded(!!this.dualHand||['plasma-pistol','plasma-rifle','needler'].includes(id))
      this.plasma = collectPlasma(viewmodel.object)
      this.object.remove(this.assembly)
      this.object.add(viewmodel.object)
      this.debug.backend = 'blender'
      this.debug.arms = viewmodel.object
      this.debug.weapon = viewmodel.object
      this.debug.animations = Object.fromEntries((['idle', 'fire', 'reload', 'melee', 'grenade'] as const).map(action => [action, viewmodel.duration(action)]))
      this.object.userData.animationSource = `/assets/viewmodels/${id}.glb`
      if(id==='plasma-pistol'){
        const canvas=document.createElement('canvas');canvas.width=canvas.height=64
        const ctx=canvas.getContext('2d')!,gradient=ctx.createRadialGradient(32,32,0,32,32,32)
        gradient.addColorStop(0,'rgba(245,255,200,1)');gradient.addColorStop(.2,'rgba(200,255,110,.95)');gradient.addColorStop(.5,'rgba(110,255,20,.45)');gradient.addColorStop(1,'rgba(70,255,0,0)')
        ctx.fillStyle=gradient;ctx.fillRect(0,0,64,64)
        this.chargeOrb=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(canvas),transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false}))
        this.chargeOrb.name='plasma-charge-glow';this.chargeOrb.frustumCulled=false;this.chargeOrb.scale.setScalar(0);viewmodel.muzzle.add(this.chargeOrb)
      }
      this.attachAuthoredFlash()
      this.update(0, 0, false)
      // Framing is measured once on the idle pose (the grip point and the bore in the rig's own frame) and re-applied whenever
      // the hold changes: dual wield has its own framing (FRAMING_SMALL_ARMS[id].dual), since a one-handed gun at the edge of
      // the screen is not the two-handed hold mirrored.
      let grip: THREE.Object3D | null = null
      viewmodel.object.traverse(node => { if (!grip && (node.name === 'anchor:grip' || node.userData.export_name === 'anchor:grip')) grip = node })
      if (grip) {
        viewmodel.object.updateWorldMatrix(true, true)
        const toLocal = viewmodel.object.getWorldQuaternion(new THREE.Quaternion()).invert()
        this.framing = {
          base: viewmodel.object.position.clone(), baseQ: viewmodel.object.quaternion.clone(),
          at: viewmodel.object.worldToLocal((grip as THREE.Object3D).getWorldPosition(new THREE.Vector3())),
          bore: viewmodel.muzzle.getWorldDirection(new THREE.Vector3()).applyQuaternion(toLocal),
        }
      }
      this.applyFraming()
    }).catch(async error => {
      // Fall back only if the authored viewmodel failed to load.
      const expected = ['assault-rifle', 'magnum', 'sniper', 'rocket-launcher', 'shotgun', 'energy-sword', 'battle-rifle', 'needler', 'gravity-hammer'].includes(id)
      const report = expected ? console.error : console.info
      report(`No Blender viewmodel for ${id}; holding the authored model with generated arms`, expected ? error : '')
      this.authored?.dispose()
      this.authored = null
      this.flashAnchor = null
      this.muzzle.add(this.flash)
      this.flash.position.set(0, 0, .05)
      this.object.add(this.assembly)
      this.debug.backend = 'fallback'
      this.debug.weapon = mesh
      this.assembly.visible = true
      try {
        const arms = await buildSpartanArms(this.rig, team)
        this.arms = arms
        this.assembly.add(arms.group)
        this.debug.arms = arms.group
        this.leftRest.copy(arms.leftArm.position)
        this.update(0, 0, false)
      } catch (armError) {
        console.error('Fallback Spartan arms failed to load', armError)
      }
    })
  }

  get canFire(): boolean {
    // Fire clips may overlap for automatic weapons. The CE cadence is governed by
    // the weapon's rate-of-fire cooldown, while the pose restarts on each round.
    // The energy sword is a plasma blade, not a magazine weapon: its battery is
    // represented in the slot for compatibility, but it never runs down.
    // A freshly drawn weapon waits out SWAP_READY, exactly as the server does.
    return this.cooldown <= 1e-6 && this.drawTime < 0 && (this.isMeleeWeapon || this.slot.ammo > 0) && this.reloading < 0 && this.meleeTime < 0 && this.throwTime < 0
  }

  get reloadElapsed(): number { return Math.max(0, this.slot.id === 'shotgun' ? this.shellPoseTime() : this.reloading) }
  private shellPoseTime(): number {
    const t = this.reloading, r = SHOTGUN_RELOAD
    if (t >= this.shellEnd) return r.clipExit + t - this.shellEnd
    return t < r.enter ? t : r.enter + (t - r.enter) % r.shell
  }
  get reloadDuration(): number { return this.rig.reload }

  consumePumpContact(): boolean {const contact=this.pumpContact;this.pumpContact=false;return contact}
  consumeReloadCancel(): boolean { const cancel=this.shellCancel; this.shellCancel=false; return cancel }
  get isReloading(): boolean {
    return this.reloading >= 0
  }

  /** Development studio only: sample the same animation and framing as gameplay, without
   * advancing ammo, audio or networking. These instances must not be used in a live match. */
  reviewSample(requested: ViewmodelAction | 'ignite', seconds: number): number {
    if (!DEBUG_HOOKS || !this.authored) throw new Error('Review sampling requires a loaded development viewmodel')
    const ignite = requested === 'ignite' && this.isBlade
    const action: ViewmodelAction = requested === 'ignite' ? 'idle' : requested
    if (ignite) { this.igniteTime = Math.min(Math.max(0, seconds), IGNITE.total - 1e-4); this.authoredIdle = 0; this.fireTime = this.meleeTime = this.throwTime = this.reloading = -1; this.updateAuthored(0, 0); this.applyViewMotion(); return IGNITE.total }
    this.igniteTime = -1
    const duration = action === 'melee' ? this.meleeProfile.duration : this.authored.duration(action)
    const t = Math.min(Math.max(0, seconds), duration)
    this.authoredIdle = action === 'idle' ? t : 0
    this.fireTime = action === 'fire' ? t : -1
    this.meleeTime = action === 'melee' ? t : -1
    this.throwTime = action === 'grenade' ? t : -1
    this.reloading = action === 'reload' ? t : -1
    this.updateAuthored(0, 0)
    this.setFlashVisible(action === 'fire' && t < .055)
    return duration
  }

  /** Call once per frame. `speed` drives walk bob, `aiming` pulls the weapon to centre. */
  update(dt: number, speed: number, aiming: boolean): void {
    if (!this.authored && this.counter && this.counter.last !== this.slot.ammo) {
      const {ctx,texture} = this.counter
      ctx.fillStyle='#061d29';ctx.fillRect(0,0,128,192)
      ctx.strokeStyle='#2f728a';ctx.lineWidth=3;ctx.strokeRect(5,5,118,182)
      ctx.fillStyle='#82dcff';ctx.textAlign='center';ctx.font='bold 64px monospace';ctx.fillText(String(this.slot.ammo).padStart(2,'0'),64,123)
      if(this.slot.id==='battle-rifle'){ctx.fillStyle='#061d29';ctx.fillRect(0,0,128,64);ctx.fillStyle='#82dcff';ctx.font='bold 56px monospace';ctx.fillText(String(this.slot.ammo).padStart(2,'0'),64,52)}else{ctx.font='22px monospace';ctx.fillText('N',64,44);ctx.font='18px monospace';ctx.fillText('MA5B',64,170)}
      texture.needsUpdate=true;this.counter.last=this.slot.ammo
    }
    if(!this.authored&&this.slot.id==='needler') {
      const gun=this.debug.weapon as THREE.Object3D
      for(let i=0;i<20;i++){const crystal=gun.getObjectByName(`needler-crystal-${i}`);if(crystal){const t=this.reloading<0?1:span(this.reloading/this.rig.reload,.3,.78);crystal.visible=i<this.slot.ammo||this.reloading>=0;crystal.scale.setScalar(this.reloading>=0?Math.max(.01,t):1)}}
    }
    this.chargeClock=this.charge.held?this.chargeClock+dt:0
    if(this.chargeOrb)this.chargeOrb.scale.setScalar(this.charge.held?(.04+this.charge.time/PLASMA_CHARGE.seconds*.09)*(1+.06*Math.sin(this.authoredIdle*40)):0)
    // A flash always gets at least the frame after its shot, however long that frame took (a 40 ms flash on a 45 ms frame
    // would otherwise never be seen).
    if(this.flashFresh)this.flashFresh=false;else this.flashTime=Math.max(0,this.flashTime-dt)
    this.setFlashVisible(this.flashTime>0)
    this.updateMuzzleFx(dt)
    // Keep only this frame's overshoot, so automatic fire retains its cadence
    // across render rates without banking shots while the trigger is released.
    this.cooldown = this.cooldown > 0 ? this.cooldown - dt : 0
    this.recoil *= Math.exp(-14 * dt)
    this.stepKick(dt)
    this.cycle = Math.max(0, this.cycle - dt * this.cycleRate)
    this.advanceActions(dt)
    if (this.authored) {
      this.updateAuthored(dt, speed)
      this.applyViewMotion()
      return
    }

    this.aim += ((aiming && this.reloading < 0 ? 1 : 0) - this.aim) * (1 - Math.exp(-16 * dt))
    this.rest.copy(this.hip).lerp(this.ads, this.aim)

    this.bob += dt * speed * 1.5
    const amp = (1 - this.aim * 0.85) * Math.min(speed / 7, 1) * 0.014

    // Idle sway. Nobody stands holding two kilos of pistol perfectly still, and a viewmodel that
    // is pixel-identical frame to frame when the player stops moving reads as a photograph pasted
    // over the game rather than as something a person is carrying. Three slow sines at
    // incommensurate rates never repeat, so it drifts instead of ticking; it is deliberately
    // below the threshold of "an animation" and only wants to be above the threshold of "still".
    this.idle += dt
    const t = this.idle
    const breathe = (1 - this.aim * 0.7) * 0.0016
    const swayX = Math.sin(t * 0.83) * 0.6 + Math.sin(t * 1.51) * 0.4
    const swayY = Math.sin(t * 1.13 + 1.1) * 0.7 + Math.sin(t * 0.47) * 0.3

    // Reload first: it owns the pose while it runs, and everything else rides on top.
    const r = this.reloadPose()
    if(this.tubes){
      const u=this.reloading<0?0:this.reloading/this.rig.reload
      const out=Math.min(span(u,.18,.35),1-span(u,.65,.83))
      this.tubes.position.set(-.12*out,.32*out,.05*out)
      this.tubes.rotation.z=-.22*out
    }
    let rightRelease = 0, leftRelease = 0
    this.weaponPivot.position.copy(this.pivotRest)
    this.weaponPivot.rotation.set(0, 0, 0)
    if (this.meleeTime >= 0) {
      const profile = this.meleeProfile
      const u = this.meleeTime / profile.duration
      const lift = Math.min(span(u,0,.22),1-span(u,.25,.45))
      const strike = Math.min(span(u,.22,.40),1-span(u,.50,1))
      const pistol = this.slot.id === "magnum", ar = this.slot.id === "assault-rifle"
      if (this.slot.id === 'gravity-hammer') {
        const wind=span(u,0,.28)*(1-span(u,.30,.52)), slam=span(u,.28,.38)*(1-span(u,.48,1))
        r.x-=.10*wind+.30*slam;r.y+=.15*wind-.19*slam;r.z+=.06*wind-.15*slam
        r.pitch+=.9*wind-1.25*slam;r.roll+=.45*wind-.65*slam
      } else if (this.isBlade) {
        // The fallback follows the authored fist-led punch and its contact/recovery timing.
        const chamber=span(this.meleeTime,0,.025)*(1-span(this.meleeTime,.025,.16))
        const punch=span(this.meleeTime,.025,.16)*(1-span(this.meleeTime,.19,.58))
        r.x += .02*chamber-.065*punch
        r.y += -.015*chamber+.025*punch
        r.z += -.045*chamber+.19*punch
        r.pitch += .08*chamber-.40*punch
        r.yaw += -.035*chamber+.035*punch
        r.roll += .025*punch
        r.left.set(.01*punch,-.015*punch,-.025*punch)
      } else {
      r.x += (ar ? -.27 : -.08)*strike
      r.y += .16*lift - (ar ? .01 : .24)*strike
      r.z += .08*lift - .20*strike
      r.pitch += (ar ? .25 : 1.35)*lift - (ar ? .1 : .85)*strike
      r.yaw += (ar ? 1.65 : .25)*strike
      r.roll += (ar ? .25 : -.35)*strike
      }
      if (pistol) {
        const airborne = Math.min(span(u, .48, .57), 1 - span(u, .83, .93))
        // The gun turns once about the grip while the open firing hand waits below it.
        this.weaponPivot.rotation.x = -Math.PI * 2 * span(u, .50, .88)
        this.weaponPivot.position.y += .11 * hump((u - .48) / .43)
        rightRelease = airborne
        leftRelease = .75 * airborne
        r.left.set(-.12 * strike, -.08 * strike, -.06 * strike)
      }
    }

    this.heldGrenade.visible = false
    if (this.throwTime >= 0) {
      const u = this.throwTime / GRENADE_THROW.duration
      const draw = Math.min(span(u, 0, .23), 1 - span(u, .23, .43))
      const cast = Math.min(span(u, .23, .43), 1 - span(u, .48, 1))
      r.y -= .07 * Math.min(span(u, 0, .2), 1 - span(u, .7, 1))
      r.pitch -= .12 * draw
      r.left.set(.18 * draw + .13 * cast, .18 * draw + .28 * cast, -.15 * draw + .36 * cast)
      leftRelease = span(u, .28, .43) * (1 - span(u, .62, 1))
      this.heldGrenade.visible = this.throwTime < GRENADE_THROW.release
      this.heldGrenade.position.set(-this.rig.left.pos[0], this.rig.left.pos[1] + .045, this.rig.left.pos[2]).add(r.left)
    }

    this.object.position.set(
      this.rest.x + Math.cos(this.bob) * amp + swayX * breathe + r.x,
      this.rest.y + Math.abs(Math.sin(this.bob)) * amp + swayY * breathe - this.recoil * 0.018 + r.y,
      this.rest.z + this.recoil * 0.05 + r.z,
    )

    // Recoil rotates the whole assembly about the wrist rather than sliding it: the muzzle rises,
    // the butt rolls out, and the hands go with it because they are children of the same group.
    const cant = 1 - this.aim
    this.object.rotation.set(
      this.cant.x * cant + this.recoil * 0.30 + swayY * breathe * 5 + r.pitch,
      this.cant.y * cant + this.recoil * 0.05 + swayX * breathe * 6 + r.yaw,
      this.cant.z * cant - this.recoil * 0.14 + swayX * breathe * 4 + r.roll,
    )

    // The action. A triangular travel — snapped open, eased shut — reads as a slam rather than
    // as a slider, and the magazine only leaves during a reload.
    const open = this.cycle < 0.5 ? this.cycle / 0.5 : (1 - this.cycle) / 0.5
    if (this.slide) this.slide.position.copy(this.slideThrow).multiplyScalar(open)
    if (this.mag) {
      this.mag.position.copy(this.magThrow).multiplyScalar(r.mag)
      // A magazine that slides straight down a rail is a lift, not a drop. Once it is clear of
      // the well it tips away from the weapon, which is the only cue that says it fell out
      // rather than retracted — and it is the difference between reading the empty magwell as a
      // reload and reading it as the gun losing a piece of itself.
      this.mag.rotation.set(r.mag * r.mag * 0.7, 0, r.mag * r.mag * -0.45)
      this.mag.visible = r.mag < 0.98
    }

    // Trigger finger: pulled while the shot is going out, relaxed by the time the gun settles.
    if (this.arms) {
      this.arms.setTrigger(Math.max(this.recoil * 1.6, r.trigger))
      this.arms.setRelease?.(rightRelease, leftRelease)
      this.arms.rightArm.position.set(0, -.028 * rightRelease, -.025 * rightRelease)
      this.arms.leftArm.position.copy(this.leftRest).add(r.left)
      this.arms.spareMag.visible = r.spare
    }
    this.applyViewMotion()
  }


  /**
   * The lower/raise of a weapon switch, composed over whatever pose the weapon itself produced
   * this frame. Two rotations do the work. One turns the whole assembly about the eye, which
   * slides it across the screen without changing how it is held; the other turns it about the
   * right hand, which changes how it is held without moving the grip much.
   */
  private applyViewMotion(): void {
    let camPitch = 0, camYaw = 0, handPitch = 0, handYaw = 0, handRoll = 0
    const offset = SCRATCH_OFFSET.set(0, 0, 0)

    if (this.lowerTime >= 0) {
      // Accelerating away: the gun drops out to the bottom right, nose tipping up as the hand
      // lets it go, the way Halo 3 puts one away.
      const u = clamp01(this.lowerTime / SWITCH.lower)
      const v = u, pose = SWITCH_POSE.lower
      camPitch += pose.camPitch * v
      camYaw += pose.camYaw * v
      handPitch += pose.handPitch * v
      handYaw += pose.handYaw * v
      handRoll += pose.handRoll * v
      offset.z += pose.near * v
    }
    if (this.drawTime >= 0) {
      // Out of sight while the old weapon clears, then up from the bottom right: nose-high and
      // rolled, carried a touch past its rest, and settled as the support hand arrives.
      const u = clamp01((this.drawTime - SWITCH.raise) / (SWITCH.ready - SWITCH.raise))
      const away = (1 - u) ** 2 * (1 + 2 * u) // smooth from 1 to 0 over the raise
      const over = Math.sin(Math.PI * clamp01((u - .25) / .75)) ** 2
      const pose = SWITCH_POSE.draw, overshoot = SWITCH_POSE.overshoot
      camPitch += pose.camPitch * away + overshoot.camPitch * over
      camYaw += pose.camYaw * away
      handPitch += pose.handPitch * away + overshoot.handPitch * over
      handYaw += pose.handYaw * away
      handRoll += pose.handRoll * away
      offset.z += pose.near * away + overshoot.near * over
    }

    if (this.igniteTime >= 0) {
      // Halo 3 draw: the bare hilt is brought up into view in the fist (the lit sword rests with its hilt below the frame),
      // the wrist cocks back, the blade bursts out of it (applyBladeIgnite) and the flick carries it down and out to its
      // resting place with a small kick toward the eye and a damped wobble as it settles.
      const t = this.igniteTime, b = IGNITE.burst, after = Math.max(0, t - b)
      const up = span(t, 0, IGNITE.cock + .06) * (1 - span(t, b + .02, b + .18))
      const cock = span(t, IGNITE.cock, b - .02) * (1 - span(t, b - .02, b + .04))
      const lit = span(t, b, b + .02)
      const wobble = Math.exp(-after * 9) * Math.sin(after * 26) * lit
      offset.x += -.06 * up; offset.y += .08 * up; offset.z += .02 * up
      handPitch += -.18 * up + .22 * cock - .14 * wobble
      handRoll += -.12 * up + .06 * wobble
      offset.z += .03 * Math.exp(-after * 14) * lit
    }
    const feel = RECOIL_FEEL[this.slot.id]
    if (feel && this.kick.n) {
      // Per-round recoil (RECOIL_FEEL): muzzle up about the wrist, shoved toward the eye, rolled and yawed to the round's side.
      handPitch += feel.pitch * this.kick.x
      handRoll += feel.roll * this.kick.lx
      handYaw += feel.yaw * this.kick.lx
      offset.z += feel.back * this.kick.x
    }
    if (this.charge.held) {
      // Overcharge: a faint tremor while the bolt builds, then the whole pistol shaking in the hand once it is full,
      // as Halo's plasma pistol does. Incommensurate frequencies so it reads as a buzz, not a wobble.
      const f = Math.min(1, this.charge.time / PLASMA_CHARGE.seconds), t = this.chargeClock
      const a = .2 * f * f + (f >= 1 ? .8 + .2 * Math.sin(t * 9) : 0)
      handPitch += a * .014 * Math.sin(t * 61)
      handYaw += a * .010 * Math.sin(t * 47 + 1.3)
      handRoll += a * .020 * Math.sin(t * 53 + 2.1)
      offset.x += a * .0018 * Math.sin(t * 71 + .7)
      offset.y += a * .0018 * Math.sin(t * 67 + 2.9)
    }
    CAM_EULER.set(camPitch, camYaw, 0, 'YXZ')
    HAND_EULER.set(handPitch, handYaw, handRoll, 'YXZ')
    CAM_TURN.setFromEuler(CAM_EULER)
    HAND_TURN.setFromEuler(HAND_EULER)
    // Pose p -> cam * (hand * (p - pivot) + pivot) + offset, applied over the weapon's own pose.
    const position = this.object.position
    position.sub(this.handPivot).applyQuaternion(HAND_TURN).add(this.handPivot).applyQuaternion(CAM_TURN).add(offset)
    this.object.quaternion.premultiply(HAND_TURN).premultiply(CAM_TURN)
    // Nothing of the incoming gun shows while the outgoing one is still leaving.
    const hidden = this.drawTime >= 0 && this.drawTime < SWITCH.raise
    if (this.authored) this.authored.object.visible = !hidden
    else if (this.debug.backend === 'fallback') this.assembly.visible = !hidden
  }

  /** Advance the RECOIL_FEEL springs, in small fixed steps so a long frame cannot blow them up. */
  private stepKick(dt: number): void {
    const feel = RECOIL_FEEL[this.slot.id], k = this.kick
    if (!feel || !k.n || dt <= 0) return
    const w = 2 * Math.PI * feel.hz, c = 2 * feel.damping * w
    for (let left = Math.min(dt, .1); left > 0; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240)
      k.v += (-w * w * k.x - c * k.v) * h; k.x += k.v * h
      k.lv += (-w * w * k.lx - c * k.lv) * h; k.lx += k.lv * h
    }
    // at rest: stop stepping until the next round
    if (Math.abs(k.x) + Math.abs(k.lx) < 1e-4 && Math.abs(k.v) + Math.abs(k.lv) < 1e-3) k.x = k.v = k.lx = k.lv = k.n = 0
  }

  /** Gameplay clocks are independent of whichever render asset is loaded. */
  private advanceActions(dt: number): void {
    if (this.drawTime >= 0) { this.drawTime += dt; if (this.drawTime >= SWITCH.ready) this.drawTime = -1 }
    if (this.igniteTime >= 0) { this.igniteTime += dt; if (this.igniteTime >= IGNITE.total) this.igniteTime = -1 }
    if (this.lowerTime >= 0) {
      this.lowerTime += dt
      // Gone: stay out of sight until it is drawn again, whoever gets round to unparenting it.
      if (this.lowerTime >= SWITCH.lower) { this.lowerTime = -1; this.object.visible = false }
    }
    if (this.fireTime >= 0) {
      const previousFire = this.fireTime
      this.fireTime += dt
      if (this.slot.id === 'shotgun' && previousFire < .32 && this.fireTime >= .32) this.pumpContact = true
      if (this.fireTime >= (this.authored?.duration('fire') ?? .3)) this.fireTime = -1
    }
    if (this.reloading >= 0) {
      this.reloading += dt
      if (this.slot.id === 'shotgun') {
        const r = SHOTGUN_RELOAD
        const contacts = Math.max(0, Math.floor((Math.min(this.reloading, this.shellEnd) - r.contact + 1e-6) / r.shell) + 1)
        while (!this.shellInterrupted && this.shellCount < contacts && this.slot.ammo < this.slot.spec.magazine && this.slot.reserve > 0) {
          this.slot.ammo++; this.slot.reserve--; this.shellCount++
          if (this.slot.ammo === this.slot.spec.magazine || this.slot.reserve === 0) this.shellEnd = r.enter + this.shellCount * r.shell
        }
        if (this.reloading >= this.shellEnd + r.exit) { this.reloading = -1; this.armed = false }
      } else if (this.reloading >= this.rig.reload) {
        const take = Math.min(this.slot.spec.magazine - this.slot.ammo, this.slot.reserve)
        this.slot.ammo += take
        this.slot.reserve -= take
        this.reloading = -1
        this.armed = false
      } else if (this.armed && this.reloading / this.rig.reload > .84) {
        this.armed = false
        this.cycle = 1
        this.cycleRate = 7
      }
    }
    if (this.meleeTime >= 0) {
      const previous = this.meleeTime
      this.meleeTime += dt
      if (previous < this.meleeProfile.hit && this.meleeTime >= this.meleeProfile.hit) this.meleeImpact = true
      if (this.meleeTime >= this.meleeProfile.duration) this.meleeTime = -1
    }
    if (this.throwTime >= 0) {
      const previous = this.throwTime
      this.throwTime += dt
      if (previous < GRENADE_THROW.release && this.throwTime >= GRENADE_THROW.release) this.throwRelease = true
      if (this.throwTime >= GRENADE_THROW.duration) this.throwTime = -1
    }
  }

  private updateAuthored(dt: number, speed: number): void {
    if (this.plasma.length) {
      this.plasmaClock += dt
      flickerPlasma(this.plasma, this.plasmaClock)
    }
    const viewmodel = this.authored!
    let action: ViewmodelAction = 'idle'
    let time = 0
    if (this.isBlade && this.fireTime >= 0) { action = 'fire'; time = this.fireTime }
    else if (this.meleeTime >= 0) { action = 'melee'; time = this.meleeTime }
    else if (this.throwTime >= 0) { action = 'grenade'; time = this.throwTime }
    else if (this.reloading >= 0) { action = 'reload'; time = this.reloadElapsed }
    else if (this.fireTime >= 0) { action = 'fire'; time = this.fireTime }
    else {
      this.authoredIdle += dt
      const duration = viewmodel.duration('idle')
      time = duration > 0 ? this.authoredIdle % duration : 0
    }
    // Blender owns all bones, grips, magazines and action movement. The camera-local wrapper
    // adds only the switch (applyViewMotion) and the melee layer below; there is no walk bob.
    // Classic Halo references: Covenant grips are held one-handed below the sightline;
    // the paired silhouettes sit toward the screen edges, with their upper surfaces visible.
    const pose=SMALL_ARM_HOLD[this.slot.id]??[0,0,0],side=this.dualHand==='left'?-1:1
    // a fitted weapon (FRAMING_SMALL_ARMS `turn`) already sits where the Halo 3 frame puts it; mirrored, that is the second gun's place too
    this.object.position.set((this.dualHand&&!FRAMING_SMALL_ARMS[this.slot.id]?.dual&&!FRAMING_SMALL_ARMS[this.slot.id]?.turn?side*.09:0)+side*pose[0],pose[1],pose[2])
    this.object.rotation.set(0, 0, 0)
    const layer = MELEE_LAYER[this.slot.id]
    if (layer && this.meleeTime >= 0) {
      const contact = this.meleeProfile.hit / this.meleeProfile.duration
      const u = this.meleeTime / this.meleeProfile.duration
      const strength = layer.strength
      if (layer.hold) {
        const settle = span(u, 0, contact * .5) * (1 - span(u, contact + .35, 1))
        this.object.position.x += layer.hold[0] * settle
        this.object.position.y += layer.hold[1] * settle
        this.object.position.z += layer.hold[2] * settle
      }
      // Wind the weapon back and over, whip it up and across the view, then settle. The
      // strike peaks on the clip's own contact frame so the arc, the sound and the damage all
      // land together. Rifle strikes are authored bone clips and never enter this wrapper.
      const wind = span(u, 0, contact * .62) * (1 - span(u, contact * .62, contact))
      const strike = span(u, contact * .55, contact) * (1 - span(u, contact + .10, Math.min(1, contact + .5)))
      const lateral = layer.lateral ?? 1
      this.object.position.x += (.02 * wind - .06 * strike * lateral) * strength
      this.object.position.y += (-.02 * wind + .10 * strike) * strength
      this.object.position.z += (.04 * wind + .02 * strike) * strength
      this.object.rotation.x += (.12 * wind + .50 * strike) * strength
      this.object.rotation.y += (.10 * wind - .20 * strike * lateral) * strength
      this.object.rotation.z += (.10 * wind - .52 * strike) * strength
    }
    viewmodel.setAmmo(this.slot.ammo)
    // Fit the full strike and recovery to the gameplay clock. Each rifle's arm tracks
    // are solved on its own rig; there is no cross-rifle bone-track copying.
    const rifleMelee = action === 'melee' && (this.slot.id === 'assault-rifle' || this.slot.id === 'battle-rifle')
    // Solve wrist IK in a proper rotation frame, then mirror the finished pose.
    // Quaternion decomposition cannot represent a reflected parent transform.
    this.object.scale.x=1;this.object.updateWorldMatrix(true,true)
    viewmodel.sample(action, rifleMelee ? this.meleeTime / this.meleeProfile.duration * viewmodel.duration('melee') : time)
    this.object.scale.x=this.dualHand==='left'?-1:1;this.object.updateWorldMatrix(true,true)
    if (this.isBlade) this.applyBladeIgnite(viewmodel.object)
    viewmodel.setGrenade(this.throwTime >= 0 && this.throwTime < GRENADE_THROW.release ? this.grenadeKind : null)
    if (this.flashTime <= 0) this.attachAuthoredFlash()
  }

  /** Hilt-only until the flick, then the plasma blade extends out of the hilt. Scaled about the hilt so the prongs
   * unfold from it; hidden while it is shorter than a sliver. */
  private applyBladeIgnite(root: THREE.Object3D): void {
    if (!this.blade) {
      this.blade = []
      root.traverse(n => { if (/^hilt:plasma-/.test(String(n.userData.export_name ?? n.name))) this.blade!.push({ node: n, z: n.position.z }) })
      const core = this.blade[0]?.node
      if (core?.parent) {
        const box = new THREE.Box3().setFromObject(core); core.parent.updateWorldMatrix(true, false)
        const size = box.getSize(new THREE.Vector3()).divideScalar(core.parent.getWorldScale(new THREE.Vector3()).x || 1)
        this.igniteFx = createSwordIgniteFx(Math.max(size.x, size.y, size.z), .2)
        core.parent.add(this.igniteFx.object)
      }
    }
    let s = 1
    if (this.igniteTime >= 0) {
      const u = clamp01((this.igniteTime - IGNITE.burst) / IGNITE.extend)
      const back = 1.70158 * 1.4, e = u - 1
      s = this.igniteTime < IGNITE.burst ? 0 : 1 + (back + 1) * e ** 3 + back * e ** 2 // ease-out-back: shoots out, overshoots, settles
    }
    for (const { node, z } of this.blade) {
      const w = s <= 0 ? 0 : Math.min(1.15, .25 + .75 * Math.min(1, s) + Math.max(0, s - 1) * .5)
      node.visible = s > .015
      node.scale.set(w, w, Math.max(s, 1e-3))
      node.position.z = z + IGNITE.pivotZ * (1 - Math.max(s, 1e-3))
    }
    // burst FX + the blade over-bright as it bursts (flickerPlasma already set this frame's base glow)
    const glow = this.igniteFx?.update(this.igniteTime >= 0 ? this.igniteTime - IGNITE.burst : -1) ?? 1
    if (glow !== 1) for (const b of this.plasma) b.material.emissiveIntensity *= glow
  }

  /**
   * The flash's life after a shot: it swells and dims (muzzle-flash.ts), the weapon's own fill light flares in its colour
   * and swings toward the muzzle so the gloves and receiver catch it, and the smoke drifts. The fill light is always on for
   * the held weapon, so this never changes the light count (no shader recompile) and costs nothing between shots.
   */
  /** Throw a case from the ejection port: the viewmodel's eject, bolt or charging-handle marker where it has one, otherwise the
   * top of the receiver just ahead of the grip. */
  private ejectCase():void {
    if(!this.casings||!this.authored)return
    // the muzzle marker hangs under the GLB's own anchor node, which sits in the gun's frame beside the other anchors
    // (three strips ':' and '.' from node names: anchor:grip.228 -> anchorgrip228)
    const anchor=this.authored.muzzle.parent,mount=anchor?.parent
    if(!anchor||!mount)return
    if(this.port?.node!==mount){
      const key=(n:THREE.Object3D)=>String(n.userData.export_name??n.name).replace(/[^a-z]/gi,'').toLowerCase()
      const find=(name:string)=>mount.children.find(n=>key(n).startsWith(name))
      const at=new THREE.Vector3(),direct=find('anchoreject')??find('anchorbolt')??find('anchorcharginghandle')
      const muzzle=anchor.position,grip=find('anchorgrip')
      if(direct)at.copy(direct.position)
      // otherwise on top of the receiver a quarter of the way from the grip to the muzzle: in frame on every gun (a magazine
      // marker can sit behind the grip on bullpups, off the edge of the screen)
      else at.set(0,muzzle.y+.01,grip?grip.position.z+(muzzle.z-grip.position.z)*.25:muzzle.z-.2)
      this.port={node:mount,at}
    }
    mount.updateWorldMatrix(true,false)
    const world=MUZZLE_AT.copy(this.port.at).applyMatrix4(mount.matrixWorld)
    this.casings.eject(this.object.worldToLocal(world),Math.abs(mount.getWorldScale(SCRATCH_SCALE).x),false)
  }

  private updateMuzzleFx(dt:number):void {
    this.smoke?.update(dt)
    if(this.casings){
      // world "down" in the weapon's own (camera) space, so a case falls straight down whatever the view pitch
      // (the object's own origin is local zero, so a point one metre below it, brought into local space, is the direction)
      this.object.getWorldPosition(MUZZLE_ALONG).y-=1
      this.casings.update(dt,this.object.worldToLocal(MUZZLE_ALONG).normalize())
    }
    const life=this.flash.userData.life??.045,k=Math.min(1,this.flashTime/life)
    if(k<=0){
      if(this.fillFlared){this.fill.intensity=this.fillBase.intensity;this.fill.color.copy(this.fillBase.color);this.fill.position.copy(this.fillHome);this.fillFlared=false}
      else this.fillHome.copy(this.fill.position)
      return
    }
    this.flash.userData.fade?.(k)
    const light=this.flash.userData.light as {color:THREE.Color;strength:number}|undefined
    if(!light)return
    this.fillFlared=true
    this.fill.intensity=this.fillBase.intensity+light.strength*k*k
    this.fill.color.copy(this.fillBase.color).lerp(light.color,Math.min(1,k*1.5))
    this.flash.updateWorldMatrix(true,false)
    this.fill.position.copy(this.fillHome).lerp(this.object.worldToLocal(this.flash.getWorldPosition(MUZZLE_AT)),.35*k)
  }
  private fillFlared=false
  private flashFresh=false

  private attachAuthoredFlash(): void {
    if (!this.authored) return
    // The authored SPNKR has a fixed firing lane. Its paired tube carrier rotates
    // in the fire clip, so muzzle FX must stay on the fixed lane marker.
    const anchor = this.authored.muzzle
    if (this.flashAnchor === anchor) return
    this.flashAnchor = anchor
    anchor.add(this.flash)
    this.setFlashVisible(this.flashTime > 0)
  }

  private setFlashVisible(visible: boolean): void {
    if (!visible) { this.flash.scale.setScalar(0); return }
    if (!this.authored || !this.flashAnchor) { this.flash.scale.setScalar(1); return }
    // Markers are exported with +Z along the barrel. Counter inherited bone/object scale.
    const scale = this.flashAnchor.getWorldScale(SCRATCH_SCALE)
    this.flash.scale.set(1 / Math.max(1e-5, Math.abs(scale.x)), 1 / Math.max(1e-5, Math.abs(scale.y)), 1 / Math.max(1e-5, Math.abs(scale.z)))
    this.flash.position.set(0, 0, .05 / Math.max(1e-5, Math.abs(scale.z)))
  }

  /**
   * The reload, as one timeline over the weapon's reload time:
   *   0.00-0.16  the gun cants over towards the shooter and drops out of the aim
   *   0.16-0.34  the magazine falls clear
   *   0.34-0.60  the support hand goes down out of frame for a fresh one
   *   0.60-0.80  the magazine comes back up and seats
   *   0.80-0.88  the support hand slaps the slide release and the action closes
   *   0.88-1.00  back to the ready position
   * Returns the pose offsets for this frame; caller composes them with bob, aim and recoil.
   */
  private reloadPose(): {
    x: number; y: number; z: number
    pitch: number; yaw: number; roll: number
    mag: number; trigger: number; spare: boolean; left: THREE.Vector3
  } {
    const left = SCRATCH_LEFT.set(0, 0, 0)
    if (this.reloading < 0) {
      return { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, mag: 0, trigger: 0, spare: false, left }
    }

    const u = this.reloading / this.rig.reload

    // The gun's own motion: down, in towards the centreline, rolled so the magazine well faces
    // the shooter. Held for the middle of the animation, eased at both ends.
    const hold = Math.min(span(u, 0, 0.16), 1 - span(u, 0.86, 1))
    if (this.slot.id === 'needler') {
      left.set(-.04*hold,-.04*hold,.04*hold)
      return {x:-.07*hold,y:.05*hold,z:.025*hold,pitch:.22*hold,yaw:.25*hold,roll:-.5*hold,mag:0,trigger:0,spare:false,left}
    }
    if (this.slot.id === 'rocket-launcher') {
      const out = Math.min(span(u, .18, .35), 1 - span(u, .65, .83))
      left.set(-.12*out, .32*out, .05*out)
      return {x:-.08*hold,y:.03*hold,z:-.10*hold,pitch:.30*hold,yaw:-.4*hold,roll:.7*hold,mag:0,trigger:0,spare:false,left}
    }

    if (this.slot.id === 'shotgun') {
      // Shells are fed one at a time into the port, so the support hand makes three trips
      // rather than one trip for a magazine, and nothing leaves the gun. The pump that closes
      // the reload comes from the action being armed at 84%, the same as every other weapon.
      const trips = 3
      const trip = hump((clamp01((u - .10) / .66) * trips) % 1)
      left.set(-.055 * trip, -.125 * trip, -.02 * trip)
      return {
        x: -.03 * hold, y: .05 * hold, z: .03 * hold,
        pitch: .34 * hold, yaw: .30 * hold, roll: -.58 * hold,
        mag: 0, trigger: 0, spare: false, left,
      }
    }

    // Magazine: out fast, gone, then back up the well.
    const out = span(u, 0.16, 0.34)
    const back = 1 - span(u, 0.60, 0.80)
    const mag = u < 0.5 ? out : back

    // Support hand: dives for a magazine, comes back with it, then knocks the action shut.
    //
    // It dives far enough to read as a reach and no further. Sending the hand a full 0.34 down
    // takes it clean off the bottom of the screen, and a beat the player cannot see is a beat
    // that did not happen — the fresh magazine it comes back holding is the whole point of the
    // move, and it has to be in frame to be worth animating.
    const dive = hump(clamp01((u - 0.30) / 0.42))
    const slap = hump(clamp01((u - 0.78) / 0.14))
    left.set(-0.03 * dive - 0.02 * slap, -0.105 * dive + 0.04 * slap, -0.04 * dive + 0.06 * slap)

    // The gun comes *up* and inboard, not down. Dropping it to reload puts the magazine well —
    // the one thing the animation is about — below the bottom of the screen along with both
    // hands, and what is left in frame is a pistol rolling on its own in the middle of the air.
    return {
      x: -0.045 * hold,
      y: 0.045 * hold,
      z: 0.02 * hold,
      pitch: (this.slot.id === "sniper" ? .62 : .10) * hold,
      yaw: 0.24 * hold,
      roll: (this.slot.id === "assault-rifle" ? -.65 : -.42) * hold,
      mag,
      trigger: 0,
      // The fresh magazine is in the hand from the moment it comes back up until it is seated.
      spare: u > 0.44 && u < 0.80,
      left,
    }
  }

  private armed = false

  /** Returns true if a shot went out. */
  /** A weapon whose shot is a swing. There is no muzzle, no recoil and no action to cycle. */
  get isBlade(): boolean {
    return this.slot.id === 'energy-sword'
  }

  fire(charged=false): boolean {
    // The shotgun loads one shell at a time; canonically, pulling the trigger fires whatever
    // is already chambered instead of waiting out the rest of the reload. The server already
    // does this unconditionally (`room.ts`'s fire handler zeroes `reloadDoneFrame` for any
    // shotgun shot with ammo left), so ending the reload here too — rather than only shortening
    // it and still running out the pump/rack exit animation — is what keeps the local weapon in
    // step with what the authoritative shot already allows.
    if (this.slot.id === 'shotgun' && this.isReloading && this.slot.ammo > 0) {
      this.shellInterrupted = true; this.shellCancel = true
      this.reloading = -1; this.armed = false
    }
    if (!this.canFire || (charged&&this.slot.ammo<PLASMA_CHARGE.cost)) return false
    if (this.isMeleeWeapon) {
      this.cooldown = 1 / this.slot.spec.rof + Math.min(0, this.cooldown)
      // Both clocks run. `meleeTime` is the damage window and stays as short as the gameplay
      // wants it; `fireTime` follows the authored forward thrust and its weighted recovery.
      // Driving the pose off the
      // damage window instead is what left the sword playing the rifle's butt-stroke.
      this.fireTime = 0
      this.meleeTime = 0
      this.meleeImpact = false
      return true
    }
    if(this.slot.spec.burst && this.burstRemaining===0)this.burstRemaining=this.slot.spec.burst.size
    this.attachAuthoredFlash()
    this.flashTime=this.flash.userData.life??.045;this.flashFresh=true
    this.flash.userData.shot?.()
    this.setFlashVisible(true)
    this.ejectCase()
    if(this.smoke){this.flash.updateWorldMatrix(true,false);this.smoke.emit(this.object.worldToLocal(this.flash.getWorldPosition(MUZZLE_AT)),this.object.worldToLocal(this.flash.getWorldPosition(MUZZLE_ALONG).add(this.flash.getWorldDirection(MUZZLE_DIR))).sub(MUZZLE_AT).normalize())}
    this.slot.ammo-=charged?PLASMA_CHARGE.cost:1
    this.authored?.setAmmo(this.slot.ammo)
    this.fireTime = 0
    this.cooldown = 1 / this.slot.spec.rof + Math.min(0, this.cooldown)
    if(charged)this.cooldown=PLASMA_CHARGE.recovery
    if(this.slot.spec.burst){this.burstRemaining--;if(!this.burstRemaining)this.cooldown=this.slot.spec.burst.pause}
    this.recoil = Math.min(1, this.recoil + (this.slot.id==='needler'?.22:this.slot.id==='battle-rifle'?.4:1))
    const feel = RECOIL_FEEL[this.slot.id]
    if (feel) {
      // an overcharged bolt kicks harder; each round goes to the other side, by a varying amount so a burst never looks metronomic
      const j = kickImpulse(feel.hz, feel.damping) * (charged ? 2 : 1), n = ++this.kick.n
      this.kick.v += j
      this.kick.lv += j * (n % 2 ? 1 : -1) * (.55 + .45 * ((n * .618034) % 1))
    }
    // The action cycles once per round, and never slower than the weapon can fire.
    this.cycle = 1
    // A hand-worked action takes as long as it takes; a self-loading one keeps up with the gun.
    this.cycleRate = this.rig.cycleSeconds ? 1 / this.rig.cycleSeconds : Math.max(9, this.slot.spec.rof * 1.6)
    return true
  }

  reload(): void {
    if (this.isMeleeWeapon) return
    if (this.reloading >= 0 || this.meleeTime >= 0 || this.throwTime >= 0 || (this.slot.id === 'rocket-launcher' && this.fireTime >= 0)) return
    const want = this.slot.spec.magazine - this.slot.ammo
    const take = Math.min(want, this.slot.reserve)
    if (take <= 0) return
    this.fireTime = -1
    this.burstRemaining=0
    this.reloading = 0
    this.shellCount = 0; this.shellEnd = Infinity; this.shellInterrupted=false; this.shellCancel=false
    this.armed = true
  }

  get meleeProfile(): {duration:number;hit:number;reach:number} {
    return this.slot.id === 'gravity-hammer' ? {duration:1.15,hit:.38,reach:5}
      : this.slot.id === 'energy-sword' ? {duration:.715,hit:.16,reach:2.9}
      : this.slot.id === 'rocket-launcher' ? {duration:1.15,hit:.42,reach:2.5}
      : this.slot.id === 'sniper' ? {duration:.95,hit:.34,reach:2.4}
      : this.slot.id === 'magnum' ? {duration:.85,hit:.28,reach:1.9}
      : this.slot.id === 'assault-rifle' || this.slot.id === 'battle-rifle' ? RIFLE_MELEE
      : {duration:.65,hit:.22,reach:2.1}
  }
  get isMeleeing(): boolean { return this.meleeTime >= 0 }
  melee(): boolean {
    if (this.isMeleeWeapon) return this.fire()
    if (this.isMeleeing || this.isThrowing || (this.slot.id === 'rocket-launcher' && this.fireTime >= 0)) return false
    // A sword has one attack. Meleeing with it is the same slash as swinging it, so it plays
    // the same clip rather than a bare-handed pistol-whip performed with a plasma blade in hand.
    this.fireTime = this.isBlade ? 0 : -1
    this.burstRemaining=0
    this.reloading=-1; this.meleeTime=0; this.meleeImpact=false; return true
  }
  get isThrowing(): boolean { return this.throwTime >= 0 }
  throwGrenade(kind: 'frag' | 'plasma' = 'frag'): boolean {
    if (this.isMeleeing || this.isThrowing || (this.slot.id === 'rocket-launcher' && this.fireTime >= 0)) return false
    this.burstRemaining=0
    this.grenadeKind = kind
    this.heldGrenade.material.color.setHex(kind === 'frag' ? 0x68714a : 0x59c5ff)
    this.heldGrenade.material.emissive.setHex(kind === 'frag' ? 0 : 0x268dff)
    this.fireTime = -1; this.reloading = -1; this.throwTime = 0; this.throwRelease = false
    return true
  }
  consumeGrenadeThrow(): boolean { const release = this.throwRelease; this.throwRelease = false; return release }
  grenadePosition(target: THREE.Vector3): THREE.Vector3 {
    return this.authored ? this.authored.grenadePosition(target) : this.heldGrenade.getWorldPosition(target)
  }

  /**
   * A fresh spawn carries a full magazine and full reserve. Death is the only thing that calls
   * this: ammo is otherwise only ever spent or reloaded, never handed out.
   */
  refill(): void {
    this.slot.ammo = this.slot.spec.magazine
    this.slot.reserve = this.slot.spec.reserve
    this.authored?.setAmmo(this.slot.ammo)
    this.holster()
  }

  /** Keep one viewmodel per loadout slot; holstering never refills it or allocates new arms. */
  holster(): void {
    this.cancelCharge()
    this.burstRemaining=0
    this.shellCancel = false; this.pumpContact = false
    this.fireTime = this.reloading = this.meleeTime = this.throwTime = -1
    this.meleeImpact = this.throwRelease = false
    this.flashTime = this.recoil = this.cycle = 0
    this.kick.x = this.kick.v = this.kick.lx = this.kick.lv = this.kick.n = 0
    this.drawTime = this.lowerTime = -1
    this.update(0, 0, false)
  }
  /** Put the weapon away on screen: holstered at once for gameplay, drawn off the bottom over `SWITCH.lower`. */
  lower(): void {
    this.fill.visible = false
    this.holster()
    this.lowerTime = 0
    this.update(0, 0, false)
  }
  /** True while a lowered weapon is still visible leaving the screen. */
  get isLowering(): boolean { return this.lowerTime >= 0 }
  /** Bring the weapon up after a switch. Presentation only: it never gates the next shot. */
  draw(): void {
    this.fill.visible = true
    this.lowerTime = -1
    this.drawTime = 0
    this.igniteTime = this.isBlade ? 0 : -1
    this.update(0, 0, false)
  }
  updateHolstered(dt: number): void {
    // A weapon on its way off screen still needs its pose advanced; update() runs the cooldown.
    if (this.lowerTime >= 0) this.update(dt, 0, false)
    else this.cooldown = Math.max(0, this.cooldown - dt)
  }
  /** Whether this weapon's fill light is on; only the weapon in hand should be lit. */
  set lit(on: boolean) { this.fill.visible = on }
  activate(): void {
    this.fill.visible = true
    if (DEBUG_HOOKS) (window as unknown as Record<string, unknown>).__viewmodel = this.debug
  }

  consumeMeleeHit(): boolean {const hit=this.meleeImpact;this.meleeImpact=false;return hit}
  muzzlePosition(target=new THREE.Vector3()): THREE.Vector3 {
    if (this.authored) return this.authored.muzzlePosition(target, false)
    this.object.updateWorldMatrix(true,true)
    if(this.slot.id==='rocket-launcher') this.muzzle.position.x=this.slot.ammo%2===0?-.115:.115
    return this.muzzle.getWorldPosition(target)
  }

  /** Vertical kick applied to the camera, radians. */
  takeKick(): number {
    return this.recoil * 0.008
  }
}

const SCRATCH_LEFT = new THREE.Vector3()
const MUZZLE_AT=new THREE.Vector3(),MUZZLE_ALONG=new THREE.Vector3(),MUZZLE_DIR=new THREE.Vector3()
const SCRATCH_SCALE = new THREE.Vector3()
const SCRATCH_OFFSET = new THREE.Vector3()
const CAM_EULER = new THREE.Euler(), HAND_EULER = new THREE.Euler()
const CAM_TURN = new THREE.Quaternion(), HAND_TURN = new THREE.Quaternion()
