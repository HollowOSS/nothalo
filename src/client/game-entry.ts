import { isArena, arenaMeta } from '../shared/arena.ts'
import { renderFirstPerson } from './render/first-person-pass.ts'
import { MAP_NAMES, levelUrl, type MapId } from '../shared/maps.ts'
import * as THREE from 'three'
import { MOVE } from '../shared/constants.ts'
import { PRESENTATION } from '../shared/presentation.ts'
import { AdaptiveQuality, markGraphicsLost } from './render/quality.ts'
import { Bloom } from './render/bloom.ts'
import { prepareStaticLightMaterials } from './render/static-lights.ts'
import { prepareWeapons } from './render/prepare-weapons.ts'
import { MapScenes, applyMapSettings, type MapScene } from './render/map-scenes.ts'
import { CacheBudget, PreparationQueue, deviceHints } from './render/cache-budget.ts'
import { installVantageHooks } from './debug/vantage.ts'
import { flyCanyon } from './render/cinematic.ts'
import { FrameStats, installPerfHooks } from './debug/stats.ts'
import { storedName, storedMode, type MatchChoice, type MenuController } from './hud/menu.ts'
import { playlistId } from '../shared/playlists.ts'
import type { Match } from './game/match.ts'
import type { CombatAudio } from './game/combat-audio.ts'
import type { Connection } from './net/connection.ts'
import { DEBUG_HOOKS } from './debug/build-flags.ts'

export async function startGame(selectedMap: MapId, onStage: (stage: string | null) => void,
  menu?: MenuController, onFailure?: () => void): Promise<void> {
  // MSAA on the screen's own framebuffer, at every density. It was held back on high-DPI screens
  // for cost, which left phones with crawling edges; measured at DPR 2 it costs nothing
  // noticeable here, and tile-based phone GPUs resolve it on chip. (What is costly is a
  // multisampled offscreen target: bloom smooths its edges in its composite pass instead.)
  // `?noaa` turns it off.
  const antialias = !new URLSearchParams(location.search).has('noaa')
  const renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  // The canvas is the game surface on touch devices. Prevent the browser from turning a two
  // finger look/fire gesture into page panning or a zoom, while leaving the menu's own buttons
  // usable before the match starts.
  renderer.domElement.style.touchAction = 'none'
  renderer.domElement.style.userSelect = 'none'
  renderer.domElement.style.webkitUserSelect = 'none'
  document.body.appendChild(renderer.domElement)


  const params = new URLSearchParams(location.search)
  const asCamera = params.has('cam'), scripted = params.has('nooverlay') || params.has('offline')
  const uncapped = params.has('uncapped')
  if (DEBUG_HOOKS) {
    const trial = Number(params.get('lockoutscale'))
    if (trial > 0) (globalThis as { __lockoutScale?: number }).__lockoutScale = trial
  }
  const camera = new THREE.PerspectiveCamera(MOVE.fovDeg, innerWidth / innerHeight, PRESENTATION.worldNear, PRESENTATION.worldFar)
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight) })
  const budget = new CacheBudget(deviceHints()), preparation = new PreparationQueue(budget)
  const maps = new MapScenes(renderer, budget)
  let active: MapScene | null = null
  let scene = new THREE.Scene()
  const quality = new AdaptiveQuality(renderer, scene, !asCamera && !params.has('fixed-quality'))
  const bloom = new Bloom(renderer, () => quality.bloomScale(), quality.mobile)
  const stats = new FrameStats()
  installPerfHooks(stats, renderer)
  if (DEBUG_HOOKS) Object.assign(window, { __renderer: renderer, __quality: () => ({ ...quality.summary(), bloomMode: bloom.mode }), __bloom: bloom, __mapCache: () => maps.summary() })
  renderer.domElement.addEventListener('webglcontextlost', () => {
    maps.releaseInactive()
    // A restored context comes back without render-target contents (environment reflections, shadow maps, bloom), and on
    // iOS the loss is usually memory pressure that repeats: reload into the same level on lighter graphics (quality.ts).
    markGraphicsLost()
    onStage('Reloading graphics…')
    setTimeout(() => location.reload(), 1200)
  })
  let match: Match | null = null
  let ambience: CombatAudio | null = null
  let updateHud: (() => void) | null = null
  let hitboxOverlay: (() => void) | null = null
  let stillRequested: ((still: HTMLCanvasElement | null) => void) | null = null
  let cinematic = !asCamera
  let inMatch = false
  let generation = 0
  let previousFrame = performance.now(), lastPresentedAt = -Infinity
  const backdrop = document.querySelector<HTMLElement>('.menu-backdrop')
  function activate(entry: MapScene): void {
    if (active === entry) return
    active = entry; scene = entry.scene
    applyMapSettings(renderer, entry.settings)
    quality.setScene(scene)
    previousFrame = performance.now()
    if (DEBUG_HOOKS) Object.assign(window, { __scene: scene })
  }
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    if (!active || (!uncapped && now - lastPresentedAt < 1000 / 60 - 2)) return
    lastPresentedAt = now
    const elapsed = now - previousFrame; previousFrame = now
    if (!document.hidden) budget.sample(elapsed, now)
    stats.tick(); quality.tick()
    const dt = Math.min(elapsed / 1000, .1)
    active.time += dt
    if (cinematic) {
      if (active.map === 'guardian') { camera.position.set(Math.cos(active.time*.035)*43,29,Math.sin(active.time*.035)*43); camera.lookAt(0,13,0) }
      else if (active.map === 'the-pit') { camera.position.set(Math.cos(active.time*.025)*42,27,Math.sin(active.time*.025)*38);camera.lookAt(0,7,0) }
      else if (active.map === 'narrows') { camera.position.set(Math.cos(active.time*.025)*64,42,Math.sin(active.time*.025)*80);camera.lookAt(0,9,0) }
      else if(active.map==='epitaph'||active.map==='rats-nest'){
        const [x,y,z]=arenaMeta(active.map).spawns[0]
        // Metadata is available with the scenery; the gameplay BVH may still be loading.
        const yaw=(active.map==='rats-nest'?Math.PI*1.5:0)+Math.sin(active.time*.06)*.24
        camera.position.set(x,y+MOVE.eyeHeight,z)
        camera.lookAt(x-Math.sin(yaw)*10,y+MOVE.eyeHeight+.4,z-Math.cos(yaw)*10)
      }
      else if (isArena(active.map)) {
        const meta=arenaMeta(active.map),[x0,x1,z0,z1]=meta.bounds,[x,y,z]=meta.focus
        camera.position.set(x+Math.cos(active.time*.025)*(x1-x0)*.32,meta.top+Math.max(x1-x0,z1-z0)*.12,z+Math.sin(active.time*.025)*(z1-z0)*.32)
        camera.lookAt(x,y,z)
      }
      else if (active.map === 'lockout') { camera.position.set(Math.cos(active.time*.025)*88,52,Math.sin(active.time*.025)*88); camera.lookAt(0,26,0) }
      else flyCanyon(camera, active.time)
    }
    // Everyone's feet, for scenery that reacts to players (Valhalla's water).
    scene.getObjectByName(active.map)?.userData.update?.(active.time, camera.position, match?.you.state, match && !cinematic ? match.feet : undefined)
    if (!cinematic) { match?.update(dt); ambience?.listen(camera.position.x, camera.position.z) }
    hitboxOverlay?.()
    scene.userData.tickShadows?.(dt)
    updateHud?.()
    renderFirstPerson(renderer, scene, camera, cinematic ? undefined : match?.viewmodel, bloom)
    // A still of this frame for the menu's crossfade, taken before the browser presents (and clears) it.
    if (stillRequested) { const done = stillRequested; stillRequested = null; done(copyFrame(renderer.domElement)) }
    backdrop?.classList.add('live')
  })

  // Shared models, audio and registry initialize once for this document, across every menu map.
  let shared: ReturnType<typeof createShared> | undefined
  async function createShared() {
    const runtime = await import('./game/runtime.ts')
    const audio = new runtime.CombatAudio(), voice = new runtime.MedalAnnouncer(() => audio.muted)
    const players = preparation.run(() => runtime.preloadSpartan())
    const weapons = preparation.run(async () => {
      await runtime.registerAuthoredWeapons(['shotgun', 'energy-sword', 'battle-rifle', 'needler', 'gravity-hammer'])
        .catch(error => console.warn('Authored weapon registration failed:', error))
      if (params.has('generated-rifle')) await runtime.preloadGeneratedRifle().catch(error => console.warn('Using procedural rifle:', error))
    })
    void players.catch(() => {}); void weapons.catch(() => {})
    return { runtime, audio, voice, players, weapons }
  }
  function getShared() { return shared ??= createShared() }

  async function selectMap(map: MapId): Promise<MapScene> {
    const version = ++generation
    selectedMap = map
    const current = () => version === generation && !inMatch
    const stage = (text: string | null) => { if (current()) onStage(text) }
    menu?.loading()
    if (!active && backdrop) backdrop.style.backgroundImage = `url('/assets/menu/${map}.jpg')`
    const sceneryStage = `Loading ${MAP_NAMES[map]} scenery…`
    stage(sceneryStage)
    const scenery = maps.request(map, current, entry => { if (current()) activate(entry) })
    if (asCamera) {
      const entry = await scenery
      await (await import('../shared/level-data.ts')).preloadLevelData(map)
      installVantageHooks(camera); stage(null)
      return entry
    }
    const waiting = new Set([sceneryStage, 'Loading game systems…', 'Loading arena data…', 'Loading player models…', 'Loading weapons…'])
    const track = async <T>(label: string, work: Promise<T>): Promise<T> => {
      const result = await work
      waiting.delete(label); stage(waiting.values().next().value ?? null)
      return result
    }
    const sceneryReady = track(sceneryStage, scenery)
    const dataReady = track('Loading arena data…', (async () => {
      if (!current()) throw new DOMException('Level selection changed', 'AbortError')
      await (await import('../shared/level-data.ts')).preloadLevelData(map)
    })())
    // Observe every branch immediately; a failed map must not create an unhandled rejection
    // while the shared runtime or another download is still pending.
    void sceneryReady.catch(() => {}); void dataReady.catch(() => {})
    try {
      const [common, entry] = await Promise.all([track('Loading game systems…', getShared()), sceneryReady, dataReady])
      await Promise.all([track('Loading player models…', common.players), track('Loading weapons…', common.weapons)])
      if (current()) {
        maps.trim()
        menu?.ready(() => {
          void common.voice.preload().catch(error => console.warn('Announcer unavailable:', error))
          return common.audio.unlock()
        })
        stage(null)
      }
      return entry
    } catch (error) {
      if (current()) {
        if (active?.map === map && !active.complete) { active = null; backdrop?.classList.remove('live') }
        menu?.fail(); onFailure?.()
      }
      throw error
    }
  }
  // The home screen's tour: load the next map behind the current one, and a still of the current frame to dissolve from.
  menu?.attachScenery({
    prefetch: map => inMatch ? Promise.resolve(false) : maps.prefetch(map),
    still: () => new Promise(resolve => { stillRequested = resolve }),
  })
  menu?.onSelect(map => { void selectMap(map).catch(error => { if ((error as Error).name !== 'AbortError') console.warn('Level preparation failed:', error) }) })
  const initial = selectMap(menu?.selectedMap ?? selectedMap)
  // A failed menu selection stays recoverable through the selector or Retry.
  void initial.catch(error => { if ((error as Error).name !== 'AbortError') console.warn('Level preparation failed:', error) })
  if (asCamera) { await initial; return }
  let choice: MatchChoice
  if (scripted) {
    await initial
    choice = { name: storedName(), room: params.has('offline') ? null : params.get('room') ?? 'gulch', map: selectedMap, mode: storedMode(),
      playlist: playlistId(params.get('playlist')) ?? undefined }
  } else choice = await menu!.choice
  inMatch = true
  selectedMap = choice.map ?? selectedMap
  const mode = choice.mode ?? 'slayer'
  maps.releaseInactive(true)
  const common = await getShared()
  const { Input, TouchControls, wantsTouchControls, Match, createHud } = common.runtime
  const input = new Input(renderer.domElement)
  const touch = wantsTouchControls() ? new TouchControls(input) : undefined
  addEventListener('keydown', e => {
    if (e.code === 'KeyC' && !cinematic && selectedMap === 'guardian' && !(e.target instanceof HTMLInputElement)) scene.getObjectByName('guardian')?.userData.toggleCollision?.()
  })
  onStage(choice.room === null ? 'Creating bot match…' : 'Connecting to match…')
  const net = choice.room === null ? null : await connectToMatch(choice.room)
  if (!net && choice.room !== null) {
    // Say so rather than quietly dropping the player into a bot match they did not ask for.
    onStage('Could not join the match. Playing against bots instead.')
    await new Promise(resolve => setTimeout(resolve, 2200))
  }
  const matchUrl = levelUrl(selectedMap, new URL(location.href))
  if (net && choice.room) matchUrl.searchParams.set('room', choice.room)
  if (net && choice.playlist) matchUrl.searchParams.set('playlist', choice.playlist); else matchUrl.searchParams.delete('playlist')
  // Keep the game type in the address so a shared link lands in the same kind of match.
  if (mode === 'slayer') matchUrl.searchParams.delete('mode'); else matchUrl.searchParams.set('mode', mode)
  history.replaceState(null, '', matchUrl)
  match = new Match(scene, camera, input, net, selectedMap, common.audio, mode)
  onStage('Loading vehicles…')
  await match.vehicles.ready
  onStage('Loading weapons…')
  const spareWeapons = await match.preloadWeapons()
  onStage('Finishing graphics…')
  prepareStaticLightMaterials(scene)
  try {
    // As in play, the weapon in hand sits on the first-person layer, out of the world pass.
    match.weapon.object.traverse(node => node.layers.set(1))
    await renderer.compileAsync(scene, camera)
    await prepareWeapons(renderer, scene, camera, [...spareWeapons, match.weapon], match.weapon)
  }
  catch (error) { console.warn('Shader warm-up skipped:', error) }
  match.stowWeapons(spareWeapons)
  choice.cleanup?.()
  cinematic = false
  // The map's ambient bed fades in with play; leaving a match reloads the page, which ends it.
  // It waits for the imported scenery, where Valhalla's river is found.
  ambience = common.audio
  const mapRoot = scene.getObjectByName(selectedMap)
  void Promise.resolve(mapRoot?.userData.ready).catch(() => {}).then(() => ambience?.ambience(selectedMap, mapRoot))
  // After the game: matchmade games search again (a new map), bot matches move to another map, custom games stay.
  updateHud = createHud(match, () => input.active, touch, choice.name, common.voice, !net ? 'map' : choice.playlist ? 'match' : 'stay')
  // Development builds only: drawing the hit shapes is a check, not something to ship.
  if (import.meta.env.DEV && params.has('hitboxes')) {
    const { createHitboxOverlay } = await import('./game/hitbox-overlay.ts')
    const live = match
    hitboxOverlay = createHitboxOverlay(scene, () => live.others)
  }
  onStage(null)
  if (!scripted) input.start()
  // __THREE: the tools that stage shots in the page (tools/trailer) build vectors and quaternions with the game's own three.js
  if (DEBUG_HOOKS) Object.assign(window, { __match: match, __THREE: THREE })

  /**
   * Join a room, or fall back to bots.
   *
   * The client talks to the origin it was served from: in production that is the Worker, in
   * development Vite proxies `/ws` to `wrangler dev`. `?server=` points a dev client at a
   * deployed Worker instead.
   */
  async function connectToMatch(room: string): Promise<Connection | null> {
    const params = new URLSearchParams(location.search)
    const base = params.get('server') ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
    const url = `${base}${base.includes('?') ? '&' : '?'}room=${encodeURIComponent(room)}&map=${selectedMap}&mode=${choice.mode ?? 'slayer'}${choice.playlist ? `&playlist=${choice.playlist}` : ''}`
    try {
      const { Connection } = await import('./net/connection.ts')
      const net = await Connection.connect(url)
      // Survives a deploy: rejoins on its own, and takes a new build once the match is over.
      const { watchSession } = await import('./net/session-watch.ts')
      watchSession(net, () => !!match?.objectives.over)
      return net
    } catch (error) {
      console.warn('Playing offline against bots:', error instanceof Error ? error.message : error)
      return null
    }
  }

}

/** A 2D copy of the WebGL canvas, made in the frame it was drawn. */
function copyFrame(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const still = document.createElement('canvas')
  still.width = source.width; still.height = source.height
  const context = still.getContext('2d')
  if (!context) return null
  context.drawImage(source, 0, 0)
  return still
}
