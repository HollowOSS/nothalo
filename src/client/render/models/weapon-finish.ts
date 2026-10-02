import * as THREE from 'three'

/**
 * A plain, matte finish for the imported weapons.
 *
 * Most of the downloaded guns were exported with spec/gloss materials. Converted to metal/rough they arrive as
 * MeshPhysicalMaterial with KHR_materials_specular colour maps and an index of refraction of 1000, which drives the
 * Fresnel reflectance to ~1: every surface turns into a mirror at grazing angles and the bright texels of the spec map
 * read as chrome. Halo's weapons are painted metal and coated polymer. This resets the dielectric response to a normal
 * 1.5 IOR with no specular colour maps and no clearcoat, keeping each material's own colour, roughness and normal maps.
 * Shared by the world/LOD and first-person loaders; never touches the arms, screens, blades or crystals (emissive only).
 */
export function finishWeapon(material: THREE.Material): void {
  const m = material as THREE.MeshPhysicalMaterial
  if (!m.isMeshStandardMaterial || m.userData.weaponFinish) return
  m.userData.weaponFinish = true
  if (m.isMeshPhysicalMaterial) {
    m.ior = 1.5; m.specularIntensity = 1; m.specularColor.set(0xffffff); m.specularColorMap = null; m.specularIntensityMap = null
    m.clearcoat = 0; m.sheen = 0; m.iridescence = 0
  }
  // a uniform (map-less) roughness of 1 on a spec/gloss conversion is "unknown", not "chalk": painted metal sits around .55
  if (!m.roughnessMap && m.roughness >= .99 && !m.emissiveMap) m.roughness = .6
  if (m.normalMap) m.normalScale.y = Math.abs(m.normalScale.y)
  for (const texture of [m.map, m.normalMap, m.roughnessMap]) if (texture) texture.anisotropy = 4
  m.needsUpdate = true
}
