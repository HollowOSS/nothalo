import { assetUrl } from '../../shared/runtime-config.ts'
import { WEAPON_SOUNDS, WEAPON_RELOAD_CUES } from './weapon-audio.ts'
import { getSharedAudioContext, onAudioActivation, resumeAudio } from './audio-activation.ts'
import { collisionSamples, collisionLevel, type CollisionVehicleKind } from './vehicle-collision-audio.ts'
import { VehicleAudio, type VehicleSoundState } from './vehicle-audio.ts'
import { GRENADE_SOUNDS } from './grenade-audio-catalog.ts'
import { FOLEY_SOUNDS } from './foley-audio-catalog.ts'
import { VEHICLE_SOUNDS } from './vehicle-audio-catalog.ts'
import { AmbienceAudio } from './ambience-audio.ts'
import type { Object3D } from 'three'
import type { MapId } from '../../shared/maps.ts'
/** Recorded, cached combat audio. Reloads follow gameplay time, never wall-clock timers. */
type SoundEntry = { files: readonly string[]; gain: number; variation?: number }
type Voice = { source: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode; volume: number; group: string; stopped: boolean }
type PendingSound = { name: string; volume: number; pan: number; group: string; rate: number; queuedAt: number }
const files = (prefix: string, count: number) => Array.from({length: count}, (_, i) => `${prefix}-${i + 1}.mp3`)
const SOUNDS: Record<string, SoundEntry> = {
  warthog: {files: files('turret', 2), gain: .92, variation: .012},
  'reload-cloth': {files: ['cloth.mp3'], gain: .60},
  'reload-release': {files: ['release.mp3'], gain: .80},
  'reload-out': {files: ['mag-out.mp3'], gain: .75},
  'reload-in': {files: ['mag-in.mp3'], gain: 1},
  'reload-bolt': {files: ['bolt.mp3'], gain: .9},
  'reload-latch': {files: ['latch.mp3'], gain: .90},
  'reload-tube': {files: ['tube.mp3'], gain: .86},
  reload: {files: ['release.mp3'], gain: .7},
  step: {files: files('step', 3), gain: .65, variation: .055},
  grenade: {files: ['release.mp3'], gain: .7},
  explosion: {files: ['explosion.mp3'], gain: 1.1},
  wilhelm: {files: ['../wilhelm.mp3'], gain: 1},
  // Halo 3's own shield cues, cut from gameplay capture: one chirp of the low-shield alarm
  // (Match repeats it) and the rising hum as the shield starts refilling.
  'shield-low': {files: ['shield-low.mp3'], gain: .55},
  'shield-charging': {files: ['shield-charging.mp3'], gain: 1.3},
  ...WEAPON_SOUNDS,
  ...GRENADE_SOUNDS,
  ...FOLEY_SOUNDS,
  // Halo 3's Ghost and Banshee: guns, fuel rod, engine loops, boost and contrail.
  ...VEHICLE_SOUNDS,
  melee: WEAPON_SOUNDS['melee:assault-rifle'],
  rocket: WEAPON_SOUNDS['rocket-launcher'],
}
/** Normalized contacts from the authored reload clips, kept in one reviewable table. */
export const RELOAD_CUES = WEAPON_RELOAD_CUES
/** Synthesized, non-recorded tones need their own mix level; anything absent here plays quiet. */
/** What the footstep and vocal routes are chosen from (foley-audio-catalog.ts); the surface under a player. */
export type Surface = 'ground' | 'sand' | 'metal' | 'stone' | 'wood' | 'water'
export type Vocal = 'hurt' | 'hurt-heavy' | 'shield-break' | 'death'
/** One started sound, for debug hooks and browser checks: which route and which recording actually played. */
export type PlayedSound = { name: string; file: string; volume: number; pan: number; at: number }
const TONE_LEVELS: Record<string, number> = {'warthog-horn': .9, 'shield-break': .78, 'shield-recharge': .52, 'contact-force': .72}

// Decode the sounds needed to make the first seconds of a match readable before loading the
// larger reload and rare-weapon library in the background. This matters on phones, where a
// fresh WebKit tab can fetch the files quickly but decode them one at a time.
const FIRST_LOAD_NAMES = new Set([
  ...Object.keys(GRENADE_SOUNDS),
  'plasma-pistol:charge-start','plasma-pistol:charge-loop','plasma-pistol:charged','plasma-pistol:charged-hit','plasma-pistol:vent',
  'smg','plasma-pistol','plasma-rifle', 'assault-rifle', 'battle-rifle', 'magnum', 'sniper', 'shotgun', 'rocket-launcher', 'needler',
  'warthog', 'body-hit', 'shield-hit', 'melee:assault-rifle', 'melee:battle-rifle',
  'explosion', 'grenade', 'step', 'shield-low', 'shield-charging', 'rocket', 'ghost', 'shotgun-pump', 'supercombine',
])

export class CombatAudio {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private loading: Promise<void> | null = null
  private criticalLoading: Promise<void> | null = null
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly encoded = new Map<string, Promise<ArrayBuffer | null>>()
  private readonly recordingFiles: readonly string[]
  private readonly voices: Voice[] = []
  private readonly pending: PendingSound[] = []
  private readonly lastVariant = new Map<string, number>()
  private reload: {weapon: string; elapsed: number; duration: number; volume: number; empty: boolean} | null = null
  private lastScream = -Infinity
  private silent = false
  private focused = true
  private vehicleAudio: VehicleAudio | null = null
  private ambienceAudio: AmbienceAudio | null = null
  private ambienceMap: MapId | null = null
  private ambienceRoot: Object3D | null = null
  private readonly collisionTimes = new Map<string | number, number>()
  soundsPlayed = 0
  /** The last few sounds started, newest last. Cheap enough to keep always; read by debug hooks only. */
  readonly recent: PlayedSound[] = []
  private label = ''

  constructor() {
    this.recordingFiles = [...new Set(Object.values(SOUNDS).flatMap(entry => [...entry.files]))]
    // Fetch the first-load group during the loading screen. Decode still waits for the
    // browser's user-gesture policy and therefore starts in unlock().
    this.fetchRecordings(this.firstLoadFiles())
    const unlock = () => { void this.unlock().catch(error => console.warn('Audio unlock failed', error)) }
    onAudioActivation(unlock)
    addEventListener('keydown', event => {
      if (event.code === 'KeyM' && !event.repeat) this.muted = !this.muted
    })
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stopAll(); this.syncAmbience() })
    addEventListener('blur', () => { this.focused = false; this.stopAll() })
    addEventListener('focus', () => { this.focused = true; this.syncAmbience() })
  }

  async unlock(): Promise<void> {
    if (this.context) {
      await resumeAudio(this.context)
      this.syncAmbience()
      return
    }
    const context = this.context = getSharedAudioContext()
    const master = this.master = context.createGain()
    master.gain.value = this.silent ? 0 : .5
    const limiter = context.createDynamicsCompressor()
    // Leave ordinary original recordings linear; limit only near-full-scale overlap peaks.
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20
    limiter.attack.value = .003; limiter.release.value = .08
    master.connect(limiter); limiter.connect(context.destination)
    this.vehicleAudio = new VehicleAudio(context, master, name => {
      const entry = SOUNDS[name], buffer = entry && this.buffers.get(entry.files[0])
      return buffer ? { buffer, gain: entry.gain } : undefined
    })
    this.ambienceAudio = new AmbienceAudio(context, master)
    // iOS interruptions (calls, lock screen) suspend the context without a page event.
    context.addEventListener('statechange', () => this.syncAmbience())
    this.addInterfaceTones(context)
    this.addWarthogHorn(context)
    this.addContactForce(context)
    this.addShieldTones(context)
    this.criticalLoading = this.decodeRecordings(context, this.firstLoadFiles()).then(() => this.flushPending())
    this.loading = this.criticalLoading.then(async () => {
      const deferred = this.recordingFiles.filter(file => !this.firstLoadFiles().includes(file))
      this.fetchRecordings(deferred)
      await this.decodeRecordings(context, deferred)
      this.flushPending()
      this.encoded.clear()
    })
    await context.resume()
    this.syncAmbience()
    // Unlock on the Play gesture, but a slow recording download must never block entering a
    // match. The pending-sound queue already drops stale cues and starts ready ones safely.
  }

  get audioReady(): boolean { return this.context?.state === 'running' }
  get screamReady(): boolean { return this.buffers.has('../wilhelm.mp3') }
  get samplesReady(): boolean { return Object.values(WEAPON_SOUNDS).every(entry => entry.files.every(file => this.buffers.has(file))) }
  get activeVoices(): number { return this.voices.length }
  get muted(): boolean { return this.silent }
  set muted(value: boolean) {
    this.silent = value
    if (value) this.stopAll()
    if (this.master && this.context) this.master.gain.setTargetAtTime(value ? 0 : .5, this.context.currentTime, .01)
    this.syncAmbience()
  }

  collision(kind: CollisionVehicleKind, impactSpeed: number, distance = 0, pan = 0, id?: string | number): void {
    const context=this.context
    if (!context || !this.master || !this.audioReady || this.silent || document.hidden || !this.focused) return
    const volume=collisionLevel(impactSpeed,distance)
    if(volume<.015)return
    const now=context.currentTime
    if(id!==undefined) {
      if(now-(this.collisionTimes.get(id)??-Infinity)<.22)return
      for(const [key,time] of this.collisionTimes)if(now-time>3)this.collisionTimes.delete(key)
      if(this.collisionTimes.size>=64)this.collisionTimes.delete(this.collisionTimes.keys().next().value!)
      this.collisionTimes.set(id,now)
    }
    const key=`vehicle-collision:${kind}`
    let buffer=this.buffers.get(key)
    if(!buffer) {
      const data=collisionSamples(kind,context.sampleRate)
      buffer=context.createBuffer(1,data.length,context.sampleRate)
      buffer.getChannelData(0).set(data)
      this.buffers.set(key,buffer)
    }
    const impacts=this.voices.filter(voice=>voice.group==='vehicle-collision')
    if(impacts.length>=6) {
      const quietest=impacts.reduce((a,b)=>a.volume<b.volume?a:b)
      if(quietest.volume>volume)return
      this.stopVoice(quietest,true)
    }
    this.label=`${key}|synth`
    this.play(buffer,volume,pan,'vehicle-collision',1.08-Math.min(impactSpeed,30)*.006)
  }

  /**
   * The map whose ambient bed should play (null to fade it out). Safe before unlock: the bed
   * starts once audio is running. `root` is the map's scenery, searched once for water.
   */
  ambience(map: MapId | null, root?: Object3D | null): void {
    this.ambienceMap = map; this.ambienceRoot = root ?? null
    this.syncAmbience()
  }
  /** Listener position for position-dependent layers (Valhalla's river); cheap per frame. */
  listen(x: number, z: number): void { this.ambienceAudio?.listen(x, z) }
  get ambiencePlaying(): MapId | null { return this.ambienceAudio?.playing ?? null }
  /** Beds stop outright while muted, hidden, unfocused or suspended, and fade back in after. */
  private syncAmbience(): void {
    const on = this.context?.state === 'running' && !this.silent && !document.hidden && this.focused
    // Leaving a map fades out slowly; losing focus or muting cuts in a quarter second.
    if (on) this.ambienceAudio?.play(this.ambienceMap, this.ambienceRoot)
    else if (this.ambienceAudio?.playing) this.ambienceAudio.stop()
  }

  get activeVehicleLoops(): number { return this.vehicleAudio?.active ?? 0 }
  vehicles(states: readonly VehicleSoundState[]): void {
    if (this.silent || document.hidden || !this.focused || !this.audioReady) { this.vehicleAudio?.stop(); return }
    this.vehicleAudio?.update(states)
  }

  offhandReload(weapon:string|null,empty=false):void {
    for(const voice of [...this.voices])if(voice.group==='left-reload')this.stopVoice(voice)
    if(!weapon)return
    const key=empty&&SOUNDS[`${weapon}:reload-empty`]?`${weapon}:reload-empty`:`${weapon}:reload`
    this.playSound(key,.55,-.25,'left-reload',1)
  }
  charge(hand:'right'|'left',on:boolean):void {
    const group=`charge:${hand}`,voices=this.voices.filter(v=>v.group===group)
    if(!on){for(const v of voices)this.stopVoice(v);return}
    if(voices.length)return
    const entry=SOUNDS['plasma-pistol:charge-loop'],buffer=this.buffers.get(entry.files[0])
    if(!buffer||!this.audioReady||this.silent||document.hidden||!this.focused)return
    this.playSound('plasma-pistol:charge-start',.65,hand==='left'?-.25:.25,group,1)
    this.play(buffer,entry.gain,hand==='left'?-.25:.25,group,1)
    const voice=this.voices.at(-1);if(voice?.group===group)voice.source.loop=true
  }
  sound(name: string, volume = 1, pan = 0): void {
    this.playSound(name, volume, pan, '', 1)
    // Keep the authentic Halo 3 vest transient as the attack, then add a restrained
    // sub/low-mid thump to ordinary contacts. Sword and gravity-hammer recordings already
    // carry their own weight and are intentionally left untouched.
    const ordinaryContact = name === 'body-hit' || name === 'shield-hit' || name.startsWith('melee-impact:')
    const heavyWeapon = name === 'melee-impact:energy-sword' || name === 'melee-impact:gravity-hammer'
    if (ordinaryContact && !heavyWeapon) this.playSound('contact-force', volume * (name === 'shield-hit' ? .55 : .7), pan, '', 1)
    // CE shotgun_fire is the complete first-person handling timeline: its pump
    // already has the original delay. Start alongside the separate muzzle report.
    if (name === 'shotgun' && volume > 0) this.playSound('shotgun-pump', volume * .65, pan, '', 1)
  }
  startReload(weapon: string, duration: number, volume = .7, empty = false): void {
    this.cancelReload()
    if (!RELOAD_CUES[weapon] || duration <= 0 || !Number.isFinite(duration)) return
    this.reload = {weapon, duration, volume, empty, elapsed: -Number.EPSILON}
    // Complete recorded reloads begin with the animation, even before its first update.
    this.reloadProgress(weapon, 0, duration)
  }
  reloadProgress(weapon: string, elapsed: number, duration: number): void {
    if (elapsed < 0 || duration <= 0 || !Number.isFinite(elapsed) || !Number.isFinite(duration)) { this.cancelReload(); return }
    if (this.silent || document.hidden || !this.focused) { this.cancelReload(); return }
    if (!this.reload || this.reload.weapon !== weapon || elapsed < this.reload.elapsed) {
      // Late attachment, unmuting and looped shell poses never restart a full recording.
      this.cancelReload()
      this.reload = {weapon, duration, volume: .7, empty: false, elapsed}
      return
    }
    const state = this.reload
    if (!state) return
    state.duration = duration
    for (const cue of RELOAD_CUES[weapon] ?? []) {
      const time = cue.at * duration
      if (time > state.elapsed && time <= elapsed && elapsed - time < .14) {
        const emptySound = `${weapon}:reload-empty`
        const sound = state.empty && cue.sound === `${weapon}:reload` && SOUNDS[emptySound] ? emptySound : cue.sound
        this.playSound(sound, state.volume * cue.gain, 0, 'reload', cue.rate ?? 1)
      }
    }
    state.elapsed = elapsed
  }
  /** Animation completion keeps the original recording tail at its original pitch. */
  finishReload(): void { this.reload = null }
  cancelReload(): void {
    this.reload = null
    for (const voice of [...this.voices]) if (voice.group === 'reload') this.stopVoice(voice)
  }
  /**
   * A footfall or landing on `surface`. Steps never queue: a step that is not decoded yet falls back to
   * the generic foley step rather than arriving late. Steps share a small voice budget so a crowd of
   * distant runners cannot crowd out gunfire.
   */
  footstep(surface: Surface, kind: 'step' | 'land' | 'land-hard', volume: number, pan = 0): void {
    const name = kind === 'land-hard' ? 'land-hard' : `${kind === 'land' ? 'land' : 'footstep'}:${surface}`
    const ready = SOUNDS[name]?.files.every(file => this.buffers.has(file))
    const steps = this.voices.filter(voice => voice.group === 'footstep')
    if (steps.length >= 6) {
      const quietest = steps.reduce((a, b) => a.volume < b.volume ? a : b)
      if (quietest.volume > volume) return
      this.stopVoice(quietest, true)
    }
    // A touch of pitch and level spread on top of the take rotation, so a run never loops audibly.
    const rate = 1 + (Math.random() * 2 - 1) * .045, level = volume * (.88 + Math.random() * .24)
    if (ready) this.playSound(name, level, pan, 'footstep', rate)
    else if (kind !== 'land-hard' && this.buffers.has(SOUNDS.step.files[0])) this.playSound('step', level * .5, pan, 'footstep', rate)
  }
  /**
   * A Spartan's pain or death vocal. `speaker` keeps one voice per throat: a new vocal cuts that
   * speaker's previous one short instead of stacking grunts.
   */
  vocal(kind: Vocal, volume: number, pan = 0, speaker: string | number = 'you'): void {
    const name = `voice:${kind}`
    if (!SOUNDS[name]?.files.every(file => this.buffers.has(file))) return
    for (const voice of [...this.voices]) if (voice.group === `voice:${speaker}`) this.stopVoice(voice)
    this.playSound(name, volume, pan, `voice:${speaker}`, 1 + (Math.random() * 2 - 1) * .03)
  }
  /** True for a moment after the Wilhelm easter egg fires, so a death vocal does not talk over it. */
  get screamedJustNow(): boolean { return !!this.context && this.context.currentTime - this.lastScream < .5 }
  death(distance: number): void {
    if (!this.context || this.context.currentTime - this.lastScream < 8 || Math.random() > .3) return
    this.lastScream = this.context.currentTime
    this.sound('wilhelm', .8 / (1 + distance * .045))
  }

  private playSound(name: string, volume: number, pan: number, group: string, rate: number): void {
    const entry = SOUNDS[name]
    if (!entry) {
      const tone = this.buffers.get(name)
      // Interface tones are intentionally quiet; the horn and the shield cues are gameplay
      // events and need enough level to read over gunfire and the Warthog engine.
      const level = TONE_LEVELS[name] ?? .25
      this.label = `${name}|tone`
      if (tone) this.play(tone, volume * level, pan, group, 1)
      return
    }
    const last = this.lastVariant.get(name) ?? -1
    const next = entry.files.length < 2 ? 0 : (last + 1 + Math.floor(Math.random() * (entry.files.length - 1))) % entry.files.length
    this.lastVariant.set(name, next)
    const buffer = this.buffers.get(entry.files[next])
    this.label = `${name}|${entry.files[next]}`
    if (buffer) this.play(buffer, volume * entry.gain, pan, group, rate * (1 + (Math.random() * 2 - 1) * (entry.variation ?? 0)))
    else if (this.context && this.pending.length < 24) this.pending.push({ name, volume, pan, group, rate, queuedAt: performance.now() })
  }

  private firstLoadFiles(): string[] {
    return [...new Set([...FIRST_LOAD_NAMES].flatMap(name => SOUNDS[name]?.files ?? []))]
  }

  private fetchRecordings(files: readonly string[]): void {
    for (const file of files) {
      if (this.encoded.has(file)) continue
      this.encoded.set(file, fetch(assetUrl(`/assets/audio/combat/${file}`), { priority: 'low' }).then(response => {
        if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`)
        return response.arrayBuffer()
      }).catch(error => { console.warn('Combat recording unavailable', error); return null }))
    }
  }

  private async decodeRecordings(context: AudioContext, files: readonly string[]): Promise<void> {
    for (const file of files) {
      const bytes = await this.encoded.get(file)
      if (!bytes) continue
      try { this.buffers.set(file, await context.decodeAudioData(bytes)) }
      catch (error) { console.warn('Combat recording could not be decoded', file, error) }
    }
  }

  private flushPending(): void {
    const now = performance.now()
    for (const sound of this.pending.splice(0)) {
      if (now - sound.queuedAt < 1500) this.playSound(sound.name, sound.volume, sound.pan, sound.group, sound.rate)
    }
  }
  private play(buffer: AudioBuffer, volume: number, pan: number, group: string, rate: number): void {
    const context = this.context, master = this.master, label = this.label
    this.label = ''
    if (!context || !master || context.state !== 'running' || this.silent || document.hidden || !this.focused || volume < .015 || !Number.isFinite(volume)) return
    volume = Math.min(2, volume)
    // A busy multiplayer scene keeps loud nearby actions over quiet distant tails.
    if (this.voices.length >= 32) {
      let quietest = this.voices[0]
      for (const voice of this.voices) if (voice.volume < quietest.volume) quietest = voice
      if (quietest.volume > volume) return
      this.stopVoice(quietest, true)
    }
    const source = context.createBufferSource(), gain = context.createGain(), stereo = context.createStereoPanner()
    source.buffer = buffer; source.playbackRate.value = Math.max(.5, Math.min(2, rate))
    gain.gain.value = volume; stereo.pan.value = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0
    source.connect(gain); gain.connect(stereo); stereo.connect(master)
    const voice: Voice = {source, gain, pan: stereo, volume, group, stopped: false}
    this.voices.push(voice); this.soundsPlayed++
    const [name, file] = (label || 'unlabelled|').split('|')
    this.recent.push({ name, file, volume, pan, at: context.currentTime })
    if (this.recent.length > 64) this.recent.shift()
    source.onended = () => this.disconnectVoice(voice)
    source.start()
  }
  private stopVoice(voice: Voice, immediately = false): void {
    if (voice.stopped || !this.context) return
    voice.stopped = true
    const now = this.context.currentTime
    voice.gain.gain.cancelScheduledValues(now)
    voice.gain.gain.setTargetAtTime(0, now, .004)
    voice.source.stop(now + (immediately ? 0 : .015))
    // Remove now so cancel/voice stealing cannot schedule a second stop.
    const i = this.voices.indexOf(voice)
    if (i >= 0) this.voices.splice(i, 1)
  }
  private disconnectVoice(voice: Voice): void {
    voice.source.disconnect(); voice.gain.disconnect(); voice.pan.disconnect()
    const i = this.voices.indexOf(voice)
    if (i >= 0) this.voices.splice(i, 1)
  }
  private stopAll(): void {
    this.vehicleAudio?.stop()
    this.syncAmbience()
    this.collisionTimes.clear()
    this.reload = null
    for (const voice of [...this.voices]) this.stopVoice(voice)
  }
  private addInterfaceTones(context: AudioContext): void {
    // Only interface feedback remains tonal; weapons and handling use recordings.
    for (const name of ['zoom','hit','teleport']) {
      const duration = name === 'zoom' ? .065 : name === 'hit' ? .08 : .42
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i++) {
        const u = i / data.length, t = i / context.sampleRate
        // The teleporter is a rising sweep with a shimmer on it, the CE cue in outline.
        data[i] = name === 'teleport'
          ? (Math.sin(t * Math.PI * 2 * (180 + 1400 * u * u)) * .7 + Math.sin(t * Math.PI * 2 * 2600 * (1 + .3 * Math.sin(t * 60))) * .3) * Math.sin(Math.PI * u)
          : Math.sin(t * Math.PI * 2 * (name === 'zoom' ? 920 + 650 * u : 430 - 120 * u)) * Math.sin(Math.PI * u)
      }
      this.buffers.set(name, buffer)
    }
  }

  /**
   * A short, low two-tone Warthog horn. Keep it synthesized and cached so the horn does not
   * depend on a second network fetch or a separately licensed recording. It is deliberately
   * louder than interface tones and has a soft attack/release so repeated Space presses do not
   * click.
   */
  private addWarthogHorn(context: AudioContext): void {
    const duration = .68
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate)
    const data = buffer.getChannelData(0)
    const tau = Math.PI * 2
    for (let i = 0; i < data.length; i++) {
      const t = i / context.sampleRate
      const u = t / duration
      const attack = Math.min(1, t / .018)
      const release = Math.min(1, (duration - t) / .16)
      const envelope = attack * release
      // Two close fundamentals give the familiar vehicle-horn beat; harmonics add body on
      // phone speakers without making the sound harsh or metallic.
      const a = tau * 196 * t
      const b = tau * 247 * t
      const signal = .56 * Math.sin(a) + .48 * Math.sin(b) +
        .16 * Math.sin(a * 2) + .13 * Math.sin(b * 2) +
        .07 * Math.sin(a * 3) + .06 * Math.sin(b * 3)
      data[i] = Math.tanh(signal * 1.45) * envelope * .82
    }
    this.buffers.set('warthog-horn', buffer)
  }

  /**
   * Shield breaks and the fully-charged chime are authored transitions. A normal shield hit is
   * routed through the Halo 3 vest-contact recordings in the catalog so it has
   * the same low armored impact as player melee and body contact.
   */
  private addShieldTones(context: AudioContext): void {
    const tau = Math.PI * 2
    const make = (name: string, duration: number, render: (t: number, u: number) => number) => {
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i++) {
        const t = i / context.sampleRate
        data[i] = render(t, t / duration)
      }
      this.buffers.set(name, buffer)
    }
    make('shield-break', .36, (t, u) => {
      const attack = Math.min(1, t / .006)
      const crackle = (Math.random() * 2 - 1) * Math.exp(-u * 13)
      const fizz = (Math.random() * 2 - 1) * .18 * Math.exp(-u * 2.4) * Math.sin(u * tau * 14)
      const tone = Math.sin(tau * (680 - 520 * u) * t) * Math.exp(-u * 3.1)
      return Math.tanh((crackle * .65 + tone * .75 + fizz) * 1.3) * attack
    })
    make('shield-recharge', .5, (t, u) => {
      const attack = Math.min(1, t / .05)
      const release = Math.min(1, (.5 - t) / .18)
      const freq = 340 + 480 * Math.min(1, u * 1.3)
      const signal = .6 * Math.sin(tau * freq * t) + .25 * Math.sin(tau * freq * 2 * t) + .15 * Math.sin(tau * freq * 1.5 * t)
      return signal * attack * release * .7
    })
  }

  /**
   * Low-frequency impact reinforcement for ordinary armor/body contact. This is deliberately
   * short and quiet: it supplies the physical push that small speakers hide in the recorded
   * vest transient without turning every hit into the metallic click that was here before.
   */
  private addContactForce(context: AudioContext): void {
    const duration = .22
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate)
    const data = buffer.getChannelData(0)
    const tau = Math.PI * 2
    for (let i = 0; i < data.length; i++) {
      const t = i / context.sampleRate
      const u = t / duration
      const attack = Math.min(1, t / .003)
      const envelope = attack * Math.exp(-u * 6.8)
      const fundamental = Math.sin(tau * (104 - 34 * u) * t)
      const body = Math.sin(tau * 208 * t) * .22
      const lowNoise = (Math.random() * 2 - 1) * .12 * Math.exp(-u * 18)
      data[i] = Math.tanh((fundamental * .86 + body + lowNoise) * 1.2) * envelope * .72
    }
    this.buffers.set('contact-force', buffer)
  }
}
