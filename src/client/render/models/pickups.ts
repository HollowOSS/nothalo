import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { registerModel } from '../models.ts'
import { SPECS, TEAM_TINT, type Team } from '../../../shared/assets.ts'

/**
 * Owner: pickups — `overshield`, `active-camo`, `healthpack`, `flag`.
 *
 * Read off `reference/renders/overshield.png` and the two base-exterior frames, not memory.
 *
 * What the overshield render actually shows, and what memory gets wrong: it is *not* a bare
 * floating diamond. It is a cube of near-invisible glass panels with a bright glowing core
 * suspended dead centre at a little under half the cube's width, and the only solid thing in
 * the silhouette is a set of small metal brackets clasping all eight corners — three short
 * arms per corner running a third of the way down each edge, each capped with a chevron
 * pointing in at the core. At fifty metres the glass vanishes, and what you actually
 * recognise is a floating point of coloured light inside a faint dotted cube. That cube of
 * corner marks is the silhouette, so it is built first and everything else hangs off it.
 *
 * `base-exterior-red.png` confirms the colour at distance: the powerup sitting on the red
 * base rim reads as a tall slab of saturated yellow-green light, brighter than anything else
 * on the building. So the core is emissive and unlit — it has to hold up with no sun on it.
 *
 * Active camo is the same object at 1.29x, in pale blue-white, with a much colder, more
 * mirror-like glass. Same builder, different palette, so the two read as siblings the way
 * they do in game.
 *
 * Draw-call discipline: every rigid greeble on a powerup is merged into one bracket mesh, so
 * a powerup is 4 meshes (brackets, glass, core, halo) rather than 26. Sixteen of these on
 * screen is 64 draw calls, not four hundred.
 */

/* ------------------------------------------------------------------ shared canvas textures */

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return [c, c.getContext('2d')!]
}

/** Cheap deterministic value noise so nothing here depends on Math.random between reloads. */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

let _panelTex: THREE.Texture | null = null
/** Off-white painted-steel panel: faint mottle plus a horizontal wear band. For the healthpack. */
function panelTexture(): THREE.Texture {
  if (_panelTex) return _panelTex
  const [c, g] = canvas(256)
  g.fillStyle = '#f2f2ee'
  g.fillRect(0, 0, 256, 256)
  const img = g.getImageData(0, 0, 256, 256)
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const n = hash2(Math.floor(x / 3), Math.floor(y / 3))
      const grime = 1 - 0.10 * Math.pow(Math.max(0, Math.sin((y / 256) * Math.PI * 2 - 1.2)), 6)
      const v = (0.92 + n * 0.08) * grime
      const i = (y * 256 + x) * 4
      img.data[i] *= v
      img.data[i + 1] *= v
      img.data[i + 2] *= v * 0.995
    }
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  _panelTex = t
  return t
}

let _clothTex: THREE.Texture | null = null
/**
 * Flag cloth. Deliberately near-white so the team colour comes entirely from the material's
 * tint and a red flag and a blue flag differ by one number. Carries the weave, the darker
 * reinforced hoist band down the pole edge, and a pale chevron device on the fly.
 */
function clothTexture(): THREE.Texture {
  if (_clothTex) return _clothTex
  const N = 256
  const [c, g] = canvas(N)
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, N, N)

  // Pale device: a broad chevron, the sort of blocky mark CE stamped on team gear.
  g.fillStyle = 'rgba(255,255,255,0.95)'
  g.strokeStyle = 'rgba(255,255,255,0.85)'
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = 'rgba(120,120,120,0.28)'
  g.beginPath()
  g.moveTo(N * 0.42, N * 0.28)
  g.lineTo(N * 0.72, N * 0.50)
  g.lineTo(N * 0.42, N * 0.72)
  g.lineTo(N * 0.42, N * 0.60)
  g.lineTo(N * 0.56, N * 0.50)
  g.lineTo(N * 0.42, N * 0.40)
  g.closePath()
  g.fill()

  // Reinforced hoist band along the pole edge, plus its stitching.
  g.fillStyle = 'rgba(0,0,0,0.22)'
  g.fillRect(0, 0, N * 0.075, N)
  g.fillStyle = 'rgba(255,255,255,0.35)'
  for (let y = 0; y < N; y += 8) g.fillRect(N * 0.055, y, 2, 4)

  // Weave: fine cross-hatch, then a soft vertical shading so folds read even when flat-lit.
  const img = g.getImageData(0, 0, N, N)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const weave = 0.965 + 0.035 * (((x & 1) ^ (y & 1)) ? 1 : 0)
      const n = 0.97 + hash2(x, y) * 0.03
      const v = weave * n
      const i = (y * N + x) * 4
      img.data[i] *= v
      img.data[i + 1] *= v
      img.data[i + 2] *= v
    }
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.anisotropy = 4
  _clothTex = t
  return t
}

let _glassTex: THREE.Texture | null = null
/** Faint containment lattice printed on the powerup glass — hex dots that catch the key light. */
function glassTexture(): THREE.Texture {
  if (_glassTex) return _glassTex
  const N = 128
  const [c, g] = canvas(N)
  g.fillStyle = '#0d1014'
  g.fillRect(0, 0, N, N)
  g.fillStyle = '#7f8f9c'
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const x = (col + (row % 2 ? 0.5 : 0)) * (N / 8)
      const y = (row + 0.5) * (N / 8)
      g.beginPath()
      g.arc(x, y, 1.6, 0, Math.PI * 2)
      g.fill()
    }
  }
  g.strokeStyle = 'rgba(150,175,195,0.35)'
  g.lineWidth = 1
  g.strokeRect(0.5, 0.5, N - 1, N - 1)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  _glassTex = t
  return t
}

/* ------------------------------------------------------------------ team tint plumbing */

/**
 * Every team-coloured surface is one material, named so it can be found, and its colour comes
 * from TEAM_TINT and nowhere else. A red flag and a blue flag are the same geometry, the same
 * texture and the same shader — one `setHex`. Models are built once and cloned, and clone()
 * shares materials, so retinting is done on a per-instance clone of that one material.
 */
const TEAM_MATERIAL = 'team-tint'

export function tintTeam(root: THREE.Object3D, team: Team): THREE.Object3D {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    const next = mats.map((mat) => {
      if (mat.name !== TEAM_MATERIAL) return mat
      const c = mat.clone()
      ;(c as THREE.MeshStandardMaterial).color.setHex(TEAM_TINT[team])
      return c
    })
    m.material = Array.isArray(m.material) ? next : next[0]
  })
  return root
}

/* ------------------------------------------------------------------ powerups */

const UNIT = 1 // powerups are authored in a unit cube and scaled to spec at the end

/** One corner clasp: three arms down the three edges that meet at this corner, each chevroned. */
function bracketPieces(sx: number, sy: number, sz: number): THREE.BufferGeometry[] {
  const h = UNIT / 2
  const t = 0.052 // arm cross-section
  const L = 0.30 // arm length as a fraction of the cube side
  const sign = [sx, sy, sz]
  const out: THREE.BufferGeometry[] = []

  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3
    const cAx = (a + 2) % 3

    // Arm: a square rod lying on the edge, running inward from the corner.
    const dim = [t, t, t]
    dim[a] = L
    const arm = new THREE.BoxGeometry(dim[0], dim[1], dim[2])
    const p = [0, 0, 0]
    p[a] = sign[a] * (h - L / 2)
    p[b] = sign[b] * (h - t / 2)
    p[cAx] = sign[cAx] * (h - t / 2)
    arm.translate(p[0], p[1], p[2])
    out.push(arm)

    // Chevron on the inner end, pointing at the core.
    const head = new THREE.ConeGeometry(0.062, 0.11, 4, 1)
    // Spin the square cone about its own axis *first*, while that axis is still +Y, so the
    // flats face the cube faces. Doing it after the alignment tilts the chevron out of the
    // edge it belongs to and pushes the model past its own bounding box.
    head.rotateY(Math.PI / 4)
    // Cone points +Y by default; aim it down the arm's axis, toward the centre.
    if (a === 0) head.rotateZ(sign[a] > 0 ? Math.PI / 2 : -Math.PI / 2)
    else if (a === 1) { if (sign[a] > 0) head.rotateZ(Math.PI) }
    else head.rotateX(sign[a] > 0 ? -Math.PI / 2 : Math.PI / 2)
    const q = [...p]
    q[a] = sign[a] * (h - L - 0.045)
    head.translate(q[0], q[1], q[2])
    out.push(head)
  }
  return out
}

interface PowerupLook {
  /** The light inside. This is the whole read at distance. */
  core: number
  /** Glass tint. */
  glass: number
  /** Metal of the corner clasps. */
  metal: number
  /** How mirror-like the glass is. Camo is colder and glassier than the overshield. */
  metalness: number
  roughness: number
  glassOpacity: number
}

function powerup(look: PowerupLook, size: readonly [number, number, number]): THREE.Group {
  const g = new THREE.Group()

  // --- corner clasps, all 24 arms merged into one mesh ---
  const pieces: THREE.BufferGeometry[] = []
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    pieces.push(...bracketPieces(sx, sy, sz))
  }
  const brackets = mergeGeometries(pieces, false)!
  for (const p of pieces) p.dispose()
  const metalMat = new THREE.MeshStandardMaterial({
    color: look.metal,
    metalness: 0.85,
    roughness: 0.45,
    emissive: look.core,
    emissiveIntensity: 0.10,
    flatShading: true,
  })
  const clasps = new THREE.Mesh(brackets, metalMat)
  clasps.name = 'clasps'
  g.add(clasps)

  // --- glass shell ---
  const glassMat = new THREE.MeshStandardMaterial({
    color: look.glass,
    map: glassTexture(),
    metalness: look.metalness,
    roughness: look.roughness,
    transparent: true,
    opacity: look.glassOpacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    emissive: look.core,
    emissiveIntensity: 0.06,
  })
  const shell = new THREE.Mesh(new THREE.BoxGeometry(UNIT, UNIT, UNIT), glassMat)
  shell.name = 'shell'
  shell.renderOrder = 2
  g.add(shell)

  // --- the light inside: a faceted core, plus a soft additive halo around it ---
  const coreMat = new THREE.MeshBasicMaterial({ color: look.core })
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.215, 1), coreMat)
  core.name = 'core'
  g.add(core)

  const haloMat = new THREE.MeshBasicMaterial({
    color: look.core,
    transparent: true,
    opacity: 0.30,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  })
  const halo = new THREE.Mesh(new THREE.IcosahedronGeometry(0.30, 1), haloMat)
  halo.name = 'halo'
  halo.renderOrder = 3
  g.add(halo)

  // Authored in a unit cube; stretched once, here, to the measured size.
  g.scale.set(size[1], size[2], size[0])
  // Powerups float; sit the cube's centre at half its own height so it rests on the grid
  // exactly the way the reference render has it hovering clear of the ground.
  g.position.y = size[2] / 2
  return g
}

registerModel('overshield', () => {
  const g = powerup({
    core: 0xd8ff4a,
    glass: 0x9fd08a,
    metal: 0x8e9384,
    metalness: 0.25,
    roughness: 0.28,
    glassOpacity: 0.24,
  }, SPECS['overshield'].size)
  g.name = 'overshield'
  return g
})

registerModel('active-camo', () => {
  const g = powerup({
    core: 0xdff2ff,
    glass: 0xa8c8e2,
    metal: 0x99a2ab,
    metalness: 0.80,
    roughness: 0.10,
    glassOpacity: 0.20,
  }, SPECS['active-camo'].size)
  g.name = 'active-camo'
  return g
})

/* ------------------------------------------------------------------ healthpack */

/**
 * The UNSC wall medkit: a small chamfered white case, taller than it is wide, standing off the
 * wall on a dark backplate, with a raised red cross on the door and a latch strip down one
 * side. 0.49 x 0.61 x 0.27 — chest height on a wall and no bigger than a briefcase.
 */
registerModel('healthpack', () => {
  const [depth, width, height] = SPECS['healthpack'].size // 0.49 fwd, 0.27 wide, 0.61 tall
  // Measured spec is [length-along-forward, width, height]; for a wall box the face is the
  // wide one, so the door is width x height and the case is `width` deep off the wall.
  const W = depth   // 0.49 across the door
  const H = height  // 0.61 tall
  const D = width   // 0.27 off the wall

  const g = new THREE.Group()
  g.name = 'healthpack'

  // The bevel grows the extrusion outward on every side, and the backplate and the raised
  // cross eat into the depth, so the profile is shrunk by exactly those amounts up front —
  // the finished object measures 0.49 x 0.61 x 0.27 and not a millimetre more.
  const bevel = 0.016
  const plateT = 0.026   // wall backplate thickness
  const proud = 0.020    // how far the cross stands off the door
  const SW = W - bevel * 2, SH = H - bevel * 2

  const r = 0.045
  const shape = new THREE.Shape()
  const hw = SW / 2 - r, hh = SH / 2 - r
  shape.moveTo(-hw - r, -hh)
  shape.lineTo(-hw - r, hh)
  shape.quadraticCurveTo(-hw - r, hh + r, -hw, hh + r)
  shape.lineTo(hw, hh + r)
  shape.quadraticCurveTo(hw + r, hh + r, hw + r, hh)
  shape.lineTo(hw + r, -hh)
  shape.quadraticCurveTo(hw + r, -hh - r, hw, -hh - r)
  shape.lineTo(-hw, -hh - r)
  shape.quadraticCurveTo(-hw - r, -hh - r, -hw - r, -hh)

  // Case occupies z from (-D/2 + plateT) to (D/2 - proud); the plate and the cross fill the rest.
  const caseBack = -D / 2 + plateT
  const caseFront = D / 2 - proud
  const body = new THREE.ExtrudeGeometry(shape, {
    depth: (caseFront - caseBack) - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  })
  body.translate(0, 0, caseBack + bevel)
  body.computeVertexNormals()

  const shellMat = new THREE.MeshStandardMaterial({
    color: 0xf6f6f2,
    map: panelTexture(),
    roughness: 0.55,
    metalness: 0.05,
  })
  const shell = new THREE.Mesh(body, shellMat)
  shell.name = 'case'
  g.add(shell)

  // Raised red cross. Two bars, proud of the door so it survives being backlit.
  const crossMat = new THREE.MeshStandardMaterial({
    color: 0xc0261d,
    roughness: 0.4,
    metalness: 0,
    emissive: 0x3a0603,
    emissiveIntensity: 1,
  })
  const armL = W * 0.60, armT = W * 0.205
  const bars = [
    new THREE.BoxGeometry(armL, armT, proud * 1.6),
    new THREE.BoxGeometry(armT, armL, proud * 1.6),
  ]
  for (const b of bars) b.translate(0, H * 0.06, D / 2 - proud * 0.8)
  const cross = new THREE.Mesh(mergeGeometries(bars, false)!, crossMat)
  for (const b of bars) b.dispose()
  cross.name = 'cross'
  g.add(cross)

  // Dark furniture: the wall backplate it hangs on, the lid seam, and the latch.
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2f3338, roughness: 0.6, metalness: 0.45 })
  const furniture = [
    new THREE.BoxGeometry(W * 0.72, H * 0.86, plateT).translate(0, 0, -D / 2 + plateT / 2),
    new THREE.BoxGeometry(W * 0.99, 0.012, (caseFront - caseBack) * 0.9).translate(0, H * 0.24, 0),
    new THREE.BoxGeometry(W * 0.14, 0.05, 0.024).translate(W * 0.30, H * 0.24, caseFront + 0.006),
  ]
  const furn = new THREE.Mesh(mergeGeometries(furniture, false)!, darkMat)
  for (const f of furniture) f.dispose()
  furn.name = 'furniture'
  g.add(furn)

  g.position.y = H / 2
  return g
})

/* ------------------------------------------------------------------ flag */

/**
 * CTF flag: a three-metre pole, spiked at the foot so it plants, with the banner hung from a
 * short yardarm near the top. It is read at range purely as a tall vertical line with a
 * coloured rectangle at head height and above — so the pole is thin and dark, the cloth is
 * broad, and the cloth's ripple is what stops it reading as a cardboard cutout.
 *
 * The whole 0.24 m depth of this object is the ripple in the cloth. Nothing else sticks out,
 * because anything that did — a stand, a base plate — would blow the measured footprint.
 */
registerModel('flag', () => {
  const [depth, width, height] = SPECS['flag'].size // 0.24 deep, 0.48 wide, 3.07 tall

  const g = new THREE.Group()
  g.name = 'flag'

  const poleR = 0.023
  const finialR = poleR * 1.9
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x6a7078, metalness: 0.9, roughness: 0.34 })

  const spikeH = 0.20
  const parts: THREE.BufferGeometry[] = [
    // Shaft. Runs the full height less the spike.
    new THREE.CylinderGeometry(poleR, poleR, height - spikeH, 8, 1)
      .translate(0, spikeH + (height - spikeH) / 2, 0),
    // Ground spike.
    new THREE.ConeGeometry(poleR, spikeH, 8, 1).rotateX(Math.PI).translate(0, spikeH / 2, 0),
    // Finial cap.
    new THREE.ConeGeometry(finialR, 0.10, 8, 1).translate(0, height - 0.05, 0),
    // Collars: the two clamps the banner's head and foot hang off.
    new THREE.CylinderGeometry(poleR * 1.5, poleR * 1.5, 0.035, 8, 1).translate(0, height * 0.885, 0),
    new THREE.CylinderGeometry(poleR * 1.5, poleR * 1.5, 0.035, 8, 1).translate(0, height * 0.395, 0),
    // Grip wrap low down, so the pole is not one featureless stick.
    new THREE.CylinderGeometry(poleR * 1.35, poleR * 1.35, 0.30, 8, 1).translate(0, height * 0.20, 0),
  ]
  const pole = new THREE.Mesh(mergeGeometries(parts, false)!, poleMat)
  for (const p of parts) p.dispose()
  pole.name = 'pole'
  g.add(pole)

  // --- the banner ---
  // The 0.48 m width is pole *and* banner: the finial is the widest point on the far side.
  const clothW = width - finialR - poleR
  const clothH = height * (0.885 - 0.395)
  const SEGX = 18, SEGY = 12
  const cloth = new THREE.PlaneGeometry(clothW, clothH, SEGX, SEGY)
  const pos = cloth.attributes.position as THREE.BufferAttribute
  // The ripple is the only thing that occupies the object's depth, so it has to reach the
  // full ±0.12 or the flag measures flat.
  const raw = new Float32Array(pos.count)
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i)
    const u = (x + clothW / 2) / clothW        // 0 at the hoist, 1 at the fly
    const v = (y + clothH / 2) / clothH
    // Ripple grows from nothing at the pole — where the cloth is clamped — to its full throw
    // at the free edge, and the free edge sags: cloth on a planted pole hangs, it does not fly.
    const grow = u * u
    const z = grow * (Math.sin(u * Math.PI * 2.4 - v * 1.3) + 0.35 * Math.sin(v * Math.PI * 1.7))
    raw[i] = z
    if (z < lo) lo = z
    if (z > hi) hi = z
    pos.setY(i, y - grow * 0.055 * (1 - v))
  }
  // Normalise the fold so the banner measures exactly the spec depth, whatever the wave does.
  const k = depth / (hi - lo)
  const mid = (hi + lo) / 2
  for (let i = 0; i < pos.count; i++) pos.setZ(i, (raw[i] - mid) * k)
  cloth.computeVertexNormals()
  cloth.translate(clothW / 2 + poleR, height * 0.395 + clothH / 2, 0)

  const clothMat = new THREE.MeshStandardMaterial({
    color: TEAM_TINT.red,
    map: clothTexture(),
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  clothMat.name = TEAM_MATERIAL
  const banner = new THREE.Mesh(cloth, clothMat)
  banner.name = 'banner'
  banner.userData.teamTint = true
  g.add(banner)

  return g
})
