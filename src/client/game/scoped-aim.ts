/** A brief Halo 3 optical zoom, measured in focal length so 2x really doubles scale. */
export function advanceOpticalZoom(currentFov: number, baseFov: number, zoom: number, dt: number): number {
  const base = Math.tan(baseFov * Math.PI / 360)
  const current = base / Math.tan(currentFov * Math.PI / 360)
  const next = current + (zoom - current) * -Math.expm1(-Math.max(0, dt) / .025)
  return 2 * Math.atan(base / (Math.abs(next - zoom) < .001 ? zoom : next)) * 180 / Math.PI
}

/** Scope-only input filter. Hip fire stays raw; zoom scales screen-space travel down. */
export class ScopedAim {
  zoom = 1
  private yaw = 0
  private pitch = 0
  private readonly result = { yaw: 0, pitch: 0 }

  setZoom(zoom: number): void {
    const next = Number.isFinite(zoom) ? Math.max(1, zoom) : 1
    if (next !== this.zoom) this.clear()
    this.zoom = next
  }

  clear(): void { this.yaw = this.pitch = 0 }

  add(yaw: number, pitch: number): void {
    const sensitivity = this.zoom > 1 ? .72 / this.zoom : 1
    this.yaw += yaw * sensitivity
    this.pitch += pitch * sensitivity
  }

  advance(dt: number): Readonly<{ yaw: number; pitch: number }> {
    // Exponential residual filtering preserves total mouse travel at every frame rate.
    // A short 35 ms time constant takes out jitter without a long camera follow delay.
    const blend = this.zoom > 1 ? -Math.expm1(-Math.max(0, dt) / .035) : 1
    this.result.yaw = this.yaw * blend
    this.result.pitch = this.pitch * blend
    this.yaw -= this.result.yaw
    this.pitch -= this.result.pitch
    return this.result
  }
}
