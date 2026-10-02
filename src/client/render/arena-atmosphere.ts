import * as THREE from 'three'
import {createSkyDome} from './sky.ts'
import {fitNormalBias} from './quality.ts'
import type {ArenaId} from '../../shared/arena.ts'

/**
 * Sky, sun, image-based light, haze and air for the imported arenas.
 *
 * The exports carry base-colour textures and nothing about their world: no sky, no light
 * direction, no shadows. Lit by a flat background colour and a hemisphere, every map read as
 * grey boxes in a grey room. Each map gets the parts Halo 3 builds its atmosphere from:
 *
 * - A sky dome (gradient, sun disc and glow, drifting cloud) that also becomes the scene's
 *   environment map, so metal, glass and wet surfaces reflect a sky and shaded sides pick up its
 *   colour instead of one flat ambient.
 * - A sun placed per map with shadows cast by the map itself. The map never moves, so the shadow
 *   map is rendered once (and again only if the quality scaler resizes it): no per-frame cost.
 * - Exponential haze matched to the sky's horizon, so distance reads as air.
 * - Motes drifting in the sunlight around the camera (sand on the desert maps, dust and pollen
 *   elsewhere), animated entirely in the vertex shader.
 */
export interface Atmosphere {
  zenith: number; horizon: number
  /** Towards the sun, in world space. */
  sun: THREE.Vector3; sunColor: number; sunIntensity: number
  sky: number; ground: number; ambient: number
  fog: number; exposure: number; environment: number
  /** Cloud cover, 0 clear to 1 overcast. */
  cloud: number
  dust: {color: number; count: number; size: number; wind: [number, number, number]; opacity: number}
}
export interface ArenaAtmosphere {
  sun: THREE.DirectionalLight
  update(time: number, camera: THREE.Vector3): void
  /** Replace the sky-only environment with one captured from inside the lit map (see below). */
  captureProbe(positions: readonly THREE.Vector3[]): void
}

const direction = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize()
export const ATMOSPHERES: Record<ArenaId, Atmosphere> = {
  // Blue hour over the canyon (sky.ts): a low golden sun under a darkening sky. At 58 degrees, near-white, under a
  // strong flat fill every cliff face came out the same even salmon. The sun now stands 27 degrees up on the same
  // bearing, deep gold; the fill is the cool blue of the sky, cut back so faces turned from the sun fall into shade.
  // Enough of it stays that a player in the walls' long shadows still reads at range. Warm bounce off the dirt.
  'blood-gulch': {zenith:0x1a2a66,horizon:0xa7b9dc,sun:direction(-.713,.454,.535),sunColor:0xffc488,sunIntensity:2.6,sky:0x8eaaea,ground:0x8a6448,ambient:2.1,fog:.0012,exposure:1.1,environment:.5,cloud:.25,dust:{color:0xffd6a0,count:80,size:.04,wind:[.3,.02,.1],opacity:.25}},
  // Kenyan training ground: low, warm late-afternoon sun streaming into the hangar from the runway
  // through its open end (azimuth 180°, 20° up: the angle that lights the most hangar floor).
  // Shade is cool, neutral concrete (Halo 3's hangar reads grey-white, not the olive the warm sky fill gave it); the
  // warmth comes from the sun and the shafts it pours through the open end.
  'the-pit': {zenith: 0x5a8ec4, horizon: 0xd9d6c8, sun: direction(0, .342, -.94), sunColor: 0xffd8a6, sunIntensity: 3.6,
    sky: 0xe2e7ec, ground: 0x857863, ambient: 2.3, fog: .0028, exposure: 1.25, environment: .42, cloud: .35,
    dust: {color: 0xfff0d0, count: 260, size: .05, wind: [.35, .02, .15], opacity: .45}},
  // Forerunner bridge over a chasm: high-key, bright and cold, washed in pale haze.
  narrows: {zenith: 0x7fa2c6, horizon: 0xdfe7ee, sun: direction(.34, .56, -.62), sunColor: 0xfff6ea, sunIntensity: 2.8,
    sky: 0xe6eef6, ground: 0x7a828c, ambient: 2, fog: .006, exposure: 1.45, environment: .7, cloud: .6,
    dust: {color: 0xeef6ff, count: 160, size: .04, wind: [1.2, -.05, .4], opacity: .35}},
  // Open desert under a dust-choked sky: beige haze overhead, sand on the wind, distance lost.
  // The sun stands lower (35 degrees) than it did: from overhead the dunes had no relief and the sand read as one flat
  // sheet; now each dune has a shaded side and the ruins throw long shadows. Less fill, so shade has some depth.
  sandtrap: {zenith: 0xa9a58f, horizon: 0xd8c6a0, sun: direction(.617, .574, .54), sunColor: 0xfff0d2, sunIntensity: 3,
    sky: 0xdcdcd0, ground: 0xa88c62, ambient: 1, fog: .0055, exposure: 1.05, environment: .45, cloud: .08,
    dust: {color: 0xe8cfa0, count: 520, size: .05, wind: [2.6, .1, 1.1], opacity: .55}},
  // Valhalla's own values (valhalla-look.ts builds its terrain and water on top).
  // A little more sun and a bluer sky fill: Halo 3's Valhalla has crisp sunlit grass and cool, sky-lit shade on the rock.
  valhalla: {zenith: 0x4f84bd, horizon: 0xc4d3dc, sun: direction(-.45, .62, .64), sunColor: 0xfff0d8, sunIntensity: 2.8,
    sky: 0xcfe0f5, ground: 0x6a6448, ambient: 1.7, fog: .0012, exposure: 1.05, environment: .6, cloud: .5,
    dust: {color: 0xfffbe8, count: 140, size: .04, wind: [.3, .05, .2], opacity: .35}},
  // A Forerunner cathedral in a desert canyon: pale stone, cool shade, glowing cyan glass.
  // The sun stands high over the canyon wall (azimuth 270°, 40° up), where it falls through the
  // most glass into the hall.
  epitaph: {zenith: 0x6f8fb8, horizon: 0xdccfbd, sun: direction(-.766, .643, 0), sunColor: 0xfff4e4, sunIntensity: 3.6,
    sky: 0xdfe6ea, ground: 0x8a7e70, ambient: 1.9, fog: .0022, exposure: 1.5, environment: .35, cloud: .28,
    dust: {color: 0xffdcb0, count: 300, size: .045, wind: [.9, .05, -.4], opacity: .45}},
  // Humid jungle garage: hazy sun and broken cloud, pollen and dust in the air.
  // Low afternoon sun from the west (azimuth 265°, 20° up) reaching in through the tunnel mouths,
  // the rock opening and the open-sided garages.
  // The garages' concrete is dark in its own textures: a strong, cool sky fill (Halo 3's fluorescent blue-grey) keeps the
  // tunnels legible, and a lower exposure keeps the sunlit apron and the haze from blowing out.
  'rats-nest': {zenith: 0x4f86c0, horizon: 0xc3cdd2, sun: direction(-.936, .342, -.082), sunColor: 0xffe6c0, sunIntensity: 2.8,
    sky: 0xdfe6ee, ground: 0x6f6a60, ambient: 4, fog: .003, exposure: 1.15, environment: .38, cloud: .45,
    dust: {color: 0xf6f0d8, count: 320, size: .04, wind: [.2, .06, .15], opacity: .45}},
}

/**
 * Surface response by Halo 3 shader family. Every imported material arrives fully rough and
 * non-metallic, so steel, Forerunner alloy, glass and concrete all read as the same chalk and
 * none of them catches the sun or the sky. Their names say what they are.
 */
const FINISHES: [RegExp, {roughness: number; metalness: number; environment?: number}][] = [
  [/glass/, {roughness: .08, metalness: 0, environment: 1.6}],
  // Forerunner alloy: satin, with a soft sky sheen.
  [/^(panel_|trim_trim|chill_(wall|metal|main|bridge|center)|waste_panel|copper|cust_copper|obelisk|for_metal|sal_floor|light_|altar_|man_cannon)/, {roughness: .5, metalness: .22}],
  // Worn human steel: girders, pipes, rails, hulls.
  [/(metal|girder|pipe|rail|pelican|bracket|corrug|grate|fence|boilerplate|cables|rustbucket)/, {roughness: .58, metalness: .3}],
  [/(floor|rubber|ramp)/, {roughness: .78, metalness: 0}],
]
export function finishSurface(material: THREE.Material): void {
  const standard = material as THREE.MeshStandardMaterial
  if (!standard.isMeshStandardMaterial) return
  const finish = FINISHES.find(([pattern]) => pattern.test(material.name))?.[1]
  if (!finish) return
  standard.roughness = finish.roughness; standard.metalness = finish.metalness
  if (finish.environment) standard.envMapIntensity = finish.environment
}
/** Glowing panels, lights and holographic glass: without bloom they read as flat paint, so they
 * are driven brighter than the export's unit emissive and tone mapping rolls them off to glow. */
export function brightenEmission(material: THREE.Material): void {
  const standard = material as THREE.MeshStandardMaterial
  if (standard.isMeshStandardMaterial && (standard.emissiveMap || standard.emissive.getHex())) standard.emissiveIntensity = 2.2
}

export function applyArenaAtmosphere(scene: THREE.Scene, renderer: THREE.WebGLRenderer, map: ArenaId, bounds: readonly number[], top: number): ArenaAtmosphere {
  const a = ATMOSPHERES[map], horizon = new THREE.Color(a.horizon)
  const [x0, x1, z0, z1] = bounds, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = a.exposure

  // ---- sky dome, and the environment map made from it ----
  const sky = map === 'blood-gulch' ? createSkyDome(a.sun) : new THREE.Mesh(new THREE.SphereGeometry(1800, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {horizon: {value: horizon}, zenith: {value: new THREE.Color(a.zenith)}, sun: {value: a.sun}, sunColor: {value: new THREE.Color(a.sunColor)}, cover: {value: a.cloud}, time: {value: 0}},
    vertexShader: `varying vec3 vDir;
void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform vec3 horizon; uniform vec3 zenith; uniform vec3 sun; uniform vec3 sunColor; uniform float cover; uniform float time; varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 11.3; a *= 0.5; } return v; }
void main() {
  vec3 d = normalize(vDir);
  float up = max(d.y, 0.0);
  vec3 col = mix(horizon, zenith, pow(up, 0.55));
  // Below the horizon: the same haze the fog fades distant ground into.
  if (d.y < 0.0) col = horizon * 0.96;
  float s = max(dot(d, normalize(sun)), 0.0);
  // Glow around the sun, warmest low in the sky where the light crosses the most air.
  col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.2 + pow(s, 3.0) * 0.06 * (1.0 - up));
  // Cloud: fbm on a flat layer overhead, thinning toward the horizon; lit edges toward the sun.
  if (d.y > 0.02) {
    vec2 uv = d.xz / (d.y + 0.12) * 1.6 + vec2(time * 0.004, time * 0.0015);
    float n = fbm(uv);
    float c = smoothstep(0.66 - cover * 0.3, 0.9 - cover * 0.25, n) * smoothstep(0.02, 0.18, d.y);
    vec3 cloud = mix(mix(vec3(0.93, 0.95, 0.97), horizon, 0.25) * (1.0 - cover * 0.18), sunColor, pow(s, 6.0) * 0.5);
    col = mix(col, cloud, c * 0.88);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`,
  }))
  sky.name = `${map}-sky`; sky.frustumCulled = false; sky.renderOrder = -1
  scene.add(sky)
  scene.background = null
  scene.fog = new THREE.FogExp2(horizon.clone(), a.fog)
  const pmrem = new THREE.PMREMGenerator(renderer), envScene = new THREE.Scene()
  envScene.add(sky.clone())
  scene.environment = pmrem.fromScene(envScene, .04).texture
  scene.environmentIntensity = a.environment
  pmrem.dispose()

  // ---- light ----
  scene.add(new THREE.HemisphereLight(a.sky, a.ground, a.ambient))
  const sun = new THREE.DirectionalLight(a.sunColor, a.sunIntensity)
  const extent = Math.hypot(x1 - x0, z1 - z0) / 2 + 12
  sun.target.position.set(cx, 0, cz); scene.add(sun.target)
  sun.position.copy(sun.target.position).addScaledVector(a.sun, extent + top + 60)
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, {left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 2 * (extent + top + 60)})
  // Normal offset grows with the texel: phones render the same map into a quarter of the pixels, and the quality
  // governor shrinks it on slow GPUs (quality.ts rescales the offset with it). A fixed 6 cm left Blood Gulch's
  // 450 m-wide map, at up to 1.75 m a texel, stippled with self-shadow acne all over its steep cliff faces.
  sun.userData.normalBiasPerTexel = .9; sun.userData.minNormalBias = .06
  fitNormalBias(sun); sun.shadow.bias = -.0004
  sun.shadow.autoUpdate = false; sun.shadow.needsUpdate = true
  scene.add(sun)

  // ---- air: motes in a box that travels with the camera ----
  const BOX = 36, count = a.dust.count
  const seeds = new Float32Array(count * 3), phase = new Float32Array(count)
  for (let i = 0; i < count; i++) { seeds[i * 3] = Math.random() * BOX; seeds[i * 3 + 1] = Math.random() * BOX * .5; seeds[i * 3 + 2] = Math.random() * BOX; phase[i] = Math.random() * 100 }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(seeds, 3))
  geometry.setAttribute('phase', new THREE.BufferAttribute(phase, 1))
  const dustUniforms = {time: {value: 0}, eye: {value: new THREE.Vector3()}, wind: {value: new THREE.Vector3(...a.dust.wind)}, color: {value: new THREE.Color(a.dust.color)},
    size: {value: a.dust.size * renderer.getPixelRatio()}, opacity: {value: a.dust.opacity}}
  const dust = new THREE.Points(geometry, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: true, uniforms: {...THREE.UniformsLib.fog, ...dustUniforms},
    vertexShader: `uniform float time; uniform vec3 eye; uniform vec3 wind; uniform float size; attribute float phase; varying float vFade;
#include <fog_pars_vertex>
void main() {
  const vec3 box = vec3(${BOX}.0, ${BOX / 2}.0, ${BOX}.0);
  // Drift with the wind plus a slow personal wander, wrapped into the box around the eye.
  vec3 p = position + wind * time + vec3(sin(time * 0.37 + phase), sin(time * 0.23 + phase * 1.7) * 0.6, cos(time * 0.31 + phase * 0.8)) * 0.8;
  p = mod(p - eye + box * 0.5, box) - box * 0.5 + eye;
  vec3 rel = (p - eye) / (box * 0.5);
  vFade = (1.0 - smoothstep(0.7, 1.0, max(abs(rel.x), max(abs(rel.y), abs(rel.z)))));
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  float depth = -mvPosition.z;
  vFade *= smoothstep(0.6, 2.5, depth);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = size * 900.0 / max(depth, 0.1);
  #include <fog_vertex>
}`,
    fragmentShader: `uniform vec3 color; uniform float opacity; varying float vFade;
#include <fog_pars_fragment>
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.1, r) * vFade * opacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(color, a);
  #include <fog_fragment>
}`,
  }))
  dust.name = `${map}-air`; dust.frustumCulled = false; dust.renderOrder = 2
  scene.add(dust)

  return {
    sun,
    captureProbe(positions) {
      // A reflection probe: the lit map seen from inside it at head height, blurred into the
      // scene's environment. Metal, wet floors and water then reflect walls, cliffs and floors
      // around them instead of open sky, and the diffuse part carries their colour as cheap
      // bounce light (a warm floor warms the walls; interiors stop turning sky-blue). One view
      // is biased by whatever stands next to it (Narrows' glowing pillars turned every surface
      // teal), so several are averaged, with glowing surfaces at their plain strength. Captured
      // once at load: the map never moves. Passing air motes are left out.
      const size = 128, target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType })
      const sum = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType })
      const camera = new THREE.CubeCamera(.3, 2000, target)
      const glowing: [THREE.MeshStandardMaterial, number][] = []
      scene.traverse(o => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
        if (m?.isMeshStandardMaterial && m.emissiveIntensity > 1) { glowing.push([m, m.emissiveIntensity]); m.emissiveIntensity = 1 }
      })
      const hidden = [dust].filter(o => o.visible)
      for (const o of hidden) o.visible = false
      // Accumulate each view into `sum` with equal weight: one face at a time, a screen-filling
      // quad that looks the face's directions up in the view just rendered.
      const add = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: { view: { value: target.texture }, face: { value: 0 }, weight: { value: 1 / positions.length } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `uniform samplerCube view; uniform int face; uniform float weight; varying vec2 vUv;
void main() {
  vec2 c = vUv; vec3 d;
  if (face == 0) d = vec3(1.0, -c.y, -c.x); else if (face == 1) d = vec3(-1.0, -c.y, c.x);
  else if (face == 2) d = vec3(c.x, 1.0, c.y); else if (face == 3) d = vec3(c.x, -1.0, -c.y);
  else if (face == 4) d = vec3(c.x, -c.y, 1.0); else d = vec3(-c.x, -c.y, -1.0);
  gl_FragColor = vec4(textureCube(view, d).rgb * weight, 1.0);
}`,
        depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      }))
      const quadScene = new THREE.Scene(), quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
      quadScene.add(add)
      const previousTarget = renderer.getRenderTarget(), autoClear = renderer.autoClear
      const clearColor = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha()
      for (let face = 0; face < 6; face++) { renderer.setRenderTarget(sum, face); renderer.setClearColor(0x000000, 1); renderer.clear() }
      for (const position of positions) {
        camera.position.copy(position); sky.position.copy(position)
        camera.update(renderer, scene)
        renderer.autoClear = false
        for (let face = 0; face < 6; face++) {
          (add.material as THREE.ShaderMaterial).uniforms.face.value = face
          renderer.setRenderTarget(sum, face); renderer.render(quadScene, quadCamera)
        }
        renderer.autoClear = autoClear
      }
      renderer.setRenderTarget(previousTarget)
      renderer.setClearColor(clearColor, clearAlpha)
      for (const o of hidden) o.visible = true
      for (const [m, intensity] of glowing) m.emissiveIntensity = intensity
      const generator = new THREE.PMREMGenerator(renderer)
      const previous = scene.environment
      scene.environment = generator.fromCubemap(sum.texture).texture
      // The map below the horizon is darker than the sky's haze was: keep shade as bright as before.
      scene.environmentIntensity = a.environment * 1.3
      generator.dispose(); target.dispose(); sum.dispose(); previous?.dispose()
      add.geometry.dispose(); (add.material as THREE.Material).dispose()
    },
    update(time, camera) {
      sky.position.copy(camera)
      const clock = (sky.material as THREE.ShaderMaterial).uniforms.time
      if(clock)clock.value = time
      dustUniforms.time.value = time
      dustUniforms.eye.value.copy(camera)
    },
  }
}
