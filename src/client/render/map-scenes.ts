import {isArena} from '../../shared/arena.ts'
import * as THREE from 'three'
import type { MapId } from '../../shared/maps.ts'
import { DEBUG_HOOKS } from '../debug/build-flags.ts'
import { bakeStaticPointLights, prepareStaticLightMaterials } from './static-lights.ts'
import { CacheBudget } from './cache-budget.ts'
import { disposeScene, estimateSceneBytes } from './scene-resources.ts'
import { rendererSettings, applyMapSettings, withMapSettings } from './renderer-settings.ts'
export { applyMapSettings } from './renderer-settings.ts'

export interface MapScene {
  map: MapId
  scene: THREE.Scene
  roots: THREE.Object3D[]
  settings: ReturnType<typeof rendererSettings>
  ready: Promise<void>
  bytes: number
  used: number
  complete: boolean
  time: number
}
async function buildMap(map: MapId, renderer: THREE.WebGLRenderer, signal: AbortSignal): Promise<MapScene> {
  // Imports happen before changing any renderer settings; the outgoing flyover can keep running.
  const arena = isArena(map) ? {id:map,create:(await import('./arena.ts')).createArena} : null
  const create = map === 'guardian' ? (await import('./guardian.ts')).createGuardian
    : map === 'lockout' ? (await import('./lockout.ts')).createLockout
    : arena ? (scene:THREE.Scene,renderer:THREE.WebGLRenderer)=>arena.create(scene,renderer,arena.id,signal) : null
  const gulch = create ? null : await Promise.all([import('./sky.ts'), import('./terrain.ts'), import('./bases.ts')])
  signal.throwIfAborted()
  const previous = rendererSettings(renderer), scene = new THREE.Scene(), roots: THREE.Object3D[] = []
  try {
    renderer.toneMappingExposure = 1
    if (create) roots.push(create(scene, renderer, signal))
    else {
      const [{ createSky }, { createTerrain }, { createBases }] = gulch!
      createSky(scene, renderer)
      const terrain = createTerrain(), bases = createBases()
      scene.add(terrain, bases); roots.push(terrain, bases)
    }
    if (!(DEBUG_HOOKS && new URLSearchParams(location.search).has('dynamiclights'))) bakeStaticPointLights(scene)
    scene.traverse(object => { if ((object as THREE.Light).isLight) object.layers.enable(1) })
    // Maps without their own bloom (arena-light-fx.ts) still get a high-threshold glow: only lamps, energy and muzzle
    // flashes cross it, so the world looks as before while the weapons' effects bloom like they do elsewhere.
    scene.userData.bloom ??= {threshold: .9, knee: .1, strength: .45}
    const settings = rendererSettings(renderer)
    const ready = Promise.all(roots.map(async root => {
      await root.userData.ready
      if (root.userData.importedError) throw new Error(String(root.userData.importedError))
    })).then(async () => {
      signal.throwIfAborted()
      // Imported arenas add their lights after the GLB finishes, too.
      if (!(DEBUG_HOOKS && new URLSearchParams(location.search).has('dynamiclights'))) bakeStaticPointLights(scene)
      scene.traverse(object => { if ((object as THREE.Light).isLight) object.layers.enable(1) })
      prepareStaticLightMaterials(scene)
      await withMapSettings(renderer, settings, () => renderer.compileAsync(scene, new THREE.PerspectiveCamera()))
    })
    void ready.catch(() => {})
    return { map, scene, roots, settings, ready, bytes: 0, used: 0, complete: false, time: 0 }
  } finally { applyMapSettings(renderer, previous) }
}

/** Cancel obsolete transfers immediately; serialize scene construction and renderer settings. */
export class MapScenes {
  private entries = new Map<MapId, MapScene>()
  private serial: Promise<unknown> = Promise.resolve()
  private active: MapScene | null = null
  private stamp = 0
  private builds = 0
  private hits = 0
  private evictions = 0
  private keepInactive = true
  private pending: AbortController | null = null
  constructor(private readonly renderer: THREE.WebGLRenderer, readonly budget: CacheBudget) {}
  request(map: MapId, current: () => boolean, preview: (entry: MapScene) => void): Promise<MapScene> {
    this.pending?.abort()
    const hit = this.entries.get(map)
    if (hit?.complete) {
      // Nothing to load: a held-over controller would block the next prefetch.
      this.pending = null
      this.hits++; hit.used = ++this.stamp
      if (current()) { this.activate(hit); preview(hit) }
      return Promise.resolve(hit)
    }
    const controller = this.pending = new AbortController()
    const task = this.serial.catch(() => {}).then(async () => {
      if (!current()) throw new DOMException('Level selection changed', 'AbortError')
      const cached = this.entries.get(map)
      if (cached?.complete) {
        this.hits++; this.activate(cached); preview(cached); return cached
      }
      // Release unused maps before allocating a new one. The visible map remains pinned.
      this.trim(true)
      let entry: MapScene | undefined
      try {
        entry = await buildMap(map, this.renderer, controller.signal)
        this.builds++; entry.used = ++this.stamp; this.entries.set(map, entry)
        // Imported maps become visible only after their model and lighting are ready.
        await entry.ready
        controller.signal.throwIfAborted()
        entry.complete = true; entry.bytes = estimateSceneBytes(entry.scene)
        if (current()) { this.activate(entry); preview(entry) }
        this.trim()
        return entry
      } catch (error) {
        if (entry) {
          if (this.active === entry) this.active = null
          this.remove(entry)
        }
        throw error
      } finally {
        if (this.pending === controller) this.pending = null
      }
    })
    this.serial = task
    return task
  }
  /**
   * Build a map in the background without showing it, so a later `request` for it is instant: the home
   * screen's tour crossfades into the next map instead of waiting on a load. Never touches the visible map,
   * and gives way to a real request. False if it could not be held (no room, superseded, failed).
   */
  prefetch(map: MapId): Promise<boolean> {
    if (this.entries.get(map)?.complete) return Promise.resolve(true)
    if (this.budget.maxMaps < 2 || this.pending) return Promise.resolve(false)
    const controller = this.pending = new AbortController()
    const task = this.serial.catch(() => {}).then(async () => {
      if (this.entries.get(map)?.complete) return true
      // Room for one more beside the visible map.
      this.trim(true)
      let entry: MapScene | undefined
      try {
        entry = await buildMap(map, this.renderer, controller.signal)
        this.builds++; entry.used = this.stamp; this.entries.set(map, entry)
        await entry.ready
        controller.signal.throwIfAborted()
        entry.complete = true; entry.bytes = estimateSceneBytes(entry.scene)
        return true
      } catch {
        if (entry) this.remove(entry)
        return false
      } finally {
        if (this.pending === controller) this.pending = null
      }
    })
    this.serial = task
    return task
  }
  private activate(entry: MapScene): void { this.active = entry; entry.used = ++this.stamp }
  trim(beforeBuild = false): void {
    for (;;) {
      const total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
      const limit = beforeBuild || !this.keepInactive ? 1 : this.budget.maxMaps
      if (this.entries.size <= limit && total <= this.budget.bytes) break
      const oldest = [...this.entries.values()].filter(entry => entry !== this.active && entry.complete).sort((a, b) => a.used - b.used)[0]
      if (!oldest) break // The visible map is required even if it exceeds our estimate budget.
      this.remove(oldest)
    }
  }
  releaseInactive(stopRetaining = false): void {
    if (stopRetaining) this.keepInactive = false
    for (const entry of this.entries.values()) if (entry !== this.active && entry.complete) this.remove(entry)
  }
  private remove(entry: MapScene): void {
    this.entries.delete(entry.map); this.evictions++
    disposeScene(entry.scene, [...this.entries.values()].map(value => value.scene))
    this.renderer.renderLists.dispose()
  }
  summary() {
    return { builds: this.builds, hits: this.hits, evictions: this.evictions, budgetBytes: this.budget.bytes,
      maxMaps: this.budget.maxMaps, parallel: this.budget.parallel,
      maps: [...this.entries.values()].map(({ map, bytes, complete }) => ({ map, bytes, complete })), active: this.active?.map }
  }
}
