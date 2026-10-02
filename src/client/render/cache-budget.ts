/** Hints select a conservative budget, never an estimate of free system or video memory. */
export interface DeviceHints { memoryGB?: number; threads?: number; saveData?: boolean }
const MiB = 1024 * 1024
export class CacheBudget {
  readonly bytes: number
  readonly maxMaps: number
  readonly parallel: number
  private slowUntil = 0
  private elapsed = 0
  private frames = 0
  constructor(hints: DeviceHints = {}) {
    const memory = hints.memoryGB ?? 0
    const threads = hints.threads ?? 2
    this.maxMaps = memory >= 4 && threads >= 4 ? 2 : 1
    this.bytes = (memory >= 8 ? 512 : memory >= 4 ? 256 : 128) * MiB
    this.parallel = threads >= 6 && !hints.saveData ? 2 : 1
  }
  sample(milliseconds: number, now: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 500) { this.elapsed = 0; this.frames = 0; return }
    this.elapsed += milliseconds; this.frames++
    if (this.elapsed < 2000) return
    if (this.elapsed / this.frames > 25) this.slowUntil = now + 4000
    this.elapsed = 0; this.frames = 0
  }
  canPrepare(now: number): boolean { return now >= this.slowUntil }
}

export function deviceHints(): DeviceHints {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
  return { memoryGB: nav.deviceMemory, threads: nav.hardwareConcurrency, saveData: nav.connection?.saveData }
}

/** Pause new background jobs during sustained stutter, but never indefinitely delay Play. */
export class PreparationQueue {
  private active = 0
  private waiting: (() => void)[] = []
  private readonly budget: CacheBudget
  constructor(budget: CacheBudget) { this.budget = budget }
  async run<T>(work: () => Promise<T>): Promise<T> {
    await new Promise<void>(resolve => { this.waiting.push(resolve); this.pump() })
    try {
      const deadline = performance.now() + 1000
      while (!this.budget.canPrepare(performance.now()) && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return await work()
    } finally { this.active--; this.pump() }
  }
  private pump(): void {
    while (this.active < this.budget.parallel && this.waiting.length) {
      this.active++; this.waiting.shift()!()
    }
  }
}
