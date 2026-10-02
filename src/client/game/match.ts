import { DEBUG_HOOKS } from '../debug/build-flags.ts'
import { rayHitBody, type BodyHit } from '../../shared/hitboxes.ts'
import {ChargedPlasma} from './plasma-charge.ts'
import {chargedDamage,PLASMA_CHARGE} from '../../shared/plasma-charge.ts'
import {createWeaponPickups,nearestWeaponPickup,pickupHands,dualSlot,type WeaponPickup} from '../../shared/weapon-pickups.ts'
import {WeaponPickupView} from './weapon-pickups.ts'
import {isArena,arenaFloor,arenaCollision,arenaRayDistance} from '../../shared/arena.ts'
import {createArenaNavigation} from '../../shared/arena-navigation.ts'
import { modeSlots } from '../../shared/game-modes.ts'
import { GuardianBotNavigator } from './guardian-bot-navigation.ts'
import { createArenaRoutePlanner } from './arena-route-planner.ts'
import { accelerateStaticInstances } from '../render/instance-raycast.ts'
import { accelerateStaticMesh } from '../render/mesh-raycast.ts'
import { LockoutBotNavigator } from './lockout-bot-navigation.ts'
import { SpawnDirector } from '../../shared/spawns.ts'
import { CorpseCrouchContacts } from './corpse-crouch.ts'
import { NeedlerProjectiles } from './needler.ts'
import { NeedleStacks } from '../../shared/needles.ts'
import { guardianRay, guardianRayDistance, guardianFloor, type MapId } from '../../shared/guardian.ts'
import { Objectives, objectiveGoal, describeEvent, enemyOf, type Contender, type ObjectiveEvent, type ObjectiveItem } from '../../shared/objectives.ts'
import { CAUSE_SPLATTER, CAUSE_UNKNOWN, CAUSE_VEHICLE_GUN, KILL_HOLDING_BALL, KILL_HOLDING_FLAG, KILL_VICTIM_BOMB, KILL_VICTIM_FLAG, SPREE_FOR_KILLJOY, fromBehind, splashCause, type KillInfo } from '../../shared/kill-info.ts'
import type { GameModeId } from '../../shared/game-modes.ts'
import { ObjectiveView, objectiveColor, OBJECTIVE_TEAM_COLOR } from './objective-view.ts'
import { lockoutRay, lockoutRayDistance, lockoutFloor } from '../../shared/lockout.ts'
import { lockoutPatrolPoints } from '../../shared/lockout-navigation.ts'
import type {BulletImpact} from '../../shared/bullet-impact.ts'
import {vehicleCharacterImpulse} from '../../shared/vehicle-physics.ts'
import { resolveVehicleContacts } from '../../shared/vehicle-contacts.ts'
import { applyPlayerBlast, blastStrength } from '../../shared/blast-impulse.ts'
import * as THREE from 'three'
import { CombatEffects, corpseBulletStrength } from './combat-fx.ts'
import type { CombatAudio } from './combat-audio.ts'
import { SpartanFoley } from './spartan-foley.ts'
import { firstPersonShieldFlash, fadeFirstPersonShieldFlash, setSpartanFloor } from '../render/models/character.ts'
import { Rockets } from './rockets.ts'
import { ExplosionFx } from './explosion-fx.ts'
import { Grenades } from './grenades.ts'
import { botShotObstruction } from './bot-shot.ts'
import { grenadeMeshContact } from './grenade-world.ts'
import { lockoutMesh, lockoutCollision } from '../../shared/lockout-collision.ts'
import { guardianCollision } from '../../shared/guardian-collision.ts'
import { Vehicles } from './vehicles.ts'
import { Input } from './input.ts'
import { advanceOpticalZoom } from './scoped-aim.ts'
import { Player } from './player.ts'
import { HeldWeapon } from './weapon.ts'
import { MOVE, NET, VITALS } from '../../shared/constants.ts'
import { RED_BASE, BLUE_BASE, type Team } from '../../shared/map.ts'
import { groundHeight, rimFraction } from '../../shared/field.ts'
import { coverBlocksRay } from '../../shared/cover.ts'
import { LOADOUT, DEFAULT_SLOT, SHOTGUN, SPLASH, SPLASH_KINDS, WEAPON_WARTHOG, type SplashKind } from '../../shared/loadout.ts'
import type { PlayerInput } from '../../shared/movement.ts'
import type { VehicleCollider } from '../../shared/vehicle-collision.ts'
import { updateRagdolls, blastRagdolls, configureRagdollMap } from '../render/ragdolls.ts'
import type { PlayerState } from '../../shared/movement.ts'
import { beginSwordLunge, beginMeleeLunge, advanceSwordLunge, swordTargetInRange, type SwordLunge } from '../../shared/sword-lunge.ts'
import { WARTHOG_GUN_PIVOT, seatWorld, applyVehicleBlast, applyVehicleMelee, vehicleImpact, exitSpot, type Seat, type VehicleInput, type VehicleKind } from '../../shared/vehicle-sim.ts'
import {
  quantiseInput, BTN_JUMP, BTN_CROUCH, BTN_ALT, BTN_STOW_LEFT, BTN_CHARGE_RIGHT, BTN_CHARGE_LEFT, BTN_CANCEL_CHARGE, SHOT_CHARGED, SHOT_LEFT, BTN_FIRE, BTN_RELOAD, BTN_RELOAD_CANCEL, BTN_LUNGE, BTN_HORN, BTN_SWAP, BTN_MELEE, BTN_INTERACT, BTN_SEAT, BTN_PICKUP_LEFT, VEHICLE_HORN,
  FLAG_ON_GROUND, FLAG_CROUCHED, FLAG_DEAD, FLAG_BLUE, FLAG_IN_VEHICLE, SHOT_HIT, SHOT_SHIELD, SHOT_MELEE, HIT_KILLED, HIT_HEADSHOT, HIT_MELEE, HIT_BEHIND, HIT_KILLJOY,
  type WireInput, type WirePlayer, type Snapshot, type Shot, type Hit, type Death, type Explosion, type Launch,
} from '../../shared/protocol.ts'
import { defaultName } from '../../shared/protocol.ts'
import type { Connection } from '../net/connection.ts'
import { Prediction, VehiclePrediction } from '../net/prediction.ts'
import { RemoteBuffer, type RemotePose } from '../net/remote.ts'
import type { Vehicle } from './vehicles.ts'

/**
 * A match: one player you drive, other people to shoot, and the loop that advances them.
 *
 * Offline the others are bots and this class is the authority. Online the others are remote
 * players drawn from server snapshots, your own movement is predicted through the same `step`
 * the server runs and reconciled against what it sends back, and every consequence — damage,
 * death, respawn — comes from the server. The rendering, effects and weapon handling are the
 * same code in both modes; what differs is who decides.
 */

const STEP = 1 / NET.tickRate
/** Over-the-shoulder third-person camera, metres from the eye: behind along the aim, to the right, up. Puts the Spartan on the left
 * of the screen with the crosshair clear of it (Halo's own third-person views). */
const SHOULDER_CAM = (() => { const q = new URLSearchParams(location.search).get('shoulder')?.split(',').map(Number); return { back: q?.[0] ?? 1.7, side: q?.[1] ?? .7, up: q?.[2] ?? .12 } })()   // ?shoulder=back,side,up tunes it
/** Seconds between chirps of the low-shield alarm, measured from Halo 3 capture. */
const SHIELD_ALARM_INTERVAL = .19
/** Every remote player is one of these; `bots` holds them so the fight code sees one list. */
interface Remote { player: Player; buffer: RemoteBuffer; pose: RemotePose }

export interface ScoreRow {
  id: string
  name: string
  team: Team
  kills: number
  deaths: number
}

// A full local population exercises the rendering budget for the multiplayer target.
const requestedPlayers = Number(new URLSearchParams(location.search).get('players') ?? 12)
const BOT_COUNT = Math.max(1, Math.min(16, Number.isFinite(requestedPlayers) ? Math.floor(requestedPlayers) : 12)) - 1
/** `?enemies` (development builds): every bot on the other side, for testing hits without hunting for a target. */
const ALL_ENEMIES = DEBUG_HOOKS && new URLSearchParams(location.search).has('enemies')

export class Match {
  private readonly spawnDirector = new SpawnDirector()
  private readonly recordedDeaths = new Set<Player>()
  readonly effects: CombatEffects
  readonly rockets: Rockets
  readonly explosions: ExplosionFx
  readonly plasma: Rockets
  /** The Banshee's fuel rod: slow green shell, splash on impact. */
  readonly chopperRounds: Rockets
  private readonly remoteChopperRounds: Rockets | null
  readonly fuelRod: Rockets
  private fuelRodIn=0
  private plasmaSide=false
  readonly grenades: Grenades
  readonly vehicles: Vehicles
  private vehicleFireIn=0
  elapsedSeconds=0
  private shieldAlarmTimer=0
  private vehicleCameraKey=''
  private vehicleCameraHeight=0
  vehicleGunner=false
  /** Screen coordinates of the physical vehicle gun ray, including nearby cover. */
  readonly vehicleReticle = new THREE.Vector3(0, 0, 0)
  private readonly vehicleAimPoint = new THREE.Vector3()
  vehicleAimObstructed = false
  /**
   * What the player can do with what is in front of them, in the words of whatever they are
   * playing with: a phone has no E key to press, and telling it to is worse than saying nothing.
   */
  interactionHint(keys = true): string {
    const v = this.vehicles.occupied
    const key = (letter: string, what: string) => (keys ? `${letter} ${what}` : what)
    const held = !v && this.you.alive ? this.carrying : null
    if (held) return key('E', `drop ${held.kind}`)
    if (!v) {const pickup=this.nearestPickup();if(pickup)return `${LOADOUT[pickup.slot].spec.name} · ${key('E','right hand')}${dualSlot(this.slotIndex)?' · '+key('Q','left hand'):''}`}
    if (!v) return this.vehicles.nearest(this.you.object.position) ? key('E', 'enter vehicle') : ''
    const drive = v.kind === 'banshee'
      ? keys ? 'W/S throttle · Shift+W boost · Shift+A/D roll · Space+W/S flip · click cannons · right-click fuel rod' : 'BOOST with stick up · ZOOM fuel rod'
      : v.kind==='chopper'?keys?'W/S drive · mouse steer · Space boost · Shift brake · click cannons':'BOOST · FIRE cannons'
      : v.kind==='ghost'?keys?'W/S/A/D drive · mouse steer · hold Space boost · click cannons':'hold BOOST · FIRE cannons'
      : this.vehicleGunner&&v.kind==='mongoose'?(keys?'Passenger · click personal weapon · R reload':'Passenger · FIRE personal weapon · RELOAD')
      : v.kind==='mongoose'?keys?'W/S drive · mouse steer · Shift brake':'stick drives · thumb steers'
      : this.vehicleGunner
        ? keys ? 'Gunner · click fire' : 'Gunner · FIRE'
        : keys ? 'W/S drive · mouse steer · Shift brake · Space horn' : 'stick drives · thumb steers · HORN'
    const seat = v.kind === 'warthog'||v.kind==='mongoose' ? ` · ${key('T', 'change seat')}` : ''
    return `${v.kind} · ${key('E', 'exit')} · ${drive}${seat}`
  }
  private readonly corpseCrouches = new CorpseCrouchContacts()
  /** Footfalls by surface, landings, and Spartan pain/death vocals (spartan-foley.ts). */
  readonly foley: SpartanFoley
  readonly you: Player
  readonly bots: Player[] = []
  offhand: HeldWeapon|null=null
  private offhandSlot=-1
  private readonly leftWeapons=new Map<number,HeldWeapon>()
  readonly weaponPickups:WeaponPickup[]
  private readonly pickupView:WeaponPickupView
  weapon: HeldWeapon
  private slotIndex = 1
  /** Loadout slots this game type carries, in switching order; the first is the spawn weapon. */
  private readonly slots: number[]
  private readonly heldWeapons = new Map<number, HeldWeapon>()
  /** The weapon just switched away from, kept on the camera until it has dropped out of view. */
  private outgoing: HeldWeapon | null = null

  private readonly raycaster = new THREE.Raycaster()
  private readonly forward = new THREE.Vector3()
  private readonly eye = new THREE.Vector3()
  /** Extra pitch from recoil, decayed separately so it does not fight mouse aim. */
  private kick = 0
  private respawnIn = 0
  /** Death camera: seconds since we died, the eye it pulls out of, and the corpse it circles. */
  private deathCamTime = -1
  private deathCamDistance = 0
  private readonly deathCamFrom = new THREE.Vector3()
  private readonly deathCamFocus = new THREE.Vector3()
  private readonly botCombat = new Map<string, {target: Player | null; think: number; cooldown: number; rounds: number; yaw: number}>()
  private readonly respawns = new Map<Player, number>()
  private readonly sightRay = new THREE.Raycaster()
  private readonly cover: THREE.Object3D[] = []
  /** The view shown this frame: third person when chosen (T) and not looking through a scope. */
  private thirdPerson = false
  /** Third person as the player chose it: zooming shows the scope in first person and zooming out returns to this. */
  private thirdPersonChosen = false
  /** How far out the shoulder camera sits, 0..1 of the SHOULDER_CAM offset: to the shoulder, then back from it. Walls pull it in at once,
   * it eases back out. */
  private shoulderSide = 1
  private shoulderBack = 1
  private swordLunge: SwordLunge | null = null
  private readonly runoverCooldown = new Map<string, number>()
  private readonly heardVehicleImpacts=new Map<number,number>()
  private readonly heardVehicleHorns=new Map<number,boolean>()
  private readonly corpseVehiclePositions = new Map<number, {x:number;y:number;z:number}>()
  private zoomIndex = -1
  get zoom(): number { return this.weapon.slot.spec.zoom?.[this.zoomIndex] ?? 1 }

  /** The game type: scores, flags, ball, bomb. Offline this is the authority; online a mirror. */
  readonly objectives: Objectives
  readonly objectiveView: ObjectiveView
  /** Something happened to an objective. The HUD turns it into a banner. */
  onObjective?: (event: ObjectiveEvent, text: string) => void
  /** Wire-style ids: the server's online, 1 for you and 2.. for bots offline. */
  private readonly numbers = new Map<Player, number>()
  private readonly contenders: Contender[] = []

  /** Your own hits only. On a kill, `info` says how it was done, for the medals. */
  onHit?: (target: Player, killed: boolean, info?: KillInfo) => void
  /** Every objective event, for the medals (onObjective belongs to the objective HUD). */
  onObjectiveMedal?: (event: ObjectiveEvent) => void
  onFire?: () => void
  /** A line for the kill feed. Online these come from the server, so everyone's kills show. */
  onFeed?: (line: string) => void

  // ---- online only
  private readonly prediction = new Prediction()
  private receivedFirstSpawn = false
  private readonly remotes = new Map<number, Remote>()
  /** Other people's rockets and grenades: they fly here for the look of it and hurt nobody. */
  private readonly remoteRockets: Rockets | null
  private readonly remoteGrenades: Grenades | null
  private readonly remoteBolts: Rockets | null
  private readonly remoteFuelRods: Rockets | null
  /** Prediction for the vehicle we are driving, if any. */
  private vehiclePrediction: VehiclePrediction | null = null
  /** The seat the server has us in, or null on foot. Transitions drive enter and exit here. */
  private serverSeat: { vehicle: Vehicle; seat: Seat } | null = null
  /** What everyone in the match is called, as the server last told us. */
  private readonly names = new Map<number, string>()
  /** Score totals are driven by the same death events that drive the kill feed. */
  private readonly scoreTotals = new Map<string, { kills: number; deaths: number }>()
  /** Kills since each player last died: ending one of five or more is a Killjoy. */
  private readonly sprees = new Map<Player, number>()
  /** Edge-triggered buttons pressed since the last simulation step, folded into the next frame. */
  private buttons = 0
  /** Where the camera pointed when the trigger was pulled, so the server fires the shot you saw. */
  private shotYaw = 0
  private shotPitch = 0
  private stepAccumulator = 0
  get playerCount(): number { return this.bots.length + 1 }
  get status(): string {
    if (!this.net) return 'offline · bots'
    return `online · ${Math.round(this.net.rtt)} ms · ${this.playerCount}/${this.net.maxPlayers} players`
  }

  private readonly chargedPlasma:ChargedPlasma
  private readonly needles: NeedlerProjectiles
  private readonly needleStacks=new NeedleStacks()

  constructor(
    private readonly scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
    readonly input: Input,
    readonly net: Connection | null = null,
    readonly map: MapId = 'blood-gulch',
    audio?: CombatAudio,
    readonly mode: GameModeId = 'slayer',
  ) {
    this.objectives = new Objectives(mode, map, (x, y, z) =>
      isArena(map) ? arenaFloor(map, x, z, y) : map === 'guardian' ? guardianFloor(x, z, y) : map === 'lockout' ? lockoutFloor(x, z, y) : groundHeight(x, z))
    this.arenaNavigation=isArena(map)?new GuardianBotNavigator(createArenaNavigation(map),createArenaRoutePlanner(map)):null
    // Feet are planted with one straight-down ray each (the movement floors probe a whole footprint), which also gives the slope to lay
    // the boot on; the heightfield's slope comes from its neighbours.
    const footRay = (c: {mesh: {raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, t: number): {t: number; nx: number; ny: number; nz: number} | null}; voidFloor: number}) =>
      (x: number, z: number, y: number, n?: THREE.Vector3) => { const hit = c.mesh.raycast(x, y, z, 0, -1, 0, y - c.voidFloor); if (!hit) return c.voidFloor; n?.set(hit.nx, hit.ny, hit.nz); return y - hit.t }
    setSpartanFloor(isArena(map) ? footRay(arenaCollision(map)) : map === 'guardian' ? footRay(guardianCollision()) : map === 'lockout' ? footRay(lockoutCollision())
      : (x, z, _y, n) => { const h = groundHeight(x, z); n?.set(groundHeight(x - .3, z) - groundHeight(x + .3, z), .6, groundHeight(x, z - .3) - groundHeight(x, z + .3)).normalize(); return h })
    configureRagdollMap(this.map)
    this.effects = new CombatEffects(scene, audio)
    this.foley = new SpartanFoley(this.effects, map, scene)
    // Needles home on whoever is hostile to the player who fired them; the "team" key is the owner.
    this.needles=new NeedlerProjectiles(scene,ownerId=>{const everyone=[this.you,...this.bots],owner=everyone.find(p=>p?.id===ownerId)
      return owner?everyone.filter(p=>p&&p.alive&&this.hostile(owner,p)).map(p=>({id:p.id,x:p.state.x,y:p.state.y+1,z:p.state.z})):[]},
      (a,b)=>!!this.sweep(new THREE.Vector3(a.x,a.y,a.z),new THREE.Vector3(b.x,b.y,b.z),false),
      (id,owner,point)=>{
        if(this.net)return
        const target=[this.you,...this.bots].find(p=>p.id===id);if(!target?.alive)return
        const hit=this.needleStacks.hit(`${owner}:${id}`,performance.now()/1000),killed=target.damage(hit.damage)
        this.effects.impact(point,target.shield>0);if(hit.combined){this.effects.shockwave(point,0xff63df);this.effects.sound('supercombine',.8)}
        const shooter=[this.you,...this.bots].find(p=>p.id===owner)??this.you
        this.reportHit(shooter,target,killed,LOADOUT.findIndex(s=>s.model==='needler'));if(killed){this.respawns.set(target,3);this.effects.death(1)}
      })
    this.chargedPlasma=new ChargedPlasma(scene,ownerId=>{const all=[this.you,...this.bots],owner=all.find(p=>p?.id===ownerId);return owner?all.filter(p=>p&&p.alive&&this.hostile(owner,p)).map(p=>({id:p.id,x:p.state.x,y:p.state.y+1,z:p.state.z})):[]},
      (a,b)=>!!this.sweep(a,b,false),(id,ownerId,point)=>{
        if(this.net)return
        const target=[this.you,...this.bots].find(p=>p.id===id),owner=[this.you,...this.bots].find(p=>p.id===ownerId)
        if(!target?.alive||!owner)return
        const shield=target.shield>0,killed=target.damage(chargedDamage(target.shield));this.effects.impact(point,shield);this.effects.sound('plasma-pistol:charged-hit',.7)
        this.reportHit(owner,target,killed,LOADOUT.findIndex(s=>s.model==='plasma-pistol'));if(killed){this.respawns.set(target,3);this.effects.death(1)}
      })
    // Spawn out in front of the base looking down the canyon, not pressed against its wall.
    // Visible, and built first-person: you can look down and see your own armour and legs, which
    // is a large part of why Halo feels like standing in a body rather than floating behind a gun.
    const team: Team = net?.team ?? 'red'
    const home = team === 'red' ? RED_BASE : BLUE_BASE
    this.objectiveView = new ObjectiveView(scene, this.objectives, camera)
    const out = team === 'red' ? 1 : -1
    this.you = new Player('you', team, home.x + 4 * out, home.z + 34 * out, true, true)
    if (this.objectives.spec.shields === false) this.you.maxShield = this.you.shield = 0
    scene.traverse(o => {
      if (o.name === 'guardian-solids' || o.name === 'bases' || o.name.startsWith('boulders-')) {
        this.cover.push(o)
        if ((o as THREE.InstancedMesh).isInstancedMesh) accelerateStaticInstances(o as THREE.InstancedMesh)
        else o.traverse(child => { if ((child as THREE.Mesh).isMesh) accelerateStaticMesh(child as THREE.Mesh) })
      }
    })
    scene.add(this.you.object)
    // Online you are whatever the server calls you; see numberOf. Offline you are player 1.
    if (!net) this.numbers.set(this.you, 1)
    this.explosions=new ExplosionFx(scene)
    this.rockets=new Rockets(scene,(a,b)=>this.sweep(a,b,true),p=>this.explode(p,300,6,'rocket'))
    this.plasma=new Rockets(scene,(a,b)=>this.sweep(a,b,true),p=>this.explode(p,SPLASH.bolt.damage,SPLASH.bolt.radius,'bolt'),0x66ddff,false,1.9)
    this.chopperRounds=new Rockets(scene,(a,b)=>this.sweep(a,b,true),p=>this.explode(p,SPLASH.chopper.damage,SPLASH.chopper.radius,'chopper'),0xffaa55,false)
    this.fuelRod=new Rockets(scene,(a,b)=>this.sweep(a,b,true),p=>this.explode(p,SPLASH.fuelrod.damage,SPLASH.fuelrod.radius,'fuelrod'),0x8cff4a,false,3.2)
    const grenadeContact = (a:THREE.Vector3,b:THREE.Vector3)=>grenadeMeshContact(isArena(this.map)?arenaCollision(this.map).mesh:this.map==='lockout'?lockoutMesh():guardianCollision().mesh,a,b)
    const grenadeImpact = (point:THREE.Vector3,kind:'frag'|'plasma',speed:number,terrain:boolean) => {
      const distance=point.distanceTo(this.camera.position)
      if(distance>40)return
      const side=(point.x-this.camera.position.x)*Math.cos(this.input.yaw)-(point.z-this.camera.position.z)*Math.sin(this.input.yaw)
      const volume=Math.min(1,speed/8)*.8/(1+distance*.16)
      this.effects.sound(`grenade-bounce:${kind}:${terrain&&kind==='frag'?'dirt':'stone'}`,volume,Math.max(-1,Math.min(1,side/Math.max(2,distance))))
    }
    this.grenades=new Grenades(scene,()=>[...this.bots,...[...this.remotes.values()].map(remote=>remote.player)],(a,b)=>this.sweep(a,b,false),(p,kind,stuck)=>this.explode(p,160,5,kind,stuck),()=>this.vehicles.all,grenadeContact,grenadeImpact)
    this.grenades.fx=this.explosions
    this.vehicles=new Vehicles(scene, this.map === 'blood-gulch')
    if (!this.placeSpawn(this.you, false)) throw new Error('No free player spawn anchor')
    this.slots = modeSlots(this.objectives.spec, LOADOUT, DEFAULT_SLOT)
    this.weaponPickups=createWeaponPickups(this.map,this.slots)
    this.pickupView=new WeaponPickupView(scene,this.weaponPickups)
    if(net)net.onArsenal=state=>{
      this.weaponPickups.splice(0,this.weaponPickups.length,...state.pickups)
      if(state.player===net.id){
        this.applyPickupHands(state.primary,state.offhand,state.pickedHand,state.leftAmmo)
      }
    }
    this.slotIndex = this.slots[0]
    this.weapon = new HeldWeapon(LOADOUT[this.slotIndex].model, LOADOUT[this.slotIndex].specKey, team)
    this.heldWeapons.set(this.slotIndex, this.weapon)
    camera.add(this.weapon.object)
    scene.add(camera)

    if (net) {
      this.remoteRockets = new Rockets(scene, (a, b) => this.sweep(a, b, true), () => { /* the server says where it went off */ })
      this.remoteGrenades = new Grenades(scene, () => [this.you, ...[...this.remotes.values()].map(remote => remote.player)], (a, b) => this.sweep(a, b, false), () => { /* likewise */ },()=>this.vehicles.all,grenadeContact,grenadeImpact)
      this.remoteGrenades.fx = this.explosions
      this.remoteChopperRounds = new Rockets(scene,(a,b)=>this.sweep(a,b,true),()=>{},0xffaa55,false)
      this.remoteBolts = new Rockets(scene, (a, b) => this.sweep(a, b, true), () => {}, 0x66ddff, false, 1.9)
      this.remoteFuelRods = new Rockets(scene, (a, b) => this.sweep(a, b, true), () => {}, 0x8cff4a, false, 3.2)
      this.attachNet(net)
    } else {
      this.remoteRockets = null
      this.remoteGrenades = null
      this.remoteChopperRounds = null
      this.remoteBolts = null
      this.remoteFuelRods = null
      for (let i = 0; i < BOT_COUNT; i++) {
        // Free for all: one colour, and hostility goes by player rather than by side.
        const botTeam: Team = !this.objectives.spec.teams ? 'red'
          : ALL_ENEMIES ? (this.you.team === 'blue' ? 'red' : 'blue')
          : i % 2 === 0 ? 'blue' : 'red'
        const anchor = botTeam === 'blue' ? BLUE_BASE : RED_BASE
        const side = botTeam === 'blue' ? -1 : 1
        const bot = new Player(`bot${i}`, botTeam, anchor.x + (i - 2) * 9, anchor.z + side * (18 + i * 6))
        if (this.objectives.spec.shields === false) bot.maxShield = bot.shield = 0
        this.numbers.set(bot, i + 2)
        if (!this.placeSpawn(bot, false)) throw new Error('No free bot spawn anchor')
        this.bots.push(bot)
        scene.add(bot.object)
      }
    }
  }

  // ------------------------------------------------------------------ network

  private attachNet(net: Connection): void {
    net.onSnapshot = (snap) => this.onSnapshot(snap)
    net.onShot = (shot) => this.onRemoteShot(shot)
    net.onHit = (hit) => this.onServerHit(hit)
    net.onDeath = (death) => this.onDeath(death)
    net.onExplosion = (e) => this.onExplosion(e)
    net.onLaunch = (l) => this.onLaunch(l)
    net.onRoster = (entries) => {
      this.names.clear()
      for (const e of entries) this.names.set(e.id, e.name)
    }
    net.onScoreboard = (entries) => {
      this.scoreTotals.clear()
      for (const e of entries) this.scoreTotals.set(String(e.id), { kills: e.kills, deaths: e.deaths })
    }
    net.onObjective = (buf) => this.objectives.apply(buf)
    net.onObjectiveEvent = (e) => this.announce([e])
  }

  // ------------------------------------------------------------------ game type

  /** The id the rules know a player by. */
  numberOf(p: Player): number {
    if (this.net && p === this.you) return this.net.id
    return this.numbers.get(p) ?? 0
  }

  /** Whether `b` is someone `a` should be shooting: the other team, or anyone at all in free for all. */
  hostile(a: Player, b: Player): boolean {
    return this.objectives.hostile({ id: this.numberOf(a), team: a.team }, { id: this.numberOf(b), team: b.team })
  }

  /** What the first-person pass draws: the gun, or the objective you are carrying. */
  get viewmodel(): THREE.Object3D {
    return this.objectiveView.held.visible ? this.objectiveView.held : this.weapon.object
  }

  /**
   * Where the HUD should point, and what to call it from where you stand: your flag is DEFEND
   * at home and RETURN on the ground, theirs is CAPTURE until a teammate has it to ESCORT.
   */
  waypoints(): { x: number; y: number; z: number; label: string; color: number }[] {
    const o = this.objectives, out: { x: number; y: number; z: number; label: string; color: number }[] = []
    if (!o.items.length || o.over) return out
    const me = this.numberOf(this.you), team = this.you.team, mine = this.carrying
    const push = (p: { x: number; y: number; z: number }, label: string, color: number, lift = 2.6) =>
      out.push({ x: p.x, y: p.y + lift, z: p.z, label, color })
    for (const item of o.items) {
      if (item.state === 'carried' && item.carrier === me) continue
      const carrier = this.carrierOf(item)
      const friendly = !!carrier && !this.hostile(this.you, carrier)
      let label: string
      // Carrying theirs, your own stand is marked SCORE below; do not stack DEFEND on it.
      if (item.kind === 'flag' && item.team === team && item.state === 'home' && mine?.kind === 'flag') continue
      if (item.kind === 'flag') {
        label = item.team === team
          ? item.state === 'home' ? 'DEFEND' : item.state === 'dropped' ? 'RETURN' : 'FLAG CARRIER'
          : item.state === 'carried' ? friendly ? 'ESCORT' : 'FLAG' : 'CAPTURE'
      } else if (item.kind === 'ball') label = carrier ? friendly ? 'ESCORT' : 'BALL CARRIER' : 'BALL'
      else label = carrier ? friendly ? 'ESCORT' : 'BOMB CARRIER' : 'BOMB'
      push(carrier ? carrier.object.position : item, label, objectiveColor(item))
    }
    if (mine?.kind === 'flag') { const z = o.zone('stand', team); if (z) push(z, 'SCORE', OBJECTIVE_TEAM_COLOR[team], 1) }
    if (mine?.kind === 'bomb') { const z = o.zone('plate', enemyOf(team)); if (z) push(z, 'PLANT', OBJECTIVE_TEAM_COLOR[enemyOf(team)], 1) }
    else if (o.mode === 'assault') {
      const bomb = o.items[0], carrier = this.carrierOf(bomb)
      if (carrier && this.hostile(this.you, carrier)) { const z = o.zone('plate', team); if (z) push(z, 'DEFEND', OBJECTIVE_TEAM_COLOR[team], 1) }
    }
    return out
  }

  /** What you are holding: a flag, the ball, the bomb, or nothing. */
  get carrying(): ObjectiveItem | null {
    return this.objectives.carried(this.numberOf(this.you))
  }

  /** Who is carrying `item`, as a player in this scene. */
  carrierOf(item: ObjectiveItem): Player | null {
    if (item.state !== 'carried') return null
    if (item.carrier === this.numberOf(this.you)) return this.you
    for (const [p, n] of this.numbers) if (n === item.carrier) return p
    return null
  }

  private nameOfNumber(id: number): string {
    if (this.net) return this.nameOf(id)
    if (id === 1) return 'you'
    for (const [p, n] of this.numbers) if (n === id) return p.id
    return defaultName(id)
  }

  private contenderList(): Contender[] {
    const list = this.contenders
    let i = 0
    for (const p of [this.you, ...this.bots]) {
      const entry = list[i] ??= { id: 0, team: 'red', x: 0, y: 0, z: 0, alive: false, seated: false }
      entry.id = this.numberOf(p); entry.team = p.team; entry.x = p.state.x; entry.y = p.state.y; entry.z = p.state.z
      entry.alive = p.alive; entry.seated = p === this.you && !!this.vehicles.occupied
      i++
    }
    list.length = i
    return list
  }

  /** Feed lines, the HUD banner, and a new game's clean slate. */
  private announce(events: readonly ObjectiveEvent[]): void {
    for (const e of events) {
      const text = describeEvent(e, id => this.nameOfNumber(id))
      if (e.kind === 'restart' && !this.net) { this.scoreTotals.clear(); for (const p of [this.you, ...this.bots]) { p.kills = 0; p.deaths = 0 } }
      if (e.kind !== 'restart') this.onFeed?.(text)
      this.onObjective?.(e, text)
      this.onObjectiveMedal?.(e)
      const plate = e.kind === 'detonated' && e.team ? this.objectives.zone('plate', e.team === 'red' ? 'blue' : 'red') : undefined
      if (plate) {
        // The plant goes off where it was armed. Scenery only: the score is the damage.
        const point = new THREE.Vector3(plate.x, plate.y + .4, plate.z)
        this.explosions.explode(point, 'rocket', new THREE.Vector3(0, 1, 0))
        this.effects.sound('explosion', 1 / (1 + point.distanceTo(this.you.object.position) * .02))
      }
    }
  }

  /** Rows for the compact HUD strip and the Tab scoreboard. */
  scoreboard(): ScoreRow[] {
    const rows: ScoreRow[] = []
    const add = (key: string, name: string, team: Team, player?: Player) => {
      const totals = this.scoreTotals.get(key) ?? { kills: player?.kills ?? 0, deaths: player?.deaths ?? 0 }
      rows.push({ id: key, name, team, kills: totals.kills, deaths: totals.deaths })
    }
    if (this.net) {
      add(String(this.net.id), 'you', this.you.team, this.you)
      for (const [id, remote] of this.remotes) add(String(id), this.nameOf(id), remote.player.team, remote.player)
    } else {
      add(this.you.id, 'you', this.you.team, this.you)
      for (const bot of this.bots) add(bot.id, bot.id, bot.team, bot)
    }
    return rows
  }

  private recordScore(killer: Player | null, victim: Player): void {
    if (!this.net) this.announce(this.objectives.onKill(killer ? { id: this.numberOf(killer), team: killer.team } : null, { id: this.numberOf(victim), team: victim.team }))
    const victimKey = this.scoreKey(victim)
    const victimTotals = this.scoreTotals.get(victimKey) ?? { kills: 0, deaths: 0 }
    victimTotals.deaths++
    this.scoreTotals.set(victimKey, victimTotals)
    this.sprees.set(victim, 0)
    if (!killer || killer === victim) return
    this.sprees.set(killer, (this.sprees.get(killer) ?? 0) + 1)
    const killerKey = this.scoreKey(killer)
    const killerTotals = this.scoreTotals.get(killerKey) ?? { kills: 0, deaths: 0 }
    killerTotals.kills++
    this.scoreTotals.set(killerKey, killerTotals)
  }

  private scoreKey(player: Player): string {
    if (this.net) {
      if (player === this.you) return String(this.net.id)
      for (const [id, remote] of this.remotes) if (remote.player === player) return String(id)
    }
    return player.id
  }

  /**
   * A hit landed offline. Hit markers and medals are only for your own: a bot's kill just scores.
   * `cause` is the loadout slot or a kill-info CAUSE_; `flags` the protocol HIT_ bits the server
   * would send online. Called before the score, so the victim's spree and flag are still theirs.
   */
  private reportHit(attacker: Player, target: Player, killed: boolean, cause = CAUSE_UNKNOWN, flags = 0): void {
    if (attacker === this.you) this.onHit?.(target, killed, killed ? this.killInfo(target, cause, flags) : undefined)
    if (killed && !this.net) this.recordScore(attacker, target)
  }

  private killInfo(victim: Player, cause: number, flags: number): KillInfo {
    if ((this.sprees.get(victim) ?? 0) >= SPREE_FOR_KILLJOY) flags |= HIT_KILLJOY
    const lost = this.objectives.carried(this.numberOf(victim))?.kind, held = this.objectives.carried(this.numberOf(this.you))?.kind
    const context = (lost === 'flag' ? KILL_VICTIM_FLAG : 0) | (lost === 'bomb' ? KILL_VICTIM_BOMB : 0)
      | (held === 'flag' ? KILL_HOLDING_FLAG : 0) | (held === 'ball' ? KILL_HOLDING_BALL : 0)
    return { cause, flags, context }
  }

  /** Every opponent down, `victim` included, and a full side of four or more: an Extermination. */
  enemyTeamWipedOut(victim: Player): boolean {
    if (!this.objectives.spec.teams) return false
    const enemies = (this.net ? [...this.remotes.values()].map(remote => remote.player) : this.bots).filter(p => this.hostile(this.you, p))
    return enemies.length >= 4 && enemies.every(p => p === victim || !p.alive)
  }

  /** Choose the name other players see. Takes effect when the server echoes the roster back. */
  setName(name: string): void {
    this.net?.setName(name)
  }

  /** Both offline bots and the online roster use the same overhead labels. */
  nameplatePlayers(): { name: string; player: Player }[] {
    const out: { name: string; player: Player }[] = []
    if (this.net) {
      for (const [id, remote] of this.remotes) out.push({ name: this.nameOf(id), player: remote.player })
    } else for (const player of this.bots) out.push({ name: player.id, player })
    return out
  }

  /** Test the body, not the floating label, so cover never reveals an enemy's name. */
  nameplateVisible(point: THREE.Vector3): boolean {
    return !this.sweep(this.camera.position, point, false)
  }

  nameOf(id: number): string {
    if (this.net && id === this.net.id) return 'you'
    return this.names.get(id) ?? defaultName(id)
  }

  private onSnapshot(snap: Snapshot): void {
    const net = this.net!
    const now = performance.now()
    const seen = new Set<number>()
    for (const p of snap.players) {
      if (p.id === net.id) { this.onSelf(p, snap); continue }
      seen.add(p.id)
      let remote = this.remotes.get(p.id)
      if (!remote) remote = this.addRemote(p)
      remote.buffer.push(now, p)
      remote.player.state.map=this.map
      remote.player.setWeaponModel(LOADOUT[p.weapon]?.model ?? 'assault-rifle')
      remote.player.setOffhandModel(p.offhand!==undefined&&p.offhand>=0?LOADOUT[p.offhand]?.model??null:null)
      const shield = (p.shield / 255) * VITALS.shield
      const health = (p.flags & FLAG_DEAD) ? 0 : (p.health / 255) * VITALS.health
      remote.player.applyVitals(shield, health)
    }
    for (const [id, remote] of this.remotes) {
      if (seen.has(id)) continue
      this.scene.remove(remote.player.object)
      this.remotes.delete(id)
      this.numbers.delete(remote.player)
      const i = this.bots.indexOf(remote.player)
      if (i >= 0) this.bots.splice(i, 1)
    }

    let mySeat: { vehicle: Vehicle; seat: Seat } | null = null
    for (const w of snap.vehicles) {
      const v = this.vehicles.byId(w.id)
      if (!v) continue
      if (w.driver === net.id) mySeat = { vehicle: v, seat: 'driver' }
      else if (w.gunner === net.id) mySeat = { vehicle: v, seat: 'gunner' }
      if (w.driver === net.id) {
        // Ours to predict: reconcile rather than interpolate.
        v.driver = w.driver; v.gunner = w.gunner
        if (snap.selfVehicle && this.vehiclePrediction) this.vehiclePrediction.reconcile(v.state, snap.selfVehicle, snap.ackSeq)
      } else {
        v.buffer.push(now, w)
      }
    }
    this.syncSeat(mySeat, snap)
  }

  /** The server's word on where we sit. Climbing in and out happens here, not on the key press. */
  private syncSeat(seat: { vehicle: Vehicle; seat: Seat } | null, snap: Snapshot): void {
    const before = this.serverSeat
    this.serverSeat = seat
    if (!before && seat) {
      this.weapon.holster()
      this.vehicles.enter(seat.vehicle, this.you.object.position)
      this.vehicleGunner = seat.seat === 'gunner'
      this.vehiclePrediction = seat.seat === 'driver' ? new VehiclePrediction(seat.vehicle.kind) : null
      this.zoomIndex = -1
      this.prediction.forget()
    } else if (before && !seat) {
      this.vehicles.occupied = null
      this.vehicleGunner = false
      this.vehiclePrediction = null
      this.weapon.object.visible = true
      this.you.object.visible = true
      if (snap.self) this.you.place(snap.self.x, snap.self.y, snap.self.z)
      this.prediction.forget()
    } else if (before && seat && (before.vehicle !== seat.vehicle || before.seat !== seat.seat)) {
      if (before.vehicle !== seat.vehicle) this.vehicles.enter(seat.vehicle, this.you.object.position)
      this.vehicleGunner = seat.seat === 'gunner'
      this.vehiclePrediction = seat.seat === 'driver' ? new VehiclePrediction(seat.vehicle.kind) : null
    }
  }

  private addRemote(p: WirePlayer): Remote {
    const team: Team = p.flags & FLAG_BLUE ? 'blue' : 'red'
    const player = new Player(`Spartan ${p.id}`, team, p.x, p.z)
    player.place(p.x, p.y, p.z)
    this.scene.add(player.object)
    this.bots.push(player)
    this.numbers.set(player, p.id)
    const remote: Remote = {
      player,
      buffer: new RemoteBuffer(),
      pose: { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, flags: p.flags, gait: { phase: 0, backward: false }, interpolated: false },
    }
    this.remotes.set(p.id, remote)
    return remote
  }

  /** Our own entry in the snapshot: vitals from the server, then movement reconciled. */
  private onSelf(p: WirePlayer, snap: Snapshot): void {
    const wasAlive = this.you.alive
    const serverAlive = (p.flags & FLAG_DEAD) === 0
    if (!wasAlive && serverAlive && snap.self) {
      // The server brought us back. Take its spawn and start clean.
      this.you.respawn(snap.self.x, snap.self.z)
      this.you.place(snap.self.x, snap.self.y, snap.self.z)
      for (const held of this.heldWeapons.values()) held.refill()
      this.grenades.refill()
      this.selectSlot(this.slots[0], false)
      this.zoomIndex = -1
      this.input.yaw = p.yaw
      this.input.pitch = p.pitch
      this.prediction.forget()
      this.buttons = 0
    }
    if (!this.receivedFirstSpawn && serverAlive && snap.self) {
      this.receivedFirstSpawn = true
      this.input.yaw = p.yaw
      this.input.pitch = p.pitch
    }
    const shield = (p.shield / 255) * VITALS.shield
    const health = serverAlive ? Math.max(0.01, (p.health / 255) * VITALS.health) : 0
    if(!serverAlive&&snap.self){this.you.state.vx=snap.self.vx;this.you.state.vy=snap.self.vy;this.you.state.vz=snap.self.vz}
    const hurt = this.you.applyVitals(shield, health)
    if (hurt && this.you.alive) { if(!['sniper','battle-rifle'].includes(this.weapon.slot.id))this.zoomIndex = -1; this.effects.sound('hit', 0.4); this.kick += 0.006 }
    if (wasAlive && !this.you.alive) this.effects.death(0)
    if (snap.self && this.you.alive && !(p.flags & FLAG_IN_VEHICLE)) this.prediction.reconcile(this.you.state, snap.self, snap.ackSeq)
  }

  private onRemoteShot(shot: Shot): void {
    if(shot.flags&SHOT_CHARGED){
      const point=new THREE.Vector3(shot.end.x,shot.end.y,shot.end.z)
      if(shot.flags&SHOT_HIT){this.effects.impact(point,true);this.effects.sound('plasma-pistol:charged-hit',.6);return}
      if(shot.shooter===this.net!.id)return
      const remote=this.remotes.get(shot.shooter)?.player;if(!remote)return
      // from their pistol's muzzle (it was their eye), toward where the server says it went
      const from=remote.muzzlePosition(new THREE.Vector3(),!!(shot.flags&SHOT_LEFT))
      this.chargedPlasma.launch(from,point.sub(from).normalize(),remote.id);this.effects.sound('plasma-pistol:charged',.5);return
    }

    if(LOADOUT[shot.weapon]?.model==='needler' && shot.flags&SHOT_HIT && !(shot.flags&SHOT_MELEE)){
      const p=new THREE.Vector3(shot.end.x,shot.end.y,shot.end.z);this.effects.impact(p,true);if(shot.flags&16){this.effects.shockwave(p,0xff63df);this.effects.sound('supercombine',.8)};return
    }
    if (shot.shooter === this.net!.id) return
    const remote = this.remotes.get(shot.shooter)
    if (!remote) return
    const shooter = remote.player
    const end = new THREE.Vector3(shot.end.x, shot.end.y, shot.end.z)
    // Before the weapon branches below: a swing carries the attacker's slot, so a melee with a
    // needler or a hammer out would otherwise be read as a needle or a slam. A swing also
    // carries nothing like a rifle report, so it falls off far faster than gunfire does.
    if (shot.flags & SHOT_MELEE) {
      const model = LOADOUT[shot.weapon]?.model ?? 'assault-rifle'
      const distance = Math.hypot(shooter.state.x - this.you.state.x, shooter.state.z - this.you.state.z)
      const sideways = (shooter.state.x - this.you.state.x) * Math.cos(this.input.yaw) - (shooter.state.z - this.you.state.z) * Math.sin(this.input.yaw)
      const level = .85 / (1 + distance * .3), pan = sideways / Math.max(5, distance)
      shooter.fire(false,false)
      // the swing arrives at contact: play the back half of the strike on their body (third person)
      shooter.action('melee', .45)
      this.effects.sound(`melee:${model}`, level, pan)
      if (shot.flags & SHOT_HIT) {
        this.effects.impact(end, (shot.flags & SHOT_SHIELD) !== 0, 'body')
        this.effects.sound(`melee-impact:${model}`, level, pan)
      }
      return
    }
    if(LOADOUT[shot.weapon]?.model==='needler'){const left=!!(shot.flags&SHOT_LEFT),muzzle=shooter.muzzlePosition(new THREE.Vector3(),left);shooter.fire(left);this.needles.launch(muzzle,end.clone().sub(muzzle).normalize(),shooter.id,shooter.id);this.effects.sound('needler',.4);return}
    if(LOADOUT[shot.weapon]?.model==='gravity-hammer'){shooter.fire();shooter.action('melee',.45);this.effects.shockwave(end);this.effects.sound('gravity-hammer',.6);return}
    const listenerDistance = Math.hypot(shooter.state.x - this.you.state.x, shooter.state.z - this.you.state.z)
    const relativeX = (shooter.state.x - this.you.state.x) * Math.cos(this.input.yaw) - (shooter.state.z - this.you.state.z) * Math.sin(this.input.yaw)
    const volume = 0.6 / (1 + listenerDistance * .08), pan = relativeX / Math.max(5, listenerDistance)
    if (shot.weapon === WEAPON_WARTHOG) {
      // The chain gun: from the barrels of whichever Warthog they are standing on.
      const v = this.vehicles.all.find(v => v.gunner === shot.shooter)
      const start = v?.model ? this.vehicles.muzzlePosition(v, false, new THREE.Vector3()) : shooter.eye()
      this.effects.shot(start, end, 'warthog', volume, pan,!(shot.flags&SHOT_HIT))
    } else {
      shooter.fire(!!(shot.flags&SHOT_LEFT))
      const muzzle = shooter.muzzlePosition(new THREE.Vector3(),!!(shot.flags&SHOT_LEFT))
      this.effects.shot(muzzle, end, LOADOUT[shot.weapon]?.model ?? 'assault-rifle', volume, pan,!(shot.flags&SHOT_HIT))
    }
    if (shot.flags & SHOT_HIT) this.effects.impact(end, (shot.flags & SHOT_SHIELD) !== 0, 'body',LOADOUT[shot.weapon]?.model)
  }

  private onServerHit(hit: Hit): void {
    const target = this.remotes.get(hit.target)?.player
    if (!target) return
    const killed = (hit.flags & HIT_KILLED) !== 0
    this.onHit?.(target, killed, killed ? { cause: hit.cause ?? CAUSE_UNKNOWN, flags: hit.flags, context: hit.context ?? 0 } : undefined)
    if (this.weapon.isMeleeing) this.effects.sound(`melee-impact:${this.weapon.slot.id}`, .85)
    if (killed) this.effects.death(Math.hypot(target.state.x - this.you.state.x, target.state.z - this.you.state.z))
  }

  private onDeath(death: Death): void {
    if(death.impact){
      const player=death.victim===this.net?.id?this.you:this.remotes.get(death.victim)?.player
      player?.receiveDeathImpact(death.impact)
    }
    const victim = this.nameOf(death.victim)
    const victimPlayer = death.victim === this.net?.id ? this.you : this.remotes.get(death.victim)?.player
    const killerPlayer = death.killer === this.net?.id ? this.you : this.remotes.get(death.killer)?.player
    if (victimPlayer) this.recordScore(killerPlayer ?? null, victimPlayer)
    this.onFeed?.(death.killer ? `${this.nameOf(death.killer)} killed ${victim}` : `${victim} died`)
    const remote = this.remotes.get(death.victim)
    if (remote && death.killer !== this.net!.id) {
      this.effects.death(Math.hypot(remote.player.state.x - this.you.state.x, remote.player.state.z - this.you.state.z))
    }
  }

  private onExplosion(e: Explosion): void {
    if (e.owner === this.net!.id) return
    const point = new THREE.Vector3(e.x, e.y, e.z)
    const kind=SPLASH_KINDS[e.kind]
    if(kind)blastRagdolls(point,SPLASH[kind].radius,blastStrength(kind),(a,b)=>!this.sweep(a,b,false))
    if (kind === 'bolt'||kind==='chopper') { this.effects.impact(point, kind==='bolt'); return }
    this.explosions.explode(point, kind ?? 'rocket', this.blastNormal(point))
    this.remoteGrenades?.extinguishNear(point)
    this.effects.sound(kind === 'fuelrod' ? 'fuel-rod-explosion' : 'explosion', .9 / (1 + point.distanceTo(this.you.object.position) * .025))
    // Shake the camera if it went off near us; whether it hurt is the server's call.
    if (point.distanceTo(this.you.object.position) < 6) this.kick += 0.01
  }

  private onLaunch(l: Launch): void {
    if (l.owner === this.net!.id) return
    const origin = new THREE.Vector3(l.x, l.y, l.z)
    const dir = new THREE.Vector3(-Math.sin(l.yaw) * Math.cos(l.pitch), Math.sin(l.pitch), -Math.cos(l.yaw) * Math.cos(l.pitch))
    const kind = SPLASH_KINDS[l.kind]
    const distance = origin.distanceTo(this.you.object.position)
    if (kind === 'rocket') { this.remoteRockets?.launch(origin, dir, l.speed); this.effects.sound('rocket-launcher', .5 / (1 + distance * .04)) }
    else if(kind==='chopper'){this.remoteChopperRounds?.launch(origin,dir,l.speed);this.effects.sound('warthog',.5/(1+distance*.04))}
    // Bolts don't say whose they are; the Banshee's fly at 75 m/s, the Ghost's at 55.
    else if (kind === 'bolt') { this.remoteBolts?.launch(origin, dir, l.speed); this.effects.sound(l.speed > 65 ? 'banshee' : 'ghost', .5 / (1 + distance * .04)) }
    else if (kind === 'fuelrod') { this.remoteFuelRods?.launch(origin, dir, l.speed); this.effects.sound('fuel-rod', .5 / (1 + distance * .04)) }
    else if (kind === 'frag' || kind === 'plasma') { this.remoteGrenades?.throwVisual(kind, origin, dir, this.remotes.get(l.owner)?.player ?? null) }
  }

  /** Move every remote player to where the buffered snapshots say they are right now. */
  private updateRemotes(dt: number): void {
    const now = performance.now()
    for (const remote of this.remotes.values()) {
      const p = remote.player
      const apparentDistance = Math.hypot(p.state.x - this.you.state.x, p.state.z - this.you.state.z) / this.zoom
      p.setDetail(apparentDistance)
      p.animateWeapon(dt)
      p.animationHz = apparentDistance > 100 ? 15 : apparentDistance > 15 ? 30 : 60
      if (!remote.buffer.sample(now, remote.pose)) continue
      const pose = remote.pose
      if (!p.alive) {
        p.applyRemote(pose.x, pose.y, pose.z, pose.yaw, pose.pitch, true, false, 0)
        p.animateDeath(dt)
        continue
      }
      p.applyRemote(pose.x, pose.y, pose.z, pose.yaw, pose.pitch, (pose.flags & FLAG_ON_GROUND) !== 0, (pose.flags & FLAG_CROUCHED) !== 0, dt, pose.gait)
      // Seated players are drawn as riders on the vehicle, not as a Spartan standing in it.
      p.object.visible = (pose.flags & FLAG_IN_VEHICLE) === 0
    }
    this.remoteRockets?.update(dt)
    this.remoteGrenades?.update(dt)
    this.remoteChopperRounds?.update(dt)
    this.remoteBolts?.update(dt)
    this.remoteFuelRods?.update(dt)
    this.updateRemoteVehicles(dt, now)
  }

  /** Every vehicle we are not driving follows the snapshots; riders are posed on their seats. */
  private updateRemoteVehicles(dt: number, now: number): void {
    const me = this.net!.id
    for (const v of this.vehicles.all) {
      const driving = this.serverSeat?.seat === 'driver' && this.serverSeat.vehicle === v
      if (!driving && v.buffer.sample(now, v.pose)) {
        this.vehicles.applyRemote(v, v.pose)
        const horn = (v.pose.flags & VEHICLE_HORN) !== 0
        const wasHorn = this.heardVehicleHorns.get(v.id) ?? false
        if (horn && !wasHorn && v !== this.vehicles.occupied) {
          const dx = v.state.x - this.camera.position.x, dz = v.state.z - this.camera.position.z
          const distance = Math.hypot(dx, v.state.y - this.camera.position.y, dz)
          const right = this.camera.matrixWorld.elements
          const pan = Math.max(-1, Math.min(1, (dx * right[0] + dz * right[2]) / Math.max(distance, 1)))
          this.effects.sound('warthog-horn', .9 / (1 + distance * .04), pan)
        }
        this.heardVehicleHorns.set(v.id, horn)
      }
      const teams: Partial<Record<Seat, Team>> = {}
      if (v.driver && v.driver !== me) { const t = this.remotes.get(v.driver)?.player.team; if (t) teams.driver = t }
      if (v.gunner && v.gunner !== me) { const t = this.remotes.get(v.gunner)?.player.team; if (t) teams.gunner = t }
      this.vehicles.updateSeatRiders(v, teams, this.camera.position, dt)
    }
  }

  /** One fixed simulation step of your own movement, predicted and recorded for the server. */
  private stepYou(): void {
    this.input.setAimZoom(this.vehicles.occupied ? 1 : this.zoom)
    const raw = this.input.sample(STEP)
    const frame: WireInput = {
      seq: raw.seq,
      forward: raw.forward,
      strafe: raw.strafe,
      yaw: raw.yaw,
      // The camera aims with recoil added; the server has to shoot where the camera looked.
      pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, raw.pitch + this.kick)),
      buttons: (this.weapon.slot.id==='plasma-pistol'&&this.input.fireHeld?BTN_CHARGE_RIGHT:0) | (this.offhand?.slot.id==='plasma-pistol'&&this.input.altFireHeld?BTN_CHARGE_LEFT:0) | (raw.jump ? BTN_JUMP : 0) | (raw.crouch ? BTN_CROUCH : 0) | this.buttons,
    }
    // A shot is judged from the aim at the trigger pull, before its own recoil moved the view.
    if ((!this.vehicles.occupied||(this.vehicles.occupied.kind==='mongoose'&&this.vehicleGunner)) && (frame.buttons & (BTN_FIRE | BTN_ALT | BTN_MELEE | BTN_LUNGE))) { frame.yaw = this.shotYaw; frame.pitch = this.shotPitch }
    if (this.vehicles.occupied?.kind==='warthog' && this.vehicleGunner) {
      const aim = this.turretTarget(this.vehicles.occupied, frame.yaw, frame.pitch)
      frame.yaw = Math.atan2(-aim.x,-aim.z)
      frame.pitch = Math.asin(THREE.MathUtils.clamp(aim.y,-1,1))
    }
    this.buttons = 0
    // Predict with exactly the numbers the wire will carry, or every snapshot corrects us.
    if (this.net) quantiseInput(frame)
    const sample: PlayerInput = {
      forward: frame.forward, strafe: frame.strafe, yaw: frame.yaw, pitch: frame.pitch,
      jump: raw.jump, crouch: raw.crouch, seq: raw.seq, dt: STEP,
      vehicles: this.vehicleColliders(),
    }
    const seated = this.vehicles.occupied
    if (seated) {
      // Driving: the frame steers the vehicle, and the body just rides in it.
      if (!this.vehicleGunner) {
        const drive: VehicleInput = { forward: frame.forward, strafe: frame.strafe, yaw: frame.yaw, pitch: frame.pitch, brake: raw.crouch, jump: raw.jump, coast: false }
        const before={x:seated.state.x,y:seated.state.y,z:seated.state.z}
        this.vehicles.drive(seated, drive, STEP)
        this.offlineRunovers(seated,before)
        if (this.net) this.vehiclePrediction?.record(raw.seq, drive, seated.state)
      }
      if (this.net) this.net.pushInput(frame)
      return
    }
    const lungeBefore=this.swordLunge ? {...this.swordLunge} : null
    const liftBefore=this.you.state.liftCooldown??0
    this.you.advance(sample)
    if(this.map==='guardian'||isArena(this.map))this.checkGuardianLiftLaunch(this.you.state,liftBefore)
    if(!this.you.alive)this.swordLunge=null
    if(this.swordLunge && !advanceSwordLunge(this.you.state,this.swordLunge,STEP))this.swordLunge=null
    // Like Halo 3, the lunge starts on the button press and closes the gap before the strike lands (BTN_LUNGE, sent
    // from the press). It used to start with the hit itself (BTN_MELEE, ~0.2 s later), after the hit had already missed.
    if((frame.buttons&BTN_LUNGE)&&this.you.alive) {
      this.swordLunge=this.weapon.isBlade
        ? beginSwordLunge(this.you.state,frame.yaw,frame.pitch,this.swordTargets())
        : beginMeleeLunge(this.you.state,frame.yaw,frame.pitch,this.swordTargets())
    }
    if(lungeBefore) {
      this.you.object.position.x=this.you.state.x
      this.you.object.position.z=this.you.state.z
    }
    // A teleporter turns you to face out of the receiver; yaw lives in the input, so apply it here.
    if (this.you.state.teleportYaw !== null) { this.input.yaw = this.you.state.teleportYaw; this.effects.sound('teleport', 0.9) }
    if (this.net) {
      this.prediction.record(sample.seq, sample, this.you.state,lungeBefore)
      this.net.pushInput(frame)
    }
  }

  private driveOthers(dt: number): void {
    if (this.net) { this.updateRemotes(dt); return }
    this.driveBots(dt)
    // Offline, anything you are not in rolls to a stop or settles out of the air on its own.
    for (const v of this.vehicles.all) if (v !== this.vehicles.occupied) {
      const before={x:v.state.x,y:v.state.y,z:v.state.z};this.vehicles.coast(v, dt);this.offlineRunovers(v,before)
    }
    resolveVehicleContacts(this.vehicles.all.map(v=>v.kind),this.vehicles.all.map(v=>v.state),dt)
    for(const v of this.vehicles.all)this.vehicles.syncObject(v)
  }

  update(dt: number): void {
    this.pickupView.update(this.weaponPickups,performance.now())
    this.input.dualWield=!!this.offhand
    this.chargedPlasma.update(dt)
    this.needles.update(dt)
    // Previous render positions sweep both predicted and remote vehicles against corpses.
    const corpseVehicles = this.vehicles.all.map(v => {
      const lift = v.kind === 'warthog' ? .6 : v.kind === 'ghost' ? .35 : .45
      const position = {x:v.state.x, y:v.state.y+lift, z:v.state.z}
      const previous = this.corpseVehiclePositions.get(v.id) ?? position
      const h = Math.max(1/240,Math.min(dt,.1))
      const velocity = {x:(position.x-previous.x)/h,y:(position.y-previous.y)/h,z:(position.z-previous.z)/h}
      const velocityScale = Math.min(1,60/Math.max(1,Math.hypot(velocity.x,velocity.y,velocity.z)))
      velocity.x*=velocityScale;velocity.y*=velocityScale;velocity.z*=velocityScale
      this.corpseVehiclePositions.set(v.id,position)
      return {id:v.id,kind:v.kind,previous,position,velocity}
    })
    updateRagdolls(Math.min(dt,.1), this.input.active ? corpseVehicles : [])
    if (!this.input.active) { this.cancelPlasmaCharge();this.buttons|=BTN_CANCEL_CHARGE;this.effects.cancelReload(); this.effects.vehicles([]); return }
    dt=Math.min(dt,.1)
    this.elapsedSeconds+=dt
    const crouchers=[this.you,...this.bots].map(p=>({id:p.id,alive:p.alive,
      seated:p===this.you?!!this.vehicles.occupied:!!(Array.from(this.remotes.values()).find(r=>r.player===p)?.pose.flags!&FLAG_IN_VEHICLE),
      state:{...p.state,yaw:p===this.you?this.input.yaw:p.object.rotation.y}}))
    for(const point of this.corpseCrouches.update(crouchers,this.elapsedSeconds,(a,b)=>!this.sweep(a,b,false))){
      const distance=point.distanceTo(this.camera.position)
      if(distance<22)this.effects.sound('body-hit',.7/(1+distance*.18))
    }
    // Shield feedback is positional and shared by everyone in earshot; only the local player
    // hears their own shields finish recharging, the way Halo's regen hum is a personal cue.
    for (const p of [this.you, ...this.bots]) {
      const popped = p.consumeShieldPop(), hit = p.consumeShieldHit(), charged = p.consumeShieldCharged()
      const recharging = p.consumeShieldRecharge()
      // Pain and death vocals: every damage path (local hits, fall damage, server vitals) lands here.
      const hurt = p.consumeHurt()
      if (hurt) this.foley.hurt(p, hurt, popped, p === this.you, this.camera)
      if (charged && p === this.you) this.effects.sound('shield-recharge', .5)
      // The armour lights up again as the shield starts refilling - softer than a hit, and the
      // tell that someone who broke cover is about to be whole again.
      if (recharging && p.alive) {
        p.shieldFlash(.8)
        if (p === this.you) firstPersonShieldFlash.value = Math.max(firstPersonShieldFlash.value, .55)
        if (p === this.you) this.effects.sound('shield-charging', .55)
      }
      if (!popped && !hit) continue
      const point = p.eye().add(new THREE.Vector3(0, -.25, 0))
      const distance = point.distanceTo(this.camera.position)
      if (distance > 45) continue
      const right = this.camera.matrixWorld.elements
      const pan = Math.max(-1, Math.min(1, ((point.x - this.camera.position.x) * right[0] + (point.z - this.camera.position.z) * right[2]) / Math.max(distance, 1)))
      // The shield itself is the effect: an orange-yellow glow riding the whole silhouette,
      // washing white and shedding a small burst on the shot that finally breaks it. Only the
      // living carry it: a hidden character stops decaying the glow, so a blow that pops the
      // shield and kills in the same instant would otherwise leave it burned into the corpse.
      if (p.alive) p.shieldFlash(popped ? 1.9 : .95)
      // First person never sees its own silhouette, so the same flash drives the viewmodel
      // arms and the owner's own legs instead - your shields light your hands.
      // Driven lower than the third-person body: arms and weapon fill the screen facing the
      // camera, so the same numbers there blow the viewmodel out to flat white.
      if (p === this.you && p.alive) firstPersonShieldFlash.value = Math.max(firstPersonShieldFlash.value, popped ? 1.25 : .65)
      if (popped) this.effects.shieldPop(point)
      this.effects.sound(popped ? 'shield-break' : 'shield-hit', (popped ? .95 : .7) / (1 + distance * .05), pan)
    }
    fadeFirstPersonShieldFlash(dt)
    // Footfalls for everyone on foot, by the surface under them; seated riders make none.
    for (const p of [this.you, ...this.bots]) {
      const seated = p === this.you ? !!this.vehicles.occupied : ((this.remotes.get(this.numbers.get(p) ?? -1)?.pose.flags ?? 0) & FLAG_IN_VEHICLE) !== 0
      this.foley.walk(p, p === this.you, seated, dt, this.camera)
    }
    // The low-shield alarm is personal, like the recharge hum: it repeats while your own shield
    // is low and stops as soon as it begins to refill (or you die).
    if (this.you.shieldAlarm) {
      this.shieldAlarmTimer -= dt
      if (this.shieldAlarmTimer <= 0) { this.effects.sound('shield-low', .6); this.shieldAlarmTimer += SHIELD_ALARM_INTERVAL }
      if (this.shieldAlarmTimer <= 0) this.shieldAlarmTimer = SHIELD_ALARM_INTERVAL
    } else this.shieldAlarmTimer = 0
    for (const held of this.heldWeapons.values()) if (held !== this.weapon) held.updateHolstered(dt)
    this.effects.update(dt)
    this.rockets.update(dt)
    this.plasma.update(dt)
    this.chopperRounds.update(dt)
    this.fuelRod.update(dt)
    this.fuelRodIn=Math.max(0,this.fuelRodIn-dt)
    this.grenades.update(dt)
    this.explosions.update(dt, this.camera)
    this.vehicles.updatePresentation(dt, this.camera.position)
    this.effects.vehicles(this.vehicles.all.map(v=>{
      const dx=v.state.x-this.camera.position.x,dz=v.state.z-this.camera.position.z
      const distance=Math.hypot(dx,v.state.y-this.camera.position.y,dz)
      const right=this.camera.matrixWorld.elements
      const pan=Math.max(-1,Math.min(1,(dx*right[0]+dz*right[2])/Math.max(distance,1)))
      const last=this.heardVehicleImpacts.get(v.id)??0
      const advance=(v.state.impactSeq-last+65536)%65536
      if(advance>0&&advance<32768){
        this.heardVehicleImpacts.set(v.id,v.state.impactSeq)
        this.effects.collision(v.kind,v.state.impactSpeed,distance,pan,v.id)
      }
      return {id:v.id,kind:v.kind,speed:v.state.speed,occupied:!!v.driver||v===this.vehicles.occupied,boosting:v.state.maneuver>0,
        distance,pan:Math.max(-1,Math.min(1,(dx*right[0]+dz*right[2])/Math.max(distance,1)))}
    }))
    this.vehicleFireIn=Math.max(0,this.vehicleFireIn-dt)
    if (!this.net) {
      for (const player of [this.you, ...this.bots]) {
        if (!player.alive && !this.recordedDeaths.has(player)) {
          this.spawnDirector.recordDeath(player.state, this.elapsedSeconds)
          this.recordedDeaths.add(player)
          this.announce(this.objectives.drop(this.numberOf(player), player.state))
        }
      }
      this.announce(this.objectives.step(dt, this.contenderList()))
    } else if (!this.objectives.over) {
      // Between the server's once-a-second updates, run the clock down locally.
      this.objectives.timeLeft = Math.max(0, this.objectives.timeLeft - dt)
    }
    this.objectiveView.update(dt, item => this.carrierOf(item), this.numberOf(this.you), this.elapsedSeconds)
    for (const [player, remaining] of this.respawns) {
      if (remaining > dt) { this.respawns.set(player, remaining - dt); continue }
      if (!this.placeSpawn(player)) { this.respawns.set(player, .25); continue }
      this.arenaNavigation?.reset(player.id)
      this.guardianNavigation.reset(player.id)
      this.lockoutNavigation.reset(player.id)
      this.botGoals.delete(player.id)
      this.respawns.delete(player)
      this.botCombat.delete(player.id)
    }
    if (!this.you.alive) {
      this.equipOffhand(-1)
      this.objectiveView.showHeld(null)
      this.swordLunge=null
      this.effects.cancelReload()
      this.weapon.holster()
      if(this.vehicles.occupied){this.vehicles.occupied=null;this.you.object.visible=true}
      this.you.animateDeath(dt)
      this.weapon.object.visible = false
      this.driveOthers(dt)
      this.updateDeathCam(dt)
      if (this.net) {
        // The server decides when we come back; see onSelf. Keep sending input so it knows we
        // are still here, and so the queue does not fill with stale frames.
        this.stepAccumulator = Math.min(this.stepAccumulator + dt, 0.25)
        while (this.stepAccumulator >= STEP) { this.stepAccumulator -= STEP; this.stepYou() }
        for (const edge of ['reloadPressed','swapPressed','meleePressed','grenadePressed','zoomPressed','grenadeSwitchPressed','pickupLeftPressed','interactPressed','viewPressed','hornPressed'] as const) this.input.consume(edge)
        this.input.consumeFire()
        return
      }
      this.respawnIn -= dt
      if (this.respawnIn <= 0) {
        if (!this.placeSpawn(this.you)) { this.respawnIn = .25; return }
        this.zoomIndex = -1
        // You come back with every weapon full and a fresh pouch, not whatever you died holding.
        for (const held of this.heldWeapons.values()) held.refill()
        this.grenades.refill()
      }
      return
    }
    if(this.input.consume('interactPressed')) {
      // Your use key drops what you carry; nobody drives off with the flag.
      if (this.net) this.buttons |= BTN_INTERACT
      else if (this.carrying) this.announce(this.objectives.drop(this.numberOf(this.you), this.you.state, true))
      else if(!this.pickupWeapon('right'))this.interactVehicle()
    }
    if(this.input.consume('pickupLeftPressed')){
      if(this.canPickupLeft){if(this.net)this.buttons|=BTN_PICKUP_LEFT;else this.pickupWeapon('left')}
      else this.input.swapPressed=true
    }
    if(this.vehicles.occupied){this.equipOffhand(-1);this.effects.cancelReload();this.updateVehicle(dt);return}
    // Space is a horn edge only while driving; discard an on-foot press so it cannot
    // fire unexpectedly when the player boards a Warthog on the same frame.
    this.input.consume('hornPressed')
    if(this.input.consume('grenadeSwitchPressed') && !this.weapon.isThrowing) this.grenades.selected=this.grenades.selected==='frag'?'plasma':'frag'
    if (this.input.consume('viewPressed')) this.thirdPersonChosen = !this.thirdPersonChosen
    const carrying = !!this.carrying
    if (carrying) {this.zoomIndex = -1;this.equipOffhand(-1)}
    if (this.input.consume('zoomPressed') && !this.offhand && !carrying && !this.weapon.isMeleeing && !this.weapon.isReloading) {
      const levels = this.weapon.slot.spec.zoom ?? []
      this.zoomIndex = this.zoomIndex + 1 >= levels.length ? -1 : this.zoomIndex + 1
      if (levels.length) this.effects.sound(this.weapon.slot.id === 'battle-rifle' ? (this.zoomIndex < 0 ? 'battle-rifle:zoom-out' : 'battle-rifle:zoom-in') : 'zoom', 0.5)
    }
    this.thirdPerson = this.thirdPersonChosen && this.zoom === 1
    // Movement runs on a fixed step so every frame the server sees covers the same time the
    // client simulated. Rendering between steps just shows the last one; at 60 Hz nobody notices.
    this.stepAccumulator = Math.min(this.stepAccumulator + dt, 0.25)
    while (this.stepAccumulator >= STEP && this.you.alive) { this.stepAccumulator -= STEP; this.stepYou() }
    if (!this.you.alive) this.respawnIn = 3

    this.you.setThirdPerson(this.thirdPerson)
    // the body's own gun shows your rounds and your plasma charge (seen in third person)
    this.you.setWeaponState(this.weapon.slot.ammo, this.weapon.charge.held ? Math.min(1, this.weapon.charge.time / PLASMA_CHARGE.seconds) : 0)
    if (this.offhand) this.you.setWeaponState(this.offhand.slot.ammo, this.offhand.charge.held ? Math.min(1, this.offhand.charge.time / PLASMA_CHARGE.seconds) : 0, true)
    this.you.setWeaponModel(this.weapon.slot.id)
    this.you.setOffhandModel(this.offhand?.slot.id??null)
    this.driveOthers(dt)

    const speed = Math.hypot(this.you.state.vx, this.you.state.vz)
    this.weapon.update(dt, speed, false)
    this.offhand?.update(dt,speed,false)
    if (this.outgoing) {
      if (this.outgoing.isLowering) this.outgoing.object.visible = !this.thirdPerson && this.zoom === 1 && this.you.alive
      else { this.camera.remove(this.outgoing.object); this.outgoing = null }
    }
    const targetFov = this.weapon.slot.id === 'battle-rifle'
      ? advanceOpticalZoom(this.camera.fov, MOVE.fovDeg, this.zoom, dt)
      : 2 * Math.atan(Math.tan(MOVE.fovDeg * Math.PI / 360) / this.zoom) * 180 / Math.PI
    if (Math.abs(this.camera.fov - targetFov) > 0.001) {
      this.camera.fov = targetFov
      this.camera.updateProjectionMatrix()
    }

    this.kick *= Math.exp(-9 * dt)
    this.deathCamTime = -1
    this.you.eye(this.eye)
    // Nudge the eye forward out of the chest, so looking down shows the body rather than the
    // inside of it. Small enough not to shift where shots originate in any way that matters.
    this.eye.x -= Math.sin(this.input.yaw) * 0.12
    this.eye.z -= Math.cos(this.input.yaw) * 0.12
    this.camera.position.copy(this.eye)
    this.camera.rotation.set(this.input.pitch + this.kick, this.input.yaw, 0, 'YXZ')
    // A carrier's hands hold the objective; the view shows that instead of the gun.
    this.weapon.object.visible = !this.thirdPerson && this.zoom === 1 && !carrying
    if(this.offhand)this.offhand.object.visible=this.weapon.object.visible
    this.objectiveView.showHeld(carrying && !this.thirdPerson ? this.carrying : null)
    if (this.thirdPerson) this.placeShoulderCamera(dt)
    // squeezed right up to the head (a wall behind and one to the right), the camera would look out through the helmet: hide the body
    this.you.object.visible = !this.thirdPerson || this.camera.position.distanceTo(this.eye) > .45

    const meleePressed=this.input.consume('meleePressed')
    if(meleePressed)this.equipOffhand(-1)
    if(meleePressed && this.weapon.melee()){
      this.you.action('melee',this.weapon.meleeProfile.duration)
      this.effects.cancelReload()
      this.zoomIndex=-1
      this.effects.sound(`melee:${this.weapon.slot.id}`, .75)
      // every melee lunges toward a target in range from the press (the sword with its long dash, the rest a short snap)
      this.requestSwordLunge()
    }
    if(this.weapon.consumeMeleeHit()) this.meleeHit()
    // Original shotgun handling audio includes its own pump timing from fire time zero.
    this.weapon.consumePumpContact()
    const grenadePressed=this.input.consume('grenadePressed')
    if(grenadePressed)this.equipOffhand(-1)
    if (grenadePressed && this.objectives.spec.grenades !== false && !carrying && this.grenades.canThrow && this.weapon.throwGrenade(this.grenades.selected)) {
      this.you.action('throw', .75)
      this.effects.cancelReload()
      this.zoomIndex = -1
    }
    if (this.weapon.consumeGrenadeThrow()) {
      this.camera.getWorldDirection(this.forward)
      if (this.thirdPerson) this.convergeOnCrosshair()
      // the first-person hand is hidden at the camera in third person: throw from in front of the Spartan instead
      const origin = this.thirdPerson ? this.eye.clone().addScaledVector(this.forward, .5) : this.weapon.grenadePosition(new THREE.Vector3())
      // The projectile leaves the visible hand. Against close cover, keep it on the
      // eye's side of the surface instead of spawning through the wall.
      if (this.sweep(this.eye, origin, false)) origin.copy(this.eye)
      const kind = this.grenades.selected
      if (this.grenades.throw(origin, this.forward)) {
        this.effects.sound('grenade', .5)
        this.net?.sendLaunch(SPLASH_KINDS.indexOf(kind), origin.x, origin.y, origin.z, this.forward.x, this.forward.y, this.forward.z, 17)
      }
    }
    const firePressed=this.input.consumeFire()
    // Carriers can only swing. The server refuses their shots as well.
    if(this.weapon.slot.id==='plasma-pistol'){if(!carrying){const shot=this.weapon.chargeTrigger(this.input.fireHeld,firePressed,dt);this.effects.charge('right',this.weapon.charge.held);if(shot)this.shoot(this.weapon,false,shot===2)}}
    else if (!carrying && (this.weapon.continuingBurst || firePressed || (this.input.fireHeld && (this.weapon.canFire || this.weapon.isReloading)))) this.shoot()
    const leftPressed=this.input.consumeAltFire()
    if(this.offhand?.slot.id==='plasma-pistol'){if(!carrying){const shot=this.offhand.chargeTrigger(this.input.altFireHeld,leftPressed,dt);this.effects.charge('left',this.offhand.charge.held);if(shot)this.shoot(this.offhand,true,shot===2)}}
    else if(this.offhand&&!carrying&&(leftPressed||this.input.altFireHeld))this.shoot(this.offhand,true)
    if (this.weapon.consumeReloadCancel()) this.buttons |= BTN_RELOAD_CANCEL
    // As in Halo, an empty magazine reloads itself when there is ammo to put in it: no R needed. Dual wielding
    // keeps its own per-hand reloads.
    const reloadPressed = this.input.consume('reloadPressed')
    const runDry = !reloadPressed && !this.offhand && !this.weapon.isMeleeWeapon && !this.weapon.isReloading
      && this.weapon.slot.ammo === 0 && this.weapon.slot.reserve > 0
    if (reloadPressed || runDry) {
      const wasReloading = this.weapon.isReloading, emptyReload = this.weapon.slot.ammo === 0
      this.weapon.reload()
      if(this.offhand){const wasLeftReloading=this.offhand.isReloading,emptyLeft=this.offhand.slot.ammo===0;this.offhand.reload();this.buttons|=BTN_RELOAD;if(!wasLeftReloading&&this.offhand.isReloading)this.effects.offhandReload(this.offhand.slot.id,emptyLeft)}
      if (!wasReloading && this.weapon.isReloading) {this.zoomIndex=-1;this.buttons|=BTN_RELOAD;this.effects.startReload(this.weapon.slot.id,this.weapon.reloadDuration,.7,emptyReload);this.you.action('reload',this.weapon.reloadDuration)}
    }
    if (this.input.consume('swapPressed')) this.swapWeapon()
    if(this.weapon.isReloading)this.effects.reloadProgress(this.weapon.slot.id,this.weapon.reloadElapsed,this.weapon.reloadDuration)
    else this.effects.finishReload()
  }

  /** Where each bot is heading, plus enough history to notice it is not getting there. */
  private readonly arenaNavigation:GuardianBotNavigator|null
  private readonly guardianNavigation = new GuardianBotNavigator()
  private readonly lockoutNavigation = new LockoutBotNavigator()
  private placeSpawn(player: Player, reset = true): boolean {
    const self={id:this.numberOf(player),team:player.team}
    const occupants = [this.you, ...this.bots].filter(p=>p!==player).map(p=>({...p.state,team:this.objectives.spawnTeam(self,{id:this.numberOf(p),team:p.team}),alive:p.alive}))
    const p=this.spawnDirector.choose(this.map,player.team,occupants,this.elapsedSeconds,
      point=>this.vehicles.all.some(v=>Math.abs(v.state.y-point.y)<3&&Math.hypot(v.state.x-point.x,v.state.z-point.z)<4),Math.random,this.objectives.spawnBias(player.team))
    if(!p)return false
    player.state.map=this.map
    if(reset)player.respawn(p.x,p.z)
    player.place(p.x,p.y,p.z)
    if(player===this.you){this.input.yaw=p.yaw;this.input.pitch=0}
    Object.assign(player.state,{map:this.map,fallFrom:p.y,onGround:true,vx:0,vy:0,vz:0})
    this.recordedDeaths.delete(player)
    return true
  }

  private readonly botGoals = new Map<string, { x: number; z: number; stuckFor: number; lastX: number; lastZ: number }>()
  private botAccumulator = 0

  /**
   * Pick a reachable point near an anchor. Rejecting positions outside the rim matters: a goal
   * inside the rock can never be reached, and a bot walking at it walks into the cliff and stays
   * there for the rest of the match.
   */
  /** Ground under a point. Blood Gulch is a heightfield; Lockout stacks decks, so it needs the
   * height being asked from — the default of 100 answers with the top deck, which is only right
   * for something known to be above every floor. */
  private ground(x:number,z:number,y=100):number { return isArena(this.map) ? arenaFloor(this.map,x,z,y) : this.map === 'guardian' ? -26 : this.map === 'lockout' ? lockoutFloor(x,z,y) : groundHeight(x,z) }
  /** Mesh maps answer occlusion exactly with their collision rays; heightfield sampling there
   * fills every space under a deck or bridge with an invisible solid. */
  private get meshMap():boolean { return true }

  private pickGoal(anchorX: number, anchorZ: number): { x: number; z: number; stuckFor: number; lastX: number; lastZ: number } {
    for (let tries = 0; tries < 12; tries++) {
      const x = anchorX + (Math.random() - 0.5) * 60
      const z = anchorZ + (Math.random() - 0.5) * 30
      if (rimFraction(x, z) < 0.85) return { x, z, stuckFor: 0, lastX: NaN, lastZ: NaN }
    }
    return { x: anchorX, z: anchorZ, stuckFor: 0, lastX: NaN, lastZ: NaN }
  }

  private pickGoalLockout(): { x: number; z: number; stuckFor: number; lastX: number; lastZ: number } {
    const point = lockoutPatrolPoints[Math.floor(Math.random() * lockoutPatrolPoints.length)]
    return { x: point.x, z: point.z, stuckFor: 0, lastX: NaN, lastZ: NaN }
  }

  /**
   * Blood Gulch uses terrain patrols; Guardian and Lockout follow floor-aware pathfinding graphs.
   * Both retain burst fire, reaction time and visibility checks.
   */
  private driveBots(dt: number): void {
    // Bot movement is gameplay simulation rather than presentation. Thirty updates per second
    // are enough for a readable aim/reaction cadence, while avoiding a second full set of
    // Guardian BVH collision queries on every render frame.
    this.botAccumulator = Math.min(this.botAccumulator + Math.max(0, dt), .1)
    const botStep = 1 / 30
    if (this.botAccumulator < botStep) return
    // Consume one fixed step at a time. If rendering stalls, never hand a large catch-up
    // delta to Guardian's swept collision code; the next render tick will consume the rest.
    dt = botStep
    this.botAccumulator -= botStep
    // The objective, if the game type has one: every bot reads the same snapshot of who is where.
    const people = this.objectives.items.length ? this.contenderList() : null
    for (const bot of this.bots) {
      const apparentDistance = Math.hypot(bot.state.x - this.you.state.x, bot.state.z - this.you.state.z) / this.zoom
      bot.setDetail(apparentDistance)
      bot.animationHz = apparentDistance > 100 ? 15 : apparentDistance > 15 ? 30 : 60
      if (!bot.alive) { bot.animateDeath(dt); continue }

      const guardian = this.map === 'guardian'||isArena(this.map)
      let goal = guardian ? {x:bot.state.x,z:bot.state.z,stuckFor:0,lastX:NaN,lastZ:NaN} : this.botGoals.get(bot.id)
      const reached = goal && Math.hypot(goal.x - bot.state.x, goal.z - bot.state.z) < 6

      // Blood Gulch's open-terrain patrol retries a different goal when progress stops.
      // Guardian keeps its own waypoint progress and route recovery.
      if (goal && !reached) {
        const moved = Math.hypot(bot.state.x - goal.lastX, bot.state.z - goal.lastZ)
        goal.stuckFor = Number.isNaN(goal.lastX) || moved > dt * 0.25 ? 0 : goal.stuckFor + dt
        goal.lastX = bot.state.x
        goal.lastZ = bot.state.z
      }

      if (!goal || (!guardian && (reached || goal.stuckFor > 1.5))) {
        const toward = (this.map === 'lockout' ? {x:0,z:0} : bot.state.z > 0 ? RED_BASE : BLUE_BASE)
        goal = this.map === 'lockout' ? this.pickGoalLockout() : this.pickGoal(toward.x, toward.z)
        this.botGoals.set(bot.id, goal)
      }

      let combat = this.botCombat.get(bot.id)
      if (!combat) { combat = {target: null, think: 0, cooldown: 0.8, rounds: 0, yaw: bot.object.rotation.y}; this.botCombat.set(bot.id, combat) }
      combat.think -= dt
      combat.cooldown -= dt
      if (combat.think <= 0) {
        combat.think = 0.2 + Math.random() * 0.1
        const candidates = [this.you, ...this.bots].filter(p => p.alive && this.hostile(bot, p))
        combat.target = candidates.filter(p => Math.hypot(p.state.x - bot.state.x, p.state.z - bot.state.z) < 75)
          .sort((a,b) => Math.hypot(a.state.x-bot.state.x,a.state.z-bot.state.z)-Math.hypot(b.state.x-bot.state.x,b.state.z-bot.state.z)).find(p => this.canSee(bot, p)) ?? null
      }
      const target = combat.target?.alive ? combat.target : null
      const isLockout = this.map === 'lockout'
      // Half of each side attacks and half holds home. An urgent objective — carrying the flag
      // home, planting the bomb — keeps the bot moving while it still shoots at whoever it sees.
      const number = this.numberOf(bot)
      const me = people?.find(p => p.id === number)
      const objective = me ? objectiveGoal(this.objectives, me, number % 2 === 0, people!) : null
      const carrier = !!this.objectives.carried(number)
      const fight = !objective?.urgent && target && this.canSee(bot,target) ? target.state : null
      let worldMove = guardian ? (this.arenaNavigation??this.guardianNavigation).steer(bot.id, bot.state, dt,
        [this.you,...this.bots].map(p=>({...p.state,id:p.id,alive:p.alive})),
        fight, this.elapsedSeconds, objective?.point ?? null)
        : isLockout ? this.lockoutNavigation.steer(bot.id, bot.state, dt,
        [this.you,...this.bots].map(p=>({...p.state,id:p.id,alive:p.alive})),
        fight, this.elapsedSeconds, objective?.point ?? null)
        : null
      // Blood Gulch is open ground: head straight for the objective.
      if (!worldMove && objective && (!target || objective.urgent)) {
        const dx = objective.point.x - bot.state.x, dz = objective.point.z - bot.state.z, d = Math.hypot(dx, dz)
        worldMove = d > .6 ? { x: dx / d, z: dz / d } : { x: 0, z: 0 }
      }
      const desiredYaw = worldMove && !target ? (Math.hypot(worldMove.x,worldMove.z)>.01 ? Math.atan2(-worldMove.x,-worldMove.z) : combat.yaw) : Math.atan2(bot.state.x - (target?.state.x ?? goal.x), bot.state.z - (target?.state.z ?? goal.z))
      const delta = Math.atan2(Math.sin(desiredYaw - combat.yaw), Math.cos(desiredYaw - combat.yaw))
      combat.yaw += THREE.MathUtils.clamp(delta, -dt * 3.5, dt * 3.5)
      const yaw = combat.yaw
      const range = target ? Math.hypot(target.state.x - bot.state.x, target.state.z - bot.state.z) : Infinity
      bot.aim(target ? Math.atan2(target.simEye() - bot.simEye(), range) : 0)
      if (target && !carrier && Math.abs(delta) < 0.16 && combat.cooldown <= 0 && this.canSee(bot, target)) {
        bot.fire()
        const muzzle = bot.muzzlePosition(new THREE.Vector3())
        const destination = target.eye().add(new THREE.Vector3(0,-.18,0))
        const obstruction = botShotObstruction(bot.eye(), muzzle, destination, (a,b) => {
          return grenadeMeshContact(isArena(this.map)?arenaCollision(this.map).mesh:this.map==='lockout'?lockoutMesh():guardianCollision().mesh,a,b)?.point??null
        })
        const listenerDistance = Math.hypot(bot.state.x-this.you.state.x,bot.state.z-this.you.state.z)
        const relativeX = (bot.state.x-this.you.state.x)*Math.cos(this.input.yaw)-(bot.state.z-this.you.state.z)*Math.sin(this.input.yaw)
        this.effects.shot(muzzle,obstruction??destination,'assault-rifle',0.6/(1+listenerDistance*.08),relativeX/Math.max(5,listenerDistance))
        combat.rounds++
        combat.cooldown = combat.rounds % 4 === 0 ? 0.85 + Math.random() * 0.55 : 0.12
        // Deliberately imperfect aim: visible bursts give the player time to react.
        const accuracy = THREE.MathUtils.clamp(0.62 - range * 0.006, 0.14, 0.55)
        if (!obstruction && Math.random() < accuracy) {
          const hadShield = target.shield > 0
          const killed = target.damage(7,undefined,{point:destination,direction:destination.clone().sub(muzzle).normalize(),strength:corpseBulletStrength('assault-rifle')})
          this.effects.impact(destination,hadShield)
          if (killed) this.effects.death(Math.hypot(target.state.x-this.you.state.x,target.state.z-this.you.state.z))
          if (killed && !this.net) this.recordScore(bot, target)
          if (target === this.you) { if(!['sniper','battle-rifle'].includes(this.weapon.slot.id))this.zoomIndex = -1; this.effects.sound('hit',0.4); this.kick += 0.006; if (killed) this.respawnIn = 3 }
          else if (killed) this.respawns.set(target, 3)
        }
      }
      // A rise steeper than a step means jump rather than stall against it.
      const ahead = 2.5
      const blocked = !guardian && !isLockout &&
        this.ground(bot.state.x - Math.sin(yaw) * ahead, bot.state.z - Math.cos(yaw) * ahead) -
          bot.state.y > MOVE.stepHeight

      let forwardMove=target?(range>28?.65:range<12?-.45:0):1
      let strafeMove=target&&range<35?Math.sin(performance.now()*.0012+Number(bot.id.slice(3))*2)*.45:0
      if (worldMove) {
        forwardMove = -Math.sin(yaw)*worldMove.x-Math.cos(yaw)*worldMove.z
        strafeMove = Math.cos(yaw)*worldMove.x-Math.sin(yaw)*worldMove.z
      }
      const botLiftBefore=guardian?bot.state.liftCooldown??0:0
      bot.advance({
        forward: forwardMove,
        strafe: strafeMove,
        yaw,
        pitch: 0,
        // Lockout follows validated ramp routes. A highest-deck query beneath a
        // ceiling must not make its bots repeatedly jump into that ceiling.
        jump: !guardian && !isLockout && blocked && goal.stuckFor > 0.5,
        crouch: false,
        seq: 0,
        dt,
        vehicles: this.vehicleColliders(),
      })
      if(guardian)this.checkGuardianLiftLaunch(bot.state,botLiftBefore)
      if (!bot.alive && !this.respawns.has(bot)) this.respawns.set(bot, 3)
    }
  }

  private vehicleColliders(): VehicleCollider[] {
    return this.vehicles.all.map(v => ({ kind: v.kind, x: v.state.x, y: v.state.y, z: v.state.z, yaw: v.state.yaw }))
  }

  /** `guardianMove` resets `liftCooldown` to a fixed value only at the instant it fires a
   * lift or man cannon; every other frame it only ever counts down. A rise from `before` is
   * therefore exactly a launch. Purely cosmetic: the actual velocity change already happened
   * in shared code, and the rider is standing on the pad at this instant regardless of which
   * lift fired. */
  private checkGuardianLiftLaunch(state: PlayerState, before: number): void {
    if ((state.liftCooldown ?? 0) <= before) return
    this.scene.getObjectByName('guardian')?.userData.liftBurst?.(state.x, state.y, state.z)
    this.effects.sound('teleport', .55 / (1 + Math.hypot(state.x - this.you.state.x, state.z - this.you.state.z) * .05))
  }

  /** Terrain and solid scene geometry both block acquisition and each individual shot. */
  private canSee(from: Player, to: Player): boolean {
    const origin = new THREE.Vector3(from.state.x, from.simEye() - 0.12, from.state.z)
    const end = new THREE.Vector3(to.state.x, to.simEye() - 0.18, to.state.z)
    const direction = end.clone().sub(origin)
    const distance = direction.length()
    if (distance < 0.01) return false
    direction.divideScalar(distance)
    // Guardian's placeholder solids leave the scene once the model loads; its collision mesh is the authority.
    if(isArena(this.map))return !arenaCollision(this.map).ray(origin.x,origin.y,origin.z,end.x,end.y,end.z)
    if (this.map === 'guardian') return !guardianRay(origin.x, origin.y, origin.z, end.x, end.y, end.z)
    if (this.map === 'lockout') return !lockoutRay(origin.x, origin.y, origin.z, end.x, end.y, end.z)
    if (coverBlocksRay(origin.x, origin.y, origin.z, end.x, end.y, end.z)) return false
    for (let t = 0.75; t < distance; t += 1) {
      if (origin.y + direction.y * t < this.ground(origin.x + direction.x * t, origin.z + direction.z * t)) return false
    }
    this.sightRay.set(origin, direction)
    this.sightRay.near = 0.2
    this.sightRay.far = distance - 0.4
    return this.sightRay.intersectObjects(this.cover, true).length === 0
  }

  /** Cycle to the next weapon. Ammo stays with the slot it belongs to. */
  private swapWeapon(): void {
    if (this.weapon.isMeleeing || this.weapon.isThrowing) return
    this.buttons |= BTN_SWAP
    this.selectSlot(this.slots[(this.slots.indexOf(this.slotIndex) + 1) % this.slots.length] ?? this.slots[0])
  }

  /**
   * Build every loadout weapon up front and hang the spares on the camera so the caller's
   * shader warm-up compiles them too. Building a weapon parses its GLB, solves its clips and
   * rigs its hands; left to the first switch, that stalled the game for 0.2-0.7 s per weapon.
   * Returns the spares; put them away with `stowWeapons` after the warm-up.
   */
  async preloadWeapons(): Promise<HeldWeapon[]> {
    for (const i of this.slots) {
      if (!this.heldWeapons.has(i)) this.heldWeapons.set(i, new HeldWeapon(LOADOUT[i].model, LOADOUT[i].specKey, this.you.team))
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
    for(const i of this.slots.filter(dualSlot)){const slot=LOADOUT[i],weapon=new HeldWeapon(slot.model,slot.specKey,this.you.team);weapon.setDualHand('left');this.leftWeapons.set(i,weapon);await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))}
    await this.pickupView.ready
    await Promise.all([...this.leftWeapons.values()].map(w=>w.ready))
    for(const w of this.leftWeapons.values())w.setDualHand('left')
    await Promise.all([...this.heldWeapons.values()].map(weapon => weapon.ready.catch(() => {})))
    const spares = [...this.heldWeapons.values(),...this.leftWeapons.values()].filter(weapon => weapon !== this.weapon)
    for (const weapon of spares) { weapon.lit = false; weapon.object.visible = true; this.camera.add(weapon.object) }
    return spares
  }
  stowWeapons(spares: readonly HeldWeapon[]): void {
    for (const weapon of spares) if (weapon !== this.weapon && weapon !== this.outgoing) { this.camera.remove(weapon.object); weapon.holster() }
  }

  private nearestPickup():WeaponPickup|undefined {
    if(!this.you.alive||this.vehicles.occupied||this.carrying)return undefined
    return nearestWeaponPickup(this.weaponPickups,this.you.state,performance.now(),p=>!this.sweep(this.you.eye(new THREE.Vector3()),new THREE.Vector3(p.x,p.y+.7,p.z),false))
  }
  get pickupPrompt():{name:string;left:boolean;transfer:boolean}|null {
    const p=this.nearestPickup();return p?{name:LOADOUT[p.slot].spec.name,left:dualSlot(this.slotIndex),transfer:dualSlot(this.slotIndex)&&this.offhandSlot<0}:null
  }
  get canPickupLeft():boolean{return dualSlot(this.slotIndex)&&!!this.nearestPickup()}
  /**
   * The vehicle E would board and the seat it would take (the server's rule: the driver's seat if free, else a Warthog's or
   * Mongoose's back seat), for the floating prompt. Null when E would do something else: pick up a weapon, drop a flag.
   */
  get vehiclePrompt():{kind:VehicleKind;seat:Seat}|null {
    if(!this.you.alive||this.vehicles.occupied||this.carrying||this.nearestPickup())return null
    const v=this.vehicles.nearest(this.you.object.position);if(!v)return null
    const seat:Seat|null=!this.net||!v.driver?'driver':(v.kind==='warthog'||v.kind==='mongoose')&&!v.gunner?'gunner':null
    return seat?{kind:v.kind,seat}:null
  }
  pickupWeapon(hand:'left'|'right'='left'):boolean {
    const p=this.nearestPickup();if(!p||this.net)return false
    const hands=pickupHands(this.slotIndex,p.slot,hand,this.offhandSlot)
    this.applyPickupHands(hands.primary,hands.offhand,hand)
    p.availableAt=performance.now()+20000
    return true
  }
  private applyPickupHands(primary:number,left:number,hand?:'left'|'right',leftAmmo?:number):void {
    // Capture before refilling: picking up a second copy must retain the old copy's ammo.
    const moved=hand==='right'&&this.offhandSlot<0&&left===this.slotIndex
      ?{ammo:leftAmmo??this.weapon.slot.ammo,reserve:this.weapon.slot.reserve}:undefined
    const keepLeft=hand==='right'&&left===this.offhandSlot&&left>=0
    if(hand==='right'||primary!==this.slotIndex)this.heldWeapons.get(primary)?.refill()
    if(primary!==this.slotIndex)this.selectSlot(primary,true,keepLeft)
    if(!keepLeft)this.equipOffhand(left,moved)
  }
  private cancelPlasmaCharge():void{this.effects.offhandReload(null);this.weapon.cancelCharge();this.offhand?.cancelCharge();this.effects.charge('right',false);this.effects.charge('left',false)}
  private equipOffhand(slot:number,moved?:{ammo:number;reserve:number}):void {
    this.cancelPlasmaCharge();this.buttons|=BTN_CANCEL_CHARGE
    if(slot<0&&this.offhand)this.buttons|=BTN_STOW_LEFT
    if(this.offhand){this.offhand.holster();this.camera.remove(this.offhand.object)}
    this.offhand=null;this.offhandSlot=-1;this.weapon.setDualHand(null)
    if(slot>=0&&dualSlot(this.slotIndex)){
      const weapon=this.leftWeapons.get(slot)
      if(weapon){this.offhand=weapon;this.offhandSlot=slot;weapon.refill();if(moved)Object.assign(weapon.slot,moved);weapon.activate();weapon.setDualHand('left');weapon.draw();weapon.lit=false;this.camera.add(weapon.object);this.weapon.setDualHand('right');this.zoomIndex=-1}
    }
    this.input.dualWield=!!this.offhand
    if(!this.offhand)this.input.setAltFire(false)
  }

  /** Seconds until you are back. The server holds online respawns for the same three seconds. */
  get respawnCountdown(): number {
    return this.net ? Math.max(0, 3 - Math.max(0, this.deathCamTime)) : Math.max(0, this.respawnIn)
  }

  /**
   * Halo's death camera: pull back out of the eye to circle your own corpse until the respawn.
   * The mouse still turns, so you can look around the body and see who did it.
   */
  private updateDeathCam(dt: number): void {
    const PULL_SECONDS = 0.8, DISTANCE = 4, DROP = 0.45
    if (this.deathCamTime < 0) {
      this.deathCamTime = 0
      this.deathCamDistance = 0
      this.deathCamFrom.copy(this.camera.position)
      this.you.deathFocus(this.deathCamFocus)
      this.zoomIndex = -1
      this.input.setAimZoom(1)
    }
    this.deathCamTime += dt
    const t = Math.min(1, this.deathCamTime / PULL_SECONDS)
    const ease = 1 - (1 - t) ** 3
    // Smooth the ragdoll's hips so its physics jitter does not shake the view.
    this.deathCamFocus.lerp(this.you.deathFocus(this.eye), 1 - Math.exp(-10 * dt))
    const yaw = this.input.yaw
    const pitch = Math.max(-1.35, Math.min(0.35, this.input.pitch - DROP * ease))
    this.forward.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
    // Keep the camera on this side of walls: snap in when something blocks, ease back out.
    let reach = DISTANCE
    const orbit = this.eye.copy(this.deathCamFocus).addScaledVector(this.forward, -DISTANCE)
    const hit = this.sweep(this.deathCamFocus, orbit, false)
    if (hit) reach = Math.max(0.3, hit.distanceTo(this.deathCamFocus) - 0.3)
    this.deathCamDistance = reach < this.deathCamDistance ? reach : this.deathCamDistance + (reach - this.deathCamDistance) * (1 - Math.exp(-4 * dt))
    orbit.copy(this.deathCamFocus).addScaledVector(this.forward, -this.deathCamDistance)
    if (!this.meshMap) orbit.y = Math.max(orbit.y, this.ground(orbit.x, orbit.z, orbit.y + 0.4) + 0.4)
    this.camera.position.lerpVectors(this.deathCamFrom, orbit, ease)
    this.camera.rotation.set(pitch, yaw, 0, 'YXZ')
    if (Math.abs(this.camera.fov - MOVE.fovDeg) > 0.001) { this.camera.fov = MOVE.fovDeg; this.camera.updateProjectionMatrix() }
  }

  /** Every living player's movement state (you, bots and remote players), for reactive scenery. */
  get feet(): readonly PlayerState[] {
    const out: PlayerState[] = []
    if (this.you.alive) out.push(this.you.state)
    for (const p of this.bots) if (p.alive) out.push(p.state)
    return out
  }

  /** `animate` plays the lower/raise; a respawn just hands over the default weapon. */
  private selectSlot(index: number, animate = true, preserveLeft = false): void {
    if(!preserveLeft)this.equipOffhand(-1)
    this.effects.cancelReload()
    this.swordLunge=null
    this.buttons&=~BTN_LUNGE
    this.zoomIndex = -1
    this.input.setAimZoom(1)
    // The old weapon is put away at once as far as gameplay goes, but stays on screen long
    // enough to be seen dropping out; the new one comes up behind it.
    if (this.outgoing) { this.outgoing.holster(); this.camera.remove(this.outgoing.object) }
    this.outgoing = null
    if (animate) { this.outgoing = this.weapon; this.weapon.lower() }
    else { this.weapon.holster(); this.camera.remove(this.weapon.object) }
    this.slotIndex = index
    let next = this.heldWeapons.get(this.slotIndex)
    if (!next) {
      const slot = LOADOUT[this.slotIndex]
      next = new HeldWeapon(slot.model, slot.specKey, this.you.team)
      this.heldWeapons.set(this.slotIndex, next)
    }
    if (next === this.outgoing) this.outgoing = null
    this.weapon = next
    this.weapon.setDualHand(this.offhand?'right':null)
    this.weapon.activate()
    if (animate) this.weapon.draw()
    this.camera.add(this.weapon.object)
  }

  setAiming(on: boolean): void {
    this.zoomIndex = on && this.weapon.slot.spec.zoom?.length ? 0 : -1
  }

  /** Every other Spartan in the match: bots offline, remote players online. */
  get others(): Player[] {
    return [...this.bots, ...[...this.remotes.values()].map(remote => remote.player)]
  }

  /** Living, unseated opponents shared by dash acquisition and its red reticle. */
  private swordTargets(): PlayerState[] {
    const targets=this.net
      ? Array.from(this.remotes.values()).filter(r=>!(r.pose.flags&FLAG_IN_VEHICLE)).map(r=>r.player)
      : this.bots
    return targets.filter(p=>p.alive&&this.hostile(this.you,p)).map(p=>p.state)
  }

  /** Center-ray feedback uses actual weapon reach and the first living body on the ray. */
  get targetInRange(): boolean {
    if(!this.you.alive)return false
    const vehicle=this.vehicles.occupied
    if(!vehicle&&this.weapon.isBlade)return this.swordTargetReady
    if(vehicle&&((vehicle.kind==='mongoose'||vehicle.kind==='warthog'&&!this.vehicleGunner)||this.vehicleAimObstructed))return false
    const range=vehicle ? vehicle.kind==='warthog'?120:SPLASH.bolt.maxRange
      : this.weapon.slot.id==='shotgun'?SHOTGUN.range
      : this.weapon.slot.id==='rocket-launcher'?Math.min(SPLASH.rocket.maxRange,(this.weapon.slot.spec.projectileSpeed??36)*7):400
    const origin=this.camera.position.clone(),direction=this.camera.getWorldDirection(new THREE.Vector3())
    const ray=new THREE.Ray(origin,direction)
    let nearest=range,enemy=false,contact:THREE.Vector3|null=null
    // The same shapes the server shoots at: red means the round would land on someone.
    for(const player of this.bots){
      if(!player.alive)continue
      const hit=rayHitBody(origin.x,origin.y,origin.z,direction.x,direction.y,direction.z,player.hitPose(),nearest)
      if(!hit)continue
      nearest=hit.dist;contact=origin.clone().addScaledVector(direction,hit.dist);enemy=this.hostile(this.you,player)
    }
    if(!enemy||!contact||this.sweep(origin,contact,false))return false
    if(vehicle){
      const muzzle=vehicle.model?.parts.anchors.get(vehicle.kind==='warthog'?'anchor:muzzle':'muzzle:right')
      if(muzzle&&this.sweep(muzzle.getWorldPosition(new THREE.Vector3()),contact,false))return false
    }
    return true
  }

  get swordTargetReady(): boolean {
    return this.you.alive && !this.vehicles.occupied && this.weapon.isBlade && this.weapon.canFire
      && swordTargetInRange(this.you.state,this.input.yaw,this.input.pitch+this.kick,this.swordTargets())
  }

  private requestSwordLunge(): void {
    this.shotYaw=this.input.yaw;this.shotPitch=this.input.pitch+this.kick
    this.buttons|=BTN_LUNGE
  }

  private offlineRunovers(vehicle:Vehicle,previous:{x:number;y:number;z:number}):void {
    if(this.net)return
    const now=this.elapsedSeconds
    for(const player of [this.you,...this.bots]){
      if(!player.alive||(player===this.you&&this.vehicles.occupied))continue
      const key=`${vehicle.id}:${player.id}`
      if((this.runoverCooldown.get(key)??0)>now)continue
      const damage=vehicleImpact(vehicle.kind,previous,vehicle.state,player.state)
      if(damage<=0)continue
      this.runoverCooldown.set(key,now+.75)
      vehicleCharacterImpulse(vehicle.kind,vehicle.state,player.state)
      const killed=player.damage(damage)
      if(player===this.you){if(killed){this.recordScore(null,player);this.respawnIn=3}}
      else{this.reportHit(this.you,player,killed,vehicle===this.vehicles.occupied?CAUSE_SPLATTER:CAUSE_UNKNOWN);if(killed)this.respawns.set(player,3)}
      if(killed)this.effects.death(1)
    }
    if(this.runoverCooldown.size>256)for(const [key,until] of this.runoverCooldown)if(until<now)this.runoverCooldown.delete(key)
  }

  /**
   * Third person sits over the right shoulder like Halo's own third-person views: the Spartan on the left of the screen, the crosshair
   * clear past it. Anything between the head and that spot pulls the camera in at once (it never looks through a wall), and it eases
   * back out when the way is clear.
   */
  private placeShoulderCamera(dt: number): void {
    this.camera.getWorldDirection(this.forward)
    // out to the shoulder first, then back from it: pulled in by a wall behind, the camera slides up to the shoulder and looks past
    // the head rather than into it
    const yaw = this.input.yaw, ease = 1 - Math.exp(-4 * dt)
    const reach = (from: THREE.Vector3, to: THREE.Vector3, now: number) => {
      const hit = this.sweep(from, to, false), allowed = hit ? Math.max(0, hit.distanceTo(from) - .22) / Math.max(1e-4, to.distanceTo(from)) : 1
      return allowed < now ? allowed : now + (allowed - now) * ease
    }
    const shoulder = this.eye.clone().add(new THREE.Vector3(Math.cos(yaw) * SHOULDER_CAM.side, SHOULDER_CAM.up, -Math.sin(yaw) * SHOULDER_CAM.side))
    this.shoulderSide = reach(this.eye, shoulder, this.shoulderSide)
    shoulder.lerpVectors(this.eye, shoulder, this.shoulderSide)
    const back = shoulder.clone().addScaledVector(this.forward, -SHOULDER_CAM.back)
    this.shoulderBack = reach(shoulder, back, this.shoulderBack)
    this.camera.position.lerpVectors(shoulder, back, this.shoulderBack)
    this.camera.position.y = Math.max(this.camera.position.y, this.ground(this.camera.position.x, this.camera.position.z, this.camera.position.y + 0.4) + 0.3)
  }

  /** Third person: the camera is beside the eye, not behind it, so the eye aims at whatever is under the crosshair (or 400 m down it). */
  private convergeOnCrosshair(): void {
    const from = this.camera.position.clone().addScaledVector(this.forward, this.camera.position.distanceTo(this.eye))
    const far = from.clone().addScaledVector(this.forward, 400)
    this.crosshairPoint.copy(this.sweep(from, far, true) ?? far)
    this.forward.copy(this.crosshairPoint).sub(this.eye).normalize()
  }
  /** Where the crosshair is on the world (set by convergeOnCrosshair). */
  private readonly crosshairPoint = new THREE.Vector3()
  /** A projectile's start and heading: from the gun you see (the Spartan's in third person, the viewmodel's in first) toward the point under
   * the crosshair, so a charged bolt or a needle leaves the muzzle rather than your eyes and still lands where you aimed. From the eye in a
   * vehicle, or when the muzzle is through a wall you are standing against. */
  private projectileFrom(muzzle: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
    if (this.vehicles.occupied || this.sweep(this.eye, muzzle, false)) return [this.eye.clone(), this.forward.clone()]
    if (!this.thirdPerson) { const far = this.eye.clone().addScaledVector(this.forward, 400); this.crosshairPoint.copy(this.sweep(this.eye, far, true) ?? far) }
    return [muzzle.clone(), this.crosshairPoint.clone().sub(muzzle).normalize()]
  }

  private shoot(weapon:HeldWeapon=this.weapon,left=false,charged=false): void {
    if(weapon.slot.id==='rocket-launcher' && this.rockets.activeCount>=12)return
    // in third person the round leaves the Spartan's own gun (the hidden first-person one sits at the camera)
    const shotMuzzle=this.vehicles.occupied?.kind==='mongoose'&&this.vehicleGunner?this.eye.clone():this.thirdPerson?this.you.muzzlePosition(new THREE.Vector3(),left):weapon.muzzlePosition()
    if (!weapon.fire(charged)) return
    // third person: the flash (and the kick) on the Spartan's own gun, as everyone else already sees it
    if(this.thirdPerson&&!this.vehicles.occupied&&!weapon.isMeleeWeapon)this.you.fire(left)
    if(left)this.effects.offhandReload(null)
    if(weapon.slot.id==='plasma-pistol')this.effects.charge(left?'left':'right',false)
    this.effects.cancelReload()
    // The camera is the crosshair. Touch input can still have a filtered pointer delta waiting
    // for the next fixed simulation step, so capture the direction the player actually sees at
    // trigger time and use that same ray for local FX, projectiles, and the server frame.
    this.camera.getWorldDirection(this.forward)
    if(this.thirdPerson&&!this.vehicles.occupied)this.convergeOnCrosshair()
    if(this.vehicles.occupied?.kind==='mongoose'&&this.vehicleGunner){const target=this.camera.position.clone().addScaledVector(this.forward,200);this.forward.copy(this.sweep(this.camera.position,target,true)??target).sub(this.eye).normalize()}
    this.shotYaw = Math.atan2(-this.forward.x, -this.forward.z)
    this.shotPitch = Math.asin(THREE.MathUtils.clamp(this.forward.y, -1, 1))
    this.kick += weapon.takeKick()
    this.onFire?.()

    if(weapon.slot.id==='rocket-launcher'){
      const obstruction=this.sweep(this.eye,shotMuzzle,false)
      this.effects.sound('rocket-launcher',.8)
      if(obstruction)this.explode(obstruction,300,6,'rocket')
      else {
        const speed=weapon.slot.spec.projectileSpeed??36
        // third person: from the tube toward the crosshair point, else down the eye line
        const heading=this.thirdPerson&&!this.vehicles.occupied?this.crosshairPoint.clone().sub(shotMuzzle).normalize():this.forward
        this.rockets.launch(shotMuzzle,heading,speed)
        this.net?.sendLaunch(SPLASH_KINDS.indexOf('rocket'),shotMuzzle.x,shotMuzzle.y,shotMuzzle.z,heading.x,heading.y,heading.z,speed)
      }
      return
    }
    // The server resolves the round from this frame's aim; what follows is only what we draw.
    // Sword damage and its network fire event happen once, at blade contact.
    if (weapon.slot.id==='gravity-hammer'||weapon.isBlade) this.you.action('melee',weapon.meleeProfile.duration)
    if (weapon.slot.id==='gravity-hammer') {this.effects.sound('hammer-windup',.8);return}
    if (weapon.isBlade) { this.effects.sound('energy-sword', .85);this.requestSwordLunge();return }
    this.buttons |= left ? BTN_ALT : BTN_FIRE
    if(charged){this.chargedPlasma.launch(...this.projectileFrom(shotMuzzle),this.you.id);this.effects.charge(left?'left':'right',false);this.effects.sound('plasma-pistol:charged',.8);this.effects.sound('plasma-pistol:vent',.5);return}
    if(weapon.slot.id==='needler'){this.needles.launch(...this.projectileFrom(shotMuzzle),this.you.id,this.you.id);this.effects.sound('needler',.6);return}
    if (!this.net && weapon.slot.id === 'shotgun') { this.offlineBuckshot(shotMuzzle); return }
    this.raycaster.set(this.eye, this.forward)
    this.raycaster.far = 400

    // Capsule-ish test against each bot: cheap, and exactly what the server will rewind later.
    let best: { player: Player; dist: number; head: boolean } | null = null
    for (const bot of this.bots) {
      if (!bot.alive) continue
      const hit = this.hitPlayer(bot, this.forward)
      if (hit && (!best || hit.dist < best.dist)) best = { player: bot, dist: hit.dist, head: hit.part === 'head' }
    }
    let stop = best?.dist ?? 150
    if (!this.meshMap) for (let distance = 0.5; distance < stop; distance += 0.5) {
      const x = this.eye.x + this.forward.x * distance
      const z = this.eye.z + this.forward.z * distance
      if (this.eye.y + this.forward.y * distance < this.ground(x, z)) { stop = distance; break }
    }

    if(isArena(this.map))stop=Math.min(stop,arenaRayDistance(this.map,this.eye.x,this.eye.y,this.eye.z,this.forward.x,this.forward.y,this.forward.z,stop))
    else if (this.map === 'guardian') stop = Math.min(stop, guardianRayDistance(this.eye.x, this.eye.y, this.eye.z, this.forward.x, this.forward.y, this.forward.z, stop))
    else if (this.map === 'lockout') stop = Math.min(stop, lockoutRayDistance(this.eye.x, this.eye.y, this.eye.z, this.forward.x, this.forward.y, this.forward.z, stop))
    else {
      this.sightRay.set(this.eye,this.forward);this.sightRay.near=.2;this.sightRay.far=stop
      const solid = this.sightRay.intersectObjects(this.cover,true)[0]
      if (solid) stop = Math.min(stop,solid.distance)
    }
    let endpoint = this.eye.clone().addScaledVector(this.forward,stop)
    const obstruction=this.sweep(this.eye,shotMuzzle,false)??this.sweep(shotMuzzle,endpoint,false)
    if(obstruction){endpoint=obstruction;best=null}
    this.effects.shot(shotMuzzle,endpoint,weapon.slot.id)
    // Buckshot: a fan of short tracers around the one that was actually traced, so a shot that
    // resolves as fifteen pellets on the server looks like fifteen leaving the barrel here.
    const pellets = weapon.slot.spec.pellets ?? 1
    if (pellets > 1) {
      const spread = Math.tan(((weapon.slot.spec.spreadDeg ?? 8) * Math.PI) / 180)
      for (let i = 1; i < Math.min(pellets, 8); i++) {
        const a = i * 2.39996, r = Math.sqrt((i + .5) / pellets) * spread
        const scatter = endpoint.clone().sub(shotMuzzle)
        const length = scatter.length()
        scatter.normalize()
        const side = new THREE.Vector3().crossVectors(scatter, new THREE.Vector3(0, 1, 0)).normalize()
        const up = new THREE.Vector3().crossVectors(side, scatter)
        scatter.addScaledVector(side, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize()
        this.effects.shot(shotMuzzle, shotMuzzle.clone().addScaledVector(scatter, length), weapon.slot.id, 0)
      }
    }
    if (!best || stop < best.dist) { if(stop < 150)this.effects.impact(endpoint,false,'world',weapon.slot.id); return }
    this.effects.impact(endpoint,best.player.shield>0,'body',weapon.slot.id)
    if (this.net) return
    const headshot = best.head
    // Offline the whole pattern is judged as one ray, so the pellets are folded into it with
    // the same falloff the server applies to each of them.
    const falloff = pellets > 1
      ? 1 + (SHOTGUN.farDamage / weapon.slot.spec.damage - 1) * Math.max(0, Math.min(1, (best.dist - SHOTGUN.fullRange) / (SHOTGUN.farRange - SHOTGUN.fullRange)))
      : 1
    const dmg = headshot && this.objectives.spec.headshotsKill ? 10_000
      : weapon.slot.spec.damage * pellets * falloff * (headshot ? (weapon.slot.spec.headshotMultiplier ?? 1) * 2 : 1)
    const killed = best.player.damage(dmg,undefined,{point:endpoint,direction:this.forward,strength:corpseBulletStrength(weapon.slot.id)})
    this.reportHit(this.you, best.player, killed, this.slotIndex, headshot ? HIT_HEADSHOT : 0)
    if (killed) {
      this.effects.death(best.dist)
      this.respawns.set(best.player, 2.5)
    }
  }

  /** Resolve each pellet independently, using the server's golden-angle spread. */
  private offlineBuckshot(muzzle: THREE.Vector3): void {
    const spec=this.weapon.slot.spec, count=spec.pellets ?? 1
    const right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),this.forward).normalize()
    const up=new THREE.Vector3().crossVectors(this.forward,right)
    const tally=new Map<Player,{damage:number;pellets:number;impact:BulletImpact}>()
    this.effects.sound('shotgun',1)
    for(let i=0;i<count;i++) {
      const radius=Math.tan(Math.sqrt((i+.5)/count)*(spec.spreadDeg??10)*Math.PI/180),angle=i*2.39996
      const direction=this.forward.clone().addScaledVector(right,Math.cos(angle)*radius).addScaledVector(up,Math.sin(angle)*radius).normalize()
      this.raycaster.set(this.eye,direction);this.raycaster.far=SHOTGUN.range
      let best: {player:Player;dist:number}|null=null
      for(const player of this.bots) {
        if(!player.alive||!this.hostile(this.you,player))continue
        // Each pellet is traced along its own line, not the centre of the pattern.
        const dist=this.hitPlayer(player,direction)?.dist??null
        if(dist!==null&&dist<=SHOTGUN.range&&(!best||dist<best.dist))best={player,dist}
      }
      let endpoint=this.eye.clone().addScaledVector(direction,best?.dist??SHOTGUN.range)
      const obstacle=this.sweep(this.eye,endpoint,false)??this.sweep(muzzle,endpoint,false)
      if(obstacle){endpoint=obstacle;best=null}
      this.effects.shot(muzzle,endpoint,'shotgun',0)
      if(best) {
        const blend=Math.max(0,Math.min(1,(best.dist-SHOTGUN.fullRange)/(SHOTGUN.farRange-SHOTGUN.fullRange)))
        const entry=tally.get(best.player)??{damage:0,pellets:0,impact:{point:endpoint.clone(),direction:direction.clone(),strength:0}}
        entry.damage+=spec.damage+(SHOTGUN.farDamage-spec.damage)*blend;entry.pellets++
        entry.impact.strength=corpseBulletStrength('shotgun',entry.pellets);tally.set(best.player,entry)
        this.effects.impact(endpoint,best.player.shield>0,'body')
      }else if(obstacle)this.effects.impact(endpoint,false)
    }
    for(const [player,entry] of tally) {
      const killed=player.damage(entry.damage,undefined,entry.impact);this.reportHit(this.you,player,killed,this.slotIndex)
      if(killed){this.respawns.set(player,2.5);this.effects.death(1)}
    }
  }

  /**
   * A swing that reaches: the fist, or the sword's own arc. Online this only draws and sounds;
   * the server decides who was in front of the blade, from where it had them.
   */
  private swing(damage: number, reach: number, cone: number): void {
    this.camera.getWorldDirection(this.forward)
    const candidates = this.bots.filter(p => p.alive && Math.hypot(p.state.x - this.you.state.x, p.state.z - this.you.state.z) < reach)
      .sort((a, b) => a.object.position.distanceToSquared(this.you.object.position) - b.object.position.distanceToSquared(this.you.object.position))
    // Swing sound is emitted once at animation start.
    for (const p of candidates) {
      const point = p.eye().add(new THREE.Vector3(0, -.25, 0))
      const direction = point.clone().sub(this.eye).normalize()
      if (direction.dot(this.forward) < cone || !this.canSee(this.you, p)) continue
      this.effects.impact(point, p.shield > 0, 'body')
      if (!this.net) this.effects.sound(`melee-impact:${this.weapon.slot.id}`, .85)
      if (this.net) break
      const killed = p.damage(damage)
      this.reportHit(this.you, p, killed, this.slotIndex)
      if (killed) { this.respawns.set(p, 3); this.effects.death(1) }
      break
    }
  }

  private hammerHit():void {
    this.shotYaw=this.input.yaw;this.shotPitch=this.input.pitch
    this.buttons|=BTN_FIRE
    const center=new THREE.Vector3(this.you.state.x-Math.sin(this.input.yaw)*1.8,this.you.state.y+.8,this.you.state.z-Math.cos(this.input.yaw)*1.8)
    this.effects.shockwave(center);this.effects.sound('gravity-hammer',.95);this.kick+=.035
    if(this.net || this.sweep(new THREE.Vector3(this.you.state.x,this.you.state.y+.8,this.you.state.z),center,false))return
    for(const p of this.bots){
      if(!p.alive||!this.hostile(this.you,p))continue
      const target=new THREE.Vector3(p.state.x,p.state.y+.8,p.state.z),delta=target.clone().sub(center),d=delta.length()
      if(d>4||this.sweep(center,target,false))continue
      const killed=p.damage(160*Math.max(0,1-Math.max(0,d-1.8)/2.2),delta.clone().normalize().multiplyScalar(12))
      p.state.vx+=delta.x/(d||1)*12;p.state.vz+=delta.z/(d||1)*12;p.state.vy=8;p.state.onGround=false
      this.reportHit(this.you,p,killed,this.slotIndex);if(killed){this.respawns.set(p,3);this.effects.death(1)}
    }
    for(const v of this.vehicles.all)applyVehicleBlast(v.kind,v.state,center,6,18)
    blastRagdolls(center,6,18,(a,b)=>!this.sweep(a,b,false))
  }

  private meleeHit():void {
    if(this.weapon.slot.id==='gravity-hammer'){this.hammerHit();return}
    if (this.weapon.isBlade) {
      this.shotYaw = this.input.yaw; this.shotPitch = this.input.pitch + this.kick
      this.camera.getWorldDirection(this.forward)
      const blade = LOADOUT[this.slotIndex].melee!
      this.swing(this.weapon.slot.spec.damage, blade.reach, blade.cone)
      this.buttons |= BTN_FIRE
      return
    }
    this.shotYaw = this.input.yaw
    this.shotPitch = this.input.pitch + this.kick
    this.camera.getWorldDirection(this.forward)
    // A close strike also transfers momentum to a nearby vehicle. The same shared rigid-body
    // impulse runs offline and on the authority, so an overturned Warthog can be shoved and
    // spun by melee instead of only registering character damage.
    for(const vehicle of this.vehicles.all){
      if(!vehicle.model||vehicle===this.vehicles.occupied)continue
      const dx=vehicle.state.x-this.you.state.x,dy=(vehicle.state.y+.8)-this.eye.y,dz=vehicle.state.z-this.you.state.z
      const distance=Math.hypot(dx,dz)
      if(distance>this.weapon.meleeProfile.reach+1.4||distance<.05)continue
      const to=new THREE.Vector3(dx,dy,dz).normalize()
      if(to.dot(this.forward)<.5||this.sweep(this.eye,this.eye.clone().add(to.multiplyScalar(distance)),false))continue
      applyVehicleMelee(vehicle.kind,vehicle.state,{x:vehicle.state.x,y:vehicle.state.y+.7,z:vehicle.state.z},{x:to.x,y:to.y,z:to.z})
      this.vehicles.syncObject(vehicle)
      this.effects.impact(new THREE.Vector3(vehicle.state.x,vehicle.state.y+.7,vehicle.state.z),false)
      break
    }
    const reach=this.weapon.meleeProfile.reach
    const candidates=this.bots.filter(p=>p.alive&&Math.hypot(p.state.x-this.you.state.x,p.state.z-this.you.state.z)<reach)
      .sort((a,b)=>a.object.position.distanceToSquared(this.you.object.position)-b.object.position.distanceToSquared(this.you.object.position))
    for(const p of candidates){
      const point=p.eye().add(new THREE.Vector3(0,-.25,0)),direction=point.clone().sub(this.eye).normalize()
      if(direction.dot(this.forward)<.65||!this.canSee(this.you,p))continue
      // Online the contact sound comes from the server's own ruling in onServerHit; playing it
      // here as well would flam the same recording against itself a round trip later.
      this.effects.impact(point,p.shield>0)
      if(!this.net)this.effects.sound(`melee-impact:${this.weapon.slot.id}`,.85)
      if(this.net)break
      const behind=fromBehind(p.object.rotation.y,p.state.x,p.state.z,this.you.state.x,this.you.state.z)
      const killed=p.damage(60);this.reportHit(this.you,p,killed,this.slotIndex,HIT_MELEE|(behind?HIT_BEHIND:0))
      if(killed){this.respawns.set(p,3);this.effects.death(1)}
      break
    }
    // The server swings from where it has us, at whoever it has in reach.
    this.buttons|=BTN_MELEE
  }

  /** Sweep terrain and scene solids, leaving the contact just outside the struck surface. */
  private sweep(a:THREE.Vector3,b:THREE.Vector3,players:boolean):THREE.Vector3|null {
    const dir=b.clone().sub(a),length=dir.length();if(length<.00001)return null;dir.divideScalar(length)
    let distance=Infinity
    this.sightRay.set(a,dir);this.sightRay.near=0;this.sightRay.far=length
    const meshMap=this.meshMap
    if(isArena(this.map)){const hit=arenaRayDistance(this.map,a.x,a.y,a.z,dir.x,dir.y,dir.z,length);if(hit<length)distance=hit}
    else if(this.map==='guardian'){const hit=guardianRayDistance(a.x,a.y,a.z,dir.x,dir.y,dir.z,length);if(hit<length)distance=hit}
    else if(this.map==='lockout'){const hit=lockoutRayDistance(a.x,a.y,a.z,dir.x,dir.y,dir.z,length);if(hit<length)distance=hit}
    else distance=this.sightRay.intersectObjects(this.cover,true)[0]?.distance??Infinity
    let terrainHit=false
    const aboveGround=(t:number)=>a.y+dir.y*t-this.ground(a.x+dir.x*t,a.z+dir.z*t)
    // Mesh maps have stacked decks: highest-floor sampling would fill every hallway
    // underneath them with an invisible solid. Only Blood Gulch is a heightfield.
    if(!meshMap&&aboveGround(0)<0){distance=0;terrainHit=true}
    else if(!meshMap){
      // Always include the segment endpoint. Refine a crossing rather than returning the
      // first underground sample: buried contacts can make a nearby blast occlude itself.
      const extent=Math.min(length,distance),steps=Math.ceil(extent/.25)
      let previous=0
      for(let i=1;i<=steps;i++){
        const t=extent*i/steps
        if(aboveGround(t)<=0){
          let low=previous,high=t
          for(let j=0;j<10;j++){const middle=(low+high)*.5;if(aboveGround(middle)>0)low=middle;else high=middle}
          distance=low;terrainHit=true;break
        }
        previous=t
      }
    }
    // Projectiles are simulated locally for responsive visuals, but online enemies live in the
    // remote-player map rather than `bots`. Include both populations so Ghost/Banshee plasma and
    // rockets detonate on a remote Spartan instead of flying through them to the next hillside.
    if(players)for(const p of [...this.bots, ...[...this.remotes.values()].map(remote => remote.player)]){if(!p.alive)continue
      for(const y of [.45,1,1.55]){const sphere=new THREE.Sphere(new THREE.Vector3(p.state.x,p.state.y+y,p.state.z),.48),hit=this.sightRay.ray.intersectSphere(sphere,new THREE.Vector3());if(hit){const d=hit.distanceTo(a);if(d<=length&&d<distance){distance=d;terrainHit=false}}}
    }
    if(distance>length)return null
    const point=a.clone().addScaledVector(dir,Math.max(0,distance-.003))
    if(terrainHit)point.y=Math.max(point.y,this.ground(point.x,point.z)+.003)
    return point
  }
  /** The outward face a blast went off against, probed along the six axes; up in the open. */
  private blastNormal(point:THREE.Vector3):THREE.Vector3 {
    const normal=new THREE.Vector3(0,1,0),probe=new THREE.Vector3()
    let nearest=.7
    for(const [x,y,z] of [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]] as const){
      const hit=this.sweep(point,probe.set(point.x+x*.7,point.y+y*.7,point.z+z*.7),false)
      const distance=hit?hit.distanceTo(point):Infinity
      if(distance<nearest){nearest=distance;normal.set(-x,-y,-z)}
    }
    return normal
  }
  /** `stuck`: who a plasma grenade was stuck to (the Stick medal). */
  private explode(point:THREE.Vector3,damage:number,radius:number,kind:SplashKind,stuck:Player|null=null):void {
    const bolt=kind==='bolt'||kind==='chopper'
    blastRagdolls(point,radius,blastStrength(kind),(a,b)=>!this.sweep(a,b,false))
    if(bolt)this.effects.impact(point,true)
    else {this.explosions.explode(point,kind,this.blastNormal(point));this.effects.sound(kind==='fuelrod'?'fuel-rod-explosion':'explosion',.9/(1+point.distanceTo(this.you.object.position)*.025))}
    if(this.net){
      // Ours to report, the server's to judge: it decides who was inside the blast.
      const stuckId=stuck?[...this.remotes].find(([,remote])=>remote.player===stuck)?.[0]??0:0
      this.net.sendSplash(SPLASH_KINDS.indexOf(kind),point.x,point.y,point.z,stuckId)
      if(point.distanceTo(this.you.object.position)<radius)this.kick+=0.01
      return
    }
    // The contact already lies outside the surface. Moving it toward each target can put
    // the blast through thin cover, or below sloping terrain, before testing visibility.
    const origin=point.clone()
    if(this.map==='blood-gulch')origin.y=Math.max(origin.y,this.ground(origin.x,origin.z)+.003)
    for(const v of this.vehicles.all){
      const center=new THREE.Vector3(v.state.x,v.state.y+.8,v.state.z)
      if(!this.sweep(origin,center,false))applyVehicleBlast(v.kind,v.state,origin,radius,blastStrength(kind))
    }
    for(const p of [this.you,...this.bots]){if(!p.alive)continue
      const center=new THREE.Vector3(p.state.x,p.state.y+.9,p.state.z),distance=center.distanceTo(point);if(distance>radius)continue
      if(this.sweep(origin,center,false))continue
      if(bolt&&p===this.you)continue
      if(!(p===this.you&&this.vehicles.occupied))applyPlayerBlast(p.state,origin,radius,blastStrength(kind))
      const hadShield=p.shield>0
      const killed=p.damage(bolt?damage:damage*Math.max(0,1-distance/radius));this.effects.impact(center,hadShield)
      if(p===this.you){if(!['sniper','battle-rifle'].includes(this.weapon.slot.id)||killed)this.zoomIndex=-1;if(killed)this.respawnIn=3}
      else{this.reportHit(this.you,p,killed,splashCause(kind,p===stuck));if(killed)this.respawns.set(p,3)}
      if(killed)this.effects.death(distance)
    }
  }
  private interactVehicle():void {
    const occupied=this.vehicles.occupied
    if(occupied){
      if(this.vehicles.isExiting)return
      // The same spot the server would pick, so offline and online step out to the same place.
      const spot={x:0,y:0,z:0}
      if(exitSpot(occupied.state,spot)){
        const p=new THREE.Vector3(spot.x,spot.y,spot.z)
        const airborne=spot.y>this.ground(spot.x,spot.z,spot.y+.5)+.5
        this.vehicles.beginExit(p,()=>{
          Object.assign(this.you.state,{x:p.x,y:p.y,z:p.z,vx:0,vy:0,vz:0,onGround:!airborne,fallFrom:p.y})
          this.you.object.position.copy(p);this.you.object.visible=true
          this.vehicles.occupied=null;this.vehicleGunner=false;this.weapon.object.visible=true
        }); return
      }
    }else{const nearby=this.vehicles.nearest(this.you.object.position);if(nearby){this.weapon.holster();this.vehicles.enter(nearby,this.you.object.position);this.vehicleGunner=false;this.zoomIndex=-1}}
  }
  /** Camera owns targeting. Converge from the turret pivot without feeding barrel pose into input. */
  private turretTarget(v:Vehicle,yaw:number,pitch:number):THREE.Vector3 {
    const look=new THREE.Vector3(-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch))
    const end=this.camera.position.clone().addScaledVector(look,200)
    this.vehicleAimPoint.copy(this.sweep(this.camera.position,end,true)??end)
    const pivot=v.model?.parts.pitch?.getWorldPosition(new THREE.Vector3())??v.object.position.clone().add(new THREE.Vector3(0,2.76,0))
    return this.vehicleAimPoint.clone().sub(pivot).normalize()
  }

  private updateVehicle(dt:number):void {
    this.swordLunge=null
    this.input.setAimZoom(1)
    this.you.updateVitals(dt)
    const v=this.vehicles.occupied!
    const hornPressed = this.input.consume('hornPressed')
    if (hornPressed && v.kind === 'warthog' && !this.vehicleGunner && !this.vehicles.isExiting) {
      this.effects.sound('warthog-horn', .9)
      if (this.net) this.buttons |= BTN_HORN
    }
    if(this.input.consume('interactPressed')) { if (this.net) this.buttons |= BTN_INTERACT; else this.interactVehicle() }
    if(this.input.consume('viewPressed')&&(v.kind==='warthog'||v.kind==='mongoose')&&!this.vehicles.isExiting){ if(this.net) this.buttons|=BTN_SEAT; else this.vehicleGunner=!this.vehicleGunner }
    // Driving runs on the same fixed step as walking, through the shared simulation.
    this.stepAccumulator = Math.min(this.stepAccumulator + dt, 0.25)
    while (this.stepAccumulator >= STEP) { this.stepAccumulator -= STEP; this.stepYou() }
    // Offline the gunner's Warthog has nobody at the wheel; it coasts.
    if (!this.net && this.vehicleGunner) {const before={x:v.state.x,y:v.state.y,z:v.state.z};this.vehicles.coast(v, dt);this.offlineRunovers(v,before)}
    Object.assign(this.you.state,{x:v.object.position.x,y:v.object.position.y+.8,z:v.object.position.z,vx:0,vy:0,vz:0})
    if(v.kind==='mongoose')seatWorld(v.kind,v.state,this.vehicleGunner?'gunner':'driver',this.you.state)
    this.you.object.position.set(this.you.state.x,this.you.state.y,this.you.state.z);this.you.object.visible=false
    this.weapon.object.visible=false;this.zoomIndex=-1
    this.camera.fov=MOVE.fovDeg;this.camera.updateProjectionMatrix()
    this.camera.rotation.set(this.input.pitch,this.input.yaw,0,'YXZ');this.camera.getWorldDirection(this.forward)
    // Follow the physical centre of mass, with vertical suspension motion damped. The
    // mouse owns the horizon; body pitch/roll never rotates the chase camera or its orbit.
    const bodyCenter=v.object.localToWorld(new THREE.Vector3(0,v.kind==='warthog'?1.10:v.kind==='ghost'?.35:.6,0))
    const cameraKey=`${v.id}:${this.vehicleGunner}`
    if(cameraKey!==this.vehicleCameraKey||Math.abs(bodyCenter.y-this.vehicleCameraHeight)>3){this.vehicleCameraKey=cameraKey;this.vehicleCameraHeight=bodyCenter.y}
    else this.vehicleCameraHeight+=(bodyCenter.y-this.vehicleCameraHeight)*(1-Math.exp(-12*Math.max(0,dt)))
    bodyCenter.y=this.vehicleCameraHeight
    if (this.vehicleGunner && v.kind === 'warthog' && v.model?.parts.pitch) {
      // Orbit only in yaw: changing pitch must not push the camera into/out of the hillside.
      const pivot = bodyCenter.clone().add(new THREE.Vector3(Math.sin(v.state.yaw)*1.4,1.81,Math.cos(v.state.yaw)*1.4))
      const desired = pivot.clone().add(new THREE.Vector3(Math.sin(this.input.yaw)*6.5,2.4,Math.cos(this.input.yaw)*6.5))
      const wall = this.sweep(pivot, desired, false)
      this.camera.position.copy(wall ? wall.lerp(pivot,.08) : desired)
      this.camera.position.y=Math.max(this.camera.position.y,this.ground(this.camera.position.x,this.camera.position.z,this.camera.position.y+.5)+.5)
      // Keep the camera's rotation exactly at mouse aim; never lookAt a terrain-dependent point.
    } else {
      // The flier gets a longer, higher chase so its arms and the ground both stay in frame. The Warthog driver sits
      // back like Halo 3's (reference/halo3/driving): the hog small and low in frame, the aim point clear above its roof.
      const flying=v.kind==='banshee',hogDriver=v.kind==='warthog'
      const focus=bodyCenter.clone().add(new THREE.Vector3(0,flying?2:hogDriver?1.6:1.65,0)),desired=focus.clone().addScaledVector(this.forward,flying?-13:hogDriver?-12:-7)
      const wall=this.sweep(focus,desired,false);this.camera.position.copy(wall?wall.addScaledVector(this.forward,.3):desired)
    }
    this.camera.position.y=Math.max(this.camera.position.y,this.ground(this.camera.position.x,this.camera.position.z,this.camera.position.y+.5)+.5)
    this.camera.updateWorldMatrix(true,false)
    const plasmaVehicle=v.kind==='ghost'||v.kind==='banshee'||v.kind==='chopper'
    const turretGunner=this.vehicleGunner&&v.kind==='warthog'
    this.vehicleAimObstructed=false
    this.vehicleReticle.set(0,0,0)
    if(this.vehicleGunner && v.kind==='warthog') {
      const desired=this.turretTarget(v,this.input.yaw,this.input.pitch)
      this.vehicles.aimTurret(v,Math.atan2(-desired.x,-desired.z),Math.asin(THREE.MathUtils.clamp(desired.y,-1,1)))
      this.vehicleAimObstructed=this.vehicles.muzzleDirection(v,new THREE.Vector3()).dot(desired)<.9995
    }else if(plasmaVehicle){
      this.camera.getWorldDirection(this.forward)
      const end=this.camera.position.clone().addScaledVector(this.forward,200)
      this.vehicleAimPoint.copy(this.sweep(this.camera.position,end,true)??end)
    }
    this.vehicles.updateRider(this.you.team, this.vehicleGunner, this.camera.position)
    this.driveOthers(dt)
    const pressed=this.input.consumeFire()
    const fire=!this.vehicles.isExiting&&(pressed||this.input.fireHeld)
    if(v.kind==='mongoose'&&this.vehicleGunner){
      this.weapon.update(dt,0,false)
      this.eye.set(this.you.state.x,this.you.state.y+MOVE.eyeHeight,this.you.state.z)
      if(this.input.consume('reloadPressed')){this.weapon.reload();this.buttons|=BTN_RELOAD}
      if(fire&&!this.weapon.isBlade&&this.weapon.slot.id!=='gravity-hammer')this.shoot()
    }
    if(v.kind==='banshee'&&this.input.consume('zoomPressed')&&this.fuelRodIn<=0&&!this.vehicles.isExiting){
      this.fuelRodIn=1.6
      v.object.updateWorldMatrix(true,true)
      const start=this.vehicles.fuelRodPosition(v,new THREE.Vector3())
      this.forward.copy(this.vehicleAimPoint).sub(start).normalize()
      this.fuelRod.launch(start,this.forward,42)
      this.net?.sendLaunch(SPLASH_KINDS.indexOf('fuelrod'),start.x,start.y,start.z,this.forward.x,this.forward.y,this.forward.z,42)
      this.effects.sound('fuel-rod',.5)
    }
    this.vehicles.setFiring(v,fire&&(plasmaVehicle||turretGunner))
    // The chain gun is the server's hitscan online: hold fire on the wire and it fires at its own cadence.
    if(fire&&turretGunner&&this.net)this.buttons|=BTN_FIRE
    if(fire&&this.vehicleFireIn<=0&&(plasmaVehicle||turretGunner)){
      this.vehicleFireIn=v.kind==='chopper'?.25:plasmaVehicle?.15:.10
      v.object.updateWorldMatrix(true,true)
      const start=this.vehicles.muzzlePosition(v,this.plasmaSide,new THREE.Vector3())
      const barrelDirection=this.vehicles.muzzleDirection(v,new THREE.Vector3())
      if(plasmaVehicle)this.forward.copy(this.vehicleAimPoint).sub(start).normalize()
      this.plasmaSide=!this.plasmaSide
      if(plasmaVehicle){
        const speed=v.kind==='chopper'?85:v.kind==='banshee'?75:55
        if(v.kind==='chopper'){this.chopperRounds.launch(start,this.forward,speed);this.effects.sound('warthog',.65)}
        else {this.plasma.launch(start,this.forward,speed);this.effects.sound(v.kind==='banshee'?'banshee':'ghost',.6)}
        this.net?.sendLaunch(SPLASH_KINDS.indexOf(v.kind==='chopper'?'chopper':'bolt'),start.x,start.y,start.z,this.forward.x,this.forward.y,this.forward.z,speed)
        return
      }
      const end=start.clone().addScaledVector(barrelDirection,120),hit=this.sweep(start,end,true)
      this.effects.shot(start,hit??end,'warthog',.65)
      if(hit){
        this.effects.impact(hit,false)
        if(this.net)return
        for(const bot of this.bots){
          const center=new THREE.Vector3(bot.state.x,bot.state.y+1,bot.state.z)
          if(bot.alive&&hit.distanceTo(center)<1.2&&!this.sweep(hit,center,false)){
            const killed=bot.damage(12,undefined,{point:hit,direction:barrelDirection,strength:corpseBulletStrength('warthog')});this.reportHit(this.you,bot,killed,CAUSE_VEHICLE_GUN);if(killed)this.respawns.set(bot,3);break
          }
        }
      }
    }
    for(const edge of ['pickupLeftPressed','reloadPressed','swapPressed','meleePressed','grenadePressed','zoomPressed','grenadeSwitchPressed'] as const)this.input.consume(edge)
  }

  /** Where a ray from the eye meets this player's body (its hit shapes), or null. */
  private hitPlayer(p: Player, direction: THREE.Vector3): BodyHit | null {
    const hit = rayHitBody(this.eye.x, this.eye.y, this.eye.z, direction.x, direction.y, direction.z, p.hitPose(), this.raycaster.far)
    if (!hit) return null
    // Ground blocks the shot before the target does; mesh maps already stopped the ray at the mesh.
    if (!this.meshMap && this.eye.y + direction.y * hit.dist < this.ground(this.eye.x + direction.x * hit.dist, this.eye.z + direction.z * hit.dist)) return null
    return hit
  }

}
