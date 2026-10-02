import { MAP_NAMES, levelUrl, mapFromUrl, type MapId } from '../../shared/maps.ts'
import { NET } from '../../shared/constants.ts'
import { GAME_MODES, modeId, type GameModeId } from '../../shared/game-modes.ts'
import { OFFERED_MODES, playlistId, type MatchTicket, type MatchmakingStats, type PlaylistId } from '../../shared/playlists.ts'
import { sanitiseName, MAX_NAME } from '../../shared/protocol.ts'

/**
 * The screen before the match: who you are, and which game you are joining.
 *
 * It exists because the choice has to be made before anything else happens — the room decides
 * which Durable Object the socket goes to, and whether there is a socket at all. The rest of
 * the client is built around the answer, so this resolves first and everything downstream just
 * reads it.
 *
 * The player count comes from the Worker's room endpoint rather than from a connection, so the
 * menu can say a room is full before anyone tries to join it.
 */

const NAME_KEY = 'halo-ce.name'
const ROOM_KEY = 'halo-ce.room'
const MODE_KEY = 'halo-ce.mode'
const DEFAULT_ROOM = 'gulch'
/** This tab, for the matchmaker's count of people looking at the menu. Not stored: a new tab is a new viewer. */
const VIEWER = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(36).padStart(2, '0')).join('')
/** How long a search shows "Searching" at the least, so a found match reads as found. */
const SEARCH_BEAT_MS = 1400
/** The last matchmade game this tab joined, kept so the next search does not send it straight back there. */
const LAST_MATCH_KEY = 'halo-ce.last-match', AVOID_MS = 3 * 60 * 1000
/** The home screen's map tour: how long each map is shown, and the fade through black between them. */
const TOUR_DWELL_MS = 16000, TOUR_FADE_MS = 650, TOUR_DISSOLVE_MS = 1400
/** Long enough not to fire on every keystroke, short enough to feel live. */
const PROBE_DEBOUNCE_MS = 350
const PROBE_INTERVAL_MS = 4000

export interface MatchChoice {
  map?: MapId
  /** The game type. Part of which room you join: a CTF match and a Slayer match never share one. */
  mode?: GameModeId
  name: string
  /** The room to join, or null to play offline against bots. */
  room: string | null
  /** The matchmaking playlist the room belongs to; unset for a custom game. */
  playlist?: PlaylistId
  /** Fade out the menu only after the complete match preparation gate. */
  cleanup?: () => void
}

function readStore(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    // Private browsing can refuse storage outright; a forgotten name is not worth an error.
    return ''
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch { /* nothing to do, and nothing worth telling the player about */ }
}

/** The name to play under when nobody is asked: a URL override, then last time's choice. */
export function storedName(): string {
  const fromUrl = new URLSearchParams(location.search).get('name')
  return sanitiseName(fromUrl || readStore(NAME_KEY))
}

export function saveName(name: string): void {
  if (name) writeStore(NAME_KEY, name)
}

/** A link's `?mode=` wins, then the last game type played. */
export function storedMode(): GameModeId {
  return modeId(new URLSearchParams(location.search).get('mode') || readStore(MODE_KEY))
}

/**
 * Room names reach the Worker as a path segment and name a Durable Object, so they are held to
 * the same shape the Worker enforces rather than being sent and rejected.
 */
export function sanitiseRoom(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}

/**
 * Show the menu and resolve once the player has picked a match. Never rejects: every path out
 * of here is a game, and an unreachable server becomes a bot match rather than an error.
 */
export interface MenuController {
  choice: Promise<MatchChoice>
  ready: (beforeStart: () => Promise<void>) => void
  fail: () => void
  loading: () => void
  readonly selectedMap: MapId
  onSelect: (listener: (map: MapId) => void) => void
  /** From the game: load a map behind the visible one, and take a still of the current frame (for the tour's crossfade). */
  attachScenery: (scenery: Scenery) => void
}

export interface Scenery {
  prefetch(map: MapId): Promise<boolean>
  still(): Promise<HTMLCanvasElement | null>
}

export function createMenu(selectedMap: MapId, onStage: (stage: string | null) => void): MenuController {
  let ready!: MenuController['ready']
  let fail!: MenuController['fail']
  let loading!: MenuController['loading']
  const listeners = new Set<(map: MapId) => void>()
  let scenery: Scenery | null = null
  const choice = new Promise<MatchChoice>((resolve) => {
    const params = new URLSearchParams(location.search)
    const root = document.querySelector<HTMLElement>('#menu-shell')!
    root.querySelector('#menu-capacity')!.textContent = String(NET.maxPlayers)

    const nameField = root.querySelector<HTMLInputElement>('#menu-name')!
    const roomField = root.querySelector<HTMLInputElement>('#menu-room')!
    const count = root.querySelector<HTMLElement>('#menu-count')!
    const online = root.querySelector<HTMLButtonElement>('#menu-online')!
    const bots = root.querySelector<HTMLButtonElement>('#menu-bots')!
    const customToggle = root.querySelector<HTMLButtonElement>('#menu-custom-toggle')!
    const customPanel = root.querySelector<HTMLElement>('#menu-custom')!
    const matchmakingPanel = root.querySelector<HTMLElement>('#menu-matchmaking')!
    const onlineText = root.querySelector<HTMLElement>('.mm-online-text')!
    const search = root.querySelector<HTMLElement>('#menu-search')!
    const notes = [root.querySelector<HTMLElement>('#menu-note')!, root.querySelector<HTMLElement>('.custom-note')!]
    const cleanupMascot = installMenuMascot(root)
    nameField.maxLength = MAX_NAME
    let assetsReady = false
    let starting = false
    let committed = false
    let selectionVersion = 0
    let roomAvailable = false
    let beforeStart: (() => Promise<void>) | undefined
    /** A custom game is the old way in: a map, a game type and a room name. A link with a room opens it. */
    let custom = params.has('room')
    /**
     * Arriving from a finished game (hud.ts postgame): `next=match` searches again at once, `next=bots` starts a
     * bot match on this map. No click came with the arrival, so the start does not wait on the audio unlock,
     * which the click into the game then gives.
     */
    let arriving: 'match' | 'bots' | null = params.get('next') === 'match' ? 'match' : params.get('next') === 'bots' ? 'bots' : null
    if (arriving) {
      custom = false
      const url = new URL(location.href); url.searchParams.delete('next'); history.replaceState(null, '', url)
    }
    /** The seat the matchmaker gave us, waiting for its map to load. */
    let ticket: MatchTicket | null = null
    let searching = false
    let searchVersion = 0
    let stats: MatchmakingStats | null = null

    const mapField=root.querySelector<HTMLSelectElement>('#menu-map')!
    mapField.value=selectedMap
    const modeField=root.querySelector<HTMLSelectElement>('#menu-mode')!
    // Only the game types offered for now; a stored or linked CTF falls back to Slayer.
    let selectedMode: GameModeId = (OFFERED_MODES as readonly string[]).includes(storedMode()) ? storedMode() : 'slayer'
    modeField.value=selectedMode
    const fields = [nameField, roomField, mapField, modeField]
    const setFieldsDisabled = (disabled: boolean) => {
      for (const field of fields) field.disabled = disabled
      customToggle.disabled = disabled
    }

    const refreshButtons = () => {
      if (custom) {
        online.disabled = !assetsReady || starting || !roomAvailable
      } else {
        // While searching the primary button cancels; once the match is starting there is no way back.
        online.disabled = starting
        if (!starting) online.textContent = searching ? 'Cancel' : 'Find match'
      }
      bots.disabled = !assetsReady || starting || searching
    }
    const heading = () => {
      root.querySelector('h1')!.textContent = custom ? MAP_NAMES[selectedMap] : 'Matchmaking'
    }
    const showMode = () => {
      matchmakingPanel.hidden = custom
      customPanel.hidden = !custom
      customToggle.textContent = custom ? 'Matchmaking' : 'Custom game'
      notes[0].hidden = custom; notes[1].hidden = !custom
      if (!custom) online.textContent = searching ? 'Cancel' : 'Find match'
      heading()
      refreshButtons()
      if (custom) void probe()
    }

    const pollStats = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/matchmaking?viewer=${VIEWER}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        stats = await response.json() as MatchmakingStats
        const playing = Object.values(stats.playlists).reduce((sum, n) => sum + n, 0)
        onlineText.textContent = `${stats.online.toLocaleString()} ${stats.online === 1 ? 'gamer' : 'gamers'} online${playing ? ` · ${playing} in matches` : ''}`
        root.classList.remove('mm-offline')
      } catch {
        stats = null
        onlineText.textContent = 'Matchmaking unavailable'
        root.classList.add('mm-offline')
      }
    }

    const showSearch = (lines: string[] | null, busy = false) => {
      search.hidden = !lines
      search.classList.toggle('searching', busy)
      search.replaceChildren(...(lines ?? []).map((text, i) => {
        const line = document.createElement('div')
        line.className = i === 0 ? 'mm-search-head' : 'mm-search-line'
        line.textContent = text
        return line
      }))
    }

    const cancelSearch = (message: string | null = null) => {
      searching = false; ticket = null; searchVersion++
      setFieldsDisabled(false)
      showSearch(message ? [message] : null)
      refreshButtons()
    }

    /** Ask the matchmaker for a seat, then load its map; the match starts once the map is ready. */
    const findMatch = async (): Promise<void> => {
      if (searching || starting) return
      tour.lift()
      const version = ++searchVersion
      searching = true
      setFieldsDisabled(true)
      nameField.disabled = false
      refreshButtons()
      showSearch(['Searching for match', 'Slayer or free for all, wherever there is a game'], true)
      // Audio may only be unlocked inside the click, and the match can start seconds after it.
      void beforeStart?.().catch(() => {})
      const began = performance.now()
      let found: MatchTicket
      try {
        // No playlist: the busiest open match of any kind, or a new one (matchmaker findAny).
        // Not back into the match just left: after a game the next one is somewhere new.
        let avoid = ''
        try { const last = JSON.parse(sessionStorage.getItem(LAST_MATCH_KEY) ?? 'null'); if (last && Date.now() - last.at < AVOID_MS) avoid = last.room } catch { /* none */ }
        const response = await fetch(`/api/matchmake?viewer=${VIEWER}${avoid ? `&avoid=${encodeURIComponent(avoid)}` : ''}`, { method: 'POST', cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        found = await response.json() as MatchTicket
      } catch {
        if (version === searchVersion) cancelSearch('Matchmaking is unavailable. Try again, or play against bots.')
        return
      }
      // An instant answer reads as nothing happening; give the search a beat.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, SEARCH_BEAT_MS - (performance.now() - began))))
      if (version !== searchVersion) return
      ticket = found
      selectedMode = found.mode
      showSearch(['Match found', `${GAME_MODES[found.mode].name} on ${MAP_NAMES[found.map]}`, 'Loading the map…'])
      if (found.map !== selectedMap) select(found.map, false)
      else startTicket()
    }

    const startTicket = () => {
      if (!ticket || !assetsReady || starting || ticket.map !== selectedMap) return
      const seat = ticket
      ticket = null; searching = false
      void finish(seat.room, seat.playlist)
    }

    ready = (prepare) => {
      beforeStart = prepare; assetsReady = true; refreshButtons(); startTicket(); tour.shown()
      const next = arriving; arriving = null
      if (next === 'match') void findMatch()
      else if (next === 'bots') void finish(null)
    }
    fail = () => {
      assetsReady = false
      starting = false
      if (searching) cancelSearch('The map could not load. Try again.')
      root.classList.remove('starting')
      root.removeAttribute('aria-busy')
      setFieldsDisabled(false)
      refreshButtons()
    }
    refreshButtons()

    modeField.addEventListener('change',()=>{
      selectedMode=modeId(modeField.value)
      writeStore(MODE_KEY,selectedMode)
      const url=new URL(location.href)
      if(selectedMode==='slayer')url.searchParams.delete('mode');else url.searchParams.set('mode',selectedMode)
      history.replaceState(null,'',url)
      schedule()
    })
    loading = () => {
      assetsReady = false; beforeStart = undefined; starting = false
      root.classList.remove('starting'); root.removeAttribute('aria-busy')
      if (!searching) setFieldsDisabled(false)
      refreshButtons()
    }
    const select = (map: MapId, push: boolean) => {
      if (committed) { location.reload(); return }
      saveName(nameField.value)
      if (push) {
        const url = levelUrl(map, new URL(location.href))
        url.searchParams.set('room', sanitiseRoom(roomField.value) || DEFAULT_ROOM)
        history.pushState(null, '', url)
      }
      selectedMap = map; selectionVersion++
      mapField.value = map
      heading()
      document.title = `${MAP_NAMES[map]} · Halo`
      loading()
      for (const listener of listeners) listener(map)
      if (custom) void probe()
    }
    mapField.addEventListener('change', () => select(mapField.value as MapId, true))
    addEventListener('popstate', () => {
      // A live match owns sockets, physics and input. Leaving it retains the existing document
      // reset boundary; browsing level menus stays within the persistent renderer.
      if (committed) { location.reload(); return }
      const url = new URL(location.href)
      const map = mapFromUrl(url)
      if (!map && !['/', '/index.html'].includes(url.pathname)) { location.replace('/'); return }
      select(map ?? 'blood-gulch', false)
    })
    customToggle.addEventListener('click', () => {
      if (searching || starting) return
      custom = !custom
      showMode()
    })
    nameField.value = storedName()
    roomField.value = sanitiseRoom(params.get('room') || readStore(ROOM_KEY) || DEFAULT_ROOM)

    let probeTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let probing = ''

    /** Ask the Worker how busy a room is. Failure means no server, which is worth saying. */
    const probe = async (): Promise<void> => {
      if (!custom) return
      const room = sanitiseRoom(roomField.value) || DEFAULT_ROOM
      const key = `${selectedMap}:${selectedMode}:${room}`
      probing = key
      try {
        const response = await fetch(`/api/room/${room}?map=${selectedMap}&mode=${selectedMode}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        const body = await response.json() as { population: number; maxPlayers: number }
        if (probing !== key || !custom) return
        const full = body.population >= body.maxPlayers
        count.textContent = full
          ? `${room} is full (${body.population}/${body.maxPlayers})`
          : `${body.population}/${body.maxPlayers} playing in ${room}`
        roomAvailable = !full
        refreshButtons()
        online.textContent = full ? 'Match full' : body.population > 0 ? `Join ${body.population} online` : 'Play online'
      } catch {
        if (probing !== key || !custom) return
        count.textContent = 'no match server reachable'
        roomAvailable = false
        refreshButtons()
        online.textContent = 'Play online'
      }
    }

    const schedule = (): void => {
      if (probeTimer) clearTimeout(probeTimer)
      count.textContent = 'checking…'
      probeTimer = setTimeout(() => void probe(), PROBE_DEBOUNCE_MS)
    }
    roomField.addEventListener('input', schedule)
    showMode()

    /**
     * The home screen tours the maps. While a map is on show the next one loads behind it, and when it is time
     * the current frame is held as a still over the scene, the scene switches underneath, and the still
     * dissolves away: one flyover melts into the next. Where a second map cannot be held in memory, or the game
     * has not offered a way to, it fades through black instead and loads in the dark. Not at all on a
     * data-saving or slow connection, where one map's download is enough.
     */
    const tour = (() => {
      const veil = document.createElement('div')
      veil.className = 'menu-veil'
      document.body.append(veil)
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
      const frugal = !!connection?.saveData || ['slow-2g', '2g', '3g'].includes(connection?.effectiveType ?? '')
      const order = (Object.keys(MAP_NAMES) as MapId[]).sort(() => Math.random() - 0.5)
      let timer: ReturnType<typeof setTimeout> | null = null, fallback: ReturnType<typeof setTimeout> | null = null, stopped = false
      let still: HTMLCanvasElement | null = null
      const lift = () => { veil.classList.remove('on'); if (fallback) clearTimeout(fallback); fallback = null }
      const idle = () => !committed && !starting && !searching && !custom && !arriving && !document.hidden && assetsReady
      const after = (map: MapId) => order[(order.indexOf(map) + 1) % order.length]
      /** Hold this frame over the scene, then let it go once the new map is drawing beneath it. */
      const dissolve = (frame: HTMLCanvasElement) => {
        still?.remove()
        still = frame
        frame.className = 'menu-still'
        document.body.append(frame)
        setTimeout(() => { frame.classList.add('gone'); setTimeout(() => frame.remove(), TOUR_DISSOLVE_MS + 100) }, 150)
      }
      const schedule = () => {
        if (timer) clearTimeout(timer)
        if (frugal || stopped) return
        const next = after(selectedMap)
        // Load the next map now, behind this one, so the change itself is instant.
        const loaded = scenery ? scenery.prefetch(next).catch(() => false) : Promise.resolve(false)
        timer = setTimeout(async () => {
          if (!idle()) { schedule(); return }
          if (await loaded && scenery && idle()) {
            const frame = await scenery.still()
            if (!idle()) { schedule(); return }
            if (frame) dissolve(frame)
            select(next, false)
            return
          }
          if (!idle()) { schedule(); return }
          veil.classList.add('on')
          setTimeout(() => {
            if (!idle()) { lift(); schedule(); return }
            select(next, false)
            // A slow load must not leave the menu over black.
            fallback = setTimeout(lift, 9000)
          }, TOUR_FADE_MS)
        }, TOUR_DWELL_MS)
      }
      return {
        /** The current map is ready: let it be seen, then move on in a while. */
        shown() { setTimeout(lift, 250); schedule() },
        stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; lift(); veil.remove(); still?.remove() },
        lift,
      }
    })()
    void pollStats()
    pollTimer = setInterval(() => { void pollStats(); void probe() }, PROBE_INTERVAL_MS)

    const finish = async (room: string | null, matchPlaylist: PlaylistId | null = null): Promise<void> => {
      if (starting || !assetsReady) return
      const version = selectionVersion
      starting = true
      online.disabled = true
      bots.disabled = true
      onStage('Preparing audio…')
      setFieldsDisabled(true)
      root.classList.add('starting')
      root.setAttribute('aria-busy', 'true')
      // Audio can only start after a click on this page; arriving from the last game there has not been one yet.
      const unclicked = !navigator.userActivation?.hasBeenActive
      try { await (unclicked ? Promise.race([beforeStart?.()?.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]) : beforeStart?.()) }
      catch {
        if (version !== selectionVersion) return
        starting = false
        root.classList.remove('starting')
        root.removeAttribute('aria-busy')
        setFieldsDisabled(false)
        showSearch(null)
        refreshButtons()
        onStage('Could not prepare audio. Try Play again.')
        online.textContent = custom ? 'Play online' : 'Find match'
        bots.textContent = 'Play against bots'
        void probe()
        return
      }
      if (version !== selectionVersion) return
      committed = true
      const name = sanitiseName(nameField.value)
      saveName(name)
      if (room && !matchPlaylist) writeStore(ROOM_KEY, room)
      if (room && matchPlaylist) {
        // Stamped when the page leaves the match, so "just left" means just left, however long the game ran.
        const remember = () => { try { sessionStorage.setItem(LAST_MATCH_KEY, JSON.stringify({ room, at: Date.now() })) } catch { /* private mode */ } }
        remember(); addEventListener('pagehide', remember)
      }
      if (probeTimer) clearTimeout(probeTimer)
      if (pollTimer) clearInterval(pollTimer)
      writeStore(MODE_KEY, selectedMode)
      tour.stop()
      resolve({ name, room, map: selectedMap, mode: selectedMode, playlist: matchPlaylist ?? undefined, cleanup: () => {
        cleanupMascot()
        // Loading status has a page lifetime, independent of the menu transition.
        const status = root.querySelector<HTMLElement>('.level-loading')
        root.inert = true
        root.classList.add('leaving')
        setTimeout(() => {
          // Preserve the status row until the fade ends so the logo never shifts during exit.
          if (status) document.body.append(status)
          root.remove()
        }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280)
        document.querySelector('.menu-backdrop')?.remove()
      } })
    }

    online.addEventListener('click', () => {
      if (online.disabled) return
      if (!custom) { if (searching) cancelSearch(); else void findMatch(); return }
      // A link into a matchmade room keeps its playlist, so the room accepts it.
      const room = sanitiseRoom(roomField.value) || DEFAULT_ROOM
      const linked = room === params.get('room') ? playlistId(params.get('playlist')) : null
      void finish(room, linked)
    })
    bots.addEventListener('click', () => { if (!bots.disabled) void finish(null) })
    for (const field of [nameField, roomField]) {
      field.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        if (!online.disabled) online.click()
        else bots.click()
      })
    }
    // A name is the first thing to fill in, but not on a phone: the keyboard would cover the menu.
    if (!matchMedia('(pointer: coarse)').matches) nameField.focus()
  })
  return { choice, ready, fail, loading, get selectedMap() { return selectedMap }, onSelect: listener => { listeners.add(listener) }, attachScenery: s => { scenery = s } }
}

export function installMenuMascot(root: HTMLElement): () => void {
const mascot = root.querySelector<HTMLElement>('.menu-mascot')!
const mascotHead = root.querySelector<HTMLElement>('.mascot-head-hit')!
const hangImage = root.querySelector<HTMLImageElement>('.mascot-hang')!
const waveImage = root.querySelector<HTMLImageElement>('.mascot-wave')!

const setMascotWaving = (waving: boolean): void => { mascot.classList.toggle('is-waving', waving) }
mascotHead.addEventListener('focus', () => setMascotWaving(true))
mascotHead.addEventListener('blur', () => setMascotWaving(false))

type AlphaMask = { width: number; height: number; data: Uint8ClampedArray }
const alphaMasks = new WeakMap<HTMLImageElement, AlphaMask>()
const prepareAlphaMask = (image: HTMLImageElement): void => {
  if (!image.naturalWidth || !image.naturalHeight) return
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) return
  context.drawImage(image, 0, 0)
  alphaMasks.set(image, {
    width: canvas.width,
    height: canvas.height,
    data: context.getImageData(0, 0, canvas.width, canvas.height).data,
  })
}
for (const image of [hangImage, waveImage]) {
  if (image.complete) prepareAlphaMask(image)
  else image.addEventListener('load', () => prepareAlphaMask(image), { once: true })
}
const isVisibleAt = (image: HTMLImageElement, x: number, y: number): boolean => {
  const mask = alphaMasks.get(image)
  if (!mask) return false
  const bounds = image.getBoundingClientRect()
  if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return false
  const pixelX = Math.min(mask.width - 1, Math.floor((x - bounds.left) / bounds.width * mask.width))
  const pixelY = Math.min(mask.height - 1, Math.floor((y - bounds.top) / bounds.height * mask.height))
  return mask.data[(pixelY * mask.width + pixelX) * 4 + 3] > 24
}
const updateMascotHover = (event: PointerEvent): void => {
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
  const waving = mascot.classList.contains('is-waving')
  const visibleImage = waving ? waveImage : hangImage
  const overVisibleImage = isVisibleAt(visibleImage, event.clientX, event.clientY)
  setMascotWaving(overVisibleImage)
}
root.addEventListener('pointermove', updateMascotHover)

  return () => root.removeEventListener('pointermove', updateMascotHover)
}
