/** Camera contract shared by gameplay, review tools and the Blender studio generator.
 * Positions in exported viewmodels are camera-local metres, +Y up, -Z forward.
 * Halo's historical 70 degree baseline is horizontal at 4:3, not vertical. */
export const PRESENTATION = {
  verticalFov: 2 * Math.atan(Math.tan(35 * Math.PI / 180) / (4 / 3)) * 180 / Math.PI,
  rigNear: .01,
  rigFar: 20,
  worldNear: .08,
  worldFar: 4000,
  formats: {
    trailer: [1920, 1080],
    classic: [1440, 1080],
    phone: [844, 390],
    portrait: [390, 844],
  },
} as const

/** Runtime framing belongs to the complete rig, never the gun alone. */
export const SMALL_ARM_HOLD: Readonly<Record<string, readonly [number, number, number]>> = {
  smg: [.025, -.025, -.035], 'plasma-pistol': [.015, -.04, -.035],
  'plasma-rifle': [.035, -.075, -.055], needler: [.04, -.085, -.035],
}

export const RIDER_TIMING = {enter: .45, exit: .38} as const

/** Whole-rig framing for the small arms: `enlarge` slides arms+gun toward the eye about the grip (same picture as
 * scaling the whole rig about the grip; scaling about the eye changes nothing on screen), `shoulder` draws it back along
 * the bore, `turn` (pitch, yaw, roll in radians, about the grip; +pitch noses the gun up, +yaw swings it left, +roll is counter-clockwise from behind) sets how it is presented. Fitted per weapon against real gameplay stills, see docs/fps-scale.md. */
export interface SmallArmFraming {enlarge: number; shoulder: number; shift?: readonly [number, number, number]; turn?: readonly [number, number, number]}
export const FRAMING_SMALL_ARMS: Record<string, SmallArmFraming & {dual?: SmallArmFraming}> = {
  // smg: two-handed; single held level (no cant: the H2A-fitted turn read as canted in play), pitch/yaw solved in game so the bore meets the crosshair at 30 m; dual fitted to Halo 2 (smg-h2-dual-short.png, the user's short).
  // Checked as a 50% overlay on the reference, not side by side. Hands in tools/fps-grip/smg.json.
  // magnum: fitted to Halo CE's first-person pistol (seen from behind, pointing downrange, low right); tools/fps-grip/magnum.json holds the hand.
  // magnum: gun scaled x1.3 in its viewmodel (tools/vm-scale-weapon.mjs; user: too small for the hands), straight-wrist grip (tools/fps-grip/magnum.json) held out with a slight relaxed cant like the plasma pistol; aim solved in game.
  magnum: {enlarge: 1.3, shoulder: 0, shift: [.04, .02, .03], turn: [-.0015, -.1012, .3]},
  smg: {enlarge: 2.2, shoulder: 0, shift: [.005, .012, .053], turn: [-.0339, -.0962, 0], dual: {enlarge: 1.896, shoulder: 0, shift: [.056, .002, .042], turn: [0.1244, 0.1738, -0.0297]}},
  // plasma-pistol: gun x1.35 in the hand (viewmodel; user: 'way too small'), framed like the magnum (held out, relaxed ~17 deg cant; user asked for that);
  // grip in tools/fps-grip/plasma-pistol.json; pitch/yaw solved in game so the bore meets the crosshair at 30 m.
  'plasma-pistol': {enlarge: 1.2, shoulder: 0, shift: [.04, .02, .03], turn: [.0007, -.0993, .3]},
  // plasma-rifle: fitted to Halo 3 (plasma-rifle-h3-single-1.png: upper claw just right of the crosshair, rear fin leaving the right edge),
  // seen from above like the reference with the hand under the body, canted in a little like the pistols; pitch/yaw solved in game.
  'plasma-rifle': {enlarge: 1.66, shoulder: 0, shift: [.0263, .0422, .0713], turn: [-.0071, -.1003, .2423]},
  // shotgun: had no hold at all (raw rig scale: a thin barrel behind a huge forearm); big and level in the lower right like Halo 3 (shotgun-h3-single-1.png); hands from tools/fps-grip/shotgun.json (support hand cups the pump from below, straight wrist). Pitch/yaw solved in game so the bore converges on the crosshair at 30 m.
  shotgun: {enlarge: 1.6, shoulder: 0, shift: [.13, -.07, 0], turn: [-.0548, -.084, 0]},
  // battle-rifle: fitted to Halo 3 (br-h3-hands-1.png: scope eyepiece, ammo display, stock exiting lower right); upright, barrel just under the crosshair; overrides weapon.ts RIFLE_HOLD.
  // battle-rifle: pitch/yaw re-solved in game so the bore converges on the crosshair at 30 m (the silhouette fit aimed 8.9 deg off).
  'battle-rifle': {enlarge: 1.364, shoulder: 0, shift: [-.001, .008, .166], turn: [0.0017, 0.0026, -0.0183]},
  // energy-sword: fitted to Halo 3 (energy-sword-h3-single-1.png: prong tips converging at the top, prongs leaving the bottom right); left-hand pose in tools/fps-overrides/energy-sword.json is mapped through this.
  'energy-sword': {enlarge: 1.865, shoulder: 0, shift: [.043, -.077, .137], turn: [0.215, 0.0108, 0.1269]},
  // gravity-hammer: the Halo 3 model (tools/import-new-hammer.mjs), fitted to Halo 3 (gravity-hammer-h3-single-2.png: fist under the head collar, collar,
  // head bracket, blade tip, haft exit); hands + arms in tools/fps-grip/gravity-hammer.json are built for exactly this framing (shoulders below the frame).
  'gravity-hammer': {enlarge: 1.6, shoulder: 0, shift: [-.05, -.031, -.125], turn: [0.4555, -0.384, -0.5372]},
  // assault-rifle / sniper / rocket-launcher: sized as before (the AR was weapon.ts RIFLE_HOLD 1.3/.07, the other two unscaled), only turned
  // about the grip so the bore converges on the crosshair at 30 m (they aimed 3-7 deg low-right of it). Solved in game: tools/aim-solve.mjs.
  'assault-rifle': {enlarge: 1.3, shoulder: .07, turn: [-.0602, -.0861, 0]},
  sniper: {enlarge: 1, shoulder: 0, turn: [-.0433, -.1202, 0]},
  'rocket-launcher': {enlarge: 1, shoulder: 0, turn: [-.0296, -.094, 0]},
  // needler: Halo 3 (needler-h3-single-1-16x9.png) seen from behind and above like the reference, hand and forearm visible under the dome; checked in the real Guardian match; hand in tools/fps-grip/needler.json.
  // Pitch/yaw solved in game so the needles fly at the crosshair (the untilted hold aimed 5.6 deg right of it).
  needler: {enlarge: 1.7, shoulder: 0, shift: [-.03, .012, .02], turn: [-.031, -.0964, 0], dual: {enlarge: 1.5, shoulder: 0, shift: [.03, -.01, .02], turn: [0, 0, 0]}},
}
