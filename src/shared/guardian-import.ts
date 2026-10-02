/** Placement of the downloaded Guardian model (Halo Online export, CC BY 4.0) in game metres.
 *
 * Scale 1.0: the model's structural footprint is 97.6 x 82.8 units. The retail Halo 3 BSP's
 * visible-cluster union spans 106 x 90 m, and includes foliage margins; the ratio is the same
 * (1.08) on both horizontal axes, so one source unit is one metre. The offset centres the Top
 * Mid platform on the origin at y = 14, keeping the old spawn/HUD height conventions.
 *
 * Every consumer applies exactly this transform: the visible GLB, the generated collision data
 * and the generated navigation grid. Collision and render therefore cannot disagree.
 */
export const GUARDIAN_IMPORT = {
  scale: 1,
  offset: { x: -4.8, y: -41.18, z: -30.4 },
} as const
