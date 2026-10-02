import {createMuzzleFlash} from './muzzle-flash.ts'
import { firstPersonBodyGeometry } from './first-person-body.ts'
import * as THREE from 'three'
import { poseFingers } from './finger-pose.ts'
import { makeRifleIdle, makeRifleBreathing, measureRifleLimb, poseRifleLimb } from '../rifle-pose.ts'
import { rigFor, type HandAnchor } from './viewmodel.ts'
import chiefHolds from './chief-holds.json'
import tpHolds from './tp-holds.json'
import { loadResource } from '../load-resource.ts'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { TEAM_TINT, type ModelId, type Team } from '../../../shared/assets.ts'
import { addArmorEdges, armorSurface, injectArmor, type ArmorSurface } from './armor-surface.ts'
import { createLegIK, type FloorQuery } from './leg-ik.ts'

/**
 * The generated Spartan: a skinned character with real animation clips.
 *
 * Loaded once and instanced per player. Skinned meshes cannot be cloned with `Object3D.clone`
 * — the copy would share one skeleton and every player would move identically — so instancing
 * goes through SkeletonUtils, which duplicates the bone hierarchy and rebinds the skin.
 *
 * Locomotion blends between idle, walking and running by speed rather than switching, so a
 * Spartan easing to a stop does not snap between poses.
 */

const forceHighDetail = new URLSearchParams(location.search).get('character-detail') === 'high'
/** The wearer's own body (first person): where its waist is cut (fraction of the body's height), how far behind the eye it stands, how far
 * it leans back about the feet (radians; hips behind the eye, boots still under it), and how much more while crouched (the crouched knees
 * otherwise come up in front of the lens). `?fpbody=cut,back,crouchBack,tilt,crouchTilt` tunes it. */
const FP_BODY = (() => { const q = new URLSearchParams(location.search).get('fpbody')?.split(',').map(Number); return { cut: q?.[0] ?? .62, back: q?.[1] ?? .02, crouchBack: q?.[2] ?? .3, tilt: q?.[3] ?? .24, crouchTilt: q?.[4] ?? 0 } })()
const URL = '/assets/characters/spartan.glb'

/** Clip names as merged into the file. */
const IDLE = 'idle'
const WALK = 'walking'
const RUN = 'running'
const CROUCH = 'crouchwalk'
const AIR = 'fall'
const JUMP = 'jump'
const HIT = 'hit'
const DEATH = 'death'

/** Above this speed the run clip is fully weighted; below it, walk. */
const RUN_SPEED = 5.2
const WALK_SPEED = 0.6

let template: Promise<THREE.Group> | null = null
/** Floor height under a point, for planting feet (leg-ik.ts); set by the match for its map. `?legik=0` turns the procedural legs off. */
let spartanFloor: FloorQuery | null = null
export function setSpartanFloor(floor: FloorQuery | null): void { spartanFloor = floor }
const legsEnabled = new URLSearchParams(location.search).get('legik') !== '0'
let clips: THREE.AnimationClip[] = []
const detailGeometries = new Map<string, THREE.BufferGeometry[]>()
/** Team-tinted copies of each source texture (a body can have several materials, each with its own map). */
const teamMaps = new Map<THREE.Texture, Map<Team, THREE.Texture>>()

/**
 * Recolour the armour for a team, once per team, by rewriting the base map.
 *
 * The generated texture is Master Chief green, so multiplying it by a blue tint only produces
 * dark green — the hue has to be discarded rather than modulated. Luminance is kept, because
 * that is where the panel lines, scuffing and shading live, and the team colour is applied to
 * it. Telling red from blue across the canyon is not decoration; it decides who you shoot.
 *
 * Done on a canvas rather than in a shader: material chunk names drift between three.js
 * versions, and a tint that silently fails to compile looks exactly like a tint that was never
 * applied.
 */
export function teamMap(team: Team, sourceMap: THREE.Texture): THREE.Texture {
  const cached = teamMaps.get(sourceMap)?.get(team)
  if (cached) return cached
  const src = sourceMap.image as (HTMLImageElement | ImageBitmap | undefined)
  if (!src) return sourceMap

  const w = (src as ImageBitmap).width
  const h = (src as ImageBitmap).height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src as CanvasImageSource, 0, 0, w, h)

  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  // Recolour green armour only; keep the gold visor and dark undersuit intact.
  const tint = new THREE.Color(TEAM_TINT[team]).convertLinearToSRGB()
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2]
    const mask = THREE.MathUtils.clamp((g - b - 6) / 24, 0, 1)
      * THREE.MathUtils.clamp((g - r * 0.85) / 20, 0, 1)
    const light = Math.min(1, Math.max(r, g, b) / 180)
    d[i] = THREE.MathUtils.lerp(r, tint.r * light * 255, mask)
    d[i + 1] = THREE.MathUtils.lerp(g, tint.g * light * 255, mask)
    d[i + 2] = THREE.MathUtils.lerp(b, tint.b * light * 255, mask)
  }
  ctx.putImageData(img, 0, 0)

  const tex = new THREE.CanvasTexture(canvas)
  tex.flipY = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  let byTeam = teamMaps.get(sourceMap); if (!byTeam) teamMaps.set(sourceMap, byTeam = new Map())
  byTeam.set(team, tex)
  return tex
}

async function load(): Promise<THREE.Group> {
  // The high, medium and low meshes are independent requests. Fetch/decode them together so
  // the character warm-up is bounded by the slowest LOD rather than three serial round trips.
  const [gltf, medium, low] = await Promise.all([
    loadResource(URL),
    loadResource('/assets/characters/spartan-medium.glb'),
    loadResource('/assets/characters/spartan-low.glb'),
  ])
  clips = gltf.animations
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) {
      // Player shadows are deliberately disabled. A dozen animated skinned casters force a
      // large dynamic shadow pass every frame and cost far more than the small silhouette they
      // contribute in first-person combat. Map and vehicle shadows remain available.
      m.castShadow = false
      m.receiveShadow = false
      if ((m as THREE.SkinnedMesh).isSkinnedMesh) {
        const skin = m as THREE.SkinnedMesh
        skin.computeBoundingSphere()
        skin.boundingSphere!.radius *= 2 // conservative bounds include running and falling poses
      }
      m.frustumCulled = true
      addArmorEdges(m.geometry)
    }
  })
  for (const [level, lod] of [[1, medium], [2, low] ] as const) {
    lod.scene.traverse(o => {
      const mesh = o as THREE.SkinnedMesh
      if (!mesh.isSkinnedMesh) return
      const high = gltf.scene.getObjectByName(mesh.name) as THREE.SkinnedMesh | undefined
      if (!high?.isSkinnedMesh || mesh.skeleton.bones.map(b => b.name).join('|') !== high.skeleton.bones.map(b => b.name).join('|')) throw new Error('Spartan LOD skeleton mismatch')
      const levels = detailGeometries.get(mesh.name) ?? [high.geometry]
      levels[level] = mesh.geometry
      // Chipped edges are sub-pixel past 40 m: the far mesh is not measured (no wear, same paint).
      addArmorEdges(mesh.geometry, level === 1)
      detailGeometries.set(mesh.name, levels)
    })
  }
  return gltf.scene as THREE.Group
}

export function preloadSpartan(): Promise<THREE.Group> {
  template ??= load()
  return template
}

export function spartanMaterial(source: THREE.MeshStandardMaterial, team?: Team): THREE.MeshStandardMaterial {
  const mat = source.clone()
  mat.map = team && source.map ? teamMap(team, source.map) : source.map
  mat.color.set(0xffffff)
  mat.emissiveMap = null
  mat.emissive.set(0)
  mat.emissiveIntensity = 0
  // Texture-only armour (user: "just remove the material thingy on the armor too", as on the guns): fully matte, no metal,
  // no authored roughness/metal maps, a trace of reflection, and no painted-plate/chipped-edge shader (armor-surface.ts).
  mat.roughness = 1
  mat.metalness = 0
  mat.roughnessMap = null
  mat.metalnessMap = null
  mat.envMapIntensity = .08
  return mat
}

/** The armour surface a `spartanMaterial` carries, for patching its shader. */
export function armorOf(material: THREE.Material): ArmorSurface | undefined {
  return material.userData.armor as ArmorSurface | undefined
}

/**
 * The energy shield reacting to a hit: an orange-yellow glow that rides the character's
 * silhouette.
 *
 * A Fresnel term is what makes it read as an outline without any second pass or duplicated
 * geometry — it goes to one exactly where the surface turns away from the eye, which is the
 * silhouette by definition, and falls off across surfaces facing the camera. The whole body
 * lights from a single uniform.
 *
 * `broad` adds a flat wash on top of the rim. Third person wants none: the silhouette is the
 * whole read. First person needs it, because the forearms and the weapon fill the screen facing
 * the camera, where a Fresnel term is near zero - rim alone is invisible from inside your own
 * helmet.
 *
 * This is the injection on its own rather than a whole `onBeforeCompile`, because the
 * first-person arms already own theirs for the elbow stretch and call this from inside it.
 * Wrapping instead would break three's program cache, which keys on the callback's source: two
 * materials with different injected shaders but the same wrapper would wrongly share a program.
 */
export function injectShieldRim(shader: { uniforms: Record<string, unknown>; fragmentShader: string }, flash: { value: number }, broad = 0): void {
  shader.uniforms.shieldFlash = flash
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <dithering_fragment>',
    `#include <dithering_fragment>
     if (shieldFlash > 0.001) {
       float facing = abs(dot(normalize(vViewPosition), normal));
       // A broad base so the armour itself warms up, and a tight power for the bright edge.
       float rim = ${broad.toFixed(3)} + pow(1.0 - facing, 2.2) * 1.35 + pow(1.0 - facing, 9.0) * 2.4;
       // Past full strength the hue washes toward white: that is the shield failing.
       vec3 tint = mix(vec3(1.0, 0.62, 0.13), vec3(1.0, 0.95, 0.78), clamp(shieldFlash - 1.0, 0.0, 1.0));
       gl_FragColor.rgb += tint * rim * min(shieldFlash, 2.0);
     }`,
  )
  shader.fragmentShader = `uniform float shieldFlash;\n${shader.fragmentShader}`
}

/**
 * The local player's own shields, shared by everything drawn in first person.
 *
 * There is only ever one of you, and your arms are rebuilt per weapon, so a single module-level
 * value is what keeps every first-person piece flashing together — the viewmodel arms and the
 * owner's own legs light from this one number.
 */
export const firstPersonShieldFlash = { value: 0 }

/**
 * How fast the flare fades, per second of strength.
 *
 * Halo 3 outlines a Spartan for about a second when their shields take a hit or start coming
 * back, so a full-strength flare has to last that long rather than blink out.
 */
export const SHIELD_FLASH_FADE = 1.15

/** How much flat wash first-person surfaces get on top of the rim. See `injectShieldRim`. */
export const FIRST_PERSON_SHIELD_WASH = 0.28

/** Decay the first-person flash. Driven from the match loop, which owns the frame clock. */
export function fadeFirstPersonShieldFlash(dt: number): void {
  if (firstPersonShieldFlash.value > 0) firstPersonShieldFlash.value = Math.max(0, firstPersonShieldFlash.value - dt * SHIELD_FLASH_FADE)
}

function applyShieldRim(material: THREE.MeshStandardMaterial, flash: { value: number }): void {
  const armor = armorOf(material)
  material.onBeforeCompile = armor
    ? (shader) => { injectArmor(shader, armor); injectShieldRim(shader, flash) }
    : (shader) => injectShieldRim(shader, flash)
}

export interface SpartanInstance {
  object: THREE.Group
  /** Where a weapon is parented, in the right hand. */
  hand: THREE.Object3D | null
  /**
   * Put something in the character's hand at true world size.
   *
   * The generated rig is authored in centimetres and scaled by 0.01 at the root, so anything
   * parented to a bone inherits that and renders a hundredth of its real size — a rifle becomes
   * nine millimetres long and looks like it simply is not there. The compensation is measured
   * from the bone rather than hardcoded, so a future model in different units still works.
   */
  attach(object: THREE.Object3D, left?:boolean): void
  setOffhandModel(model:ModelId|null):void
  /** Rebuild the world weapon hand solve when a remote snapshot changes loadout. */
  setWeaponModel(model: ModelId): void
  /**
   * `vx`/`vz`: world velocity, which turns the legs' steps toward the direction of travel. `gait`: where in its stride
   * to draw it (0..1) and whether it steps as a backpedal, when the authority says (src/shared/gait.ts); otherwise the
   * phase advances with distance and the leg IK decides, as before.
   */
  update(speed: number, onGround: boolean, crouched: boolean, dt: number, vx?: number, vz?: number, gait?: { phase: number; backward: boolean }): void
  /** Where in its stride the body is drawn (0..1), the direction of travel in its own frame, and whether it backpedals: what its hit shapes are posed from. */
  readonly gait: { readonly phase: number; readonly heading: number; readonly backward: boolean }
  /**
   * Light the shield across the silhouette. Around 1 is a shot the shields absorbed; above 1
   * washes toward white for the moment they fail.
   */
  shieldFlash(strength: number): void
  /** Play a one-shot over the top of locomotion: a flinch, or a death. */
  aim(pitch: number): void
  fire(left?:boolean, muzzleFlash?:boolean): void
  setDetail(distance: number): void
  reset(): void
  play(name: 'hit' | 'death' | 'jump'): void
  /** Toggle owner-only closed lower body versus the complete third-person mesh. */
  setFirstPerson(enabled: boolean): void
  /** A weapon action seen in third person, over `seconds`: a reload (the support hand to the magazine, the belt and back), a melee strike,
   * or a grenade throw (the free hand winds back and throws). Only drawn with a third-person hold (tp-holds.json). */
  action(kind: 'reload' | 'melee' | 'throw', seconds: number): void
  /** Rounds in the gun in each hand, where the model shows them (the needler's crystals go as the needles do). */
  setAmmo(ammo: number, left?: boolean): void
  /** 0..1 how far a plasma pistol in that hand is charged: a green glow swelling at its muzzle. */
  setCharge(amount: number, left?: boolean): void
}

/**
 * @param firstPerson Build a closed lower-body mesh for the wearer, while retaining the
 *                    complete source geometry for third-person views and death ragdolls.
 */
export async function createSpartan(team: Team, firstPerson = false): Promise<SpartanInstance> {
  const inner = cloneSkinned(await preloadSpartan()) as THREE.Group

  /**
   * Meshy requires the source character to face +Z, and the game's forward is -Z, so every
   * imported body arrives a half-turn out. Correcting it on a wrapper rather than on the model
   * keeps the skeleton's own transforms untouched, which matters because the animation clips
   * are authored against them.
   */
  const root = new THREE.Group()
  root.add(inner)
  inner.rotation.y = Math.PI

  // One flash value drives every piece of this Spartan's armour, so a hit lights the whole
  // silhouette at once rather than piece by piece.
  const shieldFlashUniform = { value: 0 }
  inner.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    // Your own body wears your team's colour too: you see it looking down and in the shoulder camera.
    const mat = spartanMaterial(m.material as THREE.MeshStandardMaterial, team)
    applyShieldRim(mat, shieldFlashUniform)
    m.material = mat
  })

  const mixer = new THREE.AnimationMixer(inner)
  const byName = new Map(clips.map((c) => [c.name, c]))
  const action = (name: string, layer: 'full' | 'lower' | 'upper' = 'full'): THREE.AnimationAction | null => {
    const source = byName.get(name)
    if (!source) return null
    const clip = layer === 'full' ? source : new THREE.AnimationClip(`${name}:${layer}`, source.duration, source.tracks.filter(track => {
      const split = track.name.lastIndexOf('.'), joint = track.name.slice(0, split), property = track.name.slice(split + 1)
      if (property === 'scale' || (property === 'position' && joint !== 'Hips')) return false
      return layer === 'lower' ? /^(Hips|(Left|Right)(UpLeg|Leg|Foot|ToeBase))$/i.test(joint)
        : /^(Spine(0[12])?|neck|Head|head_end|headfront)$/i.test(joint)
    }))
    const a = mixer.clipAction(clip)
    a.play()
    a.setEffectiveWeight(0)
    return a
  }
  const stance = makeRifleIdle(inner)
  const idle = stance ? mixer.clipAction(stance).play().setEffectiveWeight(0) : action(IDLE, 'lower')
  const upperIdle = mixer.clipAction(makeRifleBreathing(inner)).play().setEffectiveWeight(1)
  const walk = action(WALK, 'lower')
  const run = action(RUN, 'lower')
  const crouch = action(CROUCH, 'lower')
  const air = action(AIR, 'lower')
  if (idle) idle.setEffectiveWeight(1)

  // One-shots run on their own track and fade themselves out, so a flinch reads without
  // interrupting the legs.
  const oneShots: Record<string, THREE.AnimationAction | null> = {
    hit: action(HIT, 'upper'),
    death: action(DEATH),
    // The generated jump is a full-body dive, unsuitable for a rifle-ready hop.
    jump: null,
  }
  for (const a of Object.values(oneShots)) {
    if (!a) continue
    a.stop()
    a.setLoop(THREE.LoopOnce, 1)
    a.clampWhenFinished = true
  }
  let shot: keyof typeof oneShots | null = null
  let shotRemaining = 0
  let dead = false

  const bone = (want: string): THREE.Object3D | null => {
    let hit: THREE.Object3D | null = null
    inner.traverse((o) => {
      if (!hit && o.name.replace(/[\s_.:|-]/g, '').toLowerCase() === want) hit = o
    })
    return hit
  }

  const hand = bone('righthand')
  // Measured arm chains layer a rifle grip over locomotion after the mixer.
  const armR = bone('rightarm')
  const foreR = bone('rightforearm')
  const armL = bone('leftarm')
  const foreL = bone('leftforearm')
  const chest = bone('spine') ?? bone('spine01')
  const head = bone('head')
  const leftHand = bone('lefthand')
  const rightChain = armR && foreR && hand ? measureRifleLimb(armR, foreR, hand) : null
  const leftChain = armL && foreL && leftHand ? measureRifleLimb(armL, foreL, leftHand) : null
  const gripCorrection = (wrist: THREE.Object3D | null, elbow: THREE.Object3D | null) => {
    if (!wrist || !elbow) return new THREE.Quaternion()
    const y = wrist.getWorldPosition(new THREE.Vector3()).sub(elbow.getWorldPosition(new THREE.Vector3())).normalize()
    const x = new THREE.Vector3().crossVectors(y, new THREE.Vector3(0, 0, -1)).normalize()
    const z = new THREE.Vector3().crossVectors(x, y).normalize()
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,z)).invert()
      .multiply(wrist.getWorldQuaternion(new THREE.Quaternion()))
  }
  const gripR = gripCorrection(hand, foreR), gripL = gripCorrection(leftHand, foreL)
  // ---- The Chief body (tools/blender/export-chief-body.py) is held from baked data instead of the old rig's hand anchors and hard-coded finger
  // angles: per weapon, where each hand sits on the weapon and how its fingers close, derived from the first-person idle (tools/hold-extract.mjs).
  const chief = !!inner.userData.chiefBody
  type Hold = { p: number[]; q: number[]; fingers: Record<string, number[]> }
  const holdFor = (model: ModelId, side: 'left' | 'right'): Hold | undefined => (chiefHolds as unknown as Record<string, Record<string, Hold>>)[model]?.[side]
  /** Where each weapon sits against the body, authored on the rig in Blender (tools/blender/tp-holds.py): the hips blade toward the gun by
   * `blade` degrees (leg-ik.ts), the chest turns a further `twist` over the spine and the left collarbone swings forward `protract`, the weapon (its world model's own frame) sits at chest + offset turned by q, and aim pitch turns it about
   * chest + pivot (the shoulder pocket a stock is seated in, or the shoulder joint). The support hand slides leftSlide along the weapon from
   * its first-person grip, as far as the arm reaches. Root frame: +x the body's right, +y up, -z forward. */
  type TpHold = { kind: string; blade?: number; twist: number; protract?: number; leftSlide: number[]; offset: number[]; q: number[]; pivot: number[]; oneHanded?: boolean }
  const tpHold = (model: ModelId): TpHold | undefined => chief ? (tpHolds as unknown as Record<string, TpHold>)[model] : undefined
  const fingerBones = (side: 'Left' | 'Right') => {
    const list: { name: string; bone: THREE.Object3D; rest: THREE.Quaternion }[] = []
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (let i = 1; i <= 3; i++) {
      const bone = inner.getObjectByName(`${side}${f}${i}`); if (bone) list.push({ name: `${f}${i}`, bone, rest: bone.quaternion.clone() })
    }
    return list
  }
  const chiefFingers = { Left: chief ? fingerBones('Left') : [], Right: chief ? fingerBones('Right') : [] }
  const fingerPose: { Left: Record<string, THREE.Quaternion> | null; Right: Record<string, THREE.Quaternion> | null } = { Left: null, Right: null }
  const quaternionsOf = (hold: Hold | undefined, mirrored: boolean) => {
    if (!hold) return null
    const out: Record<string, THREE.Quaternion> = {}
    for (const [k, v] of Object.entries(hold.fingers)) out[k] = mirrored ? new THREE.Quaternion(v[0], -v[1], -v[2], v[3]) : new THREE.Quaternion(v[0], v[1], v[2], v[3])
    return out
  }
  // Canonical hand frame (y wrist -> middle knuckle, x across the knuckles, z out of the palm) and the constant that relates it to each hand bone:
  // mirroring a whole hand pose for a weapon in the left hand goes through that frame, so it does not depend on either bone's own axes.
  const handFrame = (side: 'Left' | 'Right') => {
    const at = (n: string) => inner.getObjectByName(side + n)?.getWorldPosition(new THREE.Vector3())
    const H = at('Hand'), I = at('Index1'), M = at('Middle1'), P = at('Pinky1'), bone = inner.getObjectByName(side + 'Hand')
    if (!H || !I || !M || !P || !bone) return null
    const y = M.clone().sub(H).normalize(), k0 = I.clone().sub(P).normalize(), n = k0.clone().cross(y).normalize(), k = y.clone().cross(n).normalize()
    const F = new THREE.Matrix4().makeBasis(k, y, n)
    const R = new THREE.Matrix4().makeRotationFromQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()))
    return R.invert().multiply(F)                                   // A = R_rest^-1 * F
  }
  if (chief) inner.updateWorldMatrix(true, true)
  const frameA = { Left: chief ? handFrame('Left') : null, Right: chief ? handFrame('Right') : null }
  // A one-handed weapon (the sword) leaves the support hand off the weapon, far outside the arm's reach: that hand takes the mirrored grip pose
  // and rests low beside the weapon instead of the arm stretching out after a target a metre away.
  const relaxedSupport = (model: ModelId, side: 'left' | 'right', mirrored: boolean) => {
    if (side !== 'left' || mirrored) return false
    // the third-person hold says whether the support hand is on the weapon (the hammer's two fists are 0.7 m apart, and the old distance
    // guess below let its left arm hang); without one, a support grip far from the firing hand means a one-handed weapon
    const tp = tpHold(model)
    if (tp) return !!tp.oneHanded
    const l = holdFor(model, 'left'), r = holdFor(model, 'right')
    return !!l && !!r && Math.hypot(l.p[0] - r.p[0], l.p[1] - r.p[1], l.p[2] - r.p[2]) > .7
  }
  const chiefTarget = (model: ModelId, side: 'left' | 'right', mirrored: boolean): THREE.Object3D => {
    const target = new THREE.Object3D(); target.name = `hold-wrist:${side}`
    const relaxed = relaxedSupport(model, side, mirrored)
    const tp = tpHold(weaponModel)
    if (relaxed && tp) {
      // the support hand is off a one-handed weapon: it rides in Halo 3's ready guard in front of the body (placed each frame from the chest,
      // see placeTpMount)
      target.quaternion.copy(guardHandLeft); root.add(target); relaxedLeft = target
      return target
    }
    if (relaxed) mirrored = true
    const hold = holdFor(model, mirrored ? 'right' : side)
    if (hold) {
      const p = new THREE.Vector3(...hold.p as [number, number, number]), q = new THREE.Quaternion(...hold.q as [number, number, number, number])
      if (!mirrored) { target.position.copy(p); target.quaternion.copy(q); if (side === 'left' && tp) target.position.add(new THREE.Vector3(...tp.leftSlide as [number, number, number])) }
      else {
        target.position.set(mirrorX - p.x, p.y, p.z)                  // the left mount is the right one reflected about x = mirrorX / 2
        if (relaxed) target.position.set(mirrorX - .02, p.y - .22, p.z + .04)
        const A = frameA.Right, B = frameA.Left
        if (A && B) {
          const FR = new THREE.Matrix4().makeRotationFromQuaternion(q).multiply(A)
          const S = new THREE.Matrix4().makeScale(-1, 1, 1), Z = new THREE.Matrix4().makeScale(1, 1, -1)
          const FL = S.multiply(FR).multiply(Z)
          target.quaternion.setFromRotationMatrix(FL.multiply(B.clone().invert()))
        }
      }
    }
    weaponMount.add(target)
    return target
  }
  const applyChiefFingers = (side: 'Left' | 'Right', pull: number, release: number) => {
    const pose = fingerPose[side]
    for (const { name, bone, rest } of chiefFingers[side]) {
      const q = pose?.[name]
      if (!q) { bone.quaternion.copy(rest); continue }
      bone.quaternion.copy(rest).slerp(q, 1 - THREE.MathUtils.clamp(release, 0, 1) * .95)
      if (name.startsWith('Index') && side === 'Right') bone.rotateX(pull * (name === 'Index1' ? .18 : name === 'Index2' ? .22 : 0))
    }
  }
  // the relaxed support hand: the bind pose's hanging left hand, in the root frame
  const restHandLeft = leftHand && chief ? root.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(leftHand.getWorldQuaternion(new THREE.Quaternion())) : new THREE.Quaternion()
  /** The free hand of a one-handed weapon, as Halo 3 carries it: not hanging but up in a loose guard, the elbow bent, a thumb-up fist low in front
   * of the belly with the palm toward it. Root frame, built through the canonical hand frame (for the left hand its z is the back of the hand). */
  const guardHandLeft = (() => {
    const A = frameA.Left; if (!A) return restHandLeft.clone()
    const y = new THREE.Vector3(.25, -.2, -1).normalize()                        // wrist to knuckles: forward, a little inward and down
    const n = new THREE.Vector3(-1, .35, 0).addScaledVector(y, -new THREE.Vector3(-1, .35, 0).dot(y)).normalize()  // back of the hand, outward
    const F = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(y, n), y, n)
    return new THREE.Quaternion().setFromRotationMatrix(F.multiply(A.clone().invert()))
  })()
  /** Its fingers: the weapon's own grip mirrored onto the left hand and three-quarters closed, a loose fist. */
  const looseFist = (hold: Hold | undefined) => {
    const q = quaternionsOf(hold, true); if (!q) return null
    for (const { name, rest } of chiefFingers.Left) if (q[name]) q[name] = rest.clone().slerp(q[name], .75)
    return q
  }
  let relaxedLeft: THREE.Object3D | null = null
  /** Mount-frame x of the mirror plane (the body's centre line) that the dual-wielded left weapon is reflected about. */
  let mirrorX = .38
  const weaponMount = new THREE.Group()
  weaponMount.name = 'rifle-aim-mount'
  weaponMount.position.set(0.10, 1.58, -0.28)
  weaponMount.rotation.y = Math.PI
  root.add(weaponMount)
  let aimPitch = 0, pitch = 0, recoil = 0, detailLevel = 0
  const flashes = new Map<string, ReturnType<typeof createMuzzleFlash>>()
  let rightFlash:ReturnType<typeof createMuzzleFlash>|null=null,leftFlash:ReturnType<typeof createMuzzleFlash>|null=null
  let rightFlashTime=0,leftFlashTime=0,rightFlashLife=.055,leftFlashLife=.055
  /** The flash cards are sized for the first-person view (a hand's length from the eye); on a Spartan seen across a room they need to be
   * about twice that to read. */
  const WORLD_FLASH=2.2
  const flashPosition=new THREE.Vector3()
  const selectFlash=(model:ModelId,mount:THREE.Group,left=false)=>{
    const key=`${left?'left':'right'}:${model}`
    let flash=flashes.get(key)
    if(!flash){flash=createMuzzleFlash(model);flash.visible=false;flashes.set(key,flash);mount.add(flash)}
    return flash
  }
  rightFlash=selectFlash('assault-rifle',weaponMount)
  let rifleRig = rigFor('assault-rifle', weaponMount)
  const wristAnchor = (side: 'right' | 'left', anchor: HandAnchor) => {
    const across = side === 'right' ? 1 : -1
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(anchor.euler[0], -anchor.euler[1], -anchor.euler[2]))
    const frame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, across, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(across, 0, 0)))
    const target = new THREE.Object3D(); target.name = `rifle-wrist:${side}`
    // The anchor describes the grip center. The wrist lies behind and outside that center,
    // otherwise the gun crosses the palm and the support hand grasps empty space.
    target.position.set(-anchor.pos[0], anchor.pos[1], anchor.pos[2])
    if (side === 'right') target.position.add(new THREE.Vector3(-anchor.grip - .016, -.006, -.10))
    else target.position.add(new THREE.Vector3(anchor.grip + .070, -.045, 0))
    // Source hand +Y runs toward the fingers. The right fingers point downrange;
    // the left fingers cross the handguard, with the support palm facing upward.
    target.quaternion.copy(rotation.multiply(frame)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), side === 'right' ? Math.PI / 2 : -Math.PI / 2))
    weaponMount.add(target)
    return target
  }
  // Measure the curled glove's contact instead of guessing a universal wrist offset.
  // The imported pistols have very different handle depths from a rifle stock.
  poseFingers(inner, 'Right'); root.updateWorldMatrix(true, true)
  const smallArmPalm = new THREE.Vector3()
  if (hand) {
    for (const name of ['RightMiddle1','RightMiddle2','RightMiddle3']) {
      const joint=inner.getObjectByName(name)
      if(joint)smallArmPalm.add(joint.getWorldPosition(new THREE.Vector3()))
    }
    smallArmPalm.multiplyScalar(1/3).sub(hand.getWorldPosition(new THREE.Vector3()))
      .applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()).invert())
  }
  let weaponModel: ModelId='assault-rifle'
  const smallArm=(model:ModelId)=>['magnum','smg','plasma-pistol','plasma-rifle','needler'].includes(model)
  const fitSmallArm=(target:THREE.Object3D,anchor:HandAnchor)=>{
    target.position.set(-anchor.pos[0],anchor.pos[1],anchor.pos[2])
      .sub(smallArmPalm.clone().applyQuaternion(target.quaternion.clone().multiply(gripR)))
  }
  const heldRig=(model:ModelId,mount:THREE.Object3D,left=false)=>rigFor(model,mount.children.find(o=>o.visible&&o.name===`${left?'offhand':'held'}:${model}`)??mount)
  let rightTarget = chief ? chiefTarget('assault-rifle', 'right', false) : wristAnchor('right', rifleRig.right)
  let leftTarget = chief ? chiefTarget('assault-rifle', 'left', false) : wristAnchor('left', rifleRig.left)
  if (chief) { fingerPose.Right = quaternionsOf(holdFor('assault-rifle', 'right'), false); fingerPose.Left = quaternionsOf(holdFor('assault-rifle', 'left'), false) }
  let offhandModel:ModelId|null=null
  const leftMount=new THREE.Group();leftMount.position.x=.38;leftMount.scale.x=-1;weaponMount.add(leftMount)
  const setOffhandModel=(model:ModelId|null)=>{
    if(leftFlash)leftFlash.visible=false
    leftFlash=model?selectFlash(model,leftMount,true):null;leftFlashTime=0
    offhandModel=model;leftTarget.removeFromParent();relaxedLeft=null
    // mirror plane of a dual wield: the body's centre line, which the mount's own x axis (the body's left) meets at x = offset.x
    const tp=tpHold(weaponModel);mirrorX=tp?2*tp.offset[0]:.38;leftMount.position.x=mirrorX
    if(chief){
      // Two-handed: the support hand of the weapon in the right hand. Dual wield: the right-hand pose of the off-hand weapon, mirrored.
      leftTarget=chiefTarget(model??weaponModel,'left',!!model)
      const relaxed=!model&&relaxedSupport(weaponModel,'left',false)
      fingerPose.Left=relaxed&&tp?looseFist(holdFor(weaponModel,'right')):quaternionsOf(holdFor(model??weaponModel,model||relaxed?'right':'left'),!!model||relaxed)
      return
    }
    const anchor=model?heldRig(model,leftMount,true).right:rifleRig.left
    leftTarget=wristAnchor(model?'right':'left',anchor)
    if(model&&smallArm(model))fitSmallArm(leftTarget,anchor)
    if(model){leftTarget.position.x=.38-leftTarget.position.x;leftTarget.quaternion.y*=-1;leftTarget.quaternion.z*=-1}
  }
  const setWeaponModel = (model: ModelId): void => {
    if(model!==weaponModel)switchT=0                                  // third person: the new weapon comes up from a low carry
    if(rightFlash)rightFlash.visible=false
    rightFlash=selectFlash(model,weaponMount);rightFlashTime=0
    weaponModel=model
    rifleRig = heldRig(model, weaponMount)
    rightTarget.removeFromParent(); leftTarget.removeFromParent()
    if (chief) { rightTarget = chiefTarget(model, 'right', false); fingerPose.Right = quaternionsOf(holdFor(model, 'right'), false) }
    else {
      rightTarget = wristAnchor('right', rifleRig.right)
      if(smallArm(model))fitSmallArm(rightTarget,rifleRig.right)
    }
    setOffhandModel(offhandModel)
  }
  const wristWorld = new THREE.Quaternion(), wristParent = new THREE.Quaternion(), identityCorrection = new THREE.Quaternion()
  const orientWrist = (wrist: THREE.Object3D, target: THREE.Object3D, correction: THREE.Quaternion) => {
    target.getWorldQuaternion(wristWorld).multiply(correction)
    wrist.quaternion.copy(wrist.parent!.getWorldQuaternion(wristParent).invert().multiply(wristWorld))
    wrist.updateWorldMatrix(false, true)
  }
  const aimTarget = new THREE.Vector3(), aimPole = new THREE.Vector3(), chestPosition = new THREE.Vector3()
  const previousPosition = new THREE.Vector3(), currentPosition = new THREE.Vector3(), localTravel = new THREE.Vector3()
  const facing = new THREE.Quaternion(), headRotation = new THREE.Quaternion(), headParent = new THREE.Quaternion(), lookRotation = new THREE.Quaternion()
  const rightAxis = new THREE.Vector3(1, 0, 0)
  const headRootRest = head ? root.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(head.getWorldQuaternion(new THREE.Quaternion())) : new THREE.Quaternion()
  let gaitPhase = Math.random(), hasPreviousPosition = false
  // procedural legs over the clips: steps turned to the travel direction, feet planted on the floor (leg-ik.ts)
  const legIK = legsEnabled ? createLegIK(root, inner) : null
  // The middle of each foot's stride in the walk, run and crouch clips (body frame), sampled once on a scratch mixer: the legs turn the
  // stride about it, and an estimate that had to settle while moving put the feet across each other for the first second of every run.
  const strideCenters = new Map<THREE.AnimationAction, [THREE.Vector3, THREE.Vector3]>()
  const feetBones = [inner.getObjectByName('LeftFoot'), inner.getObjectByName('RightFoot')]
  if (legIK && feetBones[0] && feetBones[1]) {
    const probe = new THREE.AnimationMixer(inner), at = new THREE.Vector3()
    for (const a of [walk, run, crouch]) {
      if (!a) continue
      const clip = a.getClip(), act = probe.clipAction(clip).play(), sum = [new THREE.Vector3(), new THREE.Vector3()] as [THREE.Vector3, THREE.Vector3]
      for (let i = 0; i < 24; i++) {
        act.time = i / 24 * clip.duration; probe.update(0); root.updateWorldMatrix(true, true)
        feetBones.forEach((f, k) => sum[k].add(root.worldToLocal(f!.getWorldPosition(at))))
      }
      act.stop(); strideCenters.set(a, [sum[0].divideScalar(24), sum[1].divideScalar(24)])
    }
    probe.stopAllAction(); probe.uncacheRoot(inner)
  }
  const blendedCenters: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()]
  const bodyTurn = new THREE.Quaternion(), travel = new THREE.Vector3(), feetAt = new THREE.Vector3()
  let heading = 0



  // ---- Third-person holds (tp-holds.json): the upper body blades toward the gun, the weapon sits against it, aim pitch turns it about the
  // shoulder. The twist is laid over the clips after the mixer and taken off again before the next mixer update (three.js only rewrites a
  // bone whose animated value changed, so a twist left in place would build up frame after frame).
  const twistBones = ['Spine02', 'Spine01', 'Spine', 'neck', 'LeftShoulder'].map(n => inner.getObjectByName(n)).filter((b): b is THREE.Object3D => !!b)
  const twistSaved = twistBones.map(() => new THREE.Quaternion())
  let twisted = false, twistNow = 0, bladeNow = 0, protractNow = 0
  const twistQ = new THREE.Quaternion(), boneWorld = new THREE.Quaternion(), boneParent = new THREE.Quaternion(), upAxis = new THREE.Vector3(0, 1, 0)
  const untwist = () => { if (twisted) twistBones.forEach((b, i) => b.quaternion.copy(twistSaved[i])); twisted = false }
  const applyTwist = (deg: number, protract: number) => {
    if (!twistBones.length || (Math.abs(deg) < .01 && Math.abs(protract) < .01)) return
    twistBones.forEach((b, i) => twistSaved[i].copy(b.quaternion)); twisted = true
    // the chest turns toward the body's right (clockwise from above) by deg from square, a third at each spine bone; the neck turns 40% of it
    // back (the head is aimed on its own); the left collarbone swings forward (toward the right about its own joint) by protract
    for (const b of twistBones) {
      const a = (b.name === 'neck' ? .4 * deg : b.name === 'LeftShoulder' ? -protract : -deg / 3) * Math.PI / 180
      b.getWorldQuaternion(boneWorld).premultiply(twistQ.setFromAxisAngle(upAxis, a))
      b.quaternion.copy(b.parent!.getWorldQuaternion(boneParent).invert().multiply(boneWorld)); b.updateMatrixWorld(true)
    }
  }
  const tpPivot = new THREE.Vector3(), tpPos = new THREE.Vector3(), tpQ = new THREE.Quaternion(), pitchQ = new THREE.Quaternion(), xAxis = new THREE.Vector3(1, 0, 0)
  const guardAt = new THREE.Vector3(-.2, -.32, -.27)         // the free hand's guard, from the chest (root frame): low in front of the belly, left of centre
  // ---- Third-person actions: a timed layer over the hold, turning the weapon about its pivot and taking the support hand off it
  let act: { kind: 'reload' | 'melee' | 'throw'; t: number; dur: number } | null = null
  /** Seconds since the weapon in hand changed: it is raised from a low, muzzle-down carry over SWITCH_RAISE. */
  let switchT = 10
  const SWITCH_RAISE = .42
  const actLeft = new THREE.Object3D(); actLeft.name = 'action-wrist:left'; root.add(actLeft)
  let actLeftOn = false
  const smooth01 = (x: number) => { const t = THREE.MathUtils.clamp(x, 0, 1); return t * t * (3 - 2 * t) }
  /** 0 before a, rising to 1 by b, holding, falling back to 0 between c and d. */
  const bump = (u: number, a: number, b: number, c: number, d: number) => smooth01((u - a) / (b - a)) * (1 - smooth01((u - c) / (d - c)))
  const actQ = new THREE.Quaternion(), actE = new THREE.Euler(), actT = new THREE.Vector3(), rootQ = new THREE.Quaternion()
  const keyP = [0, 1, 2, 3].map(() => new THREE.Vector3()), keyQ = [0, 1, 2, 3].map(() => new THREE.Quaternion()), tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion()
  /** Where a magazine goes into each weapon, from the right (firing) hand in the weapon's own frame (+z toward the muzzle). The battle rifle is a
   * bullpup (magazine behind the grip); the magnum loads through its grip; the launcher from the back of its tubes. */
  const MAG: Partial<Record<ModelId, readonly [number, number, number]>> = {
    'battle-rifle': [0, -.04, -.17], magnum: [0, -.09, 0], 'plasma-pistol': [0, -.04, .02], needler: [0, .06, .08], 'rocket-launcher': [0, .02, -.36], shotgun: [0, -.05, .18],
  }
  /** The support hand's path during an action, in the root frame: keyed through `points` (grip, magazine, belt, ...) at the times `at`. */
  const along = (u: number, at: number[], pts: THREE.Vector3[], qs: THREE.Quaternion[]) => {
    let i = 0; while (i < at.length - 2 && u > at[i + 1]) i++
    const k = smooth01((u - at[i]) / Math.max(1e-4, at[i + 1] - at[i]))
    actLeft.position.lerpVectors(pts[i], pts[i + 1], k); actLeft.quaternion.slerpQuaternions(qs[i], qs[i + 1], k)
  }
  const placeTpMount = (tp: TpHold, dt: number) => {
    // a dual wield holds both guns square (no stance); a carried hammer only half follows the aim up and down
    const square = !!offhandModel || (firstPerson && lowerBodyEnabled), k = 1 - Math.exp(-10 * dt)
    twistNow += ((square ? 0 : (tp.blade ?? 0) + tp.twist) - twistNow) * k
    bladeNow += ((square ? 0 : tp.blade ?? 0) - bladeNow) * k
    protractNow += ((square ? 0 : tp.protract ?? 0) - protractNow) * k
    applyTwist(twistNow, protractNow)
    root.updateWorldMatrix(true, true)
    root.worldToLocal(chest!.getWorldPosition(chestPosition))
    tpPivot.set(tp.pivot[0], tp.pivot[1], tp.pivot[2]).add(chestPosition)
    tpPos.set(tp.offset[0], tp.offset[1], tp.offset[2]).add(chestPosition)
    tpQ.set(tp.q[0], tp.q[1], tp.q[2], tp.q[3])
    // aim pitch and the recoil kick turn the weapon about the pivot (+pitch looks up: about the body's right, +x); the kick also shoves it back
    const follow = tp.kind === 'carry' ? .25 : 1
    pitchQ.setFromAxisAngle(xAxis, pitch * follow + recoil * .035)
    // the action layer: an extra turn about the pivot (pitch about +x, yaw about +y, roll about the weapon's own barrel) and a shift
    actE.set(0, 0, 0); actT.set(0, 0, 0); let roll = 0; actLeftOn = false
    if (act) {
      act.t += dt; const u = act.t / act.dur
      if (u >= 1) act = null
      else if (act.kind === 'reload') {
        const tilt = bump(u, 0, .15, .82, 1)
        actE.x = -.22 * tilt; roll = .45 * tilt; actT.set(-.07 * tilt, -.07 * tilt, .06 * tilt)
      } else if (act.kind === 'throw') {
        const tilt = bump(u, 0, .2, .6, 1)
        actE.x = -.18 * tilt; roll = .25 * tilt; actT.set(.03 * tilt, -.06 * tilt, .04 * tilt)
      } else if (weaponModel === 'energy-sword') {
        // a forehand slash, high right to low left across the body: wound back to the right (a turn about +y swings the blade to the
        // body's left in this frame, so right is negative), then swept across to the left
        const wind = bump(u, 0, .22, .26, .36), strike = bump(u, .26, .42, .55, 1)
        actE.y = -.9 * wind + 1.3 * strike; actE.x = .25 * wind - .45 * strike; roll = -.35 * wind + .25 * strike; actT.set(0, 0, -.25 * strike)
      } else if (weaponModel === 'gravity-hammer') {
        // up over the shoulder and down in front
        const raise = bump(u, 0, .3, .34, .44), slam = bump(u, .34, .45, .6, 1)
        actE.x = .9 * raise - .85 * slam; actT.set(0, .15 * raise - .2 * slam, -.3 * slam)
      } else {
        // a jab with the weapon: drawn back, driven forward and down, recovered
        const wind = bump(u, 0, .25, .3, .42), strike = bump(u, .3, .42, .55, 1)
        actE.x = .12 * wind - .35 * strike; roll = .3 * wind; actT.set(.03 * wind, .04 * wind - .06 * strike, .1 * wind - .35 * strike)
      }
    }
    switchT += dt
    if (switchT < SWITCH_RAISE) {
      const down = 1 - smooth01(switchT / SWITCH_RAISE)
      actE.x -= 1.05 * down; actT.y -= .16 * down; actT.z += .1 * down; roll += .35 * down
    }
    pitchQ.premultiply(actQ.setFromEuler(actE))
    weaponMount.position.copy(tpPos).sub(tpPivot).applyQuaternion(pitchQ).add(tpPivot).add(actT)
    weaponMount.quaternion.copy(tpQ).premultiply(pitchQ)
    if (roll) weaponMount.quaternion.multiply(actQ.setFromAxisAngle(tmpV.set(0, 0, 1), roll))
    weaponMount.position.addScaledVector(tpPos.set(0, 0, 1).applyQuaternion(weaponMount.quaternion), -recoil * .015)
    if (relaxedLeft) relaxedLeft.position.copy(guardAt).add(chestPosition)
    // the support hand's path (reload, throw); it starts and ends on its own target, so it leaves and rejoins the weapon without a jump
    if (act && !offhandModel && (act.kind === 'reload' ? tp.kind !== 'carry' && weaponModel !== 'energy-sword' && weaponModel !== 'plasma-rifle' && weaponModel !== 'plasma-pistol' : act.kind === 'throw')) {
      const u = act.t / act.dur
      root.updateWorldMatrix(true, true); weaponMount.updateWorldMatrix(false, true)
      root.getWorldQuaternion(rootQ).invert()
      const home = relaxedLeft ?? leftTarget
      root.worldToLocal(home.getWorldPosition(keyP[0])); keyQ[0].copy(rootQ).multiply(home.getWorldQuaternion(tmpQ))
      if (act.kind === 'reload') {
        const r = holdFor(weaponModel, 'right'), m = MAG[weaponModel] ?? [0, -.04, .13]
        if (r) root.worldToLocal(weaponMount.localToWorld(keyP[1].set(r.p[0] + m[0], r.p[1] + m[1] - .03, r.p[2] + m[2])))
        const lh = holdFor(weaponModel, 'left'); keyQ[1].copy(rootQ).multiply(weaponMount.getWorldQuaternion(tmpQ)).multiply(tmpQ.set(...(lh ?? r!).q as [number, number, number, number]))
        keyP[2].set(-.2, -.56, -.04).add(chestPosition); keyQ[2].copy(restHandLeft)
        along(u, [0, .18, .26, .42, .5, .66, .74, .92, 1], [keyP[0], keyP[1], keyP[1], keyP[2], keyP[2], keyP[1], keyP[1], keyP[0], keyP[0]], [keyQ[0], keyQ[1], keyQ[1], keyQ[2], keyQ[2], keyQ[1], keyQ[1], keyQ[0], keyQ[0]])
      } else {
        // wound back behind the left shoulder, thrown forward over it
        keyP[1].set(-.3, .2, .2).add(chestPosition); keyQ[1].copy(restHandLeft)
        keyP[2].set(-.08, .08, -.6).add(chestPosition); keyQ[2].copy(restHandLeft)
        along(u, [0, .32, .52, .9, 1], [keyP[0], keyP[1], keyP[2], keyP[0], keyP[0]], [keyQ[0], keyQ[1], keyQ[2], keyQ[0], keyQ[0]])
      }
      actLeftOn = true
    }
  }

  // ---- What the held gun shows: the needler's crystals as its rounds go, a plasma pistol's charge glowing at its muzzle
  let ammoRight = Infinity, ammoLeft = Infinity, chargeRight = 0, chargeLeft = 0, glowClock = 0
  // every detail level of the model carries its own crystals: each is kept with its number
  const needleCache = new WeakMap<THREE.Object3D, { node: THREE.Object3D; index: number }[]>()
  const needlesOf = (holder: THREE.Object3D) => {
    let list = needleCache.get(holder)
    if (!list || !list.length) { const found: { node: THREE.Object3D; index: number }[] = []; holder.traverse(o => { const m = /^needler-crystal-(\d+)$/.exec(o.name); if (m) found.push({ node: o, index: +m[1] }) }); list = found; if (found.length) needleCache.set(holder, found) }
    return list
  }
  const glowTexture = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64
    const g = c.getContext('2d')!, r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    r.addColorStop(0, 'rgba(245,255,215,1)'); r.addColorStop(.2, 'rgba(190,255,120,.95)'); r.addColorStop(.5, 'rgba(110,255,40,.4)'); r.addColorStop(1, 'rgba(70,255,0,0)')
    g.fillStyle = r; g.fillRect(0, 0, 64, 64)
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
  })()
  const makeGlow = (mount: THREE.Object3D) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: new THREE.Color(1.6, 2.2, 1.3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }))
    sprite.name = 'plasma-charge-glow'; sprite.scale.setScalar(0); sprite.frustumCulled = false; mount.add(sprite); return sprite
  }
  const glowRight = makeGlow(weaponMount), glowLeft = makeGlow(leftMount), glowAt = new THREE.Vector3()
  const showWeaponState = (mount: THREE.Object3D, left: boolean, dt: number) => {
    const holder = mount.children.find(o => o.visible && o.name.startsWith(left ? 'offhand:' : 'held:'))
    const ammo = left ? ammoLeft : ammoRight, charge = left ? chargeLeft : chargeRight, glow = left ? glowLeft : glowRight
    if (holder?.name.endsWith(':needler')) {
      // the crystals refill a quarter of the way into a reload, as in first person
      const refilling = !left && act?.kind === 'reload' && act.t / act.dur > .26
      for (const n of needlesOf(holder)) n.node.visible = refilling || n.index < ammo
    }
    const anchor = charge > 0 ? holder?.getObjectByName('anchor:muzzle') : null
    if (anchor) {
      glowClock += dt
      mount.worldToLocal(anchor.getWorldPosition(glowAt)); glow.position.copy(glowAt)
      glow.scale.setScalar((.08 + .26 * charge) * (1 + .08 * Math.sin(glowClock * 40) + (charge >= 1 ? .1 * Math.sin(glowClock * 13) : 0)))
    } else glow.scale.setScalar(0)
  }

  const ownerMeshes: {mesh:THREE.SkinnedMesh;full:THREE.BufferGeometry;lower:THREE.BufferGeometry;material:THREE.Material;cap:THREE.Material}[]=[]
  if(firstPerson)inner.traverse(o=>{
    const mesh=o as THREE.SkinnedMesh;if(!mesh.isSkinnedMesh)return
    const material=mesh.material as THREE.Material
    const lower=firstPersonBodyGeometry(mesh,FP_BODY.cut);addArmorEdges(lower)
    ownerMeshes.push({mesh,full:mesh.geometry,lower,material,cap:new THREE.MeshStandardMaterial({color:0x151b18,roughness:.95,side:THREE.DoubleSide})})
  })
  let lowerBodyEnabled:boolean|undefined
  const setFirstPerson=(enabled:boolean)=>{
    if(lowerBodyEnabled===enabled)return
    lowerBodyEnabled=enabled
    weaponMount.visible = !dead && !(firstPerson && enabled)
    // Keep the waist behind the eye while the knees and boots remain in the look-down view.
    // This owner-only presentation offset never changes the collision or remote avatar.
    if(firstPerson){root.position.z=enabled?FP_BODY.back:0;root.rotation.x=enabled?FP_BODY.tilt:0}
    for(const entry of ownerMeshes){entry.mesh.geometry=enabled?entry.lower:entry.full;entry.mesh.material=enabled?[entry.material,entry.cap]:entry.material}
    root.userData.firstPersonLowerBody=firstPerson&&enabled
  }
  setFirstPerson(firstPerson)

  return {
    object: root,
    hand,

    attach(object,left=false) {
      (left?leftMount:weaponMount).add(object)
    },

    setWeaponModel, setOffhandModel,

    aim(value) { aimPitch = THREE.MathUtils.clamp(value, -0.75, 0.75) },
    fire(left=false,muzzleFlash=true) {
      if(dead)return
      recoil=1
      const mount=left?leftMount:weaponMount,flash=left?leftFlash:rightFlash
      const holder=mount.children.find(o=>o.visible&&o.name.startsWith(left?'offhand:':'held:'))
      const anchor=holder?.getObjectByName('anchor:muzzle')
      if(muzzleFlash&&flash&&anchor){
        mount.updateWorldMatrix(true,true)
        flash.position.copy(mount.worldToLocal(anchor.getWorldPosition(flashPosition)))
        // each shot rolls and resizes the flash (automatic fire never repeats a frame) and it fades over its own life
        flash.userData.shot?.();const life=(flash.userData.life as number|undefined)??.055
        if(left){leftFlashTime=leftFlashLife=life}else{rightFlashTime=rightFlashLife=life}
      }
    },
    setDetail(distance) {
      const level = firstPerson || forceHighDetail ? 0 : distance > 40 ? 2 : distance > 12 ? 1 : 0
      if (level === detailLevel) return
      detailLevel = level
      inner.traverse(o => {
        const mesh = o as THREE.SkinnedMesh
        if (!mesh.isSkinnedMesh) return
        const geometry = detailGeometries.get(mesh.name)?.[level]
        if (geometry && mesh.geometry !== geometry) mesh.geometry = geometry
      })
      // A full character shadow is useful nearby, but casting and receiving it for every
      // distant avatar makes the dynamic shadow pass scale with the player count. The avatar
      // remains visible and collidable at every distance; only the low-value shadow samples
      // are removed once it is outside the readable combat range.
    },

    setFirstPerson,

    action(kind, seconds) { if (!dead && seconds > 0) act = { kind, t: 0, dur: seconds } },
    setAmmo(ammo, left = false) { if (left) ammoLeft = ammo; else ammoRight = ammo },
    setCharge(amount, left = false) { if (left) chargeLeft = amount; else chargeRight = amount },

    reset() {
      for (const a of Object.values(oneShots)) a?.stop()
      shot = null
      shotRemaining = 0
      dead = false
      recoil = 0
      shieldFlashUniform.value = 0
      hasPreviousPosition = false
      legIK?.reset()
      act = null
      upperIdle?.reset().play().setEffectiveWeight(1)
      for (const a of [idle, walk, run, crouch, air]) a?.reset().play().setEffectiveWeight(0)
      idle?.setEffectiveWeight(1)
    },

    play(name) {
      if (dead) return
      const a = oneShots[name]
      if (!a) return
      for (const other of Object.values(oneShots)) other?.stop()
      shot = name
      shotRemaining = a.getClip().duration
      dead = name === 'death'
      a.reset().setEffectiveWeight(name === 'hit' ? 0.22 : 1).play()
    },

    shieldFlash(strength) { shieldFlashUniform.value = Math.max(shieldFlashUniform.value, strength) },

    get gait() { return { phase: gaitPhase, heading, backward: legIK?.backward ?? false } },
    update(speed, onGround, crouched, dt, vx = 0, vz = 0, gait) {
      // Fast enough to read as an impact rather than a glow that lingers on the armour.
      if (shieldFlashUniform.value > 0) shieldFlashUniform.value = Math.max(0, shieldFlashUniform.value - dt * SHIELD_FLASH_FADE)
      shotRemaining = Math.max(0, shotRemaining - dt)
      if (shot && !dead) {
        const weight = THREE.MathUtils.clamp(shotRemaining / 0.16, 0, 1)
        oneShots[shot]?.setEffectiveWeight(weight * 0.22)
        if (shotRemaining === 0) { oneShots[shot]?.stop(); shot = null }
      }
      upperIdle?.setEffectiveWeight(dead ? 0 : 1)
      const locomotion = dead ? 0 : 1
      const blend = 1 - Math.exp(-14 * dt)
      const weight = (a: THREE.AnimationAction | null, target: number) => {
        if (a) a.setEffectiveWeight(dead ? 0 : THREE.MathUtils.lerp(a.getEffectiveWeight(), target, blend))
      }

      // Two crossfades chained: still -> walking -> running, weighted by speed.
      const moving = THREE.MathUtils.clamp((speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED), 0, 1)
      const still = speed < WALK_SPEED ? 1 - speed / WALK_SPEED : 0

      const airborne = !onGround
      const crouching = crouched && onGround && !!crouch

      weight(idle, crouching ? 0 : airborne ? locomotion : still * locomotion)
      weight(walk, airborne || crouching ? 0 : (1 - still) * (1 - moving) * locomotion)
      weight(run, airborne ? 0 : crouching ? 0 : (1 - still) * moving * locomotion)
      weight(crouch, crouching ? locomotion : 0)
      weight(air, 0)

      // All moving clips share a phase, so walk/run blending cannot cancel opposite legs.
      // Native walk has a ~2 m stride, versus ~3.5 m for the run; scale cadence by distance.
      root.getWorldPosition(currentPosition)
      localTravel.copy(currentPosition).sub(previousPosition)
      previousPosition.copy(currentPosition)
      const travelLength = localTravel.length()
      root.getWorldQuaternion(facing)
      localTravel.applyQuaternion(facing.clone().invert())
      // travel direction in the body's own frame (0 forward, +pi/2 to its right): the procedural legs step along it
      root.parent?.getWorldQuaternion(bodyTurn); travel.set(vx, 0, vz).applyQuaternion(bodyTurn.invert())
      if (Math.hypot(vx, vz) > .2) heading = Math.atan2(travel.x, -travel.z)
      const backward = !legIK && hasPreviousPosition && travelLength < Math.max(1, speed * dt * 2)
        && localTravel.z > Math.abs(localTravel.x) * .5 + .0001
      hasPreviousPosition = true
      // sideways steps are shorter, so the cycle runs faster for the same ground covered (feet do not skate)
      const stride = (crouching ? 2 : THREE.MathUtils.lerp(2.03, 3.47, moving)) * (legIK ? legIK.stride : 1)
      if (gait !== undefined) gaitPhase = gait.phase
      else if (onGround && speed > .1) gaitPhase = THREE.MathUtils.euclideanModulo(gaitPhase + dt * speed / stride * (backward ? -1 : 1), 1)
      for (const a of [walk, run, crouch]) {
        if (!a) continue
        a.setEffectiveTimeScale(0)
        a.time = (a === crouch && speed < .1 ? .48 : gaitPhase) * a.getClip().duration
      }
      untwist()
      legIK?.restore()
      mixer.update(dt)
      if (chief) { applyChiefFingers('Right', recoil, dead ? .7 : 0); applyChiefFingers('Left', 0, dead ? .7 : 0) }
      else {
        poseFingers(inner, 'Right', recoil, dead ? .7 : 0)
        poseFingers(inner, 'Left', 0, dead ? .7 : 0)
      }
      // Keep the rifle aimed down-range and solve both arms onto its actual grip positions.
      // Locomotion still owns the torso and legs; death owns the whole skeleton.
      recoil = Math.max(0, recoil - dt * 12)
      pitch += (aimPitch - pitch) * (1 - Math.exp(-12 * dt))
      const tp = tpHold(weaponModel)
      if (!tp) { weaponMount.rotation.set(-pitch - recoil * 0.035, Math.PI, 0, 'YXZ'); weaponMount.position.z = -0.28 + recoil * 0.015 }
      rightFlashTime=Math.max(0,rightFlashTime-dt);leftFlashTime=Math.max(0,leftFlashTime-dt)
      if(rightFlash){rightFlash.visible=rightFlashTime>0&&!dead;if(rightFlash.visible){rightFlash.scale.setScalar(WORLD_FLASH);rightFlash.userData.fade?.(rightFlashTime/rightFlashLife)}}
      if(leftFlash){leftFlash.visible=leftFlashTime>0&&!dead;if(leftFlash.visible){leftFlash.scale.setScalar(WORLD_FLASH);leftFlash.userData.fade?.(leftFlashTime/leftFlashLife)}}
      weaponMount.visible = !dead && !(firstPerson && lowerBodyEnabled)
      if (firstPerson && lowerBodyEnabled) { const c = crouch?.getEffectiveWeight() ?? 0; root.position.z = FP_BODY.back + FP_BODY.crouchBack * c; root.rotation.x = FP_BODY.tilt + FP_BODY.crouchTilt * c }
      if (legIK && !dead && (detailLevel <= 1 || firstPerson)) {
        root.parent ? root.parent.getWorldPosition(feetAt) : root.getWorldPosition(feetAt)
        let total = 0; blendedCenters[0].set(0, 0, 0); blendedCenters[1].set(0, 0, 0)
        for (const [a, c] of strideCenters) { const w = a.getEffectiveWeight(); total += w; blendedCenters[0].addScaledVector(c[0], w); blendedCenters[1].addScaledVector(c[1], w) }
        if (total > .01) { blendedCenters[0].divideScalar(total); blendedCenters[1].divideScalar(total) }
        legIK.apply({ heading, moving: THREE.MathUtils.clamp((speed - .3) / 1.2, 0, 1), grounded: onGround, floor: spartanFloor, base: feetAt.y, dt, centers: total > .01 ? blendedCenters : undefined,
          chest: twistNow * Math.PI / 180, blade: bladeNow * Math.PI / 180, crouch: crouch?.getEffectiveWeight() ?? 0, backward: gait?.backward })
      }
      if (!dead) {
        root.updateWorldMatrix(true, true)
        if (chest && tp) placeTpMount(tp, dt)
        if (weaponMount.visible) { root.updateWorldMatrix(true, true); showWeaponState(weaponMount, false, dt); showWeaponState(leftMount, true, dt) }
        else if (chest) {
          root.worldToLocal(chest.getWorldPosition(chestPosition))
          // the character faces -z in its own frame, so its right is +x and forward is -z
          weaponMount.position.set(chestPosition.x + .10, chestPosition.y + (smallArm(weaponModel) ? .025 : -.12), chestPosition.z - (smallArm(weaponModel) ? .43 : .242) + recoil * .015)
        }
        if (head) {
          root.getWorldQuaternion(facing)
          lookRotation.setFromAxisAngle(rightAxis, pitch * .65)
          headRotation.copy(facing).multiply(lookRotation).multiply(headRootRest)
          head.quaternion.copy(head.parent!.getWorldQuaternion(headParent).invert().multiply(headRotation))
        }
        root.updateWorldMatrix(true, true)
        const elbowHeight = weaponMount.position.y - .42
        if (rightChain) {
          rightTarget.getWorldPosition(aimTarget)
          root.localToWorld(aimPole.set(.55, elbowHeight, .05))
          poseRifleLimb(rightChain, aimTarget, aimPole)
          orientWrist(hand!, rightTarget, chief ? identityCorrection : gripR)
        }
        if (leftChain) {
          const lt = actLeftOn ? actLeft : leftTarget
          lt.getWorldPosition(aimTarget)
          // a guard's elbow tucks down and back beside the ribs; on a weapon it stays out and a little forward
          if (lt === relaxedLeft) root.localToWorld(aimPole.set(chestPosition.x - .55, chestPosition.y - .3, chestPosition.z + .2))
          else root.localToWorld(aimPole.set(-.48, elbowHeight, -.15))
          poseRifleLimb(leftChain, aimTarget, aimPole)
          orientWrist(leftHand!, lt, chief ? identityCorrection : gripL)
        }
      }
    },
  }
}
