import * as THREE from 'three'

/**
 * Guardian's light, without a lightmap bake (reference/guardian/GAPS.md, sections 1 and 5).
 *
 * The Halo Online export arrives with base colours only: no self-illumination on 36 of its 39
 * materials, no bounce, opaque glass. Lit by one sun, a hemisphere and a fill, every room read as
 * the same near-black teal. Halo 3's identity is its coloured light: a warm gold Gold room, a pale
 * steel-blue Blue room, a teal Bottom Blue hall. Everything here is paid for once, at load:
 *
 * - Zone light, baked per vertex. Each room is a soft-edged box of coloured ambient, and each
 *   launcher a small light that washes the walls and floor around it. The sum is evaluated once
 *   on the CPU for every vertex of the imported mesh (about 120k) into a `guardianLight`
 *   attribute, which the materials add to their indirect light: one varying, no per-pixel loop,
 *   no real-time lights.
 * - Self-illumination restored with masks derived from each material's own albedo in the shader
 *   (the navy panels of the Top Mid pylons, the bright tracery of the warm ceiling plates, the
 *   lit lines of the ring platform strips), so no new textures and one extra multiply-add.
 * - The Top Mid glass made glass again: see-through, with a faint cyan self-lit tint and a
 *   Fresnel sheen, so the glowing fins under it read.
 */

type Vec3 = readonly [number, number, number]
/** A room: a box of coloured light with feathered edges. `up` brightens up-facing surfaces
 * (floors catch the ceiling light) and darkens down-facing ones, around the flat `base`. */
interface Zone { name: string; min: Vec3; max: Vec3; feather: number; color: number; intensity: number; base?: number; up?: number }
/** A light washing its surroundings: a point or a vertical segment, with a smooth range. */
interface Pool { name: string; a: Vec3; b?: Vec3; range: number; color: number; intensity: number }

/** World frame as in guardian-nav-meta.ts: Top Mid at the origin (floor y 14), Gold at -X,
 * Sniper at +X, Green at -Z, Blue and Bottom Blue at +Z. Extents are the rooms' own floors,
 * ceilings and walls, measured from the imported mesh. Intensities are irradiance, like the
 * hemisphere's 1.35: the result is multiplied by albedo / pi. */
const ZONES: Zone[] = [
  // Gold building. Lower hall: lift base, corridor strips, walls in warm gold/beige.
  { name: 'gold-lower', min: [-41.5, 6.3, -12.5], max: [-23.5, 13.2, 15.5], feather: 2.2, color: 0xf4e2b0, intensity: 4.2, base: .9, up: .25 },
  // Upper floor round the lift's top, under the warm ceiling panels.
  { name: 'gold-upper', min: [-38.5, 13.2, -11], max: [-19, 21, 13.5], feather: 2.2, color: 0xf6e7bc, intensity: 4.8, base: .9, up: .25 },
  // Gold's south wing towards Blue (warm ceiling plates at y 20-22).
  { name: 'gold-wing', min: [-41, 14.5, 13.5], max: [-22, 24, 33.5], feather: 2.5, color: 0xf0e2bc, intensity: 3.2, base: .9, up: .2 },
  // Blue room: pale steel blue, a little violet from the ceiling.
  { name: 'blue-room', min: [-22, 16.2, 17.5], max: [-4.5, 24, 34.5], feather: 2.2, color: 0x7ea4f6, intensity: 6.2, base: .95, up: .15 },
  // Bottom Blue / shotgun hall: a saturated teal wash.
  { name: 'bottom-blue', min: [-31, 8.8, 16.5], max: [-2.5, 16.2, 44], feather: 2.2, color: 0x4ed8b0, intensity: 4.2, base: .9, up: .2 },
  // Sniper tower interior: cool, neutral.
  { name: 'sniper', min: [18.5, 8, -7.5], max: [33.5, 21.5, 9.5], feather: 2, color: 0xb4d6d8, intensity: 2.0, base: .9, up: .2 },
  // The room under Top Mid, lit by the fins through the glass: pale cyan.
  { name: 'under-mid', min: [-10.5, 7.5, -10.5], max: [10.5, 13.6, 10.5], feather: 2, color: 0x9fe8ee, intensity: 1.5, base: .9, up: .2 },
]
const POOLS: Pool[] = [
  // The Gold lift's channel spills gold along the shaft and onto both floors.
  { name: 'gold-lift', a: [-40.2, 7.2, .1], b: [-40.2, 22, .1], range: 9, color: 0xffc766, intensity: 7 },
  // Man cannons and boosters: a cyan wash on the pedestal, floor and nearby walls.
  { name: 'green-cannon', a: [-8.44, 9.4, -30.96], range: 6.5, color: 0x6fe0f0, intensity: 4 },
  { name: 'snipe-cannon', a: [7.36, 10.6, 29.14], range: 6.5, color: 0x6fe0f0, intensity: 4 },
  { name: 'sniper-booster', a: [15.53, 19.5, 5.77], range: 4.5, color: 0x7fe6f6, intensity: 3.2 },
  { name: 'camo-booster', a: [-17.43, 15.7, -7.09], range: 4.5, color: 0x7fe6f6, intensity: 3.2 },
  // Top Mid's fins light the underside of the platform's rim.
  { name: 'mid-fins', a: [0, 13.2, 0], range: 11, color: 0xbff4ff, intensity: 1.4 },
]

const TREES = /^guardian_tree_/
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** The baked light of one vertex (world position and normal), as linear irradiance. */
function lightAt(p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color, zones: {z: Zone; c: THREE.Color}[], pools: {p: Pool; c: THREE.Color}[]): THREE.Color {
  out.setRGB(0, 0, 0)
  for (const {z, c} of zones) {
    const f = z.feather
    if (p.x < z.min[0] - f || p.x > z.max[0] + f || p.y < z.min[1] - f || p.y > z.max[1] + f || p.z < z.min[2] - f || p.z > z.max[2] + f) continue
    const w = smooth(z.min[0] - f, z.min[0] + f, p.x) * (1 - smooth(z.max[0] - f, z.max[0] + f, p.x))
      * smooth(z.min[1] - f, z.min[1] + f, p.y) * (1 - smooth(z.max[1] - f, z.max[1] + f, p.y))
      * smooth(z.min[2] - f, z.min[2] + f, p.z) * (1 - smooth(z.max[2] - f, z.max[2] + f, p.z))
    if (w <= 0) continue
    const k = w * z.intensity * Math.max(0, (z.base ?? 1) + (z.up ?? 0) * n.y)
    out.r += c.r * k; out.g += c.g * k; out.b += c.b * k
  }
  for (const {p: pool, c} of pools) {
    // Closest point on the (possibly zero-length) segment.
    const [ax, ay, az] = pool.a, [bx, by, bz] = pool.b ?? pool.a
    const dx = bx - ax, dy = by - ay, dz = bz - az, len2 = dx * dx + dy * dy + dz * dz
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - ax) * dx + (p.y - ay) * dy + (p.z - az) * dz) / len2)) : 0
    const lx = ax + dx * t - p.x, ly = ay + dy * t - p.y, lz = az + dz * t - p.z
    const d = Math.hypot(lx, ly, lz)
    if (d >= pool.range) continue
    // Smooth window like three's point lights, over a gentle 1/(1+d^2) falloff; a wrapped N.L so
    // the wash reaches round corners rather than cutting off hard.
    const window = (1 - (d / pool.range) ** 4) ** 2
    const facing = d > 1e-3 ? (n.x * lx + n.y * ly + n.z * lz) / d : 1
    const k = pool.intensity * window / (1 + .35 * d * d) * Math.max(0, (facing + .35) / 1.35)
    out.r += c.r * k; out.g += c.g * k; out.b += c.b * k
  }
  return out
}

/** Bake zone and pool light into a `guardianLight` attribute on every mesh under `model`.
 * World matrices must be current. About 120k vertices: a few tens of milliseconds, once. */
export function bakeGuardianLight(model: THREE.Object3D): number {
  const zones = ZONES.map(z => ({z, c: new THREE.Color(z.color)}))
  const pools = POOLS.map(p => ({p, c: new THREE.Color(p.color)}))
  const p = new THREE.Vector3(), n = new THREE.Vector3(), c = new THREE.Color(), normalMatrix = new THREE.Matrix3()
  let count = 0
  model.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry
    const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
    if (!position || geometry.getAttribute('guardianLight')) return
    // The giant trunks are outdoors even where they pass a room's box: sky and sun light only.
    const outdoors = !Array.isArray(mesh.material) && TREES.test(mesh.material.name)
    normalMatrix.getNormalMatrix(mesh.matrixWorld)
    const light = new Float32Array(position.count * 3)
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)
      if (normal) n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize(); else n.set(0, 1, 0)
      if (outdoors) c.setRGB(0, 0, 0); else lightAt(p, n, c, zones, pools)
      light[i * 3] = c.r; light[i * 3 + 1] = c.g; light[i * 3 + 2] = c.b
    }
    geometry.setAttribute('guardianLight', new THREE.BufferAttribute(light, 3))
    count += position.count
  })
  return count
}

/** Self-illumination masks, computed in the shader from the material's own (linear) albedo. */
type Mask = 'navy' | 'bright' | 'plate' | 'channel'
interface Glow { mask: Mask; color: number; intensity: number }
const GLOWS: Record<string, Glow> = {
  // Top Mid pylons: the navy-painted panels and chevrons are the lit parts (albedo-as-glow would be navy).
  guardian_braces_light: { mask: 'navy', color: 0xe8fbff, intensity: 3.2 },
  // The navy strips on the braces round Top Mid.
  guardian_braces_side: { mask: 'navy', color: 0xcff6ff, intensity: 2.2 },
  // Gold room ceiling plates: the whole plate glows warm, its tracery brightest.
  guardian_int_light_warm: { mask: 'plate', color: 0xffd48a, intensity: 3.2 },
  // Gold corridor floor-edge strips: only the lit lines.
  cit_ringplatform_light: { mask: 'bright', color: 0xfff1d6, intensity: 3.6 },
  // Faint cyan in the blue-grey inset channels of the tech trim.
  guardian_panel_tech_trim: { mask: 'channel', color: 0x7fe6ff, intensity: .5 },
}
const MASKS: Record<Mask, string> = {
  navy: 'smoothstep(1.28, 1.5, gC.b / max(max(gC.r, gC.g), .004))',
  bright: 'smoothstep(.03, .085, dot(gC, vec3(.2126, .7152, .0722)))',
  plate: '(.18 + .82 * smoothstep(.012, .036, dot(gC, vec3(.2126, .7152, .0722))))',
  channel: 'smoothstep(1.035, 1.1, gC.b / max(max(gC.r, gC.g), .004)) * (1.0 - smoothstep(.1, .14, dot(gC, vec3(.2126, .7152, .0722))))',
}

/** Glass: see-through, faintly self-lit cyan, with a Fresnel sheen of the sky. */
const GLASS = /^guardian_glass_platform$/
/** The fins under the Top Mid glass (already emissive in the export, too dim to read). */
const FINS = 'guardian_centerplatform_metalunderglass'

/**
 * Dress every material under `model`: the baked zone light for all, glows and glass by name.
 * Call once, after the model's world matrices are final and `bakeGuardianLight` has run.
 */
export function dressGuardianMaterials(model: THREE.Object3D, sky: THREE.Color): void {
  const done = new Set<THREE.Material>()
  model.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshLambertMaterial[]) {
      // Glass lets the sun through: it does not block the god rays.
      if (GLASS.test(material.name)) { mesh.renderOrder = 2; mesh.castShadow = false }
      if (done.has(material)) continue
      done.add(material)
      dress(material, sky)
    }
  })
}

function dress(material: THREE.MeshLambertMaterial, sky: THREE.Color): void {
  const glow = GLOWS[material.name]
  const glass = GLASS.test(material.name)
  if (material.name === FINS) { material.emissive.set(0xcff6ff); material.emissiveIntensity = 3 }
  if (glass) {
    material.transparent = true; material.opacity = .3; material.depthWrite = false
    material.emissive.set(0x8fd8e0); material.emissiveIntensity = .45
  }
  const glowColor = glow ? new THREE.Color(glow.color).multiplyScalar(glow.intensity) : null
  const previous = material.onBeforeCompile
  material.onBeforeCompile = function(shader, renderer) {
    previous.call(this, shader, renderer)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 guardianLight;\nvarying vec3 vGuardianLight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGuardianLight = guardianLight;')
    let fragment = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGuardianLight;')
      // Baked room and launcher light joins the hemisphere as indirect light.
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\nirradiance += vGuardianLight;')
    if (glowColor) {
      shader.uniforms.guardianGlow = { value: glowColor }
      fragment = fragment
        .replace('#include <common>', '#include <common>\nuniform vec3 guardianGlow;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n{ vec3 gC = diffuseColor.rgb; totalEmissiveRadiance += guardianGlow * ${MASKS[glow!.mask]}; }`)
    }
    if (glass) {
      shader.uniforms.guardianSky = { value: sky }
      fragment = fragment
        .replace('#include <common>', '#include <common>\nuniform vec3 guardianSky;')
        // Opaque and bright at grazing angles, clear looking down onto it.
        .replace('#include <opaque_fragment>', `{ float gF = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 4.0);
  outgoingLight += guardianSky * gF * .9; diffuseColor.a = mix(diffuseColor.a, .82, gF); }
#include <opaque_fragment>`)
    }
    shader.fragmentShader = fragment
  }
  const key = material.customProgramCacheKey()
  material.customProgramCacheKey = () => `${key}|guardian-light:${glow?.mask ?? ''}:${glass ? 'glass' : ''}`
  material.needsUpdate = true
}

/** Haze, as seen: Halo 3's teal-green air (measured #2c6254 to #337567 on screen). The fog and the
 * sky dome share it, and the dome is tone mapped like the world, so fogged distance and sky meet. */
export const GUARDIAN_FOG = 0x2f6a5c
export const GUARDIAN_SKY = new THREE.Color(0x6fa89a)

const SKY_VERTEX = /* glsl */`
varying vec3 vDir;
void main(){
  vDir=position;
  // Centred on the eye and pinned to the far plane: only sky pixels are ever shaded.
  vec4 p=projectionMatrix*viewMatrix*vec4(cameraPosition+position*400.0,1.0);
  gl_Position=p.xyww;
}`
const SKY_FRAGMENT = /* glsl */`
uniform vec3 uFog;uniform vec3 uHigh;uniform vec3 uLow;uniform vec3 uShaft;
varying vec3 vDir;
float h11(float x){return fract(sin(x*127.1)*43758.5453);}
float n11(float x){float i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);return mix(h11(i),h11(i+1.0),f);}
void main(){
  vec3 d=normalize(vDir);
  float az=atan(d.z,d.x);
  // Brighter, greener haze towards the canopy; deep green below the horizon.
  vec3 col=mix(uFog,uHigh,smoothstep(.02,.85,d.y));
  col=mix(col,uLow,smoothstep(0.0,-.55,d.y));
  // Giant trunks lost in the haze: soft dark columns, strongest at the horizon, fading up and down.
  float t1=smoothstep(.55,.8,n11(az*9.0+3.0)),t2=smoothstep(.6,.85,n11(az*17.0+11.0));
  float band=(1.0-smoothstep(.05,.75,abs(d.y+.05)));
  col*=1.0-.28*band*max(t1,t2*.7);
  // Faint vertical light shafts falling from the canopy.
  float s=smoothstep(.45,.8,n11(az*5.0+5.0)*n11(az*13.0+1.7)*1.6)*smoothstep(-.2,.5,d.y)*(1.0-smoothstep(.55,.95,d.y));
  col+=uShaft*s*.08;
  gl_FragColor=vec4(col,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

/** A sky dome that is not flat: canopy-lit haze above, fading trunk silhouettes, faint shafts.
 * One draw of sky pixels only (pinned to the far plane, drawn after the opaque world). */
export function createGuardianSky(): THREE.Mesh {
  const fog = new THREE.Color(GUARDIAN_FOG)
  const material = new THREE.ShaderMaterial({
    name: 'guardian-sky',
    uniforms: {
      uFog: { value: fog }, uHigh: { value: new THREE.Color(0x4f9a86) }, uLow: { value: new THREE.Color(0x163a30) },
      uShaft: { value: new THREE.Color(0xcfeedd) },
    },
    vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide, depthWrite: false, fog: false,
  })
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material)
  sky.name = 'guardian-sky'
  sky.frustumCulled = false
  sky.renderOrder = 1
  sky.matrixAutoUpdate = false
  return sky
}

const AMBIENT_VERTEX = /* glsl */`
attribute vec3 aCenter;attribute vec3 aAxis;attribute vec2 aCorner;attribute vec2 aSize;attribute vec4 aParams;
uniform float uTime;uniform float uFogDensity;
varying vec2 vUv;varying vec4 vParams;varying float vAlpha;
void main(){
  float mode=aParams.x,seed=aParams.z;
  vec3 axis=normalize(aAxis);
  vec3 center=aCenter;
  if(mode>.5)center.y+=sin(uTime*.9+seed*6.2832)*.06;
  vec3 toCamera=cameraPosition-center;float dist=length(toCamera);
  // Billboard round the axis: a shaft keeps its slant, a hologram stays upright.
  vec3 side=normalize(cross(axis,toCamera/max(dist,1e-4)));
  vec3 p=center+side*aCorner.x*aSize.x*.5+axis*aCorner.y*aSize.y*.5;
  vUv=aCorner;vParams=aParams;
  float near=mode<.5?smoothstep(4.0,14.0,dist):smoothstep(.6,2.2,dist);
  vAlpha=near*exp(-uFogDensity*uFogDensity*dist*dist*(mode<.5?.25:1.0));
  gl_Position=vAlpha>.002?projectionMatrix*viewMatrix*vec4(p,1.0):vec4(0.0,0.0,2.0,1.0);
}`
const AMBIENT_FRAGMENT = /* glsl */`
uniform float uTime;uniform sampler2D uGlyphs;
varying vec2 vUv;varying vec4 vParams;varying float vAlpha;
void main(){
  float mode=vParams.x,cell=vParams.y,seed=vParams.z,gain=vParams.w;
  vec3 col;float a;
  if(mode<.5){
    // Light shaft: soft across, fading in under the canopy and out towards the ground.
    float across=exp(-vUv.x*vUv.x*3.5);
    float along=smoothstep(-1.0,-.55,vUv.y)*(1.0-smoothstep(.55,1.0,vUv.y));
    a=across*along*gain;col=vec3(.82,.96,.9);
  }else{
    // Forerunner hologram: a column of cyan glyphs, a drifting scanline and a slow flicker.
    vec2 uv=vec2((cell+(vUv.x*.5+.5))*.25,vUv.y*.5+.5);
    float g=texture2D(uGlyphs,uv).r;
    float scan=.75+.25*sin(vUv.y*60.0-uTime*6.0+seed*20.0);
    float flicker=.85+.15*sin(uTime*13.0+seed*40.0)*sin(uTime*3.1+seed*9.0);
    a=g*scan*flicker*gain;col=vec3(.35,.9,1.0)*1.6;
  }
  a*=vAlpha;
  if(a<.003)discard;
  gl_FragColor=vec4(col,a);
}`

/** Four columns of stacked Forerunner-style glyphs, white on black (the shader tints them). */
function glyphAtlas(): THREE.Texture {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256
  const g = canvas.getContext('2d')!
  g.fillStyle = '#000'; g.fillRect(0, 0, 512, 256)
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 5; g.lineCap = 'round'
  const ring = (x: number, y: number, r: number) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke() }
  const bar = (x: number, y: number, w: number, h: number) => g.fillRect(x - w / 2, y - h / 2, w, h)
  for (let c = 0; c < 4; c++) {
    const x = c * 128 + 64
    if (c === 0) { ring(x, 190, 34); ring(x, 190, 16); bar(x, 190, 6, 50); bar(x, 110, 60, 8); bar(x, 88, 40, 8); ring(x, 40, 14) }
    else if (c === 1) { for (let k = 0; k < 4; k++) { bar(x - 18, 200 - k * 44, 26, 26); bar(x + 18, 200 - k * 44, 26, 26) } }
    else if (c === 2) { ring(x, 175, 40); g.beginPath(); g.moveTo(x - 28, 175); g.lineTo(x + 28, 175); g.moveTo(x, 147); g.lineTo(x, 203); g.stroke(); bar(x, 90, 70, 6); bar(x, 70, 50, 6); bar(x, 50, 30, 6) }
    else { g.beginPath(); g.moveTo(x, 230); g.lineTo(x - 36, 170); g.lineTo(x, 110); g.lineTo(x + 36, 170); g.closePath(); g.stroke(); ring(x, 170, 12); bar(x - 20, 60, 8, 50); bar(x + 20, 60, 8, 50); bar(x, 40, 8, 30) }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace
  texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter
  return texture
}

/** Light shafts under the canopy and cyan holograms round Top Mid: one merged mesh, one draw,
 * animated only in the shader from the scene clock. */
export function createGuardianAmbientFx(fog: THREE.FogExp2, sunDirection: THREE.Vector3): { mesh: THREE.Mesh; update(time: number): void } {
  const centers: number[] = [], axes: number[] = [], corners: number[] = [], sizes: number[] = [], params: number[] = [], index: number[] = []
  const add = (c: Vec3, axis: THREE.Vector3, w: number, h: number, mode: number, cell: number, seed: number, gain: number) => {
    const start = corners.length / 2
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      centers.push(...c); axes.push(axis.x, axis.y, axis.z); corners.push(u, v); sizes.push(w, h); params.push(mode, cell, seed, gain)
    }
    index.push(start, start + 1, start + 2, start, start + 2, start + 3)
  }
  // Shafts fall along the sunlight, through the gaps round the arena, in the haze beyond the decks.
  const along = sunDirection.clone().normalize()
  const shafts: [number, number, number, number][] = [[-30, -34, 7, .07], [26, -30, 9, .06], [36, 22, 8, .07], [-46, 12, 10, .05], [4, 46, 7, .06], [-22, 40, 6, .05], [48, -6, 11, .05], [-6, -52, 9, .05]]
  shafts.forEach(([x, z, w, gain], i) => add([x, 26, z], along, w, 90, 0, 0, i * .37, gain))
  // Holograms: just outside Top Mid's rim beside the pylons, and at the walkway ends.
  const up = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < 8; i++) {
    const a = (i * 45 + 22.5 + (i % 2 ? 11 : -11)) * Math.PI / 180, r = 13.4
    add([Math.sin(a) * r, 16.1 + (i % 3) * .25, Math.cos(a) * r], up, .9, 1.9, 1, i % 4, i * .61, .9)
  }
  const extra: Vec3[] = [[-19.5, 17.4, 5.2], [-19.5, 17.4, -5.2], [14.5, 20.6, 9.5], [-15.5, 17.4, -10.5], [3.5, 16.2, 19.8], [-3.5, 16.2, -19.8], [21, 15.6, -9], [-9.5, 19.4, 18.2]]
  extra.forEach((c, i) => add(c, up, .8, 1.7, 1, (i + 2) % 4, i * .83 + .3, .8))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(centers, 3))
  geometry.setAttribute('aCenter', new THREE.Float32BufferAttribute(centers, 3))
  geometry.setAttribute('aAxis', new THREE.Float32BufferAttribute(axes, 3))
  geometry.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 2))
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 2))
  geometry.setAttribute('aParams', new THREE.Float32BufferAttribute(params, 4))
  geometry.setIndex(index)
  const time = { value: 0 }
  const material = new THREE.ShaderMaterial({
    name: 'guardian-ambient-fx',
    uniforms: { uTime: time, uFogDensity: { value: fog.density }, uGlyphs: { value: glyphAtlas() } },
    vertexShader: AMBIENT_VERTEX, fragmentShader: AMBIENT_FRAGMENT,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'guardian-ambient-fx'
  mesh.frustumCulled = false
  mesh.renderOrder = 4
  mesh.matrixAutoUpdate = false
  return { mesh, update(now) { time.value = now % 1200 } }
}
