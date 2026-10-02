import * as THREE from 'three'

export function rendererSettings(renderer: THREE.WebGLRenderer) {
  return { toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
    shadows: renderer.shadowMap.enabled, shadowType: renderer.shadowMap.type }
}
export function applyMapSettings(renderer: THREE.WebGLRenderer, settings: ReturnType<typeof rendererSettings>): void {
  renderer.toneMapping = settings.toneMapping; renderer.toneMappingExposure = settings.exposure
  renderer.shadowMap.enabled = settings.shadows; renderer.shadowMap.type = settings.shadowType
}
/** GPU preparation after a download must use that map's lighting settings, even while the
 * previous map is still rendering. Never keep the temporary settings across an await. */
export function withMapSettings<T>(renderer: THREE.WebGLRenderer, settings: ReturnType<typeof rendererSettings>, work: () => T): T {
  const previous = rendererSettings(renderer)
  try { applyMapSettings(renderer, settings); return work() }
  finally { applyMapSettings(renderer, previous) }
}
