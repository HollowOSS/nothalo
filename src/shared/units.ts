/**
 * Halo CE works in "world units" (wu). 1 wu = 10 feet = 3.048 m.
 * We simulate and render in metres; this module is the only place that conversion lives.
 */
export const METRES_PER_WORLD_UNIT = 3.048

export const wu = (n: number): number => n * METRES_PER_WORLD_UNIT
export const toWu = (metres: number): number => metres / METRES_PER_WORLD_UNIT
