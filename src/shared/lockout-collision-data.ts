import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('lockout-collision-data.json')
export const LOCKOUT_COLLISION_DATA = data.LOCKOUT_COLLISION_DATA
