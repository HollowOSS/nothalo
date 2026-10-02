import * as THREE from 'three'
import { arenaCollision, arenaMeta } from '../../shared/arena.ts'
import type { TriangleMesh } from '../../shared/guardian-collision.ts'
import { bleedCutout, detailNormalMap } from './surface-detail.ts'

/**
 * Valhalla's look, applied over the imported Riverworld export.
 *
 * The export carries one base-colour texture per material and nothing else: no normal maps,
 * no terrain blend, no vertex colours, and a pure-blue placeholder for water. Halo 3 builds the
 * map's look from blended terrain shaders, so without them the grass was a single texture
 * stretched metres wide, the rocks read as black lumps and the river as a cyan ribbon. This
 * rebuilds that look at load, from the same textures:
 *
 * - Ground: grass tiled in world space at a real-world scale, a second larger sample and a slow
 *   macro tint breaking up the repeat, and rock blended in wherever the slope steepens.
 * - Rock (boulders and cliffs): triplanar world-space rock so nothing stretches down a cliff
 *   face, brightened to read as stone rather than a hole, with grass settling on flat tops.
 * - Water: clear, tinted by depth, with moving ripples reflecting the sky.
 * - Foliage: alpha-tested rather than blended, so the pines stop sorting against each other.
 *
 * Its sky, sun and haze are arena-atmosphere.ts's. Every shader change is a few texture reads per pixel.
 */
/** A player's feet, for the water to react to. */
export interface WaterWader { x: number; y: number; z: number; vx: number; vy: number; vz: number; onGround: boolean }
export interface ValhallaLook { update(time: number, camera: THREE.Vector3, players?: readonly WaterWader[]): void }
/** Ripple rings the water shader keeps at once: footsteps, wakes and landings. */
const RIPPLES = 24

export function applyValhallaLook(renderer: THREE.WebGLRenderer, model: THREE.Object3D, scene: THREE.Scene): ValhallaLook {
  const materials = new Map<string, THREE.MeshStandardMaterial>()
  model.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.set(material.name, material as THREE.MeshStandardMaterial)
  })
  const grass = materials.get('riverworld_ground'), rock = materials.get('riverworld_ground_cliff')
  const grassMap = grass?.map ?? null, rockMap = rock?.map ?? null
  for (const texture of [grassMap, rockMap]) if (texture) { texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = renderer.capabilities.getMaxAnisotropy(); texture.needsUpdate = true }
  // Relief derived from the same two textures (surface-detail.ts), sampled in world space below.
  const grassRelief = grassMap && detailNormalMap(renderer, grassMap, 1), rockRelief = rockMap && detailNormalMap(renderer, rockMap, 1.4)

  // ---- terrain: grass ground and rock, one shader with two weightings ----
  const terrain = (material: THREE.MeshStandardMaterial | undefined, kind: 'ground' | 'rock' | 'bed') => {
    if (!material || !grassMap || !rockMap || !grassRelief || !rockRelief) return
    material.map = null
    material.roughness = kind === 'ground' ? .92 : kind === 'bed' ? .7 : .82
    material.onBeforeCompile = shader => {
      shader.uniforms.terrainGrass = { value: grassMap }
      shader.uniforms.terrainRock = { value: rockMap }
      shader.uniforms.terrainGrassRelief = { value: grassRelief }
      shader.uniforms.terrainRockRelief = { value: rockRelief }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainWorld;\nvarying vec3 vTerrainNormal;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D terrainGrass;
uniform sampler2D terrainRock;
uniform sampler2D terrainGrassRelief;
uniform sampler2D terrainRockRelief;
varying vec3 vTerrainWorld;
varying vec3 vTerrainNormal;
float terrainRocky = 0.0;
vec3 terrainTriplanar(sampler2D tex, vec3 p, vec3 n, float scale) {
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  return texture2D(tex, p.zy / scale).rgb * w.x + texture2D(tex, p.xz / scale).rgb * w.y + texture2D(tex, p.xy / scale).rgb * w.z;
}`)
        .replace('#include <map_fragment>', `
{
  vec3 p = vTerrainWorld, n = normalize(vTerrainNormal);
  // Grass: a 4 m tile, a rotated 13 m tile over it, fine 1.3 m detail up close, and slow 45-70 m
  // variation so no repeat lines up.
  float near = 1.0 - smoothstep(6.0, 30.0, length(p - cameraPosition));
  vec3 g1 = texture2D(terrainGrass, p.xz / 4.0).rgb;
  vec3 g2 = texture2D(terrainGrass, mat2(0.8, -0.6, 0.6, 0.8) * p.xz / 13.0 + 0.37).rgb;
  vec3 g3 = texture2D(terrainGrass, mat2(0.6, 0.8, -0.8, 0.6) * p.xz / 1.3).rgb;
  vec3 green = mix(mix(g1, g2, 0.45), g3, 0.35 * near);
  float macro = texture2D(terrainGrass, p.xz / 70.0 + 0.61).g;
  float patchy = texture2D(terrainRock, p.xz / 45.0 + 0.23).r;
  // Pull the saturated source toward Halo 3's olive grass, darker and drier in patches.
  float luma = dot(green, vec3(0.299, 0.587, 0.114));
  green = mix(vec3(luma), green, 0.6) * vec3(0.9, 0.95, 0.74) * mix(0.72, 1.18, smoothstep(0.1, 0.55, macro));
  // Drier, yellower grass in broad swathes, as on Halo 3's Valhalla.
  green = mix(green, green * vec3(1.18, 1.05, 0.62), smoothstep(0.3, 0.65, patchy) * 0.75);
  // Bare earth where the grass wears through.
  vec3 earth = texture2D(terrainRock, p.xz / 5.0).rgb * vec3(1.05, 0.88, 0.66) * 1.25;
  green = mix(green, earth, smoothstep(0.55, 0.72, patchy) * 0.75);
  vec3 stone = terrainTriplanar(terrainRock, p, n, 6.5) * 1.9;
  stone = mix(stone, terrainTriplanar(terrainRock, p, n, 23.0) * 1.9, 0.35) * vec3(1.02, 1.0, 0.96);
  float breakup = (texture2D(terrainRock, p.xz / 31.0).r - 0.3) * 0.35;
  ${kind === 'ground'
    // Ground: rock shows through where it steepens past ~35 degrees.
    ? 'float rocky = smoothstep(0.62, 0.86, 1.0 - n.y + breakup);'
    // Rock: all stone except flat, upward tops, where grass and moss collect.
    : kind === 'rock' ? 'float rocky = 1.0 - smoothstep(0.82, 0.95, n.y - breakup);'
    // Riverbed: wet stone and pebble under the water, darker, with a green-brown silt tint.
    : 'float rocky = 1.0; stone = mix(stone, texture2D(terrainRock, p.xz / 1.7).rgb * 1.6, 0.5) * vec3(0.62, 0.66, 0.55);'}
  diffuseColor.rgb *= mix(green, stone, rocky);
  terrainRocky = rocky;
}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // Relief from the grass and rock textures in world space, weighted as their colour is. Each
  // relief map holds -dh/du in x and dh/dv in y; the bend is the height's negated gradient along
  // the projection's two world axes.
  vec3 p = vTerrainWorld, n = normalize(vTerrainNormal);
  vec2 g = texture2D(terrainGrassRelief, p.xz / 4.0).xy * 2.0 - 1.0;
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  vec2 rx = texture2D(terrainRockRelief, p.zy / 6.5).xy * 2.0 - 1.0;
  vec2 ry = texture2D(terrainRockRelief, p.xz / 6.5).xy * 2.0 - 1.0;
  vec2 rz = texture2D(terrainRockRelief, p.xy / 6.5).xy * 2.0 - 1.0;
  vec3 bend = mix(vec3(g.x, 0.0, -g.y), w.x * vec3(0.0, -rx.y, rx.x) + w.y * vec3(ry.x, 0.0, -ry.y) + w.z * vec3(rz.x, -rz.y, 0.0), terrainRocky);
  bend -= n * dot(bend, n);
  normal = normalize(normal + mat3(viewMatrix) * bend);
}`)
    }
    material.customProgramCacheKey = () => `valhalla-terrain-${kind}`
    material.needsUpdate = true
  }
  terrain(grass, 'ground')
  terrain(rock, 'rock')

  // ---- shadows: trees, rock and structures cast onto the ground (the import turned casting off) ----
  model.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const name = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material).name
    mesh.castShadow = !/riverworld_(ground|ground_water|cliff_distant)$/.test(name)
  })

  // ---- foliage: alpha test instead of blending ----
  const leaves = materials.get('riverworld_tree_leafa')
  if (leaves) {
    leaves.transparent = false; leaves.alphaTest = .45; leaves.depthWrite = true; leaves.side = THREE.DoubleSide
    // the needles' transparent texels are black: fill them with needle colour so the edges don't speckle black (surface-detail.ts)
    if (leaves.map) bleedCutout(leaves.map)
    // Foliage lighting as games do it: needles are thin, so a needle facing away from the sun still passes light through.
    // Plain lambert let those go black against a bright sky (user: black edges on the leaves in the sun). Matte, no
    // specular, and a translucency fill so no needle drops below ~40% of its lit colour.
    leaves.roughness = 1; leaves.metalness = 0; leaves.envMapIntensity = .3
    leaves.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * 0.38;`)
    }
    leaves.customProgramCacheKey = () => 'valhalla-foliage-translucent'
    leaves.needsUpdate = true
  }

  // ---- water ----
  const waterTime = { value: 0 }
  const rippleSlots = Array.from({ length: RIPPLES }, () => new THREE.Vector4(0, 0, -99, 0))
  let nextSlot = 0
  const ripple = (x: number, z: number, time: number, strength: number) => {
    rippleSlots[nextSlot].set(x, z, time, strength); nextSlot = (nextSlot + 1) % RIPPLES
  }
  // The export's water mesh is solid collision, and nothing lies under it. It becomes the
  // riverbed (players stand on it, bots route on it, as before) and a separate visual water
  // surface sits DEPTH above it, so players wade in over their ankles. Its outline is widened
  // WIDEN metres so the rising banks cut it off instead of leaving an edge floating in the air.
  const DEPTH = .35, WIDEN = 2
  const bed = waterHeights(model)
  const surface = (x: number, z: number) => { const y = bed(x, z); return y === null ? null : y + DEPTH }
  const splashes = new Splashes(scene)
  /** Per player: when they last disturbed the water, and whether they were on it last frame. */
  const wading = new WeakMap<object, { last: number; onWater: boolean; airborne: boolean; fall: number }>()
  const ripples = rippleNormals()
  const waterMaterial = materials.get('riverworld_ground_water')
  if (waterMaterial) {
    const collision = arenaCollision('valhalla').mesh
    // Per-pixel depth and riverbed outline over the playable river (see `ShoreMap`); filled below, once every surface is in.
    const shore = new ShoreMap(arenaMeta('valhalla').bounds)
    const bedMaterial = new THREE.MeshStandardMaterial({ name: 'valhalla-riverbed' })
    terrain(bedMaterial, 'bed')
    riverbedLight(bedMaterial, shore, waterTime)
    const fallsMaterial = fallingWater(ripples, waterTime)
    const meshes: THREE.Mesh[] = []
    model.traverse(object => { const mesh = object as THREE.Mesh; if (mesh.isMesh && mesh.material === waterMaterial) meshes.push(mesh) })
    const holder = model.parent ?? scene
    holder.updateWorldMatrix(true, false)
    const toHolder = holder.matrixWorld.clone().invert()
    for (const mesh of meshes) {
      // Work in world space: the export stands the river mesh Z-up under a rotated node, and
      // "level" and "above" only mean anything in the world's frame.
      // The compact (phone) assets are meshopt-quantized: positions are small integers and the metre scale lives on the
      // node, so the node's world matrix must be current and the positions plain floats before they are baked, or the
      // whole river collapses into a few-metre box at the origin (phones showed a dry riverbed).
      mesh.updateWorldMatrix(true, false)
      const world = dequantized(mesh.geometry).applyMatrix4(mesh.matrixWorld)
      // Only the level river is a bed with water over it; the steep sheets are falls and stay
      // where they are as falling water.
      const [flat, steep] = splitBySlope(world, .9)
      const add = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string) => {
        const part = new THREE.Mesh(geometry.applyMatrix4(toHolder), material)
        part.name = name; part.receiveShadow = true; part.castShadow = false
        holder.add(part)
        return part
      }
      // The export's short vertical skirts around the water's edge are dropped; real falls stay.
      const falls = steep && tallSheets(steep, 2.5)
      if (falls) add(falls, fallsMaterial, 'valhalla-waterfalls')
      if (flat) {
        const water = annotateRiver(raisedSurface(flat, DEPTH, WIDEN), collision)
        shore.addSurface(water, flat)
        add(water, waterMaterial, 'valhalla-water-surface').renderOrder = 1
      }
      // The bed keeps all of its faces: the steep skirts are what join it to the banks.
      mesh.material = bedMaterial
      mesh.castShadow = false
    }
    shore.finish(collision)
    riverWater(waterMaterial, { ripples, time: waterTime, rings: rippleSlots, shore, sky: scene.getObjectByName('valhalla-sky') as THREE.Mesh | undefined })
  }

  return {
    update(time, _camera, players = []) {
      const dt = Math.min(.1, Math.max(0, time - waterTime.value))
      waterTime.value = time
      for (const p of players) {
        const state = wading.get(p) ?? { last: -9, onWater: false, airborne: false, fall: 0 }
        wading.set(p, state)
        const level = surface(p.x, p.z), floor = bed(p.x, p.z)
        const onWater = level !== null && floor !== null && p.onGround && Math.abs(p.y - floor) < .15
        if (!p.onGround) { state.airborne = true; state.fall = Math.max(state.fall, -p.vy) }
        if (onWater) {
          const speed = Math.hypot(p.vx, p.vz)
          if (state.airborne && state.fall > 2.5) {
            // A landing: a big ring and a burst of spray, sized by how hard they came down.
            const hard = Math.min(1, state.fall / 9)
            ripple(p.x, p.z, time, .7 + hard * .8)
            splashes.burst(p.x, level!, p.z, 40 + Math.round(hard * 60), 2.4 + hard * 3)
            state.last = time
          } else if (speed > .8 && time - state.last > .3) {
            // Wading: a ring at each stride and a little spray at a run.
            ripple(p.x - p.vx * .05, p.z - p.vz * .05, time, .35 + Math.min(.35, speed * .05))
            if (speed > 4) splashes.burst(p.x, level!, p.z, 10, 1.6)
            state.last = time
          } else if (!state.onWater && time - state.last > .3) {
            ripple(p.x, p.z, time, .4); state.last = time
          }
        }
        if (p.onGround) { state.airborne = false; state.fall = 0 }
        state.onWater = onWater
      }
      splashes.update(dt)
    },
  }
}

/**
 * What the water shader needs per pixel and the export cannot give per vertex (its river vertices lie metres apart, so a
 * per-vertex depth smeared the shoreline into bands): how deep the water stands over whatever is under it — bed, bank or
 * boulder — and whether a point lies over the riverbed itself or out over the banks the widened surface overhangs.
 * Rasterised once at load, 0.5 m a texel, over the playable map; two bytes a texel. Off the map (the far lake) the shader
 * falls back to the per-vertex depth.
 */
class ShoreMap {
  static readonly CELL = .5
  readonly x0: number
  readonly z0: number
  readonly columns: number
  readonly rows: number
  /** x0, z0, columns, rows: the shader's lookup. */
  readonly rect: THREE.Vector4
  readonly texture: THREE.DataTexture
  readonly horizon: [THREE.DataTexture, THREE.DataTexture]
  private readonly level: Float32Array
  /** The riverbed's own height, NaN off it. */
  private readonly bed: Float32Array
  constructor(bounds: readonly number[]) {
    const pad = 25, cell = ShoreMap.CELL
    this.x0 = bounds[0] - pad; this.z0 = bounds[2] - pad
    this.columns = Math.ceil((bounds[1] - bounds[0] + pad * 2) / cell) + 1
    this.rows = Math.ceil((bounds[3] - bounds[2] + pad * 2) / cell) + 1
    this.rect = new THREE.Vector4(this.x0, this.z0, this.columns, this.rows)
    this.level = new Float32Array(this.columns * this.rows).fill(NaN)
    this.bed = new Float32Array(this.columns * this.rows).fill(NaN)
    // Filled by finish(); made now so the materials can bind it before then.
    this.texture = new THREE.DataTexture(new Uint8Array(this.columns * this.rows * 2), this.columns, this.rows, THREE.RGFormat, THREE.UnsignedByteType)
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.generateMipmaps = false
    // The skyline's elevation in eight directions (see `skyline`), at 1 m: north to south-east, then south to north-west.
    this.horizon = [0, 1].map(() => {
      const texture = new THREE.DataTexture(new Uint8Array(Math.ceil(this.columns / 2) * Math.ceil(this.rows / 2) * 4), Math.ceil(this.columns / 2), Math.ceil(this.rows / 2))
      texture.minFilter = texture.magFilter = THREE.LinearFilter
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
      texture.generateMipmaps = false
      return texture
    }) as [THREE.DataTexture, THREE.DataTexture]
  }
  /** A (world-space, triangle-soup) water surface, and the riverbed it stands over. */
  addSurface(surface: THREE.BufferGeometry, bed: THREE.BufferGeometry): void {
    this.rasterize(surface, .02, (k, y) => { if (Number.isNaN(this.level[k]) || y > this.level[k]) this.level[k] = y })
    this.rasterize(bed, 0, (k, y) => { if (Number.isNaN(this.bed[k]) || y > this.bed[k]) this.bed[k] = y })
  }
  /** Measure the ground under every wet texel and upload. */
  finish(ground: TriangleMesh): void {
    const { columns, rows } = this, count = columns * rows, data = this.texture.image.data as Uint8Array
    // Wet: where the ground under the surface is the riverbed itself, or stands above the surface (a wall or boulder,
    // which hides the water anyway). Ground between the two is a grassy bank the raised surface would flood — off the
    // bed, or sloping in over its edge: dry, so the water ends where the bank leaves the bed, as the river's own
    // shoreline does, yet still runs right up to the foot of a wall.
    let inside = new Float32Array(count)
    for (let k = 0; k < count; k++) {
      const level = this.level[k]
      if (Number.isNaN(level)) { data[k * 2] = 0; inside[k] = Number.isNaN(this.bed[k]) ? 0 : 1; continue }
      const x = this.x0 + (k % columns) * ShoreMap.CELL, z = this.z0 + Math.floor(k / columns) * ShoreMap.CELL
      // Down from a little above the surface: the bed, or the bank or boulder where it rises through the water.
      const hit = ground.raycast(x, level + 3, z, 0, -1, 0, 8)
      const depth = hit ? level - (level + 3 - hit.t) : 2.5
      data[k * 2] = Math.round(Math.min(1, Math.max(0, (depth + .5) / 3)) * 255)
      inside[k] = depth < .02 || level - depth <= this.bed[k] + .06 ? 1 : 0
    }
    // Softened twice, so the edge fades over a metre rather than stepping at a texel.
    const at = (field: Float32Array, i: number, j: number) => field[Math.min(rows - 1, Math.max(0, j)) * columns + Math.min(columns - 1, Math.max(0, i))]
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float32Array(count)
      for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
        let sum = 0
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += at(inside, i + di, j + dj)
        next[j * columns + i] = sum / 9
      }
      inside = next
    }
    for (let k = 0; k < count; k++) data[k * 2 + 1] = Math.round(inside[k] * 255)
    this.texture.needsUpdate = true
    this.skyline(ground)
  }
  /**
   * What a reflection off each wet metre sees before the sky: the elevation of the land's skyline in eight directions,
   * marched over a 1 m height field of the map. A canyon's water then mirrors its dark walls with the sky between
   * them, rather than open sky everywhere (a probe captured elsewhere cannot tell one reach of the river from another).
   */
  private skyline(ground: TriangleMesh): void {
    const { columns, rows } = this, wide = Math.ceil(columns / 2), high = Math.ceil(rows / 2), cell = ShoreMap.CELL * 2
    // Highest ground in each metre: the collision's triangles rasterised, their corners too so no sliver is missed.
    const height = new Float32Array(wide * high).fill(-1e9), p = ground.positions, index = ground.indices
    const mark = (i: number, j: number, y: number) => { if (i >= 0 && j >= 0 && i < wide && j < high && y > height[j * wide + i]) height[j * wide + i] = y }
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3
      const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[b], by = p[b + 1], bz = p[b + 2], cx = p[c], cy = p[c + 1], cz = p[c + 2]
      for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) mark(Math.round((x - this.x0) / cell), Math.round((z - this.z0) / cell), y)
      const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(denominator) < 1e-9) continue
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - this.x0) / cell)), i1 = Math.min(wide - 1, Math.ceil((Math.max(ax, bx, cx) - this.x0) / cell))
      const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - this.z0) / cell)), j1 = Math.min(high - 1, Math.ceil((Math.max(az, bz, cz) - this.z0) / cell))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = this.x0 + i * cell, z = this.z0 + j * cell
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator
        if (u >= 0 && v >= 0 && u + v <= 1) mark(i, j, u * ay + v * by + (1 - u - v) * cy)
      }
    }
    const [east, west] = this.horizon.map(texture => texture.image.data as Uint8Array)
    const directions = Array.from({ length: 8 }, (_, k) => [Math.sin(k * Math.PI / 4), Math.cos(k * Math.PI / 4)])
    for (let j = 0; j < high; j++) for (let i = 0; i < wide; i++) {
      // The water's level here: any of the four half-metre texels it covers.
      let level = NaN
      for (let d = 0; d < 4 && Number.isNaN(level); d++) level = this.level[Math.min(rows - 1, j * 2 + (d >> 1)) * columns + Math.min(columns - 1, i * 2 + (d & 1))]
      if (Number.isNaN(level)) continue
      directions.forEach(([dx, dz], k) => {
        let steepest = 0
        for (let s = 1.5; s < 110; s *= 1.1) {
          const x = Math.round(i + dx * s / cell), z = Math.round(j + dz * s / cell)
          if (x < 0 || z < 0 || x >= wide || z >= high) break
          steepest = Math.max(steepest, (height[z * wide + x] - level) / s)
        }
        ;(k < 4 ? east : west)[(j * wide + i) * 4 + k % 4] = Math.round(Math.atan(steepest) / (Math.PI / 2) * 255)
      })
    }
    for (const texture of this.horizon) texture.needsUpdate = true
  }
  private rasterize(geometry: THREE.BufferGeometry, slack: number, visit: (k: number, y: number) => void): void {
    const p = geometry.attributes.position, cell = ShoreMap.CELL
    for (let t = 0; t + 2 < p.count; t += 3) {
      const ax = p.getX(t), ay = p.getY(t), az = p.getZ(t), bx = p.getX(t + 1), by = p.getY(t + 1), bz = p.getZ(t + 1), cx = p.getX(t + 2), cy = p.getY(t + 2), cz = p.getZ(t + 2)
      const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(denominator) < 1e-9) continue
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - this.x0) / cell)), i1 = Math.min(this.columns - 1, Math.ceil((Math.max(ax, bx, cx) - this.x0) / cell))
      const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - this.z0) / cell)), j1 = Math.min(this.rows - 1, Math.ceil((Math.max(az, bz, cz) - this.z0) / cell))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = this.x0 + i * cell, z = this.z0 + j * cell
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator
        const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator
        if (u < -slack || v < -slack || u + v > 1 + slack) continue
        visit(j * this.columns + i, u * ay + v * by + (1 - u - v) * cy)
      }
    }
  }
}

/** GLSL: the shore map lookup, as `vec2(depth in metres, over the bed 0..1)`, or null (-1) off the map. */
const SHORE_LOOKUP = `
vec2 shoreAt(vec2 w) {
  vec2 st = ((w - waterShoreRect.xy) / ${ShoreMap.CELL.toFixed(2)} + 0.5) / waterShoreRect.zw;
  if (any(lessThan(st, vec2(0.0))) || any(greaterThan(st, vec2(1.0)))) return vec2(-1.0);
  vec2 s = texture2D(waterShore, st).rg;
  return vec2(s.r * 3.0 - 0.5, s.g);
}`

/**
 * The riverbed under the water: sunlight focused by the ripples playing over it (caustics), only where the sun reaches,
 * and the bed turning to wet earth toward its outline so it meets the grass of the banks without a dark seam.
 */
function riverbedLight(material: THREE.MeshStandardMaterial, shore: ShoreMap, time: { value: number }): void {
  const base = material.onBeforeCompile.bind(material), caustics = causticTexture()
  material.onBeforeCompile = (shader, renderer) => {
    base(shader, renderer)
    if (!shader.fragmentShader.includes('vTerrainWorld')) return
    shader.uniforms.waterTime = time
    shader.uniforms.waterCaustics = { value: caustics }
    shader.uniforms.waterShore = { value: shore.texture }
    shader.uniforms.waterShoreRect = { value: shore.rect }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float waterTime;
uniform sampler2D waterCaustics;
uniform sampler2D waterShore;
uniform vec4 waterShoreRect;
float bedWet = 1.0;
${SHORE_LOOKUP}`)
      .replace('diffuseColor.rgb *= mix(green, stone, rocky);', `
  vec2 bedShore = shoreAt(p.xz);
  // Toward the outline the pebbles give way to the bank's own earth and grass, darkened wet.
  float bedEdge = bedShore.x < -0.9 ? 0.0 : 1.0 - smoothstep(0.6, 1.0, bedShore.y);
  stone = mix(stone, mix(green, earth, 0.55) * 0.8, bedEdge);
  bedWet = bedShore.x < -0.9 ? 1.0 : smoothstep(0.02, 0.12, bedShore.x);
  diffuseColor.rgb *= mix(green, stone, rocky);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  // Two copies of the caustic net drifting across each other; where both are bright the light is focused.
  // Wobbled slowly, so the cells swim as they do under moving ripples.
  vec2 cp = vTerrainWorld.xz;
  cp += 0.25 * sin(cp.yx * 0.9 + waterTime * vec2(0.7, 0.9));
  float c1 = texture2D(waterCaustics, cp / 2.6 + vec2(waterTime * 0.031, waterTime * 0.017)).r;
  float c2 = texture2D(waterCaustics, mat2(0.8, -0.6, 0.6, 0.8) * cp / 3.3 - vec2(waterTime * 0.022, -waterTime * 0.027)).r;
  float caustic = (c1 + c2) * 0.4 + c1 * c2 * 1.6;
  float fade = 1.0 - smoothstep(25.0, 60.0, length(cameraPosition - vTerrainWorld));
  reflectedLight.directDiffuse *= 1.0 + caustic * 5.0 * bedWet * fade;
}`)
  }
}

/** A tiling caustic net: bright ridges along the borders of a wrapped Voronoi pattern, 128 px, no download. */
function causticTexture(): THREE.DataTexture {
  const size = 128, cells = 5, data = new Uint8Array(size * size)
  let seed = 11
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const points: [number, number][] = []
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) points.push([(i + .15 + random() * .7) / cells, (j + .15 + random() * .7) / cells])
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size
    let f1 = 9, f2 = 9
    for (const [px, py] of points) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const d = Math.hypot(u - px - ox, v - py - oy)
      if (d < f1) { f2 = f1; f1 = d } else if (d < f2) f2 = d
    }
    const ridge = Math.max(0, 1 - (f2 - f1) * cells / .32)
    data[y * size + x] = Math.round(ridge ** 2.2 * 255)
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

/**
 * The river's surface, as Halo 3's Valhalla has it: clear over the bed looking down, a mirror of the sky toward the
 * horizon (Fresnel), blue-green only where it deepens, and the sun glittering off the ripples.
 *
 * - Reflection: the sky's own gradient, sun glow and drifting cloud, evaluated for the reflected ray (the same function
 *   as the sky dome, so the clouds in the water are the clouds overhead), and the map's reflection probe toward the
 *   horizon, where the banks and cliffs stand.
 * - Body: light scattered back out of the water (lit by the scene's sun, shadows and sky), weighed by how much water the
 *   view passes through; the bed shows through the rest. Drawn premultiplied, so the reflection adds to the bed rather
 *   than veiling it.
 * - Sun glint: a sharp specular lobe off finer, faster ripples, in shadow where the map shadows the sun, added after tone
 *   mapping so the brightest facets run past white into the bloom; the lobe widens with distance, so far off the
 *   sparkles merge into a glitter path instead of aliasing.
 * - Shoreline: from the shore map, per pixel — it thins to nothing where a bank or a boulder rises through it and off the
 *   riverbed's outline, with lace foam against anything standing in the current.
 * One draw call, no extra passes, no depth texture (phones render without one).
 */
function riverWater(material: THREE.MeshStandardMaterial, water: {
  ripples: THREE.Texture; time: { value: number }; rings: THREE.Vector4[]; shore: ShoreMap; sky?: THREE.Mesh
}): void {
  const skyUniforms = (water.sky?.material as THREE.ShaderMaterial | undefined)?.uniforms
  const sky = {
    skyHorizon: skyUniforms?.horizon ?? { value: new THREE.Color(0xc4d3dc) },
    skyZenith: skyUniforms?.zenith ?? { value: new THREE.Color(0x4f84bd) },
    skySun: skyUniforms?.sun ?? { value: new THREE.Vector3(-.45, .62, .64).normalize() },
    skySunColor: skyUniforms?.sunColor ?? { value: new THREE.Color(0xfff0d8) },
    skyCover: skyUniforms?.cover ?? { value: .5 },
    skyTime: skyUniforms?.time ?? { value: 0 },
  }
  // The glint is added to the display-referred colour: the sun's colour as the screen shows it.
  const glintColor = (sky.skySunColor.value as THREE.Color).clone().convertLinearToSRGB()
  Object.assign(material, { map: null, transparent: true, premultipliedAlpha: true, opacity: 1, depthWrite: false, roughness: .05, metalness: 0 })
  // The colour light scatters back out of the water with: Halo 3's Valhalla river is a clear blue-green.
  material.color.set(0x13606e)
  material.normalMap = water.ripples
  material.normalScale = new THREE.Vector2(.26, .26)
  material.envMapIntensity = 1
  // The export has no UVs for water: ripple it in world space, carried along the channel.
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, sky, {
      waterTime: water.time, waterRipples: { value: water.rings },
      waterShore: { value: water.shore.texture }, waterShoreRect: { value: water.shore.rect }, waterGlintColor: { value: glintColor },
      waterSkylineA: { value: water.shore.horizon[0] }, waterSkylineB: { value: water.shore.horizon[1] },
    })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float waterDepth;\nattribute vec2 waterFlow;\nvarying vec3 vWaterWorld;\nvarying float vWaterDepth;\nvarying vec2 vWaterFlow;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWaterDepth = waterDepth;\nvWaterFlow = waterFlow;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float waterTime;
uniform vec4 waterRipples[${RIPPLES}];
uniform sampler2D waterShore;
uniform vec4 waterShoreRect;
uniform sampler2D waterSkylineA;
uniform sampler2D waterSkylineB;
uniform vec3 waterGlintColor;
uniform vec3 skyHorizon;
uniform vec3 skyZenith;
uniform vec3 skySun;
uniform vec3 skySunColor;
uniform float skyCover;
uniform float skyTime;
varying vec3 vWaterWorld;
varying float vWaterDepth;
varying vec2 vWaterFlow;
float waterFoam = 0.0;
float waterFade = 1.0;
float waterDepthHere = 0.35;
float waterOverBed = 1.0;
vec3 waterNormal = vec3(0.0, 1.0, 0.0);
vec3 waterGlintNormal = vec3(0.0, 1.0, 0.0);
float waterNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  vec4 h = fract(sin(vec4(dot(i, vec2(127.1, 311.7)), dot(i + vec2(1, 0), vec2(127.1, 311.7)), dot(i + vec2(0, 1), vec2(127.1, 311.7)), dot(i + 1.0, vec2(127.1, 311.7)))) * 43758.5453);
  return mix(mix(h.x, h.y, f.x), mix(h.z, h.w, f.x), f.y); }
// The sky dome's own colour for a direction (arena-atmosphere.ts), less the sun's disc, which the glint draws.
vec3 waterSky(vec3 d) {
  float up = max(d.y, 0.0);
  // A touch bluer toward the horizon than the dome itself: the water's blue is the sky's.
  vec3 col = mix(skyHorizon, skyZenith, pow(up, 0.4));
  float s = max(dot(d, normalize(skySun)), 0.0);
  col += skySunColor * (pow(s, 12.0) * 0.2 + pow(s, 3.0) * 0.06 * (1.0 - up));
  if (d.y > 0.02) {
    vec2 uv = d.xz / (d.y + 0.12) * 1.6 + vec2(skyTime * 0.004, skyTime * 0.0015);
    float n = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { n += a * waterNoise(uv); uv = uv * 2.03 + 11.3; a *= 0.5; }
    float c = smoothstep(0.66 - skyCover * 0.3, 0.9 - skyCover * 0.25, n) * smoothstep(0.02, 0.18, d.y);
    vec3 cloud = mix(mix(vec3(0.93, 0.95, 0.97), skyHorizon, 0.25) * (1.0 - skyCover * 0.18), skySunColor, pow(s, 6.0) * 0.5);
    col = mix(col, cloud, c * 0.88);
  }
  return col;
}
${SHORE_LOOKUP}`)
      .replace('#include <normal_fragment_maps>', `
{
  vec2 w = vWaterWorld.xz;
  vec2 here = shoreAt(w);
  if (here.x > -0.9) { waterDepthHere = here.x; waterOverBed = here.y; } else { waterDepthHere = vWaterDepth; waterOverBed = 1.0; }
  // Flow-mapped ripples: two copies of the pattern slide downstream, each reset while the other
  // is at full strength, so the river runs without the texture ever stretching.
  float t0 = fract(waterTime * 0.25), t1 = fract(waterTime * 0.25 + 0.5);
  float blend = abs(t0 * 2.0 - 1.0);
  vec2 f = vWaterFlow * 4.0;
  vec3 a0 = texture2D(normalMap, (w - f * t0) / 6.0).xyz, a1 = texture2D(normalMap, (w - f * t1) / 6.0 + 0.5).xyz;
  vec3 b0 = texture2D(normalMap, (w - f * t0) / 2.3 + 0.21).xyz, b1 = texture2D(normalMap, (w - f * t1) / 2.3 + 0.71).xyz;
  vec3 a = mix(a0, a1, blend) * 2.0 - 1.0, b = mix(b0, b1, blend) * 2.0 - 1.0;
  // A slow wind chop over the whole surface, independent of the current.
  vec3 c = texture2D(normalMap, w / 11.0 + vec2(waterTime * 0.013, -waterTime * 0.009)).xyz * 2.0 - 1.0;
  float speed = length(vWaterFlow);
  // The map's xy is the height's falling slope along world x and z.
  vec2 slope = (a.xy * (0.8 + speed) + b.xy * 0.7 + c.xy * 0.5) * normalScale;
  // Rings from players: a wave train travelling out from each impact at 1.3 m/s, fading with age
  // and distance. Its slope bends the normal; its crest whitens a little.
  for (int i = 0; i < ${RIPPLES}; i++) {
    vec4 rp = waterRipples[i];
    float age = waterTime - rp.z;
    if (rp.w <= 0.0 || age < 0.0 || age > 2.6) continue;
    vec2 d = w - rp.xy;
    float r = length(d) + 1e-4, front = age * 1.3;
    float x = r - front;
    float envelope = exp(-x * x * 2.2) * rp.w * (1.0 - age / 2.6) / (1.0 + r * 0.8);
    float wave = cos(x * 9.0);
    slope += d / r * (sin(x * 9.0) * 9.0) * envelope * 0.13;
    waterFoam += max(wave, 0.0) * envelope * 0.55 + exp(-r * r * 6.0) * rp.w * max(0.0, 1.0 - age * 2.0) * 0.8;
  }
  // Lace foam against whatever rises through the water (banks, boulders), broken up and drifting with the current.
  float lace = waterNoise((w - vWaterFlow * waterTime * 0.6) * 1.7) * 0.6 + waterNoise(w * 4.3 + waterTime * 0.2) * 0.4;
  waterFoam += (1.0 - smoothstep(0.0, 0.1, waterDepthHere)) * smoothstep(0.55, 0.85, lace) * 0.5 * smoothstep(0.5, 0.9, waterOverBed);
  waterNormal = normalize(vec3(slope.x, 1.0, slope.y));
  // Finer, quicker capillary ripples, for the sun's glitter only: each facet catches the sun for a moment.
  vec2 g0 = texture2D(normalMap, (w - f * t0 * 1.5) / 0.9 + 0.37).xy, g1 = texture2D(normalMap, (w - f * t1 * 1.5) / 0.9 + 0.83).xy;
  vec2 fine = mix(g0, g1, blend) * 2.0 - 1.0;
  waterGlintNormal = normalize(vec3(slope.x + fine.x * 0.11, 1.0, slope.y + fine.y * 0.11));
  normal = normalize((viewMatrix * vec4(waterNormal, 0.0)).xyz);
}`)
      .replace('#include <opaque_fragment>', `
{
  vec3 V = normalize(cameraPosition - vWaterWorld);
  float NdotV = clamp(dot(waterNormal, V), 0.001, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  vec3 R = reflect(-V, waterNormal); R.y = max(abs(R.y), 0.01); R = normalize(R);
  vec3 reflection = waterSky(R);
  // The land's skyline in the reflected direction (ShoreMap.skyline): below it the water mirrors banks and cliffs.
  vec2 st = ((vWaterWorld.xz - waterShoreRect.xy) / ${(ShoreMap.CELL * 2).toFixed(2)} + 0.5) / ceil(waterShoreRect.zw * 0.5);
  {
    float azimuth = atan(R.x, R.z), heading = mod(azimuth / (2.0 * PI) * 8.0 + 8.0, 8.0);
    vec4 k = vec4(0.0, 1.0, 2.0, 3.0);
    vec4 nearA = max(vec4(0.0), 1.0 - abs(mod(heading - k + 4.0, 8.0) - 4.0)), nearB = max(vec4(0.0), 1.0 - abs(mod(heading - k, 8.0) - 4.0));
    // Off the map (the lake below the falls) the ring of distant mountains stands in: low, and rolling with the heading.
    float skyline = all(greaterThan(st, vec2(0.0))) && all(lessThan(st, vec2(1.0)))
      ? (dot(texture2D(waterSkylineA, st), nearA) + dot(texture2D(waterSkylineB, st), nearB)) * PI * 0.5
      : 0.13 + 0.05 * sin(azimuth * 3.0 + 1.3) + 0.03 * sin(azimuth * 7.0);
    float elevation = asin(R.y), land = 1.0 - smoothstep(skyline - 0.03, skyline + 0.015, elevation);
    vec3 landColor = vec3(0.06, 0.07, 0.055);
#ifdef ENVMAP_TYPE_CUBE_UV
    // The map as the probe saw it level in that direction: rock, grass, the dam's concrete.
    landColor = textureCubeUV(envMap, envMapRotation * normalize(vec3(R.x, 0.0, R.z)), 0.3).rgb * envMapIntensity;
#endif
    // Darker toward the waterline, where banks stand in their own shade, lighter up to the lit rims: the gradient is
    // what the ripples break into streaks.
    landColor *= mix(0.5, 1.2, smoothstep(0.0, 1.0, elevation / max(skyline, 0.05)));
    reflection = mix(reflection, landColor, land * 0.9);
  }
  // The body: light scattered back out of the water, stronger through more of it; the bed shows through the rest.
  // The river stands only 35 cm over its bed, so its path is exaggerated to read as blue-green in the channel and
  // clear toward its edges.
  float depth = max(waterDepthHere, 0.0) * mix(0.35, 1.0, smoothstep(0.3, 1.0, waterOverBed));
  float path = depth * 1.15 / mix(0.66, 1.0, NdotV);
  vec3 T = exp(-vec3(1.2, 0.45, 0.32) * path);
  float body = 1.0 - (T.r + T.g + T.b) / 3.0;
  // diffuseColor is the water's colour, so the lit diffuse is that colour under this spot's sun, shadow and sky.
  vec3 scatter = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  vec3 color = reflection * F + scatter * body * (1.0 - F);
  float alpha = F + body * (1.0 - F);
  // Foam: white, lit as the water is.
  float foam = clamp(waterFoam, 0.0, 0.8);
  color = mix(color, scatter / max(diffuseColor.rgb, vec3(0.02)) * 0.8, foam);
  alpha = mix(alpha, 1.0, foam);
  // Shoreline: thin to nothing where the ground rises through the water, and off the riverbed's outline.
  waterFade = smoothstep(0.0, 0.1, waterDepthHere) * smoothstep(0.3, 0.8, waterOverBed) * (1.0 - foam * 0.9);
  outgoingLight = color / max(alpha, 1e-3);
  diffuseColor.a = alpha * smoothstep(0.0, 0.1, waterDepthHere) * smoothstep(0.3, 0.8, waterOverBed);
  if (diffuseColor.a < 0.002) discard;
}
#include <opaque_fragment>`)
      .replace('#include <premultiplied_alpha_fragment>', `#include <premultiplied_alpha_fragment>
{
  // The sun on the ripples, after tone mapping so the brightest facets run past white into the bloom.
  float sunShadow = 1.0;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  DirectionalLightShadow waterSunShadow = directionalLightShadows[ 0 ];
  sunShadow = getShadow( directionalShadowMap[ 0 ], waterSunShadow.shadowMapSize, waterSunShadow.shadowIntensity, waterSunShadow.shadowBias, waterSunShadow.shadowRadius, vDirectionalShadowCoord[ 0 ] );
#endif
  vec3 V = normalize(cameraPosition - vWaterWorld), L = normalize(skySun), H = normalize(L + V), N = waterGlintNormal;
  // Sharp up close, where single facets flash; wider far off, where they merge into a path toward the sun.
  float rough = mix(0.04, 0.15, smoothstep(3.0, 70.0, length(cameraPosition - vWaterWorld)));
  float a2 = rough * rough, NdotH = max(dot(N, H), 0.0), d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  float LdotH = max(dot(L, H), 0.0);
  float spec = a2 / (PI * d * d) * (0.02 + 0.98 * pow(1.0 - LdotH, 5.0)) * max(dot(N, L), 0.0) / (4.0 * max(LdotH * LdotH, 0.1));
  vec3 glint = waterGlintColor * spec * sunShadow * waterFade * 0.9;
#ifdef USE_FOG
  glint *= 1.0 - fogFactor;
#endif
  gl_FragColor.rgb += glint;
}`)
  }
  material.customProgramCacheKey = () => 'valhalla-water-2'
  material.needsUpdate = true
}

/** A tiling ripple normal map from wrapped value noise: irregular, seamless at 256, no download. */
function rippleNormals(): THREE.DataTexture {
  const size = 256, data = new Uint8Array(size * size * 4)
  // Periodic value noise at several octaves, so the texture tiles without a visible grid.
  let seed = 7
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const octaves = [8, 16, 32, 64].map(cells => ({ cells, grid: Array.from({ length: cells * cells }, random) }))
  const sample = (o: { cells: number; grid: number[] }, x: number, y: number) => {
    const fx = x / size * o.cells, fy = y / size * o.cells
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0
    const at = (i: number, j: number) => o.grid[((j % o.cells + o.cells) % o.cells) * o.cells + ((i % o.cells + o.cells) % o.cells)]
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy
  }
  const height = (x: number, y: number) => octaves.reduce((h, o, i) => h + sample(o, x, y) * .5 ** i, 0)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = height(x + 1, y) - height(x - 1, y), dy = height(x, y + 1) - height(x, y - 1)
    const n = new THREE.Vector3(-dx * 3, -dy * 3, 1).normalize()
    const i = (y * size + x) * 4
    data[i] = (n.x * .5 + .5) * 255; data[i + 1] = (n.y * .5 + .5) * 255; data[i + 2] = (n.z * .5 + .5) * 255; data[i + 3] = 255
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

/**
 * The water surface height under a point, or null off the water: the water triangles are
 * rasterised once into a 0.5 m grid, so a lookup is one array read.
 */
function waterHeights(model: THREE.Object3D): (x: number, z: number) => number | null {
  const triangles: THREE.Vector3[] = []
  model.updateWorldMatrix(true, true)
  model.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || (mesh.material as THREE.Material).name !== 'riverworld_ground_water') return
    const position = mesh.geometry.attributes.position, index = mesh.geometry.index
    const count = index ? index.count : position.count
    for (let i = 0; i < count; i++) triangles.push(new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld))
  })
  if (!triangles.length) return () => null
  const cell = .5
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const v of triangles) { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z) }
  const cols = Math.ceil((x1 - x0) / cell) + 1, rows = Math.ceil((z1 - z0) / cell) + 1
  const heights = new Float32Array(cols * rows).fill(NaN)
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2]
    const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z)
    if (Math.abs(denominator) < 1e-9) continue
    const i0 = Math.floor((Math.min(a.x, b.x, c.x) - x0) / cell), i1 = Math.ceil((Math.max(a.x, b.x, c.x) - x0) / cell)
    const j0 = Math.floor((Math.min(a.z, b.z, c.z) - z0) / cell), j1 = Math.ceil((Math.max(a.z, b.z, c.z) - z0) / cell)
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const x = x0 + i * cell, z = z0 + j * cell
      const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator
      const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator
      if (u < -.05 || v < -.05 || u + v > 1.05) continue
      const y = u * a.y + v * b.y + (1 - u - v) * c.y, k = j * cols + i
      if (Number.isNaN(heights[k]) || y > heights[k]) heights[k] = y
    }
  }
  return (x, z) => {
    const i = Math.round((x - x0) / cell), j = Math.round((z - z0) / cell)
    if (i < 0 || j < 0 || i >= cols || j >= rows) return null
    const y = heights[j * cols + i]
    return Number.isNaN(y) ? null : y
  }
}

/** Spray from splashes: one pooled Points object, droplets thrown up and falling back. */
class Splashes {
  private readonly max = 400
  private readonly positions = new Float32Array(this.max * 3)
  private readonly velocity = new Float32Array(this.max * 3)
  private readonly life = new Float32Array(this.max)
  private readonly points: THREE.Points
  private next = 0
  constructor(scene: THREE.Scene) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage))
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
    gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(.5, 'rgba(235,245,250,.6)'); gradient.addColorStop(1, 'rgba(235,245,250,0)')
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 32, 32)
    this.points = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: .22, map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false, color: 0xe8f2f5, opacity: .85,
    }))
    this.points.name = 'valhalla-splashes'; this.points.frustumCulled = false
    this.positions.fill(-9999)
    scene.add(this.points)
  }
  burst(x: number, y: number, z: number, count: number, power: number): void {
    for (let n = 0; n < count; n++) {
      const i = this.next; this.next = (this.next + 1) % this.max
      const angle = Math.random() * Math.PI * 2, out = (.3 + Math.random() * .7) * power * .45
      this.positions.set([x + Math.cos(angle) * .15, y + .02, z + Math.sin(angle) * .15], i * 3)
      this.velocity.set([Math.cos(angle) * out, power * (.55 + Math.random() * .6), Math.sin(angle) * out], i * 3)
      this.life[i] = .5 + Math.random() * .5
    }
  }
  update(dt: number): void {
    let live = false
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue
      live = true
      this.life[i] -= dt
      this.velocity[i * 3 + 1] -= 9.8 * dt
      for (let k = 0; k < 3; k++) this.positions[i * 3 + k] += this.velocity[i * 3 + k] * dt
      if (this.life[i] <= 0) this.positions[i * 3 + 1] = -9999
    }
    if (live) this.points.geometry.attributes.position.needsUpdate = true
  }
}

/**
 * A copy of the (world-space) water geometry lifted by `lift` and with its open outline pushed
 * outward by `widen`, both in metres, for the visible water surface over the riverbed.
 * Vertices are welded by position first, since the export splits them along seams.
 */
function raisedSurface(source: THREE.BufferGeometry, lift: number, widen: number): THREE.BufferGeometry {
  const position = source.attributes.position, index = source.index
  const count = index ? index.count : position.count
  const corner = (i: number) => index ? index.getX(i) : i
  // Weld by position.
  const key = (v: number) => `${position.getX(v).toFixed(4)},${position.getY(v).toFixed(4)},${position.getZ(v).toFixed(4)}`
  const weld = new Map<string, number>(), welded: number[] = []
  const points: THREE.Vector3[] = []
  for (let v = 0; v < position.count; v++) {
    const k = key(v)
    let id = weld.get(k)
    if (id === undefined) { id = points.length; weld.set(k, id); points.push(new THREE.Vector3().fromBufferAttribute(position, v)) }
    welded.push(id)
  }
  const triangles: number[] = []
  for (let i = 0; i < count; i++) triangles.push(welded[corner(i)])
  // Open outline: edges used by exactly one triangle.
  const edges = new Map<string, [number, number, number]>()
  for (let t = 0; t < triangles.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = triangles[t + e], b = triangles[t + (e + 1) % 3], c = triangles[t + (e + 2) % 3]
    const k = a < b ? `${a},${b}` : `${b},${a}`
    if (edges.has(k)) edges.delete(k); else edges.set(k, [a, b, c])
  }
  // Push each outline vertex outward: along the sum of its outline edges' outward normals in plan.
  const push = points.map(() => new THREE.Vector2())
  for (const [a, b, c] of edges.values()) {
    const ex = points[b].x - points[a].x, ez = points[b].z - points[a].z, length = Math.hypot(ex, ez) || 1
    let nx = -ez / length, nz = ex / length
    // Outward: away from the triangle's third corner.
    const mx = (points[a].x + points[b].x) / 2, mz = (points[a].z + points[b].z) / 2
    if ((points[c].x - mx) * nx + (points[c].z - mz) * nz > 0) { nx = -nx; nz = -nz }
    push[a].x += nx; push[a].y += nz; push[b].x += nx; push[b].y += nz
  }
  const out = new Float32Array(triangles.length * 3)
  triangles.forEach((id, i) => {
    const p = points[id], d = push[id], length = d.length()
    const scale = length > 1e-6 ? widen / length : 0
    out[i * 3] = p.x + d.x * scale; out[i * 3 + 1] = p.y + lift; out[i * 3 + 2] = p.z + d.y * scale
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(out, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** The river's course, source to cascades, traced from the export's bed heights: its north arm
 * is level to a few centimetres, so the direction of flow cannot be read from the bed there. */
const RIVER: readonly [number, number, number][] = [
  // x, z, speed in m/s: slow along the level northern arm, quicker toward and past the cascade.
  [54, 138, .25], [42, 110, .25], [24, 102, .3], [0, 97, .3], [-24, 93, .3], [-48, 84, .3], [-64, 66, .3],
  [-58, 42, .35], [-46, 22, .35], [-34, 6, .4], [-20, -10, .4], [-4, -18, .45], [6, -36, .5], [12, -60, .6],
  [15, -76, .9], [6, -92, .6], [-14, -104, .55], [-26, -122, .55], [-34, -140, .55], [-38, -152, .6], [-18, -168, .7], [0, -182, .8],
]

/**
 * Per-vertex water facts for the surface shader: how deep the water stands over the ground
 * beneath it (negative out on the widened rim, where the bank rises through it), and which way
 * and how fast the river is running there.
 */
function annotateRiver(geometry: THREE.BufferGeometry, ground: TriangleMesh): THREE.BufferGeometry {
  const position = geometry.attributes.position, count = position.count
  const depth = new Float32Array(count), flow = new Float32Array(count * 2), v = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(position, i)
    // Down from a little above the surface: the bed, or the bank where it rises through the water.
    const hit = ground.raycast(v.x, v.y + 3, v.z, 0, -1, 0, 6)
    depth[i] = hit ? v.y - (v.y + 3 - hit.t) : .35
    // Along the nearest leg of the course.
    let best = Infinity
    for (let k = 0; k + 1 < RIVER.length; k++) {
      const [ax, az, as] = RIVER[k], [bx, bz, bs] = RIVER[k + 1], ex = bx - ax, ez = bz - az, length = Math.hypot(ex, ez)
      const s = Math.max(0, Math.min(1, ((v.x - ax) * ex + (v.z - az) * ez) / (length * length)))
      const d = Math.hypot(v.x - ax - ex * s, v.z - az - ez * s)
      if (d < best) { best = d; const speed = as + (bs - as) * s; flow[i * 2] = ex / length * speed; flow[i * 2 + 1] = ez / length * speed }
    }
  }
  geometry.setAttribute('waterDepth', new THREE.BufferAttribute(depth, 1))
  geometry.setAttribute('waterFlow', new THREE.BufferAttribute(flow, 2))
  return geometry
}

/** Water running down the steep sheets: streaks sliding down, whiter where it breaks. */
function fallingWater(ripples: THREE.Texture, time: { value: number }): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ name: 'valhalla-falls', color: 0xcfe0e2, roughness: .25, metalness: 0, transparent: true, opacity: .8, depthWrite: false, side: THREE.DoubleSide,
    // Drawn over the bed's own copy of the same faces.
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 })
  material.onBeforeCompile = shader => {
    shader.uniforms.waterTime = time
    shader.uniforms.fallsRipples = { value: ripples }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFallsWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvFallsWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float waterTime;\nuniform sampler2D fallsRipples;\nvarying vec3 vFallsWorld;')
      .replace('#include <map_fragment>', `
{
  // Along the sheet horizontally, and down it over time.
  vec2 uv = vec2((vFallsWorld.x + vFallsWorld.z) * 0.9, vFallsWorld.y * 0.35 + waterTime * 1.6);
  float streak = texture2D(fallsRipples, uv * vec2(1.0, 0.25)).r * 0.6 + texture2D(fallsRipples, uv * vec2(2.3, 0.5) + 0.3).g * 0.4;
  diffuseColor.rgb = mix(vec3(0.16, 0.3, 0.3), vec3(0.93, 0.97, 0.98), smoothstep(0.35, 0.75, streak));
  diffuseColor.a *= mix(0.55, 1.0, smoothstep(0.3, 0.7, streak));
}`)
  }
  material.customProgramCacheKey = () => 'valhalla-falls'
  return material
}

/** The triangles of a (world-space) sheet that drop at least `drop` metres from top to bottom. */
function tallSheets(source: THREE.BufferGeometry, drop: number): THREE.BufferGeometry | null {
  const position = source.attributes.position, values: number[] = []
  for (let i = 0; i < position.count; i += 3) {
    const ys = [position.getY(i), position.getY(i + 1), position.getY(i + 2)]
    if (Math.max(...ys) - Math.min(...ys) < drop) continue
    for (let k = 0; k < 3; k++) values.push(position.getX(i + k), position.getY(i + k), position.getZ(i + k))
  }
  if (!values.length) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(values), 3))
  geometry.computeVertexNormals()
  return geometry
}

/** Split a mesh's triangles by facing: those within `minUp` of level, and the rest. */
function splitBySlope(source: THREE.BufferGeometry, minUp: number): [THREE.BufferGeometry | null, THREE.BufferGeometry | null] {
  const position = source.attributes.position, index = source.index
  const count = index ? index.count : position.count
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3()
  const flat: number[] = [], steep: number[] = []
  for (let i = 0; i < count; i += 3) {
    const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2
    a.fromBufferAttribute(position, ia); b.fromBufferAttribute(position, ib); c.fromBufferAttribute(position, ic)
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize()
    const into = Math.abs(n.y) >= minUp ? flat : steep
    into.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  }
  const build = (values: number[]) => {
    if (!values.length) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(values), 3))
    geometry.computeVertexNormals()
    return geometry
  }
  return [build(flat), build(steep)]
}

/** A copy of `geometry` whose positions and normals are plain float32 (meshopt-quantized files store normalized int16/int8). */
function dequantized(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const copy = geometry.clone()
  for (const name of ['position', 'normal'] as const) {
    const attribute = copy.getAttribute(name) as THREE.BufferAttribute | undefined
    if (!attribute || (attribute.array instanceof Float32Array && !attribute.normalized)) continue
    const values = new Float32Array(attribute.count * attribute.itemSize)
    for (let i = 0; i < attribute.count; i++) for (let k = 0; k < attribute.itemSize; k++) values[i * attribute.itemSize + k] = attribute.getComponent(i, k)
    copy.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize))
  }
  return copy
}
