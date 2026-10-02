import {finishWeapon} from './weapon-finish.ts'
import * as THREE from 'three'
import { injectShieldRim, firstPersonShieldFlash, FIRST_PERSON_SHIELD_WASH, teamMap } from './character.ts'
import type { Team } from '../../../shared/map.ts'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { loadResource } from '../load-resource.ts'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { ModelId } from '../../../shared/assets.ts'
import { rifleReload, rifleMelee } from './rifle-reload.ts'
import { RIFLE_MELEE } from '../../../shared/loadout.ts'
import { loadFragGrenade } from './frag-grenade.ts'
import { createPlasmaGrenade, type PlasmaGrenadeModel } from './plasma-grenade.ts'
import { grenadeThrowClip, GRENADE_THROW } from './grenade-throw.ts'
import { rigHands } from './hand-rig.ts'
import { addArmorEdges, armorSurface, injectArmor, ARMS_GLOW } from './armor-surface.ts'
import { fitGrips } from './grip-fit.ts'

export type ViewmodelAction = 'idle' | 'fire' | 'reload' | 'melee' | 'grenade'
const ACTIONS: readonly ViewmodelAction[] = ['idle', 'fire', 'reload', 'melee', 'grenade']
const SUPPORTED = new Set<ModelId>(['smg', 'plasma-pistol', 'plasma-rifle', 'assault-rifle', 'magnum', 'sniper', 'rocket-launcher', 'shotgun', 'energy-sword', 'battle-rifle', 'needler', 'gravity-hammer'])
const sources = new Map<ModelId, Promise<GLTF>>()

export interface AnimatedViewmodel {
  /** Parent directly to the camera: the Blender scene is already in camera-local metres. */
  readonly object: THREE.Group
  readonly muzzle: THREE.Object3D
  readonly alternateMuzzle: THREE.Object3D | null
  /** Duration in authored seconds; gameplay owns damage, ammo, and projectile events. */
  duration(action: ViewmodelAction): number
  /** Deterministic, absolute clip time. Does not advance gameplay or emit action events. */
  sample(action: ViewmodelAction, seconds: number): void
  play(action: ViewmodelAction): void
  update(dt: number): void
  muzzlePosition(target: THREE.Vector3, alternate?: boolean): THREE.Vector3
  setAmmo(ammo: number): void
  /** A held grenade follows its authored clip transform; null hides the prop after release. */
  setGrenade(kind: 'frag' | 'plasma' | null): void
  /** Release anchor sampled at the hand-opening key, transformed by the current camera pose. */
  grenadePosition(target: THREE.Vector3): THREE.Vector3
  /** Releases instance-only resources; cached source geometry/textures remain reusable. */
  setOneHanded(on:boolean): void
  dispose(): void
}

async function sourceFor(id: ModelId): Promise<GLTF> {
  if (!SUPPORTED.has(id)) throw new Error(`No authored viewmodel for ${id}`)
  let pending = sources.get(id)
  if (!pending) {
    pending = loadResource(`/assets/viewmodels/${id}.glb`).catch(error => {
      sources.delete(id)
      throw error
    })
    sources.set(id, pending)
  }
  return pending
}

/** export_name survives Blender review-scene suffixes; Three sanitizes punctuation for tracks. */
function named(root: THREE.Object3D, name: string): THREE.Object3D | null {
  const sanitized = THREE.PropertyBinding.sanitizeNodeName(name)
  let found: THREE.Object3D | null = null
  root.traverse(node => {
    if (!found && (node.name === name || node.name === sanitized || node.userData.name === name || node.userData.export_name === name)) found = node
  })
  return found
}


/**
 * Weapons that play another weapon's melee rather than their own.
 *
 * `lead` turns the borrowed motion so this weapon presents the right face on the way in - the
 * needler takes the sword's one-handed reach but has to arrive spikes first.
 */
const BORROWED_MELEE: Partial<Record<ModelId, { from: ModelId; lead?: readonly [number, number, number]; reach?: number }>> = {
  // The sword's reach suits a metre of blade; the needler is short enough that the full
  // extension carries it out of the frame, so it takes the same motion over a shorter throw.

}

/**
 * The node the weapon body hangs from. Each file names it differently, and the loader strips the
 * punctuation out of all of them, so `held-weapon:magnum.004` arrives as `held-weaponmagnum004`
 * and `H3 held weapon needler.001` as `H3_held_weapon_needler001`.
 */
function weaponNode(root: THREE.Object3D): THREE.Object3D | null {
  let found: THREE.Object3D | null = null
  root.traverse(node => {
    if (!found && /^(held-weapon|H3[_ ]held[_ ]weapon)/i.test(node.name)) found = node
  })
  return found
}

/**
 * Play the donor's melee on this weapon.
 *
 * The Spartan arm rig is the same in every viewmodel, so its bone tracks bind by name and carry
 * over untouched - that is what makes the motion itself identical. The weapon is the part that
 * cannot be copied outright: it hangs under a different parent with its own rest pose, so its
 * track is transferred as the donor's movement away from the donor's rest, replayed from this
 * weapon's rest. Scale is left alone entirely, or one weapon would inherit another's size.
 */
function borrowMelee(donorClip: THREE.AnimationClip, donorWeapon: THREE.Object3D, ownWeapon: THREE.Object3D,
                     own: THREE.Object3D, lead?: readonly [number, number, number], reach = 1): THREE.AnimationClip {
  const donorRestQuaternion = donorWeapon.quaternion.clone()
  const donorRestPosition = donorWeapon.position.clone()
  const ownRestQuaternion = ownWeapon.quaternion.clone()
  const ownRestPosition = ownWeapon.position.clone()
  const turn = lead ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...lead)) : null
  const donorPrefix = `${donorWeapon.name}.`
  const scratch = new THREE.Quaternion()
  const tracks: THREE.KeyframeTrack[] = []
  for (const track of donorClip.tracks) {
    const dot = track.name.lastIndexOf('.')
    const node = track.name.slice(0, dot), property = track.name.slice(dot + 1)
    if (track.name.startsWith(donorPrefix)) {
      if (property === 'scale') continue
      const values = Float32Array.from(track.values)
      if (property === 'quaternion') {
        for (let i = 0; i < values.length; i += 4) {
          scratch.set(values[i], values[i + 1], values[i + 2], values[i + 3])
          scratch.premultiply(donorRestQuaternion.clone().invert()).premultiply(ownRestQuaternion)
          if (turn) scratch.multiply(turn)
          values[i] = scratch.x; values[i + 1] = scratch.y; values[i + 2] = scratch.z; values[i + 3] = scratch.w
        }
      } else if (property === 'position') {
        for (let i = 0; i < values.length; i += 3) {
          values[i] = ownRestPosition.x + (values[i] - donorRestPosition.x) * reach
          values[i + 1] = ownRestPosition.y + (values[i + 1] - donorRestPosition.y) * reach
          values[i + 2] = ownRestPosition.z + (values[i + 2] - donorRestPosition.z) * reach
        }
      }
      tracks.push(new (track.constructor as new (...args: never[]) => THREE.KeyframeTrack)(
        ...[`${ownWeapon.name}.${property}`, Float32Array.from(track.times), values] as never[]))
      continue
    }
    // Anything the donor animates that this weapon simply does not have (its own magazine, a
    // stowed grenade) would only raise a binding warning every frame.
    if (!named(own, node)) continue
    tracks.push(track.clone())
  }
  return new THREE.AnimationClip('melee', donorClip.duration, tracks)
}

/**
 * Your arms wear your team's colour, like your body (character.ts teamMap recolours the green
 * plates and leaves the gloves and undersuit). The arms are the viewmodel's only skinned meshes.
 * Their materials are shared by every cached copy of the weapon, all of them yours, so the
 * untinted map is kept to recolour from if the next match puts you on the other side.
 */
export function tintViewmodelArms(object: THREE.Object3D, team: Team): void {
  object.traverse(node => {
    const mesh = node as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
      if (!material?.map) continue
      const untinted = (material.userData.untintedMap ??= material.map) as THREE.Texture
      material.map = teamMap(team, untinted)
    }
  })
}

/** Blender arm/weapon assets with rifle reload tracks solved once on the asset's own rig. */
export async function loadAnimatedViewmodel(id: ModelId): Promise<AnimatedViewmodel> {
  const source = await sourceFor(id)
  const clips = new Map(source.animations.map(clip => [clip.name.toLowerCase(), clip]))
  for (const action of ACTIONS) {
    if (!clips.has(action)) throw new Error(`${id}.glb is missing the ${action} animation`)
  }
  const inner = cloneSkinned(source.scene) as THREE.Group
  // Files carrying the retargeted Chief arms already contain what the runtime otherwise builds on top of the old rig (grip fixes, forearm
  // twist, plates, generated reload/melee/grenade, borrowed melee): tools/vm-merge.mjs bakes it into the clips.
  const baked = !!source.scene.userData.fpsArms
  if (!baked) clips.set('grenade', grenadeThrowClip(inner, id, clips.get('idle')!, clips.get('grenade')!))
  if (!baked && (id === 'assault-rifle' || id === 'battle-rifle')) {
    clips.set('reload', rifleReload(inner, id, clips.get('idle')!, clips.get('reload')!.duration))
    clips.set('melee', rifleMelee(inner, id, clips.get('idle')!, RIFLE_MELEE.duration))
  }
  const borrow = baked ? undefined : BORROWED_MELEE[id]
  if (borrow) {
    const donor = await sourceFor(borrow.from)
    const donorClip = donor.animations.find(clip => clip.name.toLowerCase() === 'melee')
    const donorWeapon = weaponNode(donor.scene), ownWeapon = weaponNode(inner)
    if (donorClip && donorWeapon && ownWeapon) clips.set('melee', borrowMelee(donorClip, donorWeapon, ownWeapon, inner, borrow.lead, borrow.reach))
    else console.warn(`${id}: cannot borrow the ${borrow.from} melee; keeping its own`)
  }
  const object = new THREE.Group()
  object.name = `animated-viewmodel:${id}`
  object.userData.source = `/assets/viewmodels/${id}.glb`
  object.add(inner)
  const sourceMuzzle = named(inner, 'anchor:muzzle')
  if (!sourceMuzzle) throw new Error(`${id}.glb is missing anchor:muzzle`)
  const sourceAlternate = named(inner, 'anchor:muzzle:alternate')
  const alias = (anchor: THREE.Object3D, name: string) => {
    if (anchor.name === name) return anchor
    // Keep animated node names intact; exact-label aliases also support external FX/debug tools.
    const marker = new THREE.Object3D()
    marker.name = name
    anchor.add(marker)
    return marker
  }
  const muzzle = alias(sourceMuzzle, 'anchor:muzzle')
  const alternateMuzzle = sourceAlternate ? alias(sourceAlternate, 'anchor:muzzle:alternate') : null
  const skins: THREE.SkinnedMesh[] = []
  inner.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    // These arms stay beside the eye even when the source rest bounds leave the frustum.
    mesh.frustumCulled = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.userData.noShadow = true
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skins.push(mesh as THREE.SkinnedMesh)
    // Your own shields light the whole viewmodel - arms and weapon both, since this file
    // carries both. The materials are shared across cached instances of the same weapon, which
    // are all yours, and the world models other players see load from a different file, so the
    // patch cannot leak onto anyone else's gun. Guarded because the share means a second
    // instance would otherwise force a needless recompile.
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if(material)finishWeapon(material)
      if (!material || material.userData.shieldRim) continue
      material.userData.shieldRim = true
      // The only skinned mesh is the arms: painted-metal Mjolnir plates (armor-surface.ts).
      // texture-only arms, like the third-person armour (character.ts): no painted-plate shader
      const armor = null as ReturnType<typeof armorSurface>
      if (armor) addArmorEdges(mesh.geometry)
      material.onBeforeCompile = armor
        ? shader => { injectArmor(shader, armor, ARMS_GLOW); injectShieldRim(shader, firstPersonShieldFlash, FIRST_PERSON_SHIELD_WASH) }
        : shader => injectShieldRim(shader, firstPersonShieldFlash, FIRST_PERSON_SHIELD_WASH)
      material.needsUpdate = true
    }
  })
  if (!skins.length) throw new Error(`${id}.glb has no skinned arm rig`)

  // Capture the authored ready pose once. Every action switch starts from it so a clip that
  // doesn't key a magazine, finger, or helper object cannot inherit the preceding action.
  const baselineMixer = new THREE.AnimationMixer(inner)
  baselineMixer.clipAction(clips.get('idle')!).play()
  baselineMixer.update(0)
  const baseline: {
    node: THREE.Object3D
    position: THREE.Vector3
    quaternion: THREE.Quaternion
    scale: THREE.Vector3
    morphs?: number[]
  }[] = []
  inner.traverse(node => baseline.push({
    node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone(),
    morphs: (node as THREE.Mesh).morphTargetInfluences?.slice(),
  }))
  baselineMixer.stopAllAction()
  baselineMixer.uncacheRoot(inner)
  const restore = () => {
    for (const rest of baseline) {
      rest.node.position.copy(rest.position)
      rest.node.quaternion.copy(rest.quaternion)
      rest.node.scale.copy(rest.scale)
      const influences = (rest.node as THREE.Mesh).morphTargetInfluences
      if (influences && rest.morphs) for (let i = 0; i < rest.morphs.length; i++) influences[i] = rest.morphs[i]
    }
  }
  restore()
  // Joint corrections for hands that sit badly on their grips (grip-fit.ts), measured at idle.
  const gripFit = baked ? { apply() {} } : fitGrips(inner, weaponNode(inner), id)
  // Forearm twist bones and the back-of-hand armour plates (hand-rig.ts), fitted in the idle pose.
  const handRig = baked ? { apply() {}, dispose() {} } : rigHands(inner, skins)
  let oneHanded=false
  const supportArm=named(inner,'LeftArm'), supportScale=supportArm?.scale.clone()
  const mixer = new THREE.AnimationMixer(inner)
  const actions = new Map(ACTIONS.map(name => {
    const action = mixer.clipAction(clips.get(name)!)
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    return [name, action] as const
  }))
  let selected: ViewmodelAction | null = null
  let elapsed = 0
  let disposed = false
  const rotor = id === 'rocket-launcher' ? named(inner, 'rocket-tubes') : null
  let ammoValue = id==='needler'?20:2
  const needles=id==='needler'?Array.from({length:20},(_,i)=>named(inner,`needler-crystal-${i}`)):[]
  const applyNeedleVisibility=()=>{for(let i=0;i<needles.length;i++){const n=needles[i];if(n)n.visible=i<ammoValue||(selected==='reload'&&elapsed>clips.get('reload')!.duration*.26)}}
  const rotorRest = rotor?.quaternion.clone()
  const indexOffset = new THREE.Quaternion()
  const indexAxis = new THREE.Vector3(0, 0, 1)
  const applyRocketIndex = () => {
    if (!rotor || !rotorRest) return
    // The fire clip contains one half-turn; start it at the previous chamber's
    // angle. During reload the replacement pack resets while it is out of view.
    const parity = selected === 'fire' ? (ammoValue + 1) % 2
      : selected === 'reload' && elapsed > clips.get('reload')!.duration * .5 ? 0 : ammoValue % 2
    rotor.quaternion.multiply(indexOffset.setFromAxisAngle(indexAxis, parity * Math.PI))
  }
  const sample = (name: ViewmodelAction, seconds: number) => {
    if (disposed) return
    const action = actions.get(name)!
    if (selected !== name) {
      mixer.stopAllAction()
      restore()
      action.reset().setEffectiveWeight(1).play()
      selected = name
    }
    elapsed = THREE.MathUtils.clamp(Number.isFinite(seconds) ? seconds : 0, 0, action.getClip().duration)
    // Pausing lets the mixer evaluate an absolute pose without accumulating a second clock.
    action.paused = true
    action.enabled = true
    action.time = elapsed
    if (rotor && rotorRest) rotor.quaternion.copy(rotorRest)
    mixer.update(0)
    // A hidden dual-wield support arm must be restored before IK measures its chain.
    if(supportArm&&supportScale)supportArm.scale.copy(supportScale)
    gripFit.apply()
    handRig.apply()
    if(supportArm&&supportScale)supportArm.scale.copy(supportScale).multiplyScalar(oneHanded?0.00001:1)
    applyRocketIndex()
    applyNeedleVisibility()
    object.updateWorldMatrix(true, true)
  }

  // Only this optional display material is instance-owned. Armour and weapon PBR materials,
  // textures, and geometry remain exactly as exported and are shared across cached instances.
  // Replace the actual exported LCD surface; a guessed floating plane can sit
  // behind the receiver and leave the baked digits visible forever.
  const display = id === 'assault-rifle' || id==='battle-rifle' ? named(inner, 'ammo-counter') : null
  const digitsOnly = display?.userData.counterLayout === 'digits'
  let counter: { ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture; material: THREE.MeshBasicMaterial } | null = null
  if (display) {
    const canvas = document.createElement('canvas')
    canvas.width = 128; canvas.height = id==='battle-rifle'||digitsOnly?64:192
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.flipY = !digitsOnly
      const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
      display.traverse(node => { if ((node as THREE.Mesh).isMesh) (node as THREE.Mesh).material = material })
      counter = { ctx, texture, material }
    }
  }
  const grenade = named(inner, 'held-grenade')
  const grenadeMaterials: THREE.Material[] = []
  grenade?.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const copy = (material: THREE.Material) => { const cloned = material.clone(); grenadeMaterials.push(cloned); return cloned }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copy) : copy(mesh.material)
  })
  const nativeFragMaterials: THREE.Material[] = []
  let nativeFrag: THREE.Group | null = null
  let heldPlasma: PlasmaGrenadeModel | null = null
  let clock = 0
  if (grenade) {
    nativeFrag = await loadFragGrenade()
    // Fit the imported grenade into the existing prop's local bounds so all keyed hand
    // positions and visibility scales remain valid across the nine different arm rigs.
    const original = grenade.clone(true)
    original.position.set(0, 0, 0); original.quaternion.identity(); original.scale.setScalar(1)
    const targetBounds = new THREE.Box3().setFromObject(original)
    const bounds = new THREE.Box3().setFromObject(nativeFrag)
    const size = targetBounds.getSize(new THREE.Vector3()), nativeSize = bounds.getSize(new THREE.Vector3())
    const scale = Math.max(size.x, size.y, size.z) / Math.max(nativeSize.x, nativeSize.y, nativeSize.z)
    nativeFrag.scale.setScalar(scale)
    nativeFrag.position.copy(targetBounds.getCenter(new THREE.Vector3())).addScaledVector(bounds.getCenter(new THREE.Vector3()), -scale)
    nativeFrag.name = 'halo3-held-frag'
    nativeFrag.traverse(node => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.frustumCulled = false
      const copy = (material: THREE.Material) => {
        const own = material.clone()
        own.onBeforeCompile = shader => injectShieldRim(shader, firstPersonShieldFlash, FIRST_PERSON_SHIELD_WASH)
        nativeFragMaterials.push(own)
        return own
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copy) : copy(mesh.material)
    })
    grenade.add(nativeFrag)
    nativeFrag.visible = false
    // The plasma grenade fills the same bounds, so the fingers close around it the same way.
    heldPlasma = createPlasmaGrenade()
    // Measured from the model's claws and pod; its glow sprite would inflate a computed box.
    const plasmaScale = Math.max(size.x, size.y, size.z) / .17
    heldPlasma.object.scale.setScalar(plasmaScale)
    heldPlasma.object.position.copy(targetBounds.getCenter(new THREE.Vector3())).addScaledVector(new THREE.Vector3(0, -.02, 0), -plasmaScale)
    heldPlasma.object.name = 'halo3-held-plasma'
    heldPlasma.object.visible = false
    grenade.add(heldPlasma.object)
  }
  if (grenade) grenade.visible = false
  let grenadeKind: 'frag' | 'plasma' | null = null
  let lastAmmo = -1
  let alternate = false
  sample('grenade', GRENADE_THROW.release)
  const grenadeRelease = grenade ? object.worldToLocal(grenade.getWorldPosition(new THREE.Vector3())) : new THREE.Vector3(0,-.15,-.35)
  sample('idle', 0)
  return {
    object, muzzle, alternateMuzzle,
    duration: action => clips.get(action)!.duration,
    sample,
    setOneHanded(on) {oneHanded=on},
    play(action) { sample(action, 0) },
    update(dt) {
      if (disposed) return
      clock += Number.isFinite(dt) ? dt : 0
      if (heldPlasma?.object.visible) heldPlasma.update(clock, 0)
      const action = selected ?? 'idle'
      const end = clips.get(action)!.duration
      const next = elapsed + Math.max(0, Number.isFinite(dt) ? dt : 0)
      if (action === 'idle') sample('idle', end > 0 ? next % end : 0)
      else if (next <= end) sample(action, next)
      else sample('idle', 0)
    },
    muzzlePosition(target, useAlternate = alternate) {
      object.updateWorldMatrix(true, true)
      return (useAlternate && alternateMuzzle ? alternateMuzzle : muzzle).getWorldPosition(target)
    },
    setAmmo(value) {
      const ammo = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
      ammoValue = ammo
      applyNeedleVisibility()
      alternate = Boolean(ammo % 2)
      if (!counter || ammo === lastAmmo) return
      lastAmmo = ammo
      const { ctx, texture } = counter
      ctx.fillStyle = '#061d29'; ctx.fillRect(0, 0, 128, 192)
      ctx.strokeStyle = '#2f728a'; ctx.lineWidth = 3; ctx.strokeRect(5, 5, 118, 182)
      ctx.fillStyle = '#82dcff'; ctx.textAlign = 'center'; ctx.font = 'bold 64px monospace'
      ctx.fillText(String(ammo).padStart(2, '0'), 64, 123)
      ctx.font = '22px monospace'; ctx.fillText('N', 64, 44)
      ctx.font = '18px monospace'; ctx.fillText('MA5B', 64, 170)
      if(id==='battle-rifle'||digitsOnly){ctx.fillStyle='#061d29';ctx.fillRect(0,0,128,64);ctx.fillStyle='#82dcff';ctx.font='bold 56px monospace';ctx.fillText(String(ammo).padStart(2,'0'),64,52)}
      texture.needsUpdate = true
    },
    setGrenade(kind) {
      if (!grenade) return
      grenade.visible = kind !== null
      if (nativeFrag) nativeFrag.visible = kind === 'frag'
      if (heldPlasma) heldPlasma.object.visible = kind === 'plasma'
      if (kind === null || kind === grenadeKind) return
      grenadeKind = kind
      // The authored placeholder only shows if neither native model could be built.
      for (const material of grenadeMaterials) {
        material.visible = kind === 'frag' ? !nativeFrag : !heldPlasma
        const surface = material as THREE.MeshStandardMaterial
        surface.color?.setHex(kind === 'frag' ? 0x68714a : 0x59c5ff)
        surface.emissive?.setHex(kind === 'frag' ? 0 : 0x268dff)
      }
    },
    grenadePosition(target) {
      object.updateWorldMatrix(true,false)
      return object.localToWorld(target.copy(grenadeRelease))
    },
    dispose() {
      if (disposed) return
      disposed = true
      mixer.stopAllAction()
      handRig.dispose()
      mixer.uncacheRoot(inner)
      for (const skin of skins) skin.skeleton.dispose()
      counter?.texture.dispose()
      counter?.material.dispose()
      for (const material of grenadeMaterials) material.dispose()
      for (const material of nativeFragMaterials) material.dispose()
      object.removeFromParent()
    },
  }
}
