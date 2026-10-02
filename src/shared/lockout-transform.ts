/** One source unit is one metre, the same convention as Guardian (see docs/lockout-scale.md).
 * The earlier .6 was fitted so a corridor barely cleared the 2.14 m Spartan, which shrank the
 * whole map to 60 %: retail Halo interiors stand far taller than the player. Measured against
 * the creator's export of the original Halo 2 Lockout BSP, both meshes put their room heights
 * at a mode of 4.0 source units, and 4.0 m (1.3 world units) is the only reading consistent
 * with Halo 2's 0.70127 wu (2.1375 m) standing player. Rotation turns the source frame into
 * Y-up with the towers on the same sides as before; only the scale changed. */
export const LOCKOUT_IMPORT = {
  scale: 1,
  offset: { x: 0, y: 14.06, z: 0 },
  rotation: { x: -Math.PI / 2, y: Math.PI, z: 0 },
} as const
/** Walkable footprint of the imported decks plus a 3 m margin (tools/lockout-collision-fidelity-check.mjs surveys it). */
export const LOCKOUT_BOUNDS={x0:-36,x1:27,z0:-41,z1:17} as const
export const LOCKOUT_SPAWN_HASH='lockout-spawns-v4='

/** Development-only scale trial: `?lockoutscale=1.3` (set by main.ts before the map loads) scales
 * the whole Lockout world — visible model, collision mesh, spawns, bounds, lights — about the
 * origin so a disputed sense of scale can be settled by playing both, without rebuilding the
 * collision pipeline. Multiplayer ignores it: the Worker never sets it, so it stays 1 there, and
 * the real change is made by editing LOCKOUT_IMPORT.scale and rebuilding. */
export function lockoutScale():number {
  const v=(globalThis as {__lockoutScale?:unknown}).__lockoutScale
  return typeof v==='number'&&v>0&&Number.isFinite(v)?v:1
}
