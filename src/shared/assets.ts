/**
 * What every asset in the game has to be, so it can be built rather than downloaded.
 *
 * Everything this game ships is authored — geometry generated in code, textures generated on
 * a canvas. Nothing third-party is served. That is a deliberate call: it removes the licensing
 * question entirely, and the generated textures are higher resolution than the 2001 originals
 * ever were.
 *
 * The dimensions below were measured off reference meshes that are not ours and are not
 * shipped. A Warthog being 6.60 m long is a fact about a Warthog; hitting that number is what
 * keeps a hand-built model from looking like a toy next to the real screenshots.
 */

export type ModelId =
  | 'warthog' | 'warthog-rocket' | 'ghost' | 'banshee' | 'scorpion'
  | 'spartan'
  | 'assault-rifle' | 'magnum' | 'sniper' | 'rocket-launcher'
  | 'smg' | 'battle-rifle' | 'gravity-hammer' | 'shotgun' | 'energy-sword' | 'plasma-rifle' | 'plasma-pistol' | 'needler'
  | 'rocket' | 'needle'
  | 'overshield' | 'active-camo' | 'healthpack' | 'flag'

export interface AssetSpec {
  /** Bounding size in metres: length along its forward axis, width, height. */
  readonly size: readonly [number, number, number]
  /** Rough triangle ceiling. Sixteen of a thing on screen has to stay affordable. */
  readonly budget: number
  /** What it has to read as at a glance. Silhouette first — that is what players recognise. */
  readonly reads: string
}

export const SPECS: Record<ModelId, AssetSpec> = {
  smg: {size:[.63,.08,.22],budget:3000,reads:'Halo 2 M7 compact SMG with side magazine and folding stock.'},
  'battle-rifle': {size:[1.15,.17,.4],budget:6000,reads:'Bullpup rifle with carry handle and a compact scope.'},
  'gravity-hammer': {size:[.8,.4,2],budget:5000,reads:'Long wrapped haft, heavy steel head, rear blade and blue gravity emitters.'},
  'warthog': {
    size: [6.60, 3.16, 3.72],
    budget: 9000,
    reads: 'Wide, flat-nosed 4x4 with enormous knobbly tyres set outboard, a low open cab, a roll bar, and a chaingun turret standing proud at the back. Squat and heavy — wider than it looks tall.',
  },
  'warthog-rocket': {
    size: [6.60, 3.16, 3.72],
    budget: 9500,
    reads: 'The Warthog with a boxy twin rocket pod in place of the chaingun.',
  },
  'ghost': {
    size: [4.27, 2.20, 3.60],
    budget: 4500,
    reads: 'Covenant hover bike. Two forward-swept prongs with glowing plasma cannons, a curved purple carapace, no wheels, sits nose-down.',
  },
  'banshee': {
    size: [6.90, 7.20, 1.85],
    budget: 9000,
    reads: 'Covenant attack flier. A teardrop hull with a domed canopy, two long swept arms ending in drooped anti-gravity pods that glow aft, twin plasma cannons under the beak and a fat fuel rod gun between them. Wider than it is long.',
  },
  'scorpion': {
    size: [10.20, 4.10, 8.26],
    budget: 9000,
    reads: 'Squat four-tread tank, hull wider than it is long-looking, with a long thin main gun and treads on outrigger arms rather than a single track pair.',
  },
  'spartan': {
    size: [0.56, 0.91, 2.18],
    budget: 4500,
    reads: 'Armoured soldier, seven feet tall, heavy shoulder and thigh plates, a domed helmet with a gold visor covering the whole face. Bulk in the shoulders and thighs, narrow at the waist.',
  },

  // Weapon dimensions here come from the real designs, not from the reference meshes: those
  // archives carry rig marker spheres that inflated every measured bound, which is also why the
  // first pass at these models came out shapeless.
  'assault-rifle': {
    size: [0.880, 0.075, 0.317],
    budget: 3500,
    reads:
      'Long, low and almost entirely matte black. A tapered wedge nose slopes down to a thin barrel with ' +
      'a second short flashlight tube beneath it. The front half of the top is a segmented heat shroud of ' +
      'three or four raised panels with a small pale display let into its rear end. Below that, a ribbed ' +
      'handguard with four or five vertical fins and one small green status light. The rear half is a taller ' +
      'rectangular receiver ending in a stepped slab stock, with the pistol grip cut out of the body as a ' +
      'teardrop hole rather than hung below it. Length to height about 3:1.',
  },
  'magnum': {
    // 26.7 cm long and very slightly TALLER than that, counting the magazine column hanging out
    // of the grip. The M6D is a tall pistol; building it Desert-Eagle-shaped is what makes it
    // read as a blob. Cross-checked: a 12-round single stack of 12.7x40mm needs ~180 mm of
    // magazine, so the 191 mm drop below the frame is physically honest, not stylisation.
    size: [0.267, 0.048, 0.274],
    budget: 2200,
    reads:
      'A big boxy sidearm in desaturated blue-grey gunmetal. The defining feature is the KFA-2 scope block ' +
      'at the FRONT of the slide, over the muzzle — not at the rear, which is the commonest way to get this ' +
      'weapon wrong. A round bolt boss sits on the side below it. The rear of the slide carries about five ' +
      'vertical cocking serrations. The trigger guard is an oversized squared-off loop. The grip rakes back ' +
      'sharply in dark reddish-brown stippled rubber, and the magazine protrudes well below it in blue-grey ' +
      'metal. See reference/weapons/M6D-BREAKDOWN.md for measured proportions.',
  },
  'sniper': {
    size: [1.90, 0.095, 0.330],
    budget: 2600,
    reads:
      'Long and slab-sided, nearly all barrel, with a very large cylindrical scope on tall mounts over the ' +
      'receiver and a squared muzzle brake at the end. Dark grey-green. Length to height is ' +
      '5.75:1 and it really is close to two metres — an anti-materiel rifle in 14.5x114mm, the same ' +
      'round the PTRD-41 fires, and that rifle is 2.02 m. Build it true to length; the viewmodel ' +
      'scale handles first-person framing.',
  },
  'rocket-launcher': { size: [1.41, 0.42, 0.25], budget: 2700, reads: 'Shoulder tube with twin stacked barrels, a boxy optic on top and a pistol grip below.' },
  // 118 cm over all per Halopedia. The magazine tube sits *above* the barrel on the CE gun,
  // which is the detail that tells it apart from every other pump-action ever drawn.
  'shotgun': { size: [1.19, 0.082, 0.245], budget: 10000, reads: 'Pump-action, with the fat magazine tube riding above a thinner protruding barrel, a glowing blue front sight on top of it, a ribbed sliding forend with an amber button, and a heavy solid stock carrying spare shells in its butt.' },
  // 126.5 cm long, 47 cm across the blades.
  'energy-sword': { size: [1.28, 0.14, 0.53], budget: 4000, reads: 'A tall faceted black hilt held crosswise, with two curved plasma blades leaving its top and bottom, bowing outward and tapering to points that almost meet. Almost-white core inside a wide cyan glow.' },
  'plasma-rifle': { size: [0.69, 0.38, 0.18], budget: 4700, reads: 'Covenant. Smooth clamshell halves in blue-violet with a glowing core between them, no straight lines.' },
  'plasma-pistol': { size: [0.37, 0.30, 0.12], budget: 3000, reads: 'Small green-plated Covenant sidearm, hooked at the front, glowing vents.' },
  'needler': { size: [0.72, 0.60, 0.24], budget: 1800, reads: 'Pink-magenta organic shell with a fan of translucent crystal needles standing up from the top.' },

  'rocket': { size: [0.59, 0.18, 0.18], budget: 350, reads: 'Stubby finned projectile with a bright exhaust.' },
  'needle': { size: [0.62, 0.06, 0.06], budget: 260, reads: 'A single glowing magenta crystal shard.' },

  'overshield': { size: [0.73, 0.73, 0.73], budget: 800, reads: 'Floating translucent yellow-green faceted diamond, slowly rotating, lit from within.' },
  'active-camo': { size: [0.94, 0.97, 0.94], budget: 950, reads: 'Same floating faceted form as the overshield but pale blue-white and refractive.' },
  'healthpack': { size: [0.49, 0.27, 0.61], budget: 300, reads: 'Small wall-mounted white box with a red cross.' },
  'flag': { size: [0.24, 0.48, 3.07], budget: 2200, reads: 'Tall thin pole with a team-coloured cloth banner.' },
}

/** Every team-coloured surface tints from here, the way CE tinted its armour at runtime. */
export type Team = 'red' | 'blue'

export const TEAM_TINT: Record<Team, number> = {
  red: 0x9c2b22,
  blue: 0x27418f,
}
