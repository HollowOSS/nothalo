import { assetUrl } from '../../shared/runtime-config.ts'
import { getSharedAudioContext, onAudioActivation, resumeAudio } from '../game/audio-activation.ts'
/** `id` names the recording to play (public/assets/audio/announcer/<id>.mp3). */
export interface MedalCall { id: string; label: string; category: string; time: number }
/** Every voiced medal's call. Medals Halo 3 left silent (Headshot, Splatter, Beat Down, Grenade Stick) have none. */
const RECORDINGS: readonly string[] = [
  'double-kill', 'triple-kill', 'overkill', 'killtacular', 'killtrocity', 'killimanjaro', 'killtastrophe', 'killpocalypse', 'killionaire',
  'killing-spree', 'killing-frenzy', 'running-riot', 'rampage', 'untouchable', 'invincible',
  'sniper-spree', 'sharpshooter', 'shotgun-spree', 'open-season', 'sword-spree', 'slice-n-dice', 'splatter-spree', 'vehicular-manslaughter',
  'assassin', 'killjoy', 'bulltrue', 'carrier-kill', 'flag-kill', 'oddball-kill', 'flag-score', 'bomb-planted', 'extermination', 'perfection',
]
/** One centered announcer voice, with at most three pending calls and no combat-clock timers. */
export class MedalAnnouncer {
  private readonly encoded = new Map<string, Promise<ArrayBuffer | null>>()
  private readonly buffers = new Map<string, AudioBuffer>()
  private loading: Promise<void> | null = null
  private context: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null
  private pending: MedalCall[] = []
  private now = 0
  private nextAt = 0
  private voiceDeadline = Infinity
  private muted = false
  private active = true
  private disposed = false
  private readonly activate = () => { void this.preload().catch(error => console.warn('Announcer audio unavailable',error)) }
  private readonly getMuted: () => boolean
  private readonly removeActivation: () => void
  constructor(getMuted: () => boolean) {
    this.getMuted=getMuted
    for (const id of RECORDINGS) this.encoded.set(id,
      fetch(assetUrl(`/assets/audio/announcer/${id}.mp3`), { priority: 'low' }).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null))
    this.removeActivation = onAudioActivation(this.activate)
    addEventListener('blur',this.clear)
    document.addEventListener('visibilitychange',this.onVisibility)
  }
  private onVisibility = () => { if (document.hidden) this.clear() }
  async preload(): Promise<void> {
    if (this.disposed) return
    if (this.context) { await resumeAudio(this.context); if (this.loading) await this.loading; return }
    const context = this.context = getSharedAudioContext()
    this.gain = context.createGain(); this.gain.gain.value=.45; this.gain.connect(context.destination)
    this.loading = Promise.all([...this.encoded].map(async([id,request]) => {
      const bytes=await request;if(!bytes)return
      try{const buffer=await context.decodeAudioData(bytes);if(!this.disposed)this.buffers.set(id,buffer)}catch{/* A failed recording stays silent; medal visuals still appear. */}
    })).then(() => { this.encoded.clear() })
    await context.resume()
    await this.loading
  }
  enqueue(call: MedalCall): void {
    if (this.disposed || this.muted || this.getMuted() || !this.active || document.hidden) return
    // A rocket that earns several medals in one frame speaks the highest new multikill: one call
    // per family, and no more than three waiting, so the voice never trails far behind the fight.
    this.pending=this.pending.filter(item=>item.category!==call.category)
    this.pending.push(call)
    if(this.pending.length>3)this.pending.shift()
  }
  update(time: number, muted: boolean, active: boolean): void {
    this.now=time; this.muted=muted || this.getMuted(); this.active=active
    if(this.disposed)return
    if(this.muted || !active || document.hidden){this.clear();return}
    this.pending=this.pending.filter(call=>time-call.time<5)
    if(this.source && time>this.voiceDeadline){this.stopVoice();this.nextAt=time+.12}
    if(this.source || time<this.nextAt)return
    // Briefly collect same-frame awards so explosive multikills do not build a voice backlog.
    const call=this.pending[0]
    if(!call || time-call.time<.08)return
    this.pending.shift()
    const buffer=this.buffers.get(call.id)
    if(buffer && this.context?.state==='running' && this.gain){
      const source=this.source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.gain)
      source.onended=()=>{source.disconnect();if(this.source===source){this.source=null;this.nextAt=this.now+.12}}
      this.voiceDeadline=time+Math.min(4,buffer.duration+.4);source.start();return
    }
    // All supported medals use recordings. Failed/missing files never invoke a synthetic voice.
  }
  private stopVoice():void {
    if(this.source){const source=this.source;this.source=null;source.stop();source.disconnect()}
    this.voiceDeadline=Infinity
  }
  clear = (): void => {
    this.pending=[];this.stopVoice();this.nextAt=this.now+.12
  }
  dispose(): void {
    if(this.disposed)return
    this.disposed=true;this.clear()
    this.removeActivation()
    removeEventListener('blur',this.clear);document.removeEventListener('visibilitychange',this.onVisibility)
    this.buffers.clear();this.encoded.clear()
  }
}
