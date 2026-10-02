export interface RuntimeConfig {
  assetsBase?: string
  dataBase?: string
  ipfsGateway?: string
  assetOverrides?: Record<string, string>
}
let config: RuntimeConfig = {}
let pending: Promise<RuntimeConfig> | undefined
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  return pending ??= fetch('/runtime-config.json', { cache: 'no-store' }).then(async response => {
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return config
    config = await response.json()
    return config
  }).catch(() => config)
}
export function gatewayUrl(value: string): string {
  const expanded = value.startsWith('ipfs://')
    ? (config.ipfsGateway ?? 'https://ipfs.io/ipfs/').replace(/\/?$/, '/') + value.slice(7).replace(/^ipfs\//, '')
    : value
  if (!expanded.startsWith('/') && !/^https?:\/\//i.test(expanded)) throw new Error('Asset URLs must use HTTP(S), ipfs://, or a local absolute path')
  return expanded
}
export function assetUrl(path: string): string {
  if (!path.startsWith('/assets/')) return path
  const override = config.assetOverrides?.[path]
  if (override) return gatewayUrl(override)
  if (!config.assetsBase) return path
  return gatewayUrl(config.assetsBase).replace(/\/$/, '') + '/' + path.slice('/assets/'.length)
}
export async function loadExternalData(name: string): Promise<any> {
  await loadRuntimeConfig()
  if (!config.dataBase) throw new Error('Configure dataBase in runtime-config.json before loading a map')
  const response = await fetch(gatewayUrl(config.dataBase).replace(/\/$/, '') + '/' + name)
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error(`External level data unavailable: ${name}`)
  return response.json()
}
