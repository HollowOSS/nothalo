import * as THREE from 'three'

/**
 * The Halo 3 plasma grenade, built in code so it needs no asset and runs headless in checks.
 *
 * A bright blue plasma orb held in a violet Covenant-alloy cradle: a bulbous base pod with a
 * glowing collar, and four thin claws that sweep up from it, hug the orb and curl in over
 * the top without meeting. The orb swirls and pulses; once the grenade is armed (stuck to
 * something) the pulse quickens and brightens toward detonation.
 *
 * Local +Y runs from the base pod to the top of the orb. About 0.2 m tall overall.
 */
export interface PlasmaGrenadeModel {
  readonly object: THREE.Group
  /** `seconds` is absolute; `armed` runs 0 (in flight or in hand) to 1 (about to go off). */
  update(seconds: number, armed: number): void
}

const CORE_RADIUS = .052
const CLAW_RADIUS = .062
const CLAWS = 4

let shared: {
  claw: THREE.BufferGeometry; seam: THREE.BufferGeometry; pod: THREE.BufferGeometry; collar: THREE.BufferGeometry; core: THREE.BufferGeometry
  alloy: THREE.MeshStandardMaterial; light: THREE.MeshBasicMaterial; glow: THREE.Texture
} | null = null

/**
 * A claw's sweep, as a flat band following an arc in the plane of its azimuth. `angle` is the
 * elevation above the orb's equator; the band is widest at the pod and tapers to a hook.
 */
function band(width: (k: number) => number, thickness: number, lift: number, from: number, to: number): THREE.BufferGeometry {
  const steps = 28, positions: number[] = [], normals: number[] = [], indices: number[] = []
  const centre = new THREE.Vector3(), radial = new THREE.Vector3(), side = new THREE.Vector3(0, 0, 1), corner = new THREE.Vector3()
  // Four faces, each with its own vertices so the edges stay crisp.
  const faces = [[1, 1, -1, 1, 'r'], [-1, -1, 1, -1, 'r'], [1, -1, 1, 1, 's'], [-1, 1, -1, -1, 's']] as const
  for (const [s0, t0, s1, t1, facing] of faces) {
    const base = positions.length / 3
    for (let i = 0; i <= steps; i++) {
      const k = i / steps, angle = from + (to - from) * k
      // Swell slightly around the orb's waist, then hook inward at the tip.
      const radius = CLAW_RADIUS + lift + .006 * Math.sin(k * Math.PI) - .009 * Math.pow(Math.max(0, (k - .78) / .22), 2)
      radial.set(Math.cos(angle), Math.sin(angle), 0)
      centre.copy(radial).multiplyScalar(radius)
      const w = width(k) / 2, h = thickness / 2
      for (const [s, t] of [[s0, t0], [s1, t1]]) {
        corner.copy(centre).addScaledVector(side, s * w).addScaledVector(radial, t * h)
        positions.push(corner.x, corner.y, corner.z)
        if (facing === 'r') normals.push(radial.x * t0, radial.y * t0, 0)
        else normals.push(0, 0, s0)
      }
      if (i < steps) { const a = base + i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  return geometry
}

function glowTexture(): THREE.Texture {
  const size = 64, data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + .5) / size * 2 - 1, dy = (y + .5) / size * 2 - 1, r = Math.min(1, Math.hypot(dx, dy))
    const a = Math.pow(1 - r, 2.2) * .85 + Math.exp(-r * r * 30) * .15
    const i = (y * size + x) * 4
    data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = Math.round(a * 255)
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.magFilter = texture.minFilter = THREE.LinearFilter; texture.needsUpdate = true
  return texture
}

function resources() {
  if (shared) return shared
  const claw = band(k => .024 * (1 - k) + .007 * k, .0075, 0, -1.4, 1.12)
  const seam = band(k => .006 * (1 - k * .6), .001, .0045, -1.1, .92)
  // The base pod: a squat bulb under the orb that the claws grow out of.
  const profile = [[0, -.108], [.016, -.106], [.03, -.099], [.04, -.088], [.045, -.075], [.044, -.064], [.037, -.056], [.024, -.05], [0, -.048]]
  const pod = new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 24)
  const collar = new THREE.TorusGeometry(.0445, .0032, 8, 32).rotateX(Math.PI / 2).translate(0, -.07, 0)
  const core = new THREE.SphereGeometry(CORE_RADIUS, 32, 20)
  const alloy = new THREE.MeshStandardMaterial({ color: 0xa097d6, metalness: .55, roughness: .28, emissive: 0x1c1846 })
  const light = new THREE.MeshBasicMaterial({ color: new THREE.Color(.55, 1.5, 3.6), toneMapped: false })
  return shared = { claw, seam, pod, collar, core, alloy, light, glow: glowTexture() }
}

function coreMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, armed: { value: 0 } },
    vertexShader: `
      varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal;
      void main() {
        vLocal = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal); vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float time, armed;
      varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal;
      void main() {
        vec3 p = vLocal * 60.0;
        // Plasma churning inside the shell: three drifting interference bands.
        float swirl = sin(p.x * 1.3 + time * 2.7 + sin(p.y * 1.7 - time * 1.9)) + sin(p.y * 1.5 - time * 3.3 + p.z)
          + sin(p.z * 1.2 + time * 4.1 + sin(p.x * 2.1 + time));
        float bands = .5 + .5 * sin(swirl * 1.6);
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float rim = pow(1.0 - facing, 2.5);
        vec3 deep = vec3(.04, .2, 1.15), hot = vec3(.45, 1.15, 2.7);
        vec3 c = mix(deep, hot, pow(facing, 3.0) * .55 + bands * .45) + vec3(.25, .65, 1.6) * rim;
        float pulse = .5 + .5 * sin(time * mix(6.0, 34.0, armed));
        c *= 1.0 + armed * (.35 + .9 * pulse);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
}

export function createPlasmaGrenade(): PlasmaGrenadeModel {
  const r = resources()
  const object = new THREE.Group()
  object.name = 'halo3-plasma-grenade'
  const core = new THREE.Mesh(r.core, coreMaterial())
  core.name = 'plasma-grenade-core'
  object.add(core)
  object.add(new THREE.Mesh(r.pod, r.alloy), new THREE.Mesh(r.collar, r.light))
  for (let i = 0; i < CLAWS; i++) {
    // Each band is authored in the XY plane; turn it to its azimuth around the orb.
    const azimuth = i / CLAWS * Math.PI * 2 + Math.PI / 4
    const claw = new THREE.Mesh(r.claw, r.alloy), seam = new THREE.Mesh(r.seam, r.light)
    claw.rotation.y = seam.rotation.y = azimuth
    object.add(claw, seam)
  }
  const glowMaterial = new THREE.SpriteMaterial({ map: r.glow, color: new THREE.Color(.35, .75, 1.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false })
  const glow = new THREE.Sprite(glowMaterial)
  glow.name = 'plasma-grenade-glow'
  glow.scale.setScalar(.34)
  object.add(glow)
  object.traverse(node => { node.frustumCulled = false })
  const uniforms = (core.material as THREE.ShaderMaterial).uniforms
  return {
    object,
    update(seconds, armed) {
      uniforms.time.value = seconds; uniforms.armed.value = armed
      const beat = .5 + .5 * Math.sin(seconds * (6 + armed * 28))
      const flicker = .92 + .08 * Math.sin(seconds * 53.1) * Math.sin(seconds * 17.3)
      glow.scale.setScalar((.3 + .05 * beat + armed * (.18 + .22 * beat)) * flicker)
      glowMaterial.opacity = Math.min(1, (.4 + .12 * beat + armed * .5) * flicker)
    },
  }
}
