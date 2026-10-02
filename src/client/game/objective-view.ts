import * as THREE from 'three'
import type { Objectives, ObjectiveItem, ObjectiveZone } from '../../shared/objectives.ts'
import type { Team } from '../../shared/map.ts'
import type { Player } from './player.ts'

/**
 * What the game type puts in the world: flags on their stands, the ball, the bomb, the plates,
 * and a column of light over anything worth running at.
 *
 * All of it is unlit and procedural. An objective has to read from across the canyon in any
 * light, and none of it is worth a download. The light columns are the Halo convention for
 * "this is where the game is" and double as the long-range cue the HUD waypoints point at.
 */

/** Brighter than the armour tints: these have to carry at a hundred metres. */
export const OBJECTIVE_TEAM_COLOR: Record<Team, number> = { red: 0xff5d4a, blue: 0x5fa8ff }
const BALL_COLOR = 0xfff0a0
const BOMB_COLOR = 0xffa040

export function objectiveColor(item: { kind: ObjectiveItem['kind']; team: Team | null }): number {
  return item.team ? OBJECTIVE_TEAM_COLOR[item.team] : item.kind === 'ball' ? BALL_COLOR : BOMB_COLOR
}

let fade: THREE.Texture | null = null
/** Opaque at the foot of a column, gone at the top. An alpha map reads the green channel, so
 * the gradient runs black to white rather than through transparency. */
function fadeTexture(): THREE.Texture {
  if (fade) return fade
  const canvas = document.createElement('canvas')
  canvas.width = 1; canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 64)
  g.addColorStop(0, '#000')
  g.addColorStop(.55, '#555')
  g.addColorStop(1, '#fff')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 1, 64)
  fade = new THREE.CanvasTexture(canvas)
  return fade
}

function column(color: number, height: number, radius: number, opacity: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 20, 1, true),
    new THREE.MeshBasicMaterial({ color, alphaMap: fadeTexture(), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  )
  mesh.position.y = height / 2
  mesh.renderOrder = 5
  mesh.userData.opacity = opacity
  return mesh
}

/** A column is a long-range cue; up close it would only be a wall of colour in your face. */
function fadeNear(mesh: THREE.Mesh, camera: THREE.Vector3): void {
  const at = mesh.getWorldPosition(scratch)
  const near = Math.hypot(at.x - camera.x, at.z - camera.z)
  const k = Math.max(0, Math.min(1, (near - 2) / 10))
  ;(mesh.material as THREE.MeshBasicMaterial).opacity = mesh.userData.opacity * k
  mesh.visible = mesh.visible && k > 0
}
const scratch = new THREE.Vector3()

function ring(color: number, radius: number): THREE.Group {
  const group = new THREE.Group()
  const edge = new THREE.Mesh(new THREE.RingGeometry(radius - .16, radius, 56),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .85, depthWrite: false, side: THREE.DoubleSide }))
  const fill = new THREE.Mesh(new THREE.CircleGeometry(radius - .16, 56),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .12, depthWrite: false, side: THREE.DoubleSide }))
  for (const m of [edge, fill]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 4; group.add(m) }
  group.position.y = .06
  return group
}

interface FlagParts { group: THREE.Group; cloth: THREE.Mesh; rest: Float32Array }

function buildFlag(color: number, scale = 1): FlagParts {
  const group = new THREE.Group()
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(.035, .035, 2.5, 8), new THREE.MeshBasicMaterial({ color: 0xb8c0c8 }))
  pole.position.y = 1.25
  const cap = new THREE.Mesh(new THREE.SphereGeometry(.07, 10, 8), new THREE.MeshBasicMaterial({ color: 0xe8edf2 }))
  cap.position.y = 2.52
  const geometry = new THREE.PlaneGeometry(1.05, .68, 10, 1)
  geometry.translate(.54, 0, 0)
  const cloth = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }))
  cloth.position.y = 2.1
  group.add(pole, cap, cloth)
  group.scale.setScalar(scale)
  return { group, cloth, rest: Float32Array.from(geometry.attributes.position.array as ArrayLike<number>) }
}

function buildBall(scale = 1): THREE.Group {
  const group = new THREE.Group()
  const core = new THREE.Mesh(new THREE.SphereGeometry(.2, 20, 14), new THREE.MeshBasicMaterial({ color: BALL_COLOR }))
  const halo = new THREE.Mesh(new THREE.SphereGeometry(.34, 20, 14),
    new THREE.MeshBasicMaterial({ color: BALL_COLOR, transparent: true, opacity: .28, blending: THREE.AdditiveBlending, depthWrite: false }))
  // Two sockets and a jaw line: enough to read as Halo's skull without a model.
  const socket = new THREE.MeshBasicMaterial({ color: 0x3a2e14 })
  for (const x of [-.07, .07]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(.048, 10, 8), socket)
    eye.position.set(x, .03, .17)
    group.add(eye)
  }
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(.13, .025, .02), socket)
  jaw.position.set(0, -.09, .18)
  group.add(core, halo, jaw)
  group.scale.setScalar(scale)
  return group
}

function buildBomb(scale = 1): THREE.Group {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(.6, .34, .34), new THREE.MeshBasicMaterial({ color: 0x2d3138 }))
  const band = new THREE.Mesh(new THREE.BoxGeometry(.62, .09, .36), new THREE.MeshBasicMaterial({ color: BOMB_COLOR }))
  const light = new THREE.Mesh(new THREE.SphereGeometry(.05, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3a20 }))
  light.position.set(.2, .19, 0)
  group.add(body, band, light)
  group.scale.setScalar(scale)
  return group
}

interface ItemView { item: ObjectiveItem; root: THREE.Group; model: THREE.Group; beam: THREE.Mesh; flag?: FlagParts }

export class ObjectiveView {
  private readonly root = new THREE.Group()
  private readonly items: ItemView[] = []
  private readonly pillars: THREE.Mesh[] = []
  private readonly camera: THREE.Camera
  /** First-person model of what you are carrying, parented to the camera. */
  readonly held = new THREE.Group()
  private readonly heldModels = new Map<string, { group: THREE.Group; flag?: FlagParts }>()
  private heldKey = ''
  private time = 0

  constructor(scene: THREE.Scene, objectives: Objectives, camera: THREE.Camera) {
    this.root.name = 'objectives'
    this.camera = camera
    for (const zone of objectives.zones) this.root.add(this.zone(zone))
    for (const item of objectives.items) {
      const root = new THREE.Group()
      const color = objectiveColor(item)
      const flag = item.kind === 'flag' ? buildFlag(color) : undefined
      const model = flag?.group ?? (item.kind === 'ball' ? buildBall() : buildBomb())
      const beam = column(color, 26, item.kind === 'flag' ? .5 : .42, .3)
      root.add(model, beam)
      this.root.add(root)
      this.items.push({ item, root, model, beam, flag })
    }
    scene.add(this.root)
    this.held.name = 'held-objective'
    this.held.visible = false
    camera.add(this.held)
  }

  private zone(zone: ObjectiveZone): THREE.Group {
    const group = new THREE.Group()
    const color = OBJECTIVE_TEAM_COLOR[zone.team]
    group.add(ring(color, zone.radius))
    if (zone.kind === 'plate') {
      // A plate is a target, so it gets a column of its own even with nothing on it.
      const pillar = column(color, 9, zone.radius * .92, .12)
      this.pillars.push(pillar)
      group.add(pillar)
    }
    group.position.set(zone.x, zone.y, zone.z)
    return group
  }

  /**
   * Put everything where the rules say it is. A carried item rides on its carrier's body; your
   * own is drawn in your hands instead, by `showHeld`.
   */
  update(dt: number, carrierOf: (item: ObjectiveItem) => Player | null, you: number, time: number): void {
    this.time = time
    for (const v of this.items) {
      const { item, root, model, beam } = v
      const carrier = carrierOf(item)
      if (item.state === 'carried' && item.carrier === you) { root.visible = false; continue }
      root.visible = true
      beam.visible = item.state !== 'carried'
      if (carrier) {
        const body = carrier.object
        root.visible = body.visible && carrier.alive
        const yaw = body.rotation.y
        const back = item.kind === 'ball' ? -.38 : .3
        root.position.set(body.position.x + Math.sin(yaw) * back, body.position.y + (item.kind === 'flag' ? .15 : item.kind === 'ball' ? 1.05 : 1.15), body.position.z + Math.cos(yaw) * back)
        root.rotation.set(item.kind === 'flag' ? -.25 : 0, yaw, 0)
        model.position.y = 0
      } else {
        root.position.set(item.x, item.y, item.z)
        root.rotation.set(0, 0, 0)
        // Loose items hover and turn so they read as pick-ups; a flag just stands.
        if (item.kind !== 'flag') {
          model.position.y = .6 + Math.sin(time * 2.2) * .08
          model.rotation.y = time * 1.4
        }
      }
      if (v.flag) wave(v.flag, time, carrier ? 1.8 : 1)
    }
    const eye = this.camera.getWorldPosition(new THREE.Vector3())
    this.root.updateMatrixWorld()
    for (const v of this.items) if (v.beam.visible) fadeNear(v.beam, eye)
    for (const p of this.pillars) { p.visible = true; fadeNear(p, eye) }
    const held = this.heldModels.get(this.heldKey)
    if (held?.flag) wave(held.flag, time, 1.4)
    if (held && !held.flag) held.group.rotation.y = Math.sin(time * 1.3) * .15
    void dt
  }

  /** Swap the gun for the flag, ball or bomb in first person, or put it away. */
  showHeld(item: ObjectiveItem | null): void {
    const key = item ? `${item.kind}:${item.team ?? ''}` : ''
    if (key === this.heldKey) { this.held.visible = !!item; return }
    this.heldKey = key
    for (const m of this.heldModels.values()) m.group.visible = false
    this.held.visible = !!item
    if (!item) return
    let entry = this.heldModels.get(key)
    if (!entry) {
      if (item.kind === 'flag') {
        const flag = buildFlag(objectiveColor(item), .42)
        // Carried over the right shoulder, pole running up out of the bottom of the view.
        flag.group.position.set(.34, -.95, -.72)
        flag.group.rotation.set(-.28, .5, -.32)
        entry = { group: flag.group, flag }
      } else {
        // Held low and to the right, where the gun was, and small enough to see past.
        const group = item.kind === 'ball' ? buildBall(.55) : buildBomb(.42)
        group.position.set(.24, -.22, -.52)
        entry = { group }
      }
      for (const o of entry.group.children) o.renderOrder = 10
      this.held.add(entry.group)
      this.heldModels.set(key, entry)
    }
    entry.group.visible = true
  }
}

/** A cheap travelling wave along the cloth: ten segments, no simulation. */
function wave(flag: FlagParts, time: number, speed: number): void {
  const position = flag.cloth.geometry.attributes.position as THREE.BufferAttribute
  const rest = flag.rest
  for (let i = 0; i < position.count; i++) {
    const x = rest[i * 3]
    position.setZ(i, rest[i * 3 + 2] + Math.sin(x * 5 - time * 5 * speed) * .09 * x)
  }
  position.needsUpdate = true
}
