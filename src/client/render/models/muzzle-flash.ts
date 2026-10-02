import * as THREE from 'three'
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js'
import {WEAPON_FX} from '../../game/weapon-fx.ts'

/**
 * The first-person muzzle flash: one mesh, one draw, no transient lights (the weapon's own fill light is kicked
 * instead, see HeldWeapon), nothing allocated per shot.
 *
 * Three cards: a star burst facing back down the barrel (what the shooter sees of the flash) and two crossed flame
 * tongues along the barrel (its side view). One atlas holds both shapes. The colour runs past 1 and is not tone mapped,
 * so inside the bloom target (first-person-pass.ts) the core blooms white-hot while the petals keep their colour.
 * Every shot rolls and resizes it (`userData.shot`) so automatic fire never repeats a frame, and it fades and swells
 * over its short life (`userData.fade`). Plasma and needles get a soft orb instead of petals.
 */
const atlases = new Map<string, THREE.CanvasTexture>()
type Kind = 'ballistic' | 'plasma' | 'needle'
const kindOf = (id: string): Kind => id.startsWith('plasma-') ? 'plasma' : id === 'needler' ? 'needle' : 'ballistic'
/** HDR tint of the petals (linear); the core is white either way. */
const TINT: Record<string, [number, number, number]> = {
  ballistic: [2.4, 1.45, .55], 'plasma-pistol': [.7, 2.6, .45], 'plasma-rifle': [.45, 1.5, 2.8], needle: [2.6, .6, 2.2],
}
/** Seconds the flash stays up; heavy single shots linger, automatic fire flickers. */
const LIFE: Record<string, number> = {smg: .035, 'assault-rifle': .04, 'battle-rifle': .045, magnum: .055, shotgun: .075, sniper: .08, 'rocket-launcher': .09}

function atlas(kind: Kind): THREE.CanvasTexture {
  const hit = atlases.get(kind)
  if (hit) return hit
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128
  const c = canvas.getContext('2d')!
  // left half: the burst seen from behind
  c.save(); c.translate(64, 64)
  const core = c.createRadialGradient(0, 0, 0, 0, 0, 64)
  core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(.18, 'rgba(255,255,255,.95)'); core.addColorStop(.42, 'rgba(255,255,255,.35)'); core.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = core
  if (kind === 'ballistic') {
    // uneven petals: the gas leaves through the flash hider in jets, not a circle
    c.beginPath()
    const petals = 7
    for (let i = 0; i <= petals * 2; i++) {
      const a = i / (petals * 2) * Math.PI * 2, r = i % 2 ? 9 + 5 * Math.sin(i * 2.3) : 46 + 16 * Math.sin(i * 1.7 + 1)
      c.lineTo(Math.cos(a) * r, Math.sin(a) * r)
    }
    c.closePath(); c.fill()
    c.globalAlpha = .9; c.beginPath(); c.arc(0, 0, 22, 0, Math.PI * 2); c.fill()
  } else {
    c.beginPath(); c.arc(0, 0, 62, 0, Math.PI * 2); c.fill()
    c.globalAlpha = .6; c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 3; c.beginPath(); c.arc(0, 0, 34, 0, Math.PI * 2); c.stroke()
  }
  c.restore()
  // right half: the flame tongue from the side, root at the left edge (the muzzle), tip at the right
  c.save(); c.translate(128, 64)
  const tongue = c.createLinearGradient(0, 0, 128, 0)
  tongue.addColorStop(0, 'rgba(255,255,255,1)'); tongue.addColorStop(.35, 'rgba(255,255,255,.7)'); tongue.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = tongue
  c.beginPath(); c.moveTo(0, -10)
  if (kind === 'ballistic') { c.quadraticCurveTo(40, -34, 128, -3); c.lineTo(128, 3); c.quadraticCurveTo(40, 34, 0, 10) }
  else { c.quadraticCurveTo(30, -26, 80, -2); c.lineTo(80, 2); c.quadraticCurveTo(30, 26, 0, 10) }
  c.closePath(); c.fill()
  c.restore()
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace
  atlases.set(kind, map)
  return map
}

/** A plane whose UVs cover one half of the atlas (0 = burst, 1 = tongue). */
function card(w: number, h: number, half: 0 | 1): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h), uv = g.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setX(i, half * .5 + uv.getX(i) * .5)
  return g
}

export function createMuzzleFlash(id: string): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const kind = kindOf(id), fx = WEAPON_FX[id]?.flash ?? 1
  const size = fx * (kind === 'plasma' ? .1 : kind === 'needle' ? .14 : .13)
  // burst faces back along the barrel (+Z is downrange at the muzzle anchor); tongues lie along it, root at the muzzle
  const burst = card(size, size, 0)
  const length = size * (kind === 'ballistic' ? 2.1 : 1.2)
  const side = card(length, size * .9, 1).translate(length / 2, 0, 0).rotateY(-Math.PI / 2)
  const cross = side.clone().rotateZ(Math.PI / 2)
  const geometry = mergeGeometries([burst, side, cross]); burst.dispose(); side.dispose(); cross.dispose()
  const tint = TINT[kind === 'ballistic' ? 'ballistic' : kind === 'needle' ? 'needle' : id] ?? TINT.ballistic
  const material = new THREE.MeshBasicMaterial({map: atlas(kind), color: new THREE.Color(...tint), toneMapped: false, transparent: true,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false})
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'muzzle-flash'; mesh.frustumCulled = false
  let size01 = 1
  mesh.userData.life = LIFE[id] ?? .05
  /** Light kick for the weapon's fill light: its colour and how hard it flashes. */
  mesh.userData.light = {color: new THREE.Color(...tint).multiplyScalar(1 / Math.max(...tint)), strength: kind === 'ballistic' ? 2.2 * fx : 1.6 * fx}
  mesh.userData.shot = () => { mesh.rotation.z = Math.random() * Math.PI * 2; size01 = .8 + Math.random() * .4 }
  /** 1 at the shot, 0 at the end of its life: bright and tight first, then dimmer and wider. */
  mesh.userData.fade = (k: number) => { material.opacity = Math.min(1, k * 1.6); mesh.scale.multiplyScalar(size01 * (1.25 - .25 * k)) }
  return mesh
}

/**
 * A few soft puffs that leave the muzzle after a ballistic shot and drift up as they thin out: the shooter's side of
 * the smoke. Viewmodel space (they ride the camera, like the flash), normal blending so they read as smoke not light.
 */
export interface MuzzleSmoke { group: THREE.Group; emit(at: THREE.Vector3, along: THREE.Vector3): void; update(dt: number): void }
let smokeMap: THREE.CanvasTexture | null = null
export function createMuzzleSmoke(id: string): MuzzleSmoke | null {
  if (kindOf(id) !== 'ballistic' || !WEAPON_FX[id]?.flash) return null
  if (!smokeMap) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
    const c = canvas.getContext('2d')!, g = c.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(.5, 'rgba(255,255,255,.22)'); g.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = g; c.fillRect(0, 0, 64, 64)
    smokeMap = new THREE.CanvasTexture(canvas); smokeMap.colorSpace = THREE.SRGBColorSpace
  }
  const heavy = ['shotgun', 'sniper', 'rocket-launcher', 'magnum'].includes(id)
  const group = new THREE.Group(); group.name = 'muzzle-smoke'
  const puffs = Array.from({length: 4}, () => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({map: smokeMap, color: 0xb9b4ac, transparent: true, depthWrite: false, opacity: 0}))
    sprite.visible = false; sprite.frustumCulled = false; group.add(sprite)
    return {sprite, age: 1, life: 1, velocity: new THREE.Vector3(), grow: 0}
  })
  let next = 0
  return {
    group,
    emit(at, along) {
      const p = puffs[next]; next = (next + 1) % puffs.length
      p.sprite.position.copy(at); p.age = 0; p.life = heavy ? .7 : .4
      p.velocity.copy(along).multiplyScalar(heavy ? .5 : .3).add(new THREE.Vector3((Math.random() - .5) * .06, .09 + Math.random() * .05, 0))
      p.grow = heavy ? .16 : .09; p.sprite.visible = true
      p.sprite.material.rotation = Math.random() * Math.PI * 2
    },
    update(dt) {
      for (const p of puffs) {
        if (!p.sprite.visible) continue
        p.age += dt
        const k = p.age / p.life
        if (k >= 1) { p.sprite.visible = false; continue }
        p.velocity.multiplyScalar(Math.exp(-3 * dt)); p.velocity.y += .05 * dt
        p.sprite.position.addScaledVector(p.velocity, dt)
        p.sprite.scale.setScalar(.03 + p.grow * Math.sqrt(k))
        p.sprite.material.opacity = (heavy ? .5 : .32) * (1 - k) * Math.min(1, k * 8)
      }
    },
  }
}
