import * as THREE from 'three'
import {arenaCollision, type ArenaId} from '../../shared/arena.ts'
import {preloadLevelData} from '../../shared/level-data.ts'
import type {TriangleMesh} from '../../shared/guardian-collision.ts'
import {ATMOSPHERES} from './arena-atmosphere.ts'
import type {BloomSettings} from './bloom.ts'
import type {VolumeSettings} from './volumetric-light.ts'
import {DEBUG_HOOKS} from '../debug/build-flags.ts'

/**
 * The light that makes Halo 3's maps sparkle, on top of the imported arenas:
 *
 * - Lamps. The exports lost every self-illumination shader. The lamp materials named below get a
 *   thresholded emissive map made from their own albedo (only the bulbs and tubes glow), so the
 *   bloom picks up the lamps wherever they are actually visible. Nothing is drawn around them:
 *   glow sprites and faked light pools floated free of occlusion and bled through floors.
 * - God rays: settings for volumetric-light.ts, which scatters the sun through the air wherever
 *   its shadow map says the sun reaches, so shafts appear only at real openings.
 * - Glass the sun shines through (Epitaph's holographic panes, The Pit's roof bands): glossy,
 *   no longer blocking the sun, whose light comes through in the glass's colour.
 * - Sun glare. A camera-space flare, occluded by casting rays at the sun through the map's
 *   collision each frame, eased so the glare swells and fades rather than blinks.
 * - Bloom settings for bloom.ts.
 */
interface MapLights {
  bloom: BloomSettings
  /** Materials whose near-white texels are lamps: the export dropped their self-illumination. */
  lamps?: RegExp
  /** Lamp colour when the texture's own tint is too washed out to carry one. */
  tint?: number
  /** Glass the sun shines through: `glow` makes it self-lit (holographic), `tint` how strongly
   * it colours the light that passes. */
  glass?: {pattern: RegExp; glow: number; tint: number; clear?: number}
  /** God rays (volumetric-light.ts): scattering per metre, brightness, forward bias, reach. */
  volume: {density: number; intensity: number; anisotropy: number; distance: number; ceiling: number; resolution?: number; thinning?: {floor: number; height: number}}
  flare: number
}

const LIGHTS: Record<ArenaId, MapLights> = {
  // The canyon's air: the same sunlit haze as the other open maps (at .001 it was effectively off), so the far cliffs
  // sit back in the light and looking towards the sun glows. The haze lies in the canyon and thins above the rims: even
  // air marched the full 120 m straight up too, which laid a lavender veil over the whole sky and hid its stars.
  'blood-gulch': {bloom:{threshold:.95,knee:.05,strength:.25},lamps:/bloodgulch_light/,volume:{density:.006,intensity:2,anisotropy:.75,distance:120,ceiling:.25,resolution:.5,thinning:{floor:0,height:22}},flare:.4},
  // The hangar's barrel roof is solid; the sun comes in through the glass bands along its sides.
  'the-pit': {bloom: {threshold: .86, knee: .14, strength: .6}, glass: {pattern: /^cyberdyne_roof_glass_a$/, glow: 0, tint: .3}, lamps: /^metal_doodad_a$/, tint: 0xfff2dc, volume: {density: .025, intensity: 1.6, anisotropy: .5, distance: 45, ceiling: .3}, flare: 1},
  // The walkways' glass panes: see-through to the chasm, not opaque navy slabs.
  narrows: {bloom: {threshold: .9, knee: .1, strength: .55}, glass: {pattern: /^riverworld_glass$/, glow: 0, tint: .2, clear: .45}, volume: {density: .006, intensity: 2, anisotropy: .75, distance: 120, ceiling: .25, resolution: .5}, flare: .7},
  sandtrap: {bloom: {threshold: .91, knee: .09, strength: .5}, volume: {density: .006, intensity: 1.5, anisotropy: .75, distance: 120, ceiling: .25, resolution: .5}, flare: .9},
  valhalla: {bloom: {threshold: .91, knee: .09, strength: .5}, lamps: /^light_florescent_a_illum$/, volume: {density: .006, intensity: 2, anisotropy: .75, distance: 120, ceiling: .25, resolution: .5}, flare: 1},
  // Pale stone lit through cyan glass: a tint, not paint (at .55 the floors turned turquoise), and shafts that read as
  // shafts rather than a veil over the whole hall.
  epitaph: {bloom: {threshold: .82, knee: .16, strength: .85}, glass: {pattern: /^sal_glass_white$/, glow: 1.4, tint: .3}, volume: {density: .03, intensity: 2, anisotropy: .6, distance: 45, ceiling: .32}, flare: 1},
  'rats-nest': {bloom: {threshold: .84, knee: .15, strength: .65}, lamps: /^hb_concrete_slabs_01_(28|32|51|84)$/, tint: 0xffe6b8, volume: {density: .035, intensity: 1.6, anisotropy: .5, distance: 40, ceiling: .28}, flare: .9},
}

export interface ArenaLightFx {
  /** @param playing true once a match runs: the glare's occlusion needs the collision mesh. */
  update(time: number, eye: THREE.Vector3, playing: boolean): void
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** Pixels of a texture's image, scaled to at most `size` on a side. */
function pixels(texture: THREE.Texture, size: number): {data: Uint8ClampedArray; w: number; h: number} | null {
  const image = texture.image as {width: number; height: number} | undefined
  if (!image?.width) return null
  const w = Math.min(size, image.width), h = Math.min(size, image.height)
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
  const context = canvas.getContext('2d', {willReadFrequently: true})
  if (!context) return null
  try { context.drawImage(image as CanvasImageSource, 0, 0, w, h); return {data: context.getImageData(0, 0, w, h).data, w, h} }
  catch { return null }
}

/** A thresholded copy of a lamp material's albedo as its emissive map: only the bulbs glow. */
function lampEmission(material: THREE.MeshStandardMaterial): THREE.Texture | null {
  const source = material.map, image = source && pixels(source, 1024)
  if (!source || !image) return null
  const canvas = document.createElement('canvas'); canvas.width = image.w; canvas.height = image.h
  const context = canvas.getContext('2d')!, out = context.createImageData(image.w, image.h), d = image.data
  for (let i = 0; i < d.length; i += 4) {
    const k = smooth(.66, .92, (d[i] * .2126 + d[i + 1] * .7152 + d[i + 2] * .0722) / 255)
    out.data[i] = d[i] * k; out.data[i + 1] = d[i + 1] * k; out.data[i + 2] = d[i + 2] * k; out.data[i + 3] = 255
  }
  context.putImageData(out, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = source.wrapS; texture.wrapT = source.wrapT; texture.anisotropy = source.anisotropy
  return texture
}

/** Lamp materials glow where their albedo is near white; returns how many were lit. */
function lightLamps(model: THREE.Object3D, config: MapLights): number {
  if (!config.lamps) return 0
  const tint = new THREE.Color(config.tint ?? 0xffffff), done = new Set<THREE.Material>()
  model.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || Array.isArray(mesh.material)) return
    const material = mesh.material as THREE.MeshStandardMaterial
    if (!material.isMeshStandardMaterial || !config.lamps!.test(material.name) || done.has(material)) return
    done.add(material)
    const emission = lampEmission(material)
    if (!emission) return
    material.emissiveMap = emission; material.emissive.set(tint); material.emissiveIntensity = 2.6
    material.needsUpdate = true
  })
  return done.size
}

/**
 * Glass the sun shines through. The export left it flat paint with its reflections switched off
 * (zero specular), so it reads as a wall. It becomes glass: glossy, with a clear coat whose
 * Fresnel reflection of the sky grows at grazing angles, optionally glowing from within (the
 * holographic panes) so the bloom catches it, and no longer blocking the sun, whose light comes
 * through in its colour (volumetric-light.ts).
 */
function dressGlass(model: THREE.Object3D, spec: NonNullable<MapLights['glass']>): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [], dressed = new Set<THREE.Material>()
  model.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || Array.isArray(mesh.material) || !spec.pattern.test(mesh.material.name)) return
    const material = mesh.material as THREE.MeshPhysicalMaterial
    meshes.push(mesh)
    mesh.castShadow = false
    if (spec.clear !== undefined) mesh.renderOrder = 1
    if (dressed.has(material)) return
    dressed.add(material)
    material.roughness = .03; material.metalness = 0; material.envMapIntensity = 3
    if (material.isMeshPhysicalMaterial) {
      material.ior = 1.5; material.specularIntensity = 1; material.specularColor.set(0xffffff)
      material.clearcoat = 1; material.clearcoatRoughness = .02
    }
    if (material.map && spec.glow > 0) { material.emissiveMap = material.map; material.emissive.set(0xffffff); material.emissiveIntensity = spec.glow }
    // See-through panes (`clear` is their opacity): the export made them opaque slabs of flat blue.
    if (spec.clear !== undefined) { material.transparent = true; material.opacity = spec.clear; material.depthWrite = false; material.alphaTest = 0 }
    material.needsUpdate = true
  })
  return meshes
}

/** The sun's glare and ghosts, laid out in screen space along the line through the centre. */
function flareMesh(sun: THREE.Vector3, color: THREE.Color): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  // [position along the axis (1 = the sun, 0 = centre), size, kind (0 glare, 1 disc, 2 ring), r, g, b]
  const elements = [
    [1, .75, 0, .3, .27, .22], [1, .12, 3, .8, .75, .68],
    [.62, .05, 1, .35, .5, .3], [.38, .1, 2, .25, .35, .5], [.12, .035, 1, .5, .4, .25],
    [-.22, .075, 1, .2, .35, .45], [-.48, .16, 2, .3, .3, .22], [-.85, .24, 1, .12, .18, .22],
  ]
  const corners = [-1, -1, 1, -1, 1, 1, -1, 1], position: number[] = [], corner: number[] = [], data: number[] = [], tint: number[] = [], index: number[] = []
  elements.forEach(([t, size, kind, r, g, b], i) => {
    for (let k = 0; k < 4; k++) { position.push(0, 0, 0); corner.push(corners[k * 2], corners[k * 2 + 1]); data.push(t, size, kind); tint.push(r, g, b) }
    index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3)
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  geometry.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 2))
  geometry.setAttribute('element', new THREE.Float32BufferAttribute(data, 3))
  geometry.setAttribute('tint', new THREE.Float32BufferAttribute(tint, 3))
  geometry.setIndex(index)
  const material = new THREE.ShaderMaterial({
    uniforms: {sun: {value: sun}, color: {value: color}, visible: {value: 0}},
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
    vertexShader: `uniform vec3 sun; uniform float visible; attribute vec2 corner; attribute vec3 element; attribute vec3 tint; varying vec2 vCorner; varying vec3 vTint; varying float vKind; varying float vFade;
void main() {
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * sun, 0.0);
  vec2 s = clip.xy / max(clip.w, 1e-4);
  float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
  // Full while the sun is on screen, gone once it is well outside or behind.
  float onScreen = (1.0 - smoothstep(0.9, 1.5, max(abs(s.x), abs(s.y)))) * step(0.0, clip.w);
  vFade = visible * onScreen;
  vCorner = corner; vTint = tint; vKind = element.z;
  // Ghosts brighten as the sun nears the centre, as a real lens's do.
  if (element.z > 0.5 && element.z < 2.5) vFade *= 1.0 - smoothstep(0.2, 1.1, length(s));
  vec2 p = s * element.x + corner * element.y * vec2(1.0 / aspect, 1.0);
  gl_Position = vFade > 0.001 ? vec4(p, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`,
    fragmentShader: `uniform vec3 color; varying vec2 vCorner; varying vec3 vTint; varying float vKind; varying float vFade;
void main() {
  float r = length(vCorner), a;
  if (vKind < 0.5) {
    // Glare: a wide soft bloom with faint rays.
    float ang = atan(vCorner.y, vCorner.x);
    float rays = 0.65 + 0.35 * pow(abs(sin(ang * 6.0 + 0.4)) * abs(sin(ang * 4.0)), 3.0);
    a = exp(-r * 4.0) * rays;
  } else if (vKind < 1.5) a = (1.0 - smoothstep(0.6, 1.0, r)) * 0.6;
  else if (vKind < 2.5) a = smoothstep(0.55, 0.85, r) * (1.0 - smoothstep(0.85, 1.0, r));
  else a = exp(-r * r * 9.0);
  gl_FragColor = vec4(vTint * color * a * vFade, 1.0);
}`,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false; mesh.renderOrder = 10
  return mesh
}

type SunTest = (x: number, y: number, z: number, dx: number, dy: number, dz: number) => boolean

/** `?nolightfx` leaves the maps as they were, for comparison. */
const DISABLED = new URLSearchParams(location.search).has('nolightfx')

export function createArenaLightFx(scene: THREE.Scene, _renderer: THREE.WebGLRenderer, map: ArenaId, model: THREE.Object3D, root: THREE.Object3D): ArenaLightFx {
  if (DISABLED) return {update() {}}
  const config = LIGHTS[map], atmosphere = ATMOSPHERES[map], sun = atmosphere.sun.clone().normalize()
  const sunColor = new THREE.Color(atmosphere.sunColor)
  scene.userData.bloom = config.bloom
  const group = new THREE.Group(); group.name = `${map}-light-fx`; root.add(group)
  const lamps = lightLamps(model, config)
  const glass = config.glass ? dressGlass(model, config.glass) : []
  // God rays from the map's sun and its static shadow map (volumetric-light.ts, run by bloom.ts).
  const sunLight = scene.children.find(o => (o as THREE.DirectionalLight).isDirectionalLight && o.castShadow) as THREE.DirectionalLight | undefined
  const volume: VolumeSettings | undefined = sunLight && {sun: sunLight, color: sunColor, ...config.volume, glass, glassTint: config.glass?.tint}
  scene.userData.volume = volume
  if (glass.length && sunLight) sunLight.shadow.needsUpdate = true
  const flare = flareMesh(sun, sunColor)
  flare.material.uniforms.visible.value = 0
  group.add(flare)
  let collision: TriangleMesh | null = null, sees: SunTest | null = null
  const state = {enabled: true, visibility: 0, last: 0, lamps, glass: glass.length, buildMs: 0}
  // The glare's occlusion needs the collision mesh. Building that BVH takes the main thread for
  // seconds on the bigger maps, so it is left to the match (which needs it anyway).
  let building = false
  const build = () => preloadLevelData(map).then(() => {
    const time = performance.now()
    const mesh = collision = arenaCollision(map).mesh
    sees = (x, y, z, dx, dy, dz) => !mesh.raycast(x, y, z, dx, dy, dz, 600)
    state.buildMs = Math.max(1, Math.round(performance.now() - time))
  }).catch(error => console.warn('Arena light effects skipped:', error))

  const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]], tangent = new THREE.Vector3(), bitangent = new THREE.Vector3()
  tangent.set(-sun.z, 0, sun.x).normalize(); bitangent.crossVectors(sun, tangent)
  const debug = {
    get enabled() { return state.enabled },
    set enabled(on: boolean) { state.enabled = on; group.visible = on; scene.userData.bloom = on ? config.bloom : undefined; scene.userData.volume = on ? volume : undefined },
    sunDirection: sun, summary: () => ({...state}),
    /** Distance to the collision along a ray, for placing test cameras. */
    ray: (x: number, y: number, z: number, dx: number, dy: number, dz: number, max: number) => collision?.raycast(x, y, z, dx, dy, dz, max)?.t ?? max,
    /** The map material under a point of the screen, for finding lamps by eye. */
    pick(x: number, y: number, camera: THREE.Camera) {
      const hit = new THREE.Raycaster()
      hit.setFromCamera(new THREE.Vector2(x, y), camera)
      const first = hit.intersectObject(model, true)[0]
      return first && {material: ((first.object as THREE.Mesh).material as THREE.Material).name, point: first.point.toArray(), uv: first.uv?.toArray()}
    },
  }
  if (DEBUG_HOOKS) Object.assign(window, {__lightFx: debug})
  return {
    update(time, eye, playing) {
      if (playing && !building) { building = true; void build() }
      const dt = Math.min(.1, Math.max(0, time - state.last)); state.last = time
      // The glare: how much of the sun's disc the eye can see, eased.
      let seen = 0
      if (sees) {
        const spread = .02
        for (const [a, b] of offsets) {
          const dx = sun.x + (tangent.x * a + bitangent.x * b) * spread, dy = sun.y + (tangent.y * a + bitangent.y * b) * spread, dz = sun.z + (tangent.z * a + bitangent.z * b) * spread
          const l = Math.hypot(dx, dy, dz)
          if (sees(eye.x, eye.y, eye.z, dx / l, dy / l, dz / l)) seen++
        }
        seen /= offsets.length
      }
      state.visibility += (seen - state.visibility) * Math.min(1, dt * 10)
      flare.material.uniforms.visible.value = state.visibility * config.flare * (scene.userData.bloomActive ? .8 : 1)
    },
  }
}
