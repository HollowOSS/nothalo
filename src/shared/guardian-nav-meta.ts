import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('guardian-nav-meta.json')
export const GUARDIAN_NAV_META = data.GUARDIAN_NAV_META
