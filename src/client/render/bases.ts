import { assetUrl } from '../../shared/runtime-config.ts'
import * as THREE from 'three'
import { BASE_GEOMETRY, baseWallRadius, baseWallPlane } from '../../shared/base-collision.ts'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  RED_BASE,
  BLUE_BASE,
  BASE_RADIUS,
  BASE_DECK_HEIGHT,
  TEAM_COLOR,
  TELEPORTERS,
  type Anchor,
  type Team,
} from '../../shared/map.ts'
import { exitGround, FRAME_HALF_WIDTH, FRAME_HEIGHT } from '../../shared/teleport.ts'

/**
 * Owner: base geometry piece. Red and Blue base structures, ramps, teleporters.
 *
 * Read from `reference/frames/base-exterior-{red,blue}.png` and `ridge-overlook.png`,
 * not memory. What those frames actually show:
 *   - a low faceted drum, roughly 16-sided, that reads almost circular at distance;
 *   - the outer wall is battered *inward* going down, so the deck overhangs the footing;
 *   - coarse vertical corrugation — you can count the ribs, ~70 around the drum;
 *   - fat buttresses standing proud of the wall, splitting it into distinct bays, with
 *     a recessed dark doorway in the bay between each pair;
 *   - the deck is flush and open, and reads much *lighter* than the wall because it
 *     faces the sky — that step is the strongest tonal edge on the building;
 *   - what stands above the rim is a ring of separate objects: pale grey wedges, darker
 *     consoles with glowing screens, one emblem panel, one overshield;
 *   - two ramps run from the deck down the outside to the ground.
 * The whole thing is much lower and wider than it is remembered.
 *
 * Tonal targets, sampled off `base-exterior-red` where the base sits in the end wall's
 * cast shadow exactly as ours does (sRGB):
 *   deck 127,125,110 · coping/trim 94,85,70 · drum 85,70,52 · consoles & fins 40,38,31
 * That ladder has to survive with no direct sun on the building at all, which is why
 * the concretes carry a baked bounce term rather than relying on the scene ambient.
 */

/** Facet count of the drum. 16 reads as round at the distances the vantages use. */
const FACETS = BASE_GEOMETRY.facets
const FACET = (Math.PI * 2) / FACETS

/** Wall geometry. The batter is what makes the deck overhang and read as "sunk in". */
const TOP_R = BASE_RADIUS
const BOTTOM_R = BASE_RADIUS - 1.9
/** The footing carries on below datum so terrain never opens a gap under the wall. */
const FOOTING_Y = BASE_GEOMETRY.footing
const COPING_Y = BASE_GEOMETRY.coping

/** Rim furniture. Wedges are ~2.6 m — chest-and-a-half on a Spartan, as in the frames. */
const PYLON_H = 2.6
const CONSOLE_H = 2.0

const PIT_X = BASE_GEOMETRY.pitX
const PIT_Z = BASE_GEOMETRY.pitZ

type RimKind = 'pylon' | 'console' | 'emblem' | 'shield' | 'ramp' | 'bare'

/**
 * What sits on each of the 16 rim facets, indexed clockwise from the face that looks
 * up the canyon at the other base. Deliberately irregular: in the frames the rim
 * furniture is a mixed, unevenly spaced row, not a turned colonnade.
 */
const RIM: readonly RimKind[] = [
  'emblem', // 0 — front, faces midfield
  'console',
  'pylon',
  'bare', // 3 — doorway bay
  'ramp', // 4 — side ramp down to the floor
  'pylon',
  'bare', // 6 — doorway bay
  'console',
  'pylon', // 8 — rear
  'console',
  'pylon',
  'console',
  'ramp', // 12 — opposite side ramp
  'shield',
  'bare', // 14 — doorway bay
  'console',
]

/** Ground-level openings, each recessed into the bay between a pair of buttresses. */
const DOORS = BASE_GEOMETRY.doorFacets

/**
 * Buttresses. Placed to flank the doorways and then a couple on their own, so the wall
 * reads as unevenly sized bays rather than a colonnade — that is what the frames show.
 */
const BUTTRESSES = [2, 5, 7, 10, 13, 15]

// ---------------------------------------------------------------------------- textures

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

function finish(c: HTMLCanvasElement, repeatX: number, repeatY: number): THREE.Texture {
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(repeatX, repeatY)
  t.anisotropy = 8
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/**
 * Corrugated concrete. The ribs are countable in the reference — about 70 around the
 * whole drum — so they are drawn coarse and mapped 1:1 round the cylinder. Any finer
 * and they alias into flat grey at the distance the vantages sit at.
 */
function wallTexture(): THREE.Texture {
  const [c, x] = canvas(512, 256)
  x.fillStyle = '#b6b3a4'
  x.fillRect(0, 0, 512, 256)
  const ribs = 64
  const w = 512 / ribs
  for (let i = 0; i < ribs; i++) {
    const px = i * w
    // Jittered so it reads as cast corrugation rather than planking.
    const j = (Math.random() - 0.5) * w * 0.3
    x.fillStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.05})`
    x.fillRect(px + j, 0, w * 0.4, 256)
    x.fillStyle = `rgba(0,0,0,${0.06 + Math.random() * 0.07})`
    x.fillRect(px + j + w * 0.6, 0, w * 0.36, 256)
  }
  // Broad weathering bands across several ribs at a time — the reference wall is
  // blotchy at a much larger scale than the corrugation.
  for (let i = 0; i < 70; i++) {
    const px = Math.random() * 512
    const bw = 10 + Math.random() * 50
    x.fillStyle = `rgba(${Math.random() < 0.45 ? '58,58,50' : '216,216,206'},${0.05 + Math.random() * 0.09})`
    x.fillRect(px, 0, bw, 256)
  }
  // Runoff streaks, biased downward the way rain stains a wall.
  for (let i = 0; i < 300; i++) {
    const px = Math.random() * 512
    const top = Math.random() * 150
    const len = 40 + Math.random() * 190
    x.fillStyle = `rgba(${Math.random() < 0.5 ? '40,36,30' : '210,205,190'},${0.03 + Math.random() * 0.07})`
    x.fillRect(px, top, 1 + Math.random() * 3, len)
  }
  // Grade the bottom third down: dirt splash and the drum's own contact shading.
  const grad = x.createLinearGradient(0, 90, 0, 256)
  grad.addColorStop(0, 'rgba(30,26,20,0)')
  grad.addColorStop(1, 'rgba(30,26,20,0.30)')
  x.fillStyle = grad
  x.fillRect(0, 90, 512, 166)
  return finish(c, 1, 1)
}

/** Deck slab: flat pale grey-green concrete, mottled, no strong direction. */
function deckTexture(): THREE.Texture {
  const [c, x] = canvas(256, 256)
  x.fillStyle = '#cdc7b3'
  x.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 2600; i++) {
    const r = 2 + Math.random() * 22
    x.fillStyle = `rgba(${Math.random() < 0.5 ? '128,128,116' : '206,206,192'},0.05)`
    x.beginPath()
    x.arc(Math.random() * 256, Math.random() * 256, r, 0, Math.PI * 2)
    x.fill()
  }
  return finish(c, 0.18, 0.18)
}

/** Lighter cast-concrete for pilasters, coping, wedges and ramps. */
function trimTexture(): THREE.Texture {
  const [c, x] = canvas(128, 128)
  x.fillStyle = '#cdc6b4'
  x.fillRect(0, 0, 128, 128)
  for (let i = 0; i < 900; i++) {
    x.fillStyle = `rgba(${Math.random() < 0.5 ? '110,105,94' : '206,201,188'},0.07)`
    x.fillRect(Math.random() * 128, Math.random() * 128, 1 + Math.random() * 6, 1 + Math.random() * 14)
  }
  return finish(c, 1, 1)
}

/**
 * The UNSC targeting-reticle glyph on the front panel, drawn as a glow on black so one
 * texture serves both teams through the material's colour.
 */
function emblemTexture(): THREE.Texture {
  const [c, x] = canvas(256, 256)
  x.strokeStyle = '#fff'
  x.lineCap = 'butt'
  x.beginPath()
  x.arc(128, 128, 74, 0, Math.PI * 2)
  x.lineWidth = 13
  x.stroke()
  x.beginPath()
  x.arc(128, 128, 26, 0, Math.PI * 2)
  x.lineWidth = 9
  x.stroke()
  x.lineWidth = 13
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4
    x.beginPath()
    x.moveTo(128 + Math.cos(a) * 78, 128 + Math.sin(a) * 78)
    x.lineTo(128 + Math.cos(a) * 122, 128 + Math.sin(a) * 122)
    x.stroke()
  }
  // The hook that makes it read as Halo's reticle rather than a plain crosshair.
  x.lineWidth = 10
  x.beginPath()
  x.arc(128, 128, 50, -Math.PI * 0.15, Math.PI * 0.75)
  x.stroke()
  return finish(c, 1, 1)
}

/** Console face: a couple of blown-out readout bars, as they appear in the frames. */
function screenTexture(): THREE.Texture {
  const [c, x] = canvas(64, 64)
  x.fillStyle = '#fff'
  x.fillRect(12, 20, 40, 9)
  x.fillRect(12, 34, 24, 7)
  x.fillRect(40, 34, 12, 7)
  return finish(c, 1, 1)
}

// ---------------------------------------------------------------------------- geometry

/**
 * Box with independent top and bottom cross-sections — the shape every piece of rim
 * furniture and every buttress on this building is.
 */
function wedge(bw: number, tw: number, bd: number, td: number, h: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, h, 1)
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) {
    const top = p.getY(i) > 0
    p.setX(i, p.getX(i) * (top ? tw : bw))
    p.setZ(i, p.getZ(i) * (top ? td : bd))
  }
  g.computeVertexNormals()
  g.translate(0, h / 2, 0)
  return g
}

/** Outer wall radius at height `y` — the drum's batter, needed by anything set into it. */
function wallRadius(y: number): number {
  return baseWallRadius(y)
}

/** Drop a geometry onto rim facet `i`, its local +Z pointing out of the building. */
function atFacet(g: THREE.BufferGeometry, i: number, radius: number, y: number): THREE.BufferGeometry {
  const a = i * FACET
  g.rotateY(a)
  g.translate(Math.sin(a) * radius, y, Math.cos(a) * radius)
  return g
}

/** Deck slab as a 16-gon with the central pit punched out of it. */
function deckSlab(): THREE.BufferGeometry {
  const outer = new THREE.Shape()
  for (let i = 0; i < FACETS; i++) {
    const a = (i + 0.5) * FACET
    const p = new THREE.Vector2(Math.sin(a) * TOP_R, -Math.cos(a) * TOP_R)
    if (i === 0) outer.moveTo(p.x, p.y)
    else outer.lineTo(p.x, p.y)
  }
  const hole = new THREE.Path()
  hole.moveTo(-PIT_X, -PIT_Z)
  hole.lineTo(-PIT_X, PIT_Z)
  hole.lineTo(PIT_X, PIT_Z)
  hole.lineTo(PIT_X, -PIT_Z)
  outer.holes.push(hole)
  const g = new THREE.ExtrudeGeometry(outer, { depth: BASE_GEOMETRY.roofThickness, bevelEnabled: false, steps: 1 })
  g.rotateX(-Math.PI / 2)
  g.translate(0, BASE_DECK_HEIGHT - BASE_GEOMETRY.roofThickness, 0)
  return g
}

interface Parts {
  wall: THREE.BufferGeometry[]
  deck: THREE.BufferGeometry[]
  trim: THREE.BufferGeometry[]
  dark: THREE.BufferGeometry[]
  screen: THREE.BufferGeometry[]
  emblem: THREE.BufferGeometry[]
  shield: THREE.BufferGeometry[]
}

function buildParts(): Parts {
  const p: Parts = { wall: [], deck: [], trim: [], dark: [], screen: [], emblem: [], shield: [] }

  // Each wall bay is a solid shell with an inner face. Doorway bays have two
  // jambs and a lintel, leaving real openings for players, vehicles, and projectiles.
  const panel = (facet: number, left: number | null, right: number | null, bottom: number, top: number) => {
    const box = new THREE.BoxGeometry(1, 1, 1)
    const a = box.attributes.position
    for (let v = 0; v < a.count; v++) {
      const y = a.getY(v) < 0 ? bottom : top
      const half = baseWallRadius(y) * Math.sin(FACET / 2)
      const u = a.getX(v) < 0 ? (left ?? -half) : (right ?? half)
      const z = baseWallPlane(y) - (a.getZ(v) < 0 ? BASE_GEOMETRY.wallThickness : 0)
      a.setXYZ(v, u, y, z)
    }
    box.computeVertexNormals()
    p.wall.push(atFacet(box, facet, 0, 0))
  }
  for (let i = 0; i < FACETS; i++) {
    if (DOORS.includes(i)) {
      panel(i, null, -BASE_GEOMETRY.doorWidth / 2, FOOTING_Y, COPING_Y)
      panel(i, BASE_GEOMETRY.doorWidth / 2, null, FOOTING_Y, COPING_Y)
      panel(i, -BASE_GEOMETRY.doorWidth / 2, BASE_GEOMETRY.doorWidth / 2, BASE_GEOMETRY.doorTop, COPING_Y)
    } else panel(i, null, null, FOOTING_Y, COPING_Y)
  }

  // Coping: the bright lip that caps the wall in every frame and separates the dark
  // corrugated drum from the deck furniture above it.
  const coping = new THREE.CylinderGeometry(TOP_R + 0.35, TOP_R + 0.12, BASE_DECK_HEIGHT - COPING_Y, FACETS, 1, true, -FACET / 2, Math.PI * 2)
  coping.translate(0, (COPING_Y + BASE_DECK_HEIGHT) / 2, 0)
  p.trim.push(coping)

  p.deck.push(deckSlab())

  // A continuous interior floor with space to circulate around the central ramp.
  const floor = new THREE.CylinderGeometry(baseWallRadius(BASE_GEOMETRY.floor) - 0.3, baseWallRadius(BASE_GEOMETRY.floor) - 0.3,
    0.24, FACETS, 1, false, -FACET / 2)
  floor.translate(0, BASE_GEOMETRY.floor - 0.12, 0)
  p.deck.push(floor)

  // Solid central ramp rises from the room through the open rectangular roof hatch.
  const innerRamp = new THREE.BoxGeometry(PIT_X * 2, 1, BASE_GEOMETRY.innerRampHalfWidth * 2)
  const rampPos = innerRamp.attributes.position
  for (let v = 0; v < rampPos.count; v++) {
    const x = rampPos.getX(v)
    const y = rampPos.getY(v) > 0
      ? BASE_GEOMETRY.floor + (x + PIT_X) / (2 * PIT_X) * (BASE_DECK_HEIGHT - BASE_GEOMETRY.floor)
      : BASE_GEOMETRY.floor - 0.1
    rampPos.setY(v, y)
  }
  innerRamp.computeVertexNormals()
  p.trim.push(innerRamp)

  for (const i of DOORS) {
    const near = baseWallPlane(BASE_GEOMETRY.floor) - BASE_GEOMETRY.wallThickness
    const threshold = new THREE.BoxGeometry(BASE_GEOMETRY.doorWidth, 1, 2.7)
    const a = threshold.attributes.position
    for (let v = 0; v < a.count; v++) {
      const z = a.getZ(v) + 1.35
      a.setY(v, a.getY(v) > 0 ? BASE_GEOMETRY.floor * (1 - z / 2.7) : -0.15)
      a.setZ(v, z + near)
    }
    threshold.computeVertexNormals()
    p.deck.push(atFacet(threshold, i, 0, 0))
    // Small recessed strips make the interior readable without extra dynamic lights.
    const strip = new THREE.BoxGeometry(1.7, 0.10, 0.10)
    strip.translate(0, BASE_GEOMETRY.doorTop + 0.25, baseWallPlane(BASE_GEOMETRY.doorTop) - BASE_GEOMETRY.wallThickness - 0.08)
    p.screen.push(atFacet(strip, i, 0, 0))
  }

  // Flat grating panels let down into the deck — small, but they break up a bare slab.
  for (const [gx, gz, gw, gd] of [
    [-7.5, 4.6, 4.4, 3.2],
    [6.8, -5.2, 3.6, 2.6],
    [1.5, 8.6, 3.0, 2.2],
  ] as const) {
    const g = new THREE.BoxGeometry(gw, 0.14, gd)
    g.translate(gx, BASE_DECK_HEIGHT + 0.03, gz)
    p.dark.push(g)
  }

  // Buttresses: fat tapered piers that stand proud of the drum face and carry on a
  // little above the coping. They are what turns the wall into bays at silhouette
  // distance, so they get real depth rather than a flush pilaster strip.
  for (const i of BUTTRESSES) {
    const h = COPING_Y - FOOTING_Y + 1.05
    const g = wedge(1.9, 1.35, 1.35, 1.0, h)
    const ga = g.attributes.position
    for (let v = 0; v < ga.count; v++) {
      // Lean the pier with the wall's batter so it stays welded to the drum face.
      const y = ga.getY(v) + FOOTING_Y
      ga.setZ(v, ga.getZ(v) + wallRadius(Math.min(y, COPING_Y)) + 0.02)
    }
    g.computeVertexNormals()
    p.trim.push(atFacet(g, i, 0, FOOTING_Y))
  }

  for (let i = 0; i < FACETS; i++) {
    const kind = RIM[i]

    if (kind === 'pylon') {
      const py = wedge(2.3, 1.35, 1.6, 1.0, PYLON_H)
      py.rotateX(0.06)
      p.trim.push(atFacet(py, i, TOP_R - 0.35, BASE_DECK_HEIGHT - 0.1))
    }

    if (kind === 'console' || kind === 'emblem') {
      const w = kind === 'emblem' ? 3.4 : 2.6
      const h = kind === 'emblem' ? 2.5 : CONSOLE_H
      const body = wedge(w, w * 0.78, 1.3, 0.95, h)
      // Tilt the face back a few degrees; in the frames every console leans away.
      body.rotateX(-0.10)
      p.dark.push(atFacet(body, i, TOP_R - 0.55, BASE_DECK_HEIGHT - 0.1))

      const faceW = kind === 'emblem' ? w * 0.85 : w * 0.62
      const faceH = kind === 'emblem' ? h * 0.8 : h * 0.42
      const face = new THREE.PlaneGeometry(faceW, faceH)
      face.rotateX(-0.10)
      face.translate(0, h * 0.52, 0.68)
      const placed = atFacet(face, i, TOP_R - 0.55, BASE_DECK_HEIGHT - 0.1)
      ;(kind === 'emblem' ? p.emblem : p.screen).push(placed)
    }

    if (kind === 'shield') {
      // Overshield: a green slab in a grey cradle, the one bright note on the deck.
      const post = (dx: number) => {
        const g = wedge(0.7, 0.6, 0.9, 0.7, 2.4)
        g.translate(dx, 0, 0)
        return g
      }
      const cradle = mergeGeometries([post(-1.0), post(1.0)])!
      p.trim.push(atFacet(cradle, i, TOP_R - 1.2, BASE_DECK_HEIGHT - 0.1))
      const slab = new THREE.BoxGeometry(1.0, 1.9, 0.35)
      slab.translate(0, 1.15, 0)
      p.shield.push(atFacet(slab, i, TOP_R - 1.2, BASE_DECK_HEIGHT - 0.1))
    }

    if (kind === 'ramp') {
      // A solid buttress, not a plank: in the frames the ramp reads as a wedge of mass
      // packed against the wall, its top surface the only part that catches the sun.
      const rise = BASE_DECK_HEIGHT
      const run = BASE_GEOMETRY.rampRun
      const near = BASE_GEOMETRY.rampNear
      const far = near + run
      const w = BASE_GEOMETRY.rampHalfWidth
      const g = new THREE.BufferGeometry()
      const v = new Float32Array([
        // top face (sloping), then the two triangular flanks and the outer end
        -w, rise, near, w, rise, near, w, 0.05, far, -w, 0.05, far,
        -w, rise, near, -w, 0.05, far, -w, 0, far, -w, 0, near,
        w, rise, near, w, 0, near, w, 0, far, w, 0.05, far,
        -w, 0.05, far, w, 0.05, far, w, 0, far, -w, 0, far,
      ])
      g.setAttribute('position', new THREE.BufferAttribute(v, 3))
      g.setIndex([0, 3, 2, 0, 2, 1, 4, 7, 6, 4, 6, 5, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14, 15])
      g.computeVertexNormals()
      const uv = new Float32Array(v.length / 3 * 2)
      for (let k = 0; k < v.length / 3; k++) {
        uv[k * 2] = v[k * 3] * 0.35
        uv[k * 2 + 1] = v[k * 3 + 2] * 0.35
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      p.trim.push(atFacet(g, i, 0, 0))

      // Kerbs down both flanks. Without them the sloping top face is a bare pale sheet;
      // in the frames the ramp is clearly walled.
      const slope = Math.atan2(rise - 0.05, run)
      for (const side of [-1, 1]) {
        const kerb = new THREE.BoxGeometry(0.4, 0.75, Math.hypot(run, rise) + 0.4)
        kerb.rotateX(slope)
        kerb.translate(side * (w - 0.1), rise / 2 + 0.3, (near + far) / 2)
        p.trim.push(atFacet(kerb, i, 0, 0))
      }
    }
  }

  return p
}

// ---------------------------------------------------------------------------- shading

/**
 * Direction to the canyon sun, kept in step with SUN_AZ/SUN_ELEV in `sky.ts`.
 *
 * Both bases stand in a cliff's cast shadow at the vantages that frame them — the
 * reference frames show exactly the same thing — so the scene's directional light never
 * touches them and every face would otherwise resolve to one flat ambient grey. The
 * reference base in that same shadow is neither flat nor grey: it is warm, and it is
 * banded, because a 2001 forward renderer gave it a baked ambient with direction in it.
 * So the shape cue is baked here, per vertex, and the missing bounce is carried as a
 * warm emissive on the concrete materials.
 */
const SUN = new THREE.Vector3(-0.452, 0.616, -0.646)

/** Baked shading factor per vertex, in world orientation for a site turned by `yaw`. */
function bake(geo: THREE.BufferGeometry, yaw: number): THREE.BufferGeometry {
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  const col = new Float32Array(pos.count * 3)
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  for (let i = 0; i < pos.count; i++) {
    const nx = nor.getX(i)
    const ny = nor.getY(i)
    const nz = nor.getZ(i)
    const wx = nx * cy + nz * sy
    const wz = -nx * sy + nz * cy
    const d = Math.max(0, wx * SUN.x + ny * SUN.y + wz * SUN.z)
    // Contact shading: everything within a couple of metres of the sand loses light.
    const ao = 0.78 + 0.22 * Math.min(1, Math.max(0, (pos.getY(i) + 1.2) / 4.5))
    const s = (0.50 + 0.50 * d) * ao
    col[i * 3] = s
    col[i * 3 + 1] = s
    col[i * 3 + 2] = s
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return geo
}

/**
 * Three.js adds emissive after vertex colours are applied, so the fake bounce would
 * flood straight over the bake and flatten the building again. One line of patch keeps
 * the two in step.
 */
function bounceFollowsBake(mat: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 totalEmissiveRadiance = emissive;',
      'vec3 totalEmissiveRadiance = emissive * vColor.xyz;',
    )
  }
  return mat
}

// ---------------------------------------------------------------------------- detail kit

/**
 * The authored detail kit from `tools/blender/author-base-detail-blender.py`: pilasters, ring
 * beam, ceiling ribs, door surrounds, wall lights, the teleporter frame, deck coaming and
 * vents. Base-local, so it clones once per site; the `teleporter` node clones again onto the
 * receiver ledges.
 *
 * It loads after the drum is up. The building is complete without it, just plainer, which is
 * what a slow connection should see rather than a hole.
 */
const DETAIL_KIT_URL = assetUrl('/assets/ce-models/base-detail.glb')

/**
 * The field in the frame: a rippling green sheet, drawn additive and double-sided so it reads
 * from either side and over anything behind it. Animated from the clock inside its own render
 * hook, so nothing else has to know it exists.
 */
function teleporterField(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x4dff6a) } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
      void main() {
        float wave = sin(vUv.y * 26.0 - uTime * 3.4 + sin(vUv.x * 9.0 + uTime * 1.3) * 1.4) * 0.5 + 0.5;
        float wave2 = sin(vUv.y * 7.0 + uTime * 1.1 + vUv.x * 4.0) * 0.5 + 0.5;
        float edge = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x) * smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.95, vUv.y);
        float a = (0.28 + 0.42 * wave * (0.6 + 0.4 * wave2)) * edge;
        gl_FragColor = vec4(uColor * (0.7 + 0.7 * wave), a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(FRAME_HALF_WIDTH * 2 - 0.04, FRAME_HEIGHT), mat)
  mesh.position.set(0, 0.14 + FRAME_HEIGHT / 2 + 0.05, 0)
  mesh.name = 'teleporter-field'
  mesh.onBeforeRender = () => { mat.uniforms.uTime.value = performance.now() / 1000 }
  return mesh
}

/**
 * Fold a subtree's meshes into one mesh per material, in the frame of `origin`. The kit is a
 * hundred small parts; drawn as authored, two bases and two receivers would cost more draw
 * calls than the rest of the canyon put together.
 */
function mergeByMaterial(origin: THREE.Object3D, skip?: THREE.Object3D): THREE.Group {
  const inverse = origin.matrixWorld.clone().invert()
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>()
  origin.traverse(node => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) if (p === skip) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', mesh.geometry.attributes.position.clone())
    geo.setAttribute('normal', mesh.geometry.attributes.normal.clone())
    if (mesh.geometry.index) geo.setIndex(mesh.geometry.index.clone())
    geo.applyMatrix4(inverse.clone().multiply(mesh.matrixWorld))
    const list = buckets.get(mesh.material as THREE.Material)
    if (list) list.push(geo)
    else buckets.set(mesh.material as THREE.Material, [geo])
  })
  const group = new THREE.Group()
  for (const [material, geos] of buckets) {
    const merged = mergeGeometries(geos, false)
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.name = `detail:${(material as THREE.Material).name}`
    group.add(mesh)
  }
  return group
}

function attachDetailKit(g: THREE.Group, sites: { anchor: Anchor; yaw: number }[]): Promise<void> {
  return new GLTFLoader().loadAsync(DETAIL_KIT_URL).then(gltf => {
    gltf.scene.updateMatrixWorld(true)
    const seen = new Set<THREE.Material>()
    gltf.scene.traverse(node => {
      if (typeof node.userData.export_name === 'string') node.name = node.userData.export_name
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      const mat = mesh.material as THREE.MeshStandardMaterial
      if (seen.has(mat)) return
      seen.add(mat)
      // The drum carries a baked bounce so it holds its tone in the cliff's shadow; the kit
      // gets the same lift or it would sit on the building as a set of black bars.
      if (mat.emissive.getHex() === 0) mat.emissive.copy(mat.color).multiplyScalar(0.42)
    })
    const root = gltf.scene.getObjectByName('base-detail') ?? gltf.scene
    const tele = root.getObjectByName('teleporter')

    const kit = mergeByMaterial(root, tele)
    const frame = tele ? mergeByMaterial(tele) : null
    frame?.add(teleporterField())
    if (frame && tele) {
      // Put the merged frame back where the kit authored it, so it clones with the kit.
      frame.position.copy(tele.position)
      frame.quaternion.copy(tele.quaternion)
      kit.add(frame)
    }
    for (const site of sites) {
      const copy = kit.clone(true)
      copy.name = 'base-detail'
      copy.rotation.y = site.yaw
      copy.position.set(site.anchor.x, site.anchor.y, site.anchor.z)
      g.add(copy)
    }
    if (!frame) return
    for (const t of TELEPORTERS) {
      // The frame's front faces the room at an entrance and the canyon at a receiver: in both
      // cases toward the player, which for the receiver is the way they walk out.
      const receiver = frame.clone(true)
      receiver.name = `teleporter-receiver:${t.id}`
      receiver.position.set(t.exit.x, exitGround(t), t.exit.z)
      receiver.rotation.y = t.exitYaw + Math.PI
      g.add(receiver)
    }
  }).catch(error => console.warn('Base detail kit not loaded; bases render plain:', error))
}

// ---------------------------------------------------------------------------- assembly

export function createBases(): THREE.Object3D {
  const g = new THREE.Group()
  g.name = 'bases'

  // Each base's local +Z faces midfield, so blue's is turned to look back down the canyon.
  const sites: { team: Team; anchor: Anchor; yaw: number }[] = [
    { team: 'red', anchor: RED_BASE, yaw: 0 },
    { team: 'blue', anchor: BLUE_BASE, yaw: Math.PI },
  ]

  const wallMap = wallTexture()
  const deckMap = deckTexture()
  const trimMap = trimTexture()
  const screenMap = screenTexture()

  // Albedo plus a baked bounce term, tuned so each surface lands on its measured value
  // from `base-exterior-red`. The gaps between them are the point: deck brightest, then
  // coping and buttresses, then the drum, with the consoles nearly black.
  const wallMat = bounceFollowsBake(new THREE.MeshStandardMaterial({
    map: wallMap,
    color: 0xe4dfd2,
    roughness: 0.95,
    vertexColors: true,
    emissive: 0x7c6a58,
    emissiveMap: wallMap,
  }))
  const deckMat = bounceFollowsBake(new THREE.MeshStandardMaterial({
    map: deckMap,
    color: 0xdad3c0,
    roughness: 1,
    vertexColors: true,
    emissive: 0xa49f92,
    emissiveMap: deckMap,
  }))
  const trimMat = bounceFollowsBake(new THREE.MeshStandardMaterial({
    map: trimMap,
    color: 0xf0ede4,
    roughness: 0.9,
    vertexColors: true,
    emissive: 0x847a6b,
    emissiveMap: trimMap,
  }))
  const darkMat = bounceFollowsBake(new THREE.MeshStandardMaterial({
    color: 0x53544f,
    roughness: 0.7,
    metalness: 0.2,
    vertexColors: true,
    emissive: 0x302d25,
  }))
  const screenMat = new THREE.MeshStandardMaterial({
    map: screenMap,
    color: 0x000000,
    emissive: 0xffe6ea,
    emissiveMap: screenMap,
    emissiveIntensity: 2.4,
    transparent: true,
    depthWrite: false,
  })
  const shieldMat = new THREE.MeshStandardMaterial({
    color: 0x0d3312,
    emissive: 0x36ff4a,
    emissiveIntensity: 1.1,
    roughness: 0.4,
  })

  const emblemMap = emblemTexture()

  // Both sites bake into world space and then merge, one mesh per material. Instancing
  // is off the table because the shading bake is orientation-dependent and the two sites
  // face opposite ways; with only two of them the merge costs nothing and keeps the draw
  // call count where instancing had it.
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>()

  for (const site of sites) {
    const parts = buildParts()
    const emblemMat = new THREE.MeshBasicMaterial({
      map: emblemMap,
      color: new THREE.Color(TEAM_COLOR[site.team]).multiplyScalar(4.2),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
    const groups: [THREE.BufferGeometry[], THREE.Material, boolean][] = [
      [parts.wall, wallMat, true],
      [parts.deck, deckMat, true],
      [parts.trim, trimMat, true],
      [parts.dark, darkMat, true],
      [parts.screen, screenMat, false],
      [parts.shield, shieldMat, false],
      [parts.emblem, emblemMat, false],
    ]
    for (const [geos, material, baked] of groups) {
      const merged = mergeGeometries(geos.map(geo => geo.index ? geo.toNonIndexed() : geo), false)
      if (!merged) continue
      if (baked) bake(merged, site.yaw)
      merged.rotateY(site.yaw)
      merged.translate(site.anchor.x, site.anchor.y, site.anchor.z)
      const list = buckets.get(material)
      if (list) list.push(merged)
      else buckets.set(material, [merged])
    }
  }

  for (const [material, geos] of buckets) {
    const merged = mergeGeometries(geos, false)
    if (merged) g.add(new THREE.Mesh(merged, material))
  }

  // Expose the detail-kit load to the startup barrier so its decode and texture upload happen
  // before the first active gameplay frames.
  g.userData.ready = attachDetailKit(g, sites)
  return g
}
