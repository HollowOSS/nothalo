import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('lockout-spawn-data.json')
export const LOCKOUT_SPAWN_COLLISION_HASH = data.LOCKOUT_SPAWN_COLLISION_HASH
export const LOCKOUT_RESPAWNS = data.LOCKOUT_RESPAWNS
