/**
 * Frame-time sampler. The performance half of the bar is a number, so it has to be
 * measurable from outside: window.__perf() returns a summary a critic can read.
 */
import { DEBUG_HOOKS } from './build-flags.ts'

export class FrameStats {
  private samples: number[] = []
  private last = performance.now()
  private readonly cap = 600

  tick(): void {
    const now = performance.now()
    this.samples.push(now - this.last)
    this.last = now
    if (this.samples.length > this.cap) this.samples.shift()
  }

  summary(): { fps: number; p95ms: number; worstMs: number; samples: number } {
    if (this.samples.length === 0) return { fps: 0, p95ms: 0, worstMs: 0, samples: 0 }
    const sorted = [...this.samples].sort((a, b) => a - b)
    const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length
    return {
      fps: Math.round(1000 / mean),
      p95ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      worstMs: +sorted[sorted.length - 1].toFixed(2),
      samples: this.samples.length,
    }
  }

  reset(): void {
    this.samples = []
    this.last = performance.now()
  }
}

/** `memory` counts live GPU resources, which is what a leak actually shows up in: a geometry
 * or texture that is dropped from the scene but never disposed stays counted here even after
 * the JS object is collected, so a climbing count is the signal a flat JS heap can hide. */
export function installPerfHooks(stats: FrameStats, renderer: {
  info: { render: { calls: number; triangles: number }; memory: { geometries: number; textures: number }; programs?: unknown[] | null }
}): void {
  if (!DEBUG_HOOKS) return
  const w = window as unknown as Record<string, unknown>
  w.__perf = () => ({
    ...stats.summary(),
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length ?? 0,
  })
  w.__perfReset = () => { stats.reset(); return 'ok' }
}
