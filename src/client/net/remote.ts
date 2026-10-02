import { NET } from '../../shared/constants.ts'
import type { WirePlayer } from '../../shared/protocol.ts'
import { lerpGait, unpackGait } from '../../shared/gait.ts'

/**
 * Where a remote player is drawn.
 *
 * Snapshots come at 20 Hz and the screen refreshes at 60 or more, so a remote player is shown
 * a tenth of a second in the past, between the two snapshots that bracket that moment. That
 * delay is what the server rewinds by when it judges a shot at them, so what you aim at is
 * what gets hit.
 */

interface Sample {
  t: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  flags: number
  gait: number
  back: boolean
}

export interface RemotePose {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  flags: number
  /** Stride phase 0..1 and backpedal, as the server has them. */
  gait: { phase: number; backward: boolean }
  /** True when the buffer had two samples to blend; false when it had to hold the last one. */
  interpolated: boolean
}

const KEEP_MS = NET.interpolationDelay * 1000 * 4

export class RemoteBuffer {
  private readonly samples: Sample[] = []

  push(t: number, p: WirePlayer): void {
    const last = this.samples[this.samples.length - 1]
    // A respawn is a cut, not a sprint: drop the history so nobody slides across the map.
    if (last && Math.hypot(p.x - last.x, p.z - last.z) > 25) this.samples.length = 0
    const gait = unpackGait(p.gait ?? 0)
    this.samples.push({ t, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, flags: p.flags, gait: gait.phase, back: gait.backward })
    const cutoff = t - KEEP_MS
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift()
  }

  get empty(): boolean {
    return this.samples.length === 0
  }

  /** The pose at local time `now`, rendered `NET.interpolationDelay` in the past. */
  sample(now: number, out: RemotePose): boolean {
    const s = this.samples
    if (s.length === 0) return false
    const when = now - NET.interpolationDelay * 1000
    if (when <= s[0].t || s.length === 1) { copy(s[0], out, false); return true }
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].t <= when && when <= s[i].t) {
        const a = s[i - 1], b = s[i]
        const f = (when - a.t) / (b.t - a.t || 1)
        out.x = a.x + (b.x - a.x) * f
        out.y = a.y + (b.y - a.y) * f
        out.z = a.z + (b.z - a.z) * f
        out.yaw = a.yaw + wrap(b.yaw - a.yaw) * f
        out.pitch = a.pitch + (b.pitch - a.pitch) * f
        out.flags = f < 0.5 ? a.flags : b.flags
        out.gait.phase = lerpGait(a.gait, b.gait, f)
        out.gait.backward = f < 0.5 ? a.back : b.back
        out.interpolated = true
        return true
      }
    }
    copy(s[s.length - 1], out, false)
    return true
  }
}

function copy(s: Sample, out: RemotePose, interpolated: boolean): void {
  out.x = s.x; out.y = s.y; out.z = s.z; out.yaw = s.yaw; out.pitch = s.pitch; out.flags = s.flags; out.gait.phase = s.gait; out.gait.backward = s.back
  out.interpolated = interpolated
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

// ---------------------------------------------------------------- vehicles

export interface VehiclePose {
  impactSeq?:number
  impactSpeed?:number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
  turretYaw: number
  turretPitch: number
  speed: number
  driver: number
  gunner: number
  flags: number
}

interface VehicleSample extends VehiclePose { t: number }

/** The same idea for a vehicle nobody here is driving: shown a tenth of a second back. */
export class VehicleBuffer {
  private readonly samples: VehicleSample[] = []

  push(t: number, v: VehiclePose): void {
    const last = this.samples[this.samples.length - 1]
    if (last && Math.hypot(v.x - last.x, v.z - last.z) > 40) this.samples.length = 0
    this.samples.push({ t, ...v })
    const cutoff = t - KEEP_MS
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift()
  }

  get empty(): boolean {
    return this.samples.length === 0
  }

  sample(now: number, out: VehiclePose): boolean {
    const s = this.samples
    if (s.length === 0) return false
    const when = now - NET.interpolationDelay * 1000
    if (when <= s[0].t || s.length === 1) { Object.assign(out, s[0]); return true }
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].t <= when && when <= s[i].t) {
        const a = s[i - 1], b = s[i]
        const f = (when - a.t) / (b.t - a.t || 1)
        out.x = a.x + (b.x - a.x) * f
        out.y = a.y + (b.y - a.y) * f
        out.z = a.z + (b.z - a.z) * f
        out.yaw = a.yaw + wrap(b.yaw - a.yaw) * f
        out.pitch = a.pitch + wrap(b.pitch - a.pitch) * f
        out.roll = a.roll + wrap(b.roll - a.roll) * f
        out.turretYaw = a.turretYaw + wrap(b.turretYaw - a.turretYaw) * f
        out.turretPitch = a.turretPitch + (b.turretPitch - a.turretPitch) * f
        out.speed = a.speed + (b.speed - a.speed) * f
        // Occupancy and firing are discrete: take the newer sample once past halfway.
        const d = f < 0.5 ? a : b
        out.driver = d.driver; out.gunner = d.gunner; out.flags = d.flags
        out.impactSeq=d.impactSeq??0;out.impactSpeed=d.impactSpeed??0
        return true
      }
    }
    Object.assign(out, s[s.length - 1])
    return true
  }
}
