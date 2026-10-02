export type CollisionVehicleKind = 'warthog' | 'ghost' | 'banshee' | 'mongoose' | 'chopper'
/** Cached dry impact: low body thud, inharmonic metal flex, granular scrape and loose-panel rattle. */
export function collisionSamples(kind: CollisionVehicleKind, sampleRate: number): Float32Array {
  const duration = kind === 'warthog' ? .72 : .65
  const samples = new Float32Array(Math.ceil(sampleRate * duration))
  let seed = kind === 'warthog' ? 317 : kind === 'ghost' ? 991 : 733, low = 0
  const metal = kind === 'warthog' ? [173, 397, 811] : kind === 'ghost' ? [231, 547, 1093] : [193, 463, 977]
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate
    seed = (Math.imul(seed,1664525)+1013904223) | 0
    const noise = (seed >>> 0)/2147483648-1
    low += (noise-low)*.13
    const attack = Math.min(1,t/.002), tail = Math.min(1,(duration-t)/.035)
    const thud = Math.sin(Math.PI*2*(95*t-25*t*t)) * Math.exp(-t*24) * .7
    const flex = metal.reduce((sum,f,index)=>sum+Math.sin(Math.PI*2*f*t+index*.7)*Math.exp(-t*(20+index*10))/(index+2),0) * .22
    const scrapeEnvelope = Math.exp(-t*7)*(1-Math.exp(-t*65))*(.35+.65*Math.sin(t*73)**2)
    const rattle = Math.exp(-t*8)*Math.max(0,Math.sin(t*91)-.6)*.25
    samples[i] = Math.tanh((thud+flex+low*.75*Math.exp(-t*38)+(noise-low)*(.16*scrapeEnvelope+rattle))*1.1)*attack*tail
  }
  return samples
}
/** Impact speed is relative contact speed in m/s, not merely the vehicle's forward speed. */
export function collisionLevel(speed: number, distance: number): number {
  if (!Number.isFinite(speed) || !Number.isFinite(distance) || speed < 1.8) return 0
  const strength=Math.min(1,(speed-1.8)/22)
  const range=Math.max(0,distance)
  return (.12+Math.sqrt(strength)*.98)*Math.pow(Math.max(0,1-range/90),2)/(1+range*.035)
}
