import * as THREE from 'three'

/**
 * The energy sword igniting: the blade bursts out of the hilt with a flash, a spray of plasma sparks thrown up and out along
 * the prongs as they extend, and a crackle that dies down as the blade settles (Halo 3's draw, reference/fps-rig/sword-draw).
 *
 * A pure function of the time since the burst, so review tools can sample any moment. Everything is unlit (Sprite, Points),
 * additive and untonemapped: it blooms like the blade does and adding it never recompiles a lit material or adds a light.
 * Parented to the blade's hilt node, in that node's units (the sword model's metres; +z runs up the blade, +-y are the prongs).
 */
export interface SwordIgniteFx {
  readonly object: THREE.Group
  /** Seconds since the burst; negative hides everything. Returns the blade-glow multiplier for this moment. */
  update(t: number): number
  dispose(): void
}

const SPARKS = 56
const FLASH_LIFE = .22
const SPARK_LIFE = .42

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 128
  const g = c.getContext('2d')!, r = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.18, 'rgba(210,235,255,.95)'); r.addColorStop(.45, 'rgba(90,150,255,.45)'); r.addColorStop(1, 'rgba(40,60,255,0)')
  g.fillStyle = r; g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
}

/** Small deterministic PRNG so every ignite throws the same spray (and review frames are reproducible). */
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 } }

export function createSwordIgniteFx(bladeLength: number, prongSpread: number): SwordIgniteFx {
  const object = new THREE.Group(); object.name = 'sword-ignite-fx'
  const texture = glowTexture()
  const flashMaterial = new THREE.SpriteMaterial({ map: texture, color: 0xbfd9ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false })
  const flash = new THREE.Sprite(flashMaterial); flash.name = 'ignite-flash'; flash.frustumCulled = false
  object.add(flash)

  // sparks: born along the prongs as they extend, thrown outward with a little drag, fading to nothing (additive: black = invisible)
  const random = rng(117)
  const spawn = new Float32Array(SPARKS * 3), velocity = new Float32Array(SPARKS * 3), born = new Float32Array(SPARKS)
  for (let i = 0; i < SPARKS; i++) {
    const along = random(), side = random() < .5 ? -1 : 1
    const z = .05 + along * bladeLength * .75
    const y = side * prongSpread * (1 - along * .85) * (.6 + .4 * random())
    spawn.set([(random() - .5) * .04, y, z], i * 3)
    const out = .6 + random() * 1.4
    velocity.set([(random() - .5) * 1.6, side * out * (.5 + random()), .4 + random() * 1.8], i * 3)
    born[i] = along * .07 + random() * .03                       // born as the extension passes that point
  }
  const positions = new Float32Array(SPARKS * 3), colors = new Float32Array(SPARKS * 3)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const sparkMaterial = new THREE.PointsMaterial({ size: .016, map: texture, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, sizeAttenuation: true })
  const sparks = new THREE.Points(geometry, sparkMaterial); sparks.name = 'ignite-sparks'; sparks.frustumCulled = false
  object.add(sparks)

  const smooth = (a: number, b: number, x: number) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u) }
  const update = (t: number): number => {
    const live = t >= 0 && t < Math.max(FLASH_LIFE, SPARK_LIFE + .1)
    object.visible = live
    if (!live) return 1
    // flash at the hilt: blooms in 40 ms, gone by FLASH_LIFE
    const f = smooth(0, .04, t) * (1 - smooth(.04, FLASH_LIFE, t))
    flash.position.set(0, 0, .08); flash.scale.setScalar(.12 + .3 * smooth(0, .06, t)); flashMaterial.opacity = f
    // sparks
    for (let i = 0; i < SPARKS; i++) {
      const age = t - born[i], k = 6                                  // drag
      const alive = age >= 0 && age < SPARK_LIFE
      const d = alive ? (1 - Math.exp(-k * age)) / k : 0
      for (let a = 0; a < 3; a++) positions[i * 3 + a] = spawn[i * 3 + a] + velocity[i * 3 + a] * d - (a === 2 ? .4 * age * age : 0)
      const glow = alive ? Math.pow(1 - age / SPARK_LIFE, 1.5) : 0
      colors[i * 3] = .55 * glow; colors[i * 3 + 1] = .8 * glow; colors[i * 3 + 2] = 1.2 * glow
    }
    geometry.attributes.position.needsUpdate = true; geometry.attributes.color.needsUpdate = true
    // blade glow: over-bright as it bursts, then the plasma crackles down to its resting flicker
    return 1 + 2.2 * (1 - smooth(0, .3, t)) + .35 * Math.sin(t * 90) * (1 - smooth(.05, .35, t))
  }
  update(-1)
  return {
    object, update,
    dispose() { geometry.dispose(); sparkMaterial.dispose(); flashMaterial.dispose(); texture.dispose() },
  }
}
