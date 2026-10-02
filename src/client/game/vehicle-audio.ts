/** Continuous propulsion; uses only the existing gesture-unlocked combat AudioContext. */
export interface VehicleSoundState { id: string | number; kind: 'warthog' | 'ghost' | 'banshee' | 'mongoose' | 'chopper'; speed: number; occupied: boolean; boosting?: boolean; distance: number; pan: number }
/**
 * A decoded recording and its catalogue gain, or undefined while it is still loading. The Ghost and Banshee run on
 * Halo 3's own engine loops (vehicle-audio-catalog.ts) once decoded, and on the synthesized hum until then.
 */
export type RecordedLoop = (name: string) => { buffer: AudioBuffer; gain: number } | undefined
type Layer = { source: AudioBufferSourceNode; gain: GainNode }
type Engine = { source: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode; filter: BiquadFilterNode; kind: VehicleSoundState['kind']; recorded: number; contrail?: Layer; boosting: boolean }
const wheeled = (kind: VehicleSoundState['kind']) => kind === 'warthog' || kind === 'mongoose' || kind === 'chopper'
export class VehicleAudio {
  private readonly engines = new Map<string | number, Engine>()
  private readonly buffers = new Map<VehicleSoundState['kind'], AudioBuffer>()
  private readonly context: AudioContext
  private readonly output: AudioNode
  private readonly recorded: RecordedLoop
  constructor(context: AudioContext, output: AudioNode, recorded: RecordedLoop = () => undefined) { this.context = context; this.output = output; this.recorded = recorded }
  get active(): number { return this.engines.size }
  private buffer(kind: VehicleSoundState['kind']): AudioBuffer {
    const cached = this.buffers.get(kind)
    if (cached) return cached
    const rate = 22050, count = rate * 2
    const buffer = this.context.createBuffer(1, count, rate), data = buffer.getChannelData(0)
    // Integer frequencies form exactly periodic loops without a splice discontinuity.
    for (let i = 0; i < count; i++) {
      const t = i / rate, tau = Math.PI * 2
      let signal = 0
      if (wheeled(kind)) {
        for (let h = 1; h <= 9; h++) signal += Math.sin(tau * 42 * h * t + h * .31) / (h * 1.8)
        signal *= .7 + .3 * Math.sin(tau * 21 * t)
        signal += .07 * Math.sin(tau * 313 * t) + .045 * Math.sin(tau * 727 * t)
      } else {
        const base = kind === 'ghost' ? 86 : 112
        signal = .48 * Math.sin(tau * base * t + .35 * Math.sin(tau * 3 * t)) + .2 * Math.sin(tau * (base * 2 + 1) * t) + .09 * Math.sin(tau * base * 4 * t)
        for (const f of [379, 547, 809, 1201, 1613]) signal += .025 * Math.sin(tau * f * t + f)
      }
      data[i] = Math.tanh(signal)
    }
    this.buffers.set(kind, buffer)
    return buffer
  }
  update(states: readonly VehicleSoundState[]): void {
    if (this.context.state !== 'running') { this.stop(); return }
    const audible = states.filter(s => Number.isFinite(s.distance) && Number.isFinite(s.speed) && s.distance < 95 && (s.occupied || s.boosting || Math.abs(s.speed) > .5)).sort((a,b) => a.distance-b.distance).slice(0,6)
    const wanted = new Set(audible.map(s=>s.id))
    for (const [id, engine] of this.engines) if (!wanted.has(id)) { this.release(engine); this.engines.delete(id) }
    const now = this.context.currentTime
    for (const state of audible) {
      let engine = this.engines.get(state.id)
      const loop = state.kind === 'ghost' || state.kind === 'banshee' ? this.recorded(`${state.kind}-engine`) : undefined
      // A recording that finished decoding after this engine started takes over from the synthesized hum.
      if (engine && (engine.kind !== state.kind || (loop && !engine.recorded))) { this.release(engine); this.engines.delete(state.id); engine = undefined }
      if (!engine) {
        const source = this.context.createBufferSource(), gain = this.context.createGain(), pan = this.context.createStereoPanner(), filter = this.context.createBiquadFilter()
        source.buffer = loop?.buffer ?? this.buffer(state.kind); source.loop = true; gain.gain.value = 0
        filter.type = 'lowpass'; filter.Q.value = .5
        source.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(this.output)
        // Recorded loops start at a random point so two Ghosts side by side never phase against each other.
        if (loop) source.start(now, Math.random() * loop.buffer.duration); else source.start()
        engine = {source,gain,pan,filter,kind:state.kind,recorded:loop?.gain ?? 0,boosting:false}; this.engines.set(state.id,engine)
      }
      const speed = Math.min(1,Math.abs(state.speed)/(wheeled(state.kind) ? 22 : 30))
      const distance = Math.max(0,state.distance)
      const attenuation = Math.pow(Math.max(0,1-distance/95),2)/(1+Math.max(0,distance-3)*.035)
      const boost=(state.kind==='ghost'||state.kind==='chopper')&&state.boosting
      const boostAmount=boost?1.8:1
      const level=((state.occupied ? .09 : .03)+speed*(wheeled(state.kind) ? .21 : .16))*attenuation*boostAmount
      if (engine.recorded) {
        // The recording already has its own pitch and colour: bend it only a little with speed, and open the filter wide.
        engine.gain.gain.setTargetAtTime(level*engine.recorded,now,.08)
        engine.source.playbackRate.setTargetAtTime(.9+speed*.28+(boost?.12:0),now,.08)
        engine.filter.frequency.setTargetAtTime(2400+speed*9000+(boost?4000:0),now,.08)
      } else {
        engine.gain.gain.setTargetAtTime(level,now,.08)
        engine.source.playbackRate.setTargetAtTime((wheeled(state.kind) ? .72 : .82)+speed*(wheeled(state.kind) ? 1.45 : .75)+(boost? .42:0),now,.08)
        engine.filter.frequency.setTargetAtTime((wheeled(state.kind) ? 450 : 700)+speed*1700+(boost?520:0),now,.08)
      }
      const pan = Number.isFinite(state.pan) ? Math.max(-1,Math.min(1,state.pan)) : 0
      engine.pan.pan.setTargetAtTime(pan,now,.1)
      // The Ghost's boost kicks in with Halo 3's own boost roar.
      if (state.kind === 'ghost' && state.boosting && !engine.boosting) this.oneShot('ghost-boost', attenuation * (state.occupied ? 1 : .8), pan)
      engine.boosting = !!state.boosting
      // The Banshee screams through its tricks and at boost speed: Halo 3's contrail loop over the engine.
      if (state.kind === 'banshee') {
        const scream = Math.max(state.boosting ? 1 : 0, Math.min(1, Math.max(0, (Math.abs(state.speed) - 30) / 10)))
        const contrail = this.recorded('banshee-contrail')
        if (!engine.contrail && scream > 0 && contrail) {
          const source = this.context.createBufferSource(), gain = this.context.createGain()
          source.buffer = contrail.buffer; source.loop = true; gain.gain.value = 0
          source.connect(gain); gain.connect(engine.pan); source.start(now, Math.random() * contrail.buffer.duration)
          engine.contrail = {source, gain}
        }
        if (engine.contrail && contrail) {
          engine.contrail.gain.gain.setTargetAtTime(scream * .22 * attenuation * contrail.gain, now, scream > 0 ? .06 : .25)
          engine.contrail.source.playbackRate.setTargetAtTime(.94 + .12 * scream, now, .1)
        }
      }
    }
  }
  private oneShot(name: string, volume: number, pan: number): void {
    const sound = this.recorded(name)
    if (!sound || volume < .015) return
    const source = this.context.createBufferSource(), gain = this.context.createGain(), stereo = this.context.createStereoPanner()
    source.buffer = sound.buffer; gain.gain.value = Math.min(2, volume * sound.gain); stereo.pan.value = pan
    source.connect(gain); gain.connect(stereo); stereo.connect(this.output)
    source.onended = () => { source.disconnect(); gain.disconnect(); stereo.disconnect() }
    source.start()
  }
  private release(engine: Engine): void {
    engine.source.stop(); engine.source.disconnect(); engine.filter.disconnect(); engine.gain.disconnect(); engine.pan.disconnect()
    if (engine.contrail) { engine.contrail.source.stop(); engine.contrail.source.disconnect(); engine.contrail.gain.disconnect() }
  }
  stop(): void { for (const engine of this.engines.values()) this.release(engine); this.engines.clear() }
}
