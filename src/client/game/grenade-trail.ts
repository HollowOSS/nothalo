import * as THREE from 'three'

/** Short, wispy frag trails. Fixed storage and one draw call for the whole grenade pool. */
export class GrenadeTrail {
  private readonly count = 512
  private readonly positions = new Float32Array(this.count * 3)
  private readonly sizes = new Float32Array(this.count)
  private readonly alphas = new Float32Array(this.count)
  private readonly ages = new Float32Array(this.count).fill(1)
  private readonly geometry = new THREE.BufferGeometry()
  private readonly viewport = new THREE.Vector2()
  private cursor = 0
  readonly object: THREE.Points
  constructor(scene: THREE.Scene) {
    for (const [name, array, width] of [['position', this.positions, 3], ['size', this.sizes, 1], ['alpha', this.alphas, 1]] as const) {
      this.geometry.setAttribute(name, new THREE.BufferAttribute(array, width).setUsage(THREE.DynamicDrawUsage))
    }
    const material = new THREE.ShaderMaterial({
      uniforms: { viewportHeight: { value: 1000 } }, transparent: true, depthWrite: false,
      vertexShader: `
        attribute float size; attribute float alpha;
        uniform float viewportHeight;
        varying float opacity;
        void main() {
          vec4 view = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = clamp(viewportHeight * projectionMatrix[1][1] * size / max(.05, -view.z), 1.0, 64.0);
          opacity = alpha;
        }`,
      fragmentShader: `
        varying float opacity;
        void main() {
          vec2 p = gl_PointCoord - .5;
          float edge = 1.0 - smoothstep(.0, .5, length(p));
          float cloud = .75 + .25 * sin(p.x * 19.0 + sin(p.y * 15.0));
          float a = opacity * edge * cloud;
          if (a < .003) discard;
          gl_FragColor = vec4(.73, .75, .70, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })
    this.object = new THREE.Points(this.geometry, material)
    this.object.name = 'frag-grenade-smoke'; this.object.frustumCulled = false; this.object.visible = false
    this.object.onBeforeRender = renderer => { renderer.getDrawingBufferSize(this.viewport); material.uniforms.viewportHeight.value = this.viewport.y }
    scene.add(this.object)
  }
  emit(point: THREE.Vector3): void {
    const i = this.cursor++ % this.count
    this.positions.set(point.toArray(), i * 3); this.ages[i] = 0
    this.sizes[i] = .075; this.alphas[i] = .30
  }
  get activeCount(): number { let n = 0; for (const age of this.ages) if (age < .55) n++; return n }
  update(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      const age = this.ages[i] += dt
      if (age >= .55) { this.alphas[i] = 0; continue }
      this.positions[i * 3] += .025 * dt; this.positions[i * 3 + 1] += .07 * dt
      this.sizes[i] = .075 + age * .22
      this.alphas[i] = .30 * Math.pow(1 - age / .55, 1.4)
    }
    for (const name of ['position', 'size', 'alpha']) this.geometry.attributes[name].needsUpdate = true
    this.object.visible = this.activeCount > 0
  }
}
