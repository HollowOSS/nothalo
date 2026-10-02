import * as THREE from 'three'

export function sceneResources(scene: THREE.Scene) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>(), targets = new Set<THREE.RenderTarget>()
  const texture = (value: unknown) => { if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture) }
  scene.traverse(object => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry) geometries.add(mesh.geometry)
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material)
    const shadow = (object as THREE.Light & { shadow?: THREE.LightShadow }).shadow
    if (shadow?.map) targets.add(shadow.map)
    if (shadow?.mapPass) targets.add(shadow.mapPass)
  })
  for (const material of materials) {
    Object.values(material).forEach(texture)
    const uniforms = (material as THREE.ShaderMaterial).uniforms
    if (uniforms) for (const uniform of Object.values(uniforms)) {
      if (Array.isArray(uniform.value)) uniform.value.forEach(texture)
      else texture(uniform.value)
    }
  }
  texture(scene.background); texture(scene.environment)
  return { geometries, materials, textures, targets }
}

/** Conservative CPU + GPU estimate; compressed download size is not a useful residency budget. */
export function estimateSceneBytes(scene: THREE.Scene): number {
  const { geometries, textures, targets } = sceneResources(scene)
  const arrays = new Set<ArrayBufferLike>()
  for (const geometry of geometries) {
    const attributes = [...Object.values(geometry.attributes), ...Object.values(geometry.morphAttributes).flat()]
    if (geometry.index) attributes.push(geometry.index)
    for (const attr of attributes) arrays.add(('data' in attr ? attr.data.array : attr.array).buffer)
  }
  let bytes = [...arrays].reduce((sum, buffer) => sum + buffer.byteLength * 2, 0)
  for (const texture of textures) {
    const images = Array.isArray(texture.image) ? texture.image : [texture.image]
    for (const image of images) {
      const width = image?.width ?? 1, height = image?.height ?? 1
      const componentBytes = texture.type === THREE.FloatType ? 4 : texture.type === THREE.HalfFloatType ? 2 : 1
      bytes += width * height * (image?.depth ?? 1) * 4 * componentBytes * (texture.generateMipmaps ? 4 / 3 : 1) * 2
    }
  }
  for (const target of targets) bytes += target.width * target.height * 16
  return Math.ceil(bytes)
}

/** Dispose only resources not borrowed by another retained scene. Keep shared image sources valid. */
export function disposeScene(scene: THREE.Scene, retained: THREE.Scene[]): void {
  const live = retained.map(sceneResources), dead = sceneResources(scene)
  for (const key of ['geometries', 'materials', 'textures', 'targets'] as const) {
    const keep = new Set(live.flatMap(resources => [...resources[key]] as { dispose(): void }[]))
    for (const resource of dead[key]) if (!keep.has(resource)) resource.dispose()
  }
  scene.clear()
  scene.background = null; scene.environment = null; scene.userData = {}
}
