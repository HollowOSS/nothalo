import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('guardian-collision-data.json')
export const GUARDIAN_COLLISION_DATA = data.GUARDIAN_COLLISION_DATA
