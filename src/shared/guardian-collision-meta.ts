import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('guardian-collision-meta.json')
export const GUARDIAN_COLLISION_BOUNDS = data.GUARDIAN_COLLISION_BOUNDS
