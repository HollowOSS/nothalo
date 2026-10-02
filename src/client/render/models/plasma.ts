import * as THREE from 'three'

/**
 * The energy sword's blades never sit still.
 *
 * In the footage the plasma flickers constantly — it is the thing that separates a sword that
 * is switched on from a pane of cyan glass. The mesh cannot show that, so the emission does:
 * the bright core pulses fast and shallow, and the halo around it breathes slower and deeper
 * and slightly out of phase, which reads as a field being held rather than a light being
 * dimmed.
 *
 * Materials are matched by the names the Blender file gives them, and the same blades are used
 * for the viewmodel and for the sword in someone else's hands, so both flicker together.
 */

interface Blade {
  material: THREE.MeshStandardMaterial
  /** What the file asked for, so the flicker is a modulation rather than a replacement. */
  emissive: number
  opacity: number
  core: boolean
  clock: { value: number }
}

const CORE = /plasma core/i
const HALO = /plasma halo/i

/** Every plasma material under an object, captured with the values it was authored with. */
export function collectPlasma(root: THREE.Object3D): Blade[] {
  const blades: Blade[] = []
  const seen = new Set<THREE.Material>()
  root.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const standard = material as THREE.MeshStandardMaterial
      if (!standard || seen.has(standard)) continue
      const core = CORE.test(standard.name)
      if (!core && !HALO.test(standard.name)) continue
      seen.add(standard)
      // Clone so a flicker on the weapon in your hands does not drive one across the canyon.
      const own = standard.clone()
      const clock = {value: 0}
      own.toneMapped = false
      // Hot enough to cross the bloom threshold with room to spare: the blade is the brightest thing on screen, and its
      // glow (bloom.ts, which the viewmodel is drawn inside) is most of what makes it read as energy rather than glass.
      own.emissiveIntensity = Math.max(own.emissiveIntensity, core ? 1.35 : 1.2)
      if (!core) { own.depthWrite = false; own.blending = THREE.AdditiveBlending; own.opacity = .11 }
      own.onBeforeCompile = shader => {
        shader.uniforms.plasmaTime = clock
        shader.vertexShader = 'varying vec3 plasmaPosition;\n' + shader.vertexShader
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n plasmaPosition = position;')
        shader.fragmentShader = 'uniform float plasmaTime; varying vec3 plasmaPosition;\n' + shader.fragmentShader
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
          #include <emissivemap_fragment>
          float ribbon = sin(plasmaPosition.z * 53.0 + plasmaPosition.y * 97.0 + sin(plasmaPosition.z * 31.0 - plasmaTime * 5.0) * 2.0);
          float current = sin(plasmaPosition.z * 91.0 - plasmaTime * 9.0 + plasmaPosition.x * 180.0);
          float filament = smoothstep(-.5, .85, ribbon * .65 + current * .35);
          totalEmissiveRadiance *= mix(vec3(.16,.38,1.0), vec3(.7,.97,1.25), filament);
          // crackle: thin bright arcs that run up the blade and never line up with the ribbons
          float arc = sin(plasmaPosition.z * 170.0 - plasmaTime * 23.0 + sin(plasmaPosition.x * 240.0 + plasmaTime * 7.0) * 3.0);
          float crackle = pow(max(arc, 0.0), 24.0);
          // edges face away from the eye: plasma is brightest where you look through the most of it
          float rim = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.0);
          totalEmissiveRadiance += vec3(.3, .7, 1.5) * (rim * ${core ? '1.6' : '1.0'} + crackle * ${core ? '1.3' : '.6'}) * max(max(emissive.r, emissive.g), emissive.b);
          ${core ? '' : 'diffuseColor.a *= (.25 + .75 * filament) * (.6 + .8 * rim);'}
        `)
      }
      own.customProgramCacheKey = () => core ? 'sword-core-flow-v2' : 'sword-halo-flow-v2'
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(m => (m === standard ? own : m))
      } else {
        mesh.material = own
      }
      blades.push({ material: own, emissive: own.emissiveIntensity, opacity: own.opacity, core, clock })
    }
  })
  return blades
}

/**
 * Advance the flicker. `seconds` is absolute, so two swords lit at different moments do not
 * pulse in lockstep as though they were wired together.
 */
export function flickerPlasma(blades: readonly Blade[], seconds: number): void {
  // Three incommensurate rates: it never repeats, and it never settles into a visible beat.
  const fast = Math.sin(seconds * 31.0) * 0.5 + Math.sin(seconds * 47.3 + 1.7) * 0.3 + Math.sin(seconds * 19.1 + 0.4) * 0.2
  const slow = Math.sin(seconds * 7.3 + 2.1) * 0.6 + Math.sin(seconds * 11.9) * 0.4
  for (const blade of blades) {
    blade.clock.value = seconds
    if (blade.core) {
      blade.material.emissiveIntensity = blade.emissive * (1 + fast * 0.12 + slow * 0.05)
    } else {
      blade.material.emissiveIntensity = blade.emissive * (1 + slow * 0.18 + fast * 0.06)
      blade.material.opacity = Math.min(1, blade.opacity * (1 + slow * 0.22))
    }
  }
}
