import { loadExternalData } from './runtime-config.ts'
const data = await loadExternalData('hitbox-data.json')
export const HITBOX_PITCHES = data.HITBOX_PITCHES
export const HITBOX_KINDS = data.HITBOX_KINDS
export const HITBOX_NAMES = data.HITBOX_NAMES
export const HITBOX_RADII = data.HITBOX_RADII
export const HITBOX_STAND = data.HITBOX_STAND
export const HITBOX_CROUCH = data.HITBOX_CROUCH
export const HITBOX_HEADINGS = data.HITBOX_HEADINGS
export const HITBOX_PHASES = data.HITBOX_PHASES
export const HITBOX_MOVING_MM = data.HITBOX_MOVING_MM
export const HITBOX_MOVING_BACK_MM = data.HITBOX_MOVING_BACK_MM
