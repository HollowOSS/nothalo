import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('guardian-nav-data.json')
export const GUARDIAN_NAV_DATA = data.GUARDIAN_NAV_DATA
