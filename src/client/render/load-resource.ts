import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { resourceUrl } from './resource-profile.ts'
import { disposeScene } from './scene-resources.ts'
import { Scene } from 'three'
import { assetUrl } from '../../shared/runtime-config.ts'

/** Abort obsolete map transfers, retry transient transport failures, and choose the asset
 * before downloading it. The compact asset contains the same complete scene and lighting maps. */
export async function loadResource(url: string, signal?: AbortSignal, adaptive = true): Promise<GLTF> {
  const fallback = assetUrl(url)
  let selected = assetUrl(adaptive ? resourceUrl(url) : url)
  let bytes: ArrayBuffer | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted()
    try {
      const response = await fetch(selected, { signal, priority: /\/(maps|guardian)\//.test(url) ? 'high' : 'auto' })
      // A rolling deployment can temporarily serve an older asset set. Vite and single-page asset hosts
      // answer a missing file with index.html and a 200, so an HTML body is a miss as well.
      const missing = response.status === 404 || response.headers.get('content-type')?.includes('text/html')
      if (missing && selected !== fallback) { selected = fallback; attempt--; continue }
      if (missing) throw new Error(`Asset is missing or returned HTML: ${selected}`)
      if (!response.ok) throw new Error(`Asset request failed (${response.status}): ${selected}`)
      bytes = await response.arrayBuffer()
      break
    } catch (error) {
      signal?.throwIfAborted()
      if (attempt === 1) throw error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  signal?.throwIfAborted()
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  const gltf = await loader.parseAsync(bytes!, selected.slice(0, selected.lastIndexOf('/') + 1))
  if (signal?.aborted) { disposeScene(new Scene().add(gltf.scene), []); signal.throwIfAborted() }
  return gltf
}
