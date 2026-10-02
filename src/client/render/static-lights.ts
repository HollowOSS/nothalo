import * as THREE from 'three'

/** Static lights are compiled per material/scene, so cached maps never alter global shaders. */
type Lighting = { key: string; block: string }
const lighting = new WeakMap<THREE.Scene, Lighting>()
const applied = new WeakMap<THREE.Material, { key: string; compile: THREE.Material['onBeforeCompile']; cacheKey: string }>()

function prepareMaterial(material: THREE.Material, scene: THREE.Scene): void {
  const spec = lighting.get(scene)
  const key = spec?.key ?? 'none'
  let state = applied.get(material)
  if (state?.key === key) return
  if (!state) state = { key, compile: material.onBeforeCompile, cacheKey: material.customProgramCacheKey() }
  state.key = key
  const original = state.compile
  material.onBeforeCompile = function(shader, renderer) {
    original.call(this, shader, renderer)
    if (!spec) return
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>' + WORLD_VARYING)
      .replace('#include <project_vertex>', THREE.ShaderChunk.project_vertex.replace(PROJECT, PROJECT + WORLD_WRITE))
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>' + WORLD_VARYING)
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(ANCHOR, ANCHOR + spec.block))
  }
  material.customProgramCacheKey = () => state!.cacheKey + '|static-lights:' + key
  material.needsUpdate = true
  applied.set(material, state)
}
// Material's render hook covers late-arriving models and effects without another scene traversal
// on every frame. Preserve any inherited hook; object-specific animation hooks are unaffected.
const beforeRender = THREE.Material.prototype.onBeforeRender
THREE.Material.prototype.onBeforeRender = function(renderer, scene, camera, geometry, object, group) {
  beforeRender.call(this, renderer, scene, camera, geometry, object, group)
  prepareMaterial(this, scene)
}
/** compileAsync does not invoke render hooks. Prepare its materials explicitly. */
export function prepareStaticLightMaterials(scene: THREE.Scene): void {
  scene.traverse(object => {
    const material = (object as THREE.Mesh).material
    if (material) for (const item of Array.isArray(material) ? material : [material]) prepareMaterial(item, scene)
  })
}
const ANCHOR = 'IncidentLight directLight;\n'
const PROJECT = 'gl_Position = projectionMatrix * mvPosition;'
/** Every built-in shader includes <common> in both stages, so the varying is declared there; it is
 * written beside the projection, including instancing and batching like three's own world
 * position. Range checks against it cost a subtraction and a dot product per light. */
const WORLD_VARYING = '\nvarying vec3 vStaticLightWorld;\n'
const WORLD_WRITE = `
vec4 staticLightWorld = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	staticLightWorld = batchingMatrix * staticLightWorld;
#endif
#ifdef USE_INSTANCING
	staticLightWorld = instanceMatrix * staticLightWorld;
#endif
vStaticLightWorld = ( modelMatrix * staticLightWorld ).xyz;
`

export function bakeStaticPointLights(scene: THREE.Scene): number {
  scene.updateMatrixWorld(true)
  const lights: THREE.PointLight[] = []
  scene.traverse(object => {
    const light = object as THREE.PointLight
    // A zero distance means unlimited reach, which has no range to skip.
    if (light.isPointLight && light.userData.staticLight && light.distance > 0 && !light.castShadow) lights.push(light)
  })
  const chunk = THREE.ShaderChunk.lights_fragment_begin
  if (lights.length === 0 || !chunk.includes(ANCHOR) || !THREE.ShaderChunk.project_vertex.includes(PROJECT)) {
    if (lights.length) console.warn('Static lights left dynamic: three.js lighting chunk changed shape')
    return 0
  }
  const f = (n: number) => n.toFixed(6)
  const vec3 = (v: { x: number; y: number; z: number }) => `vec3(${f(v.x)},${f(v.y)},${f(v.z)})`
  const position = new THREE.Vector3()
  const rows = lights.map(light => {
    light.getWorldPosition(position)
    // WebGLLights uploads colour × intensity in linear working space; this is the same product.
    const colour = { x: light.color.r * light.intensity, y: light.color.g * light.intensity, z: light.color.b * light.intensity }
    return { position: vec3(position), colour: vec3(colour), range: f(light.distance), rangeSq: f(light.distance * light.distance), decay: f(light.decay) }
  })
  const n = rows.length
  const block = `
const vec3 STATIC_POINT_POSITION[${n}] = vec3[${n}](${rows.map(r => r.position).join(',')});
const vec3 STATIC_POINT_COLOR[${n}] = vec3[${n}](${rows.map(r => r.colour).join(',')});
const float STATIC_POINT_RANGE_SQ[${n}] = float[${n}](${rows.map(r => r.rangeSq).join(',')});
const float STATIC_POINT_RANGE[${n}] = float[${n}](${rows.map(r => r.range).join(',')});
const float STATIC_POINT_DECAY[${n}] = float[${n}](${rows.map(r => r.decay).join(',')});
#if defined( RE_Direct )
for ( int i = 0; i < ${n}; i ++ ) {
	vec3 staticLightVector = STATIC_POINT_POSITION[ i ] - vStaticLightWorld;
	float staticLightDistanceSq = dot( staticLightVector, staticLightVector );
	if ( staticLightDistanceSq >= STATIC_POINT_RANGE_SQ[ i ] ) continue;
	// In range: the rest mirrors getPointLightInfo, turned into view space like three's own lights.
	float staticLightDistance = sqrt( staticLightDistanceSq );
	directLight.direction = normalize( mat3( viewMatrix ) * staticLightVector );
	directLight.color = STATIC_POINT_COLOR[ i ] * getDistanceAttenuation( staticLightDistance, STATIC_POINT_RANGE[ i ], STATIC_POINT_DECAY[ i ] );
	directLight.visible = true;
	RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
}
#endif
`
  let hash = 2166136261
  for (let i = 0; i < block.length; i++) hash = Math.imul(hash ^ block.charCodeAt(i), 16777619)
  lighting.set(scene, { key: String(hash >>> 0), block })
  prepareStaticLightMaterials(scene)
  // Per-scene shader code supplies these lights; remove their dynamic counterparts.
  for (const light of lights) light.removeFromParent()
  return n
}
