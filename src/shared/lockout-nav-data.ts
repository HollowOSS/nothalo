import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('lockout-nav-data.json')
export const LOCKOUT_NAV_DATA = data.LOCKOUT_NAV_DATA
