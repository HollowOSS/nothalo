import * as THREE from 'three'

/** Frame pacing controls only rendering quality, never simulation or input frequency. */
export class QualityBudget {
  level = 0
  private elapsed = 0
  private total = 0
  private count = 0
  private cooldown = 8
  private goodWindows = 0
  private badWindows = 0

  resetWindow(): void { this.elapsed = 0; this.total = 0; this.count = 0 }

  sample(seconds: number): boolean {
    // Discard background-tab gaps rather than interpreting them as slow graphics.
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 0.5) { this.resetWindow(); return false }
    this.cooldown = Math.max(0, this.cooldown - seconds)
    this.elapsed += seconds; this.total += seconds * 1000; this.count++
    if (this.elapsed < 2) return false
    const mean = this.total / this.count
    this.resetWindow()
    if (this.cooldown > 0) return false
    // One slow window is usually a hitch (a spawn, an explosion, a shader or texture upload), not a slow GPU: step down only
    // when it persists, or at once when the window was dire.
    this.badWindows = mean > 20 ? this.badWindows + 1 : 0
    if ((mean > 32 || this.badWindows >= 2) && this.level < 4) {
      this.level++; this.goodWindows = 0; this.badWindows = 0; this.cooldown = mean > 32 ? 2 : 6
      return true
    }
    this.goodWindows = mean < 17.5 ? this.goodWindows + 1 : 0
    if (this.goodWindows >= 5 && this.level > 0) {
      this.level--; this.goodWindows = 0; this.cooldown = 12
      return true
    }
    return false
  }
}

/** A shadow's normal offset of about one texel, for suns that ask for it (`userData.normalBiasPerTexel`). */
export function fitNormalBias(sun: THREE.DirectionalLight): void {
  const perTexel = sun.userData.normalBiasPerTexel as number | undefined
  if (perTexel === undefined) return
  const camera = sun.shadow.camera, texel = (camera.right - camera.left) / sun.shadow.mapSize.x
  sun.shadow.normalBias = Math.max(sun.userData.minNormalBias as number ?? 0, texel * perTexel)
}

/**
 * Shadow maps only ever shrink; they are never switched off.
 *
 * Toggling `renderer.shadowMap.enabled` at runtime recompiles every material without its
 * shadow sampler, and WebKit — every browser on iOS — then rejects each of those draws with
 * "mismatch between texture format and sampler type", because the depth texture is still
 * bound where the new program expects a plain sampler. The ground, cliffs and bases vanish
 * and only vehicles are left floating in fog. A 256-pixel map costs less than the bug did.
 */
const TIERS = [
  // High-density displays otherwise render 2.25-4x as many pixels as a normal monitor.
  // These tiers keep the first frame crisp while leaving enough GPU headroom for the map,
  // characters and vehicles at a 60 Hz presentation rate.
  { pixelRatio: 1.25, shadows: 1536 },
  { pixelRatio: 1, shadows: 1024 },
  { pixelRatio: 0.85, shadows: 768 },
  { pixelRatio: 0.7, shadows: 512 },
  { pixelRatio: 0.55, shadows: 256 },
] as const

// On phones preserve silhouette resolution and spend the shadow budget first.
// The lowest tier remains an escape hatch for slower/thermally limited GPUs.
const MOBILE_TIERS = [
  // The previous 1.5 ceiling rendered an 844px-wide phone viewport at only 1266
  // physical pixels. Give the scene 2x when it has room, and trade shadow detail before
  // reducing the characters and map to a visibly soft internal render target.
  { pixelRatio: 2, shadows: 512 },
  { pixelRatio: 1.75, shadows: 512 },
  { pixelRatio: 1.5, shadows: 256 },
  { pixelRatio: 1.25, shadows: 256 },
  { pixelRatio: 1, shadows: 256 },
] as const

/** `?bloom` forces the glow on (phones included), `?nobloom` turns it off. */
const BLOOM_PARAM = new URLSearchParams(location.search)

/**
 * Safe graphics after a lost WebGL context. iOS kills a page's GPU context outright when it runs short of memory (the level
 * turns grey or black and never recovers); the game then reloads itself (game-entry.ts) and, for the next ten minutes,
 * starts on the lightest tier with no bloom so it does not happen again straight away.
 */
const LOST_KEY = 'halo:graphics-lost'
export function markGraphicsLost(): void { try { sessionStorage.setItem(LOST_KEY, String(Date.now())) } catch { /* private mode */ } }
function graphicsSafeMode(): boolean {
  try { const at = Number(sessionStorage.getItem(LOST_KEY)); return at > 0 && Date.now() - at < 10 * 60_000 } catch { return false }
}
const SAFE_GRAPHICS = graphicsSafeMode()

export class AdaptiveQuality {
  private readonly budget = new QualityBudget()
  private readonly suns: THREE.DirectionalLight[] = []
  private last = performance.now()
  readonly mobile = matchMedia('(pointer: coarse)').matches
  private readonly tiers = this.mobile ? MOBILE_TIERS : TIERS
  constructor(private readonly renderer: THREE.WebGLRenderer, scene: THREE.Scene, private readonly enabled = true) {
    if (SAFE_GRAPHICS) this.budget.level = this.tiers.length - 1
    this.setScene(scene)
    document.addEventListener('visibilitychange', () => { this.last = performance.now(); this.budget.resetWindow() })
  }
  setScene(scene: THREE.Scene): void {
    this.suns.length = 0
    scene.traverse(o => { if ((o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.DirectionalLight).castShadow) this.suns.push(o as THREE.DirectionalLight) })
    this.last = performance.now(); this.budget.resetWindow()
    if (this.enabled) this.apply()
  }
  private apply(): void {
    const tier = this.tiers[this.budget.level]
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, tier.pixelRatio))
    for (const sun of this.suns) {
      if (sun.shadow.mapSize.x === tier.shadows) continue
      sun.shadow.mapSize.set(tier.shadows, tier.shadows)
      fitNormalBias(sun)
      sun.shadow.map?.dispose(); sun.shadow.map = null
      sun.shadow.needsUpdate = true
    }
  }
  tick(): void {
    const now = performance.now(), seconds = (now - this.last) / 1000
    this.last = now
    if (!document.hidden && this.enabled && this.budget.sample(seconds)) this.apply()
  }
  /**
   * Bloom resolution as a fraction of the screen, 0 for off. Desktop starts at half resolution and drops to a quarter from
   * the middle tier down. It is never switched off by the governor: the god rays ride on it, and turning it off mid-match read
   * as the lighting "glitching off" (a quarter-resolution pass costs little next to the resolution the lower tiers shed). Phones run a cheap
   * quarter-resolution bloom on their top two tiers only.
   */
  bloomScale(): number {
    if (BLOOM_PARAM.has('nobloom') || (SAFE_GRAPHICS && this.mobile)) return 0
    // Phones: a quarter-resolution, four-level bloom with no god rays (bloom.ts), on the top tiers.
    if (this.mobile) return BLOOM_PARAM.has('bloom') || (this.enabled ? this.budget.level : 0) <= 1 ? .25 : 0
    if (BLOOM_PARAM.has('bloom')) return .5
    const level = this.enabled ? this.budget.level : 0
    return level <= 1 ? .5 : .25
  }
  summary() {
    return { mode: this.enabled ? 'adaptive' : 'fixed', safeGraphics: SAFE_GRAPHICS, level: this.budget.level, pixelRatio: this.renderer.getPixelRatio(), shadows: this.renderer.shadowMap.enabled, shadowSize: this.suns[0]?.shadow.mapSize.x, bloom: this.bloomScale(), targetFps: 60, minimumFps: 30 }
  }
}
