/** Connection hints are absent in Safari. Phones start compact; real transfer timings can
 * also move a desktop onto compact assets. Choices apply to new loads, never mid-frame swaps. */
export interface ResourceHints {
  mobile?: boolean; memoryGB?: number; saveData?: boolean; effectiveType?: string
  downlink?: number; rtt?: number; measuredMbps?: number
}
export function compactResources(hints: ResourceHints): boolean {
  return !!hints.mobile || !!hints.saveData || (hints.memoryGB !== undefined && hints.memoryGB <= 4)
    || ['slow-2g','2g','3g'].includes(hints.effectiveType ?? '')
    || (hints.downlink !== undefined && hints.downlink > 0 && hints.downlink < 5)
    || (hints.rtt !== undefined && hints.rtt >= 300)
    || (hints.measuredMbps !== undefined && hints.measuredMbps < 5)
}
let measuredMbps: number | undefined
if (typeof PerformanceObserver !== 'undefined') {
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      // Ignore cache hits, tiny responses, and cross-origin opaque timing entries.
      const duration = entry.responseEnd - entry.requestStart
      if (entry.transferSize < 65536 || duration < 100) continue
      const rate = entry.encodedBodySize * 8 / duration / 1000
      measuredMbps = measuredMbps === undefined ? rate : measuredMbps * .7 + rate * .3
    }
  })
  observer.observe({ type: 'resource', buffered: true })
}
export function resourceProfile(): 'compact' | 'full' {
  const override = new URLSearchParams(location.search).get('assets')
  if (override === 'compact' || override === 'full') return override
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: ResourceHints }
  return compactResources({ ...nav.connection && { saveData: nav.connection.saveData, effectiveType: nav.connection.effectiveType,
    downlink: nav.connection.downlink, rtt: nav.connection.rtt }, mobile: matchMedia('(pointer: coarse)').matches,
    memoryGB: nav.deviceMemory, measuredMbps }) ? 'compact' : 'full'
}
export function resourceUrl(url: string): string {
  return resourceProfile() === 'compact' ? url.replace('/assets/', '/assets/compact/') : url
}
