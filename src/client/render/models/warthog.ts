/**
 * M12 Light Reconnaissance Vehicle — the Warthog.
 *
 * Everything here is generated: the hull is a hand-written loft (a stack of chamfered cross
 * sections stitched into a shell), the tyres are a revolved profile whose tread band steps in
 * and out per segment so the knobbles are real geometry and read in silhouette, and every pixel
 * of every texture is painted onto a canvas at load. Nothing is fetched.
 *
 * The silhouette is the whole job. Reading `reference/frames/midfield.png` left to right you get:
 * a stepped rear bumper with a whip antenna standing off the left rear corner, a raised engine
 * deck carrying the chaingun on a pintle, an open cab between high sills, a long gently-sloping
 * hood, and a blunt nose with a bar bumper — all of it sitting on four enormous knobbly tyres
 * pushed right out past the bodywork on visible A-arms. Wider than it is tall, and the wheels
 * are absurdly big for the body. That is what makes it a Warthog at fifty metres.
 *
 * Geometry is merged per material, so a Warthog is six draw calls no matter how many greebles
 * hang off it, and sixteen of them is still six materials' worth of state changes.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { registerModel } from '../models.ts'
import { TEAM_TINT, type Team } from '../../../shared/assets.ts'

// ---------------------------------------------------------------------------------------------
// Dimensions. 6.60 m long, 3.16 m wide over the tyres, 3.72 m to the tip of the antenna.
// ---------------------------------------------------------------------------------------------

const HALF_LEN = 3.3 // nose at +z, tail at -z
const AXLE_Z = 1.9 // 3.8 m wheelbase
const TYRE_R = 0.65
const TYRE_HALF_W = 0.26
const WHEEL_X = 1.32 // outer face lands at 1.58 => 3.16 m across
const ANTENNA_TOP = 3.72

// ---------------------------------------------------------------------------------------------
// Textures. Painted on a canvas: one panelled metal sheet that every painted surface shares
// (colour-modulated per material) and one block-tread sheet for the rubber.
// ---------------------------------------------------------------------------------------------

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return [c, c.getContext('2d')!]
}

function finish(c: HTMLCanvasElement, repeat = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  t.repeat.set(repeat, repeat)
  return t
}

/**
 * Painted armour plate. Mid-grey so material colours multiply predictably: hull, dark underbody
 * and the team panels are all this sheet under a different tint.
 */
function panelTexture(): THREE.CanvasTexture {
  const N = 512
  const [c, g] = canvas(N)
  g.fillStyle = '#8e9184'
  g.fillRect(0, 0, N, N)

  // Grain. Fine speckle so flat faces are never a dead flat colour.
  const img = g.getImageData(0, 0, N, N)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 22
    img.data[i] += n
    img.data[i + 1] += n
    img.data[i + 2] += n * 0.9
  }
  g.putImageData(img, 0, 0)

  // Weathering: soft dark blotches, then a couple of lighter scuffs.
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * N
    const y = Math.random() * N
    const r = 18 + Math.random() * 70
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    const dark = Math.random() < 0.72
    grd.addColorStop(0, dark ? 'rgba(46,48,42,0.30)' : 'rgba(190,193,180,0.22)')
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grd
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }

  // Panel seams on a coarse grid (each tile is 2 m of hull, so these land as real panel lines).
  g.lineWidth = 2
  const seam = (x0: number, y0: number, x1: number, y1: number) => {
    g.strokeStyle = 'rgba(44,46,42,0.55)'
    g.beginPath()
    g.moveTo(x0, y0)
    g.lineTo(x1, y1)
    g.stroke()
    g.strokeStyle = 'rgba(198,201,190,0.28)'
    g.beginPath()
    g.moveTo(x0 + 2, y0 + 2)
    g.lineTo(x1 + 2, y1 + 2)
    g.stroke()
  }
  for (let i = 0; i < 4; i++) {
    seam(0, i * 128, N, i * 128)
    seam(i * 128, 0, i * 128, N)
  }
  // A few sub-panels so the grid is not too regular.
  for (let i = 0; i < 10; i++) {
    const x = Math.floor(Math.random() * 4) * 128 + 16
    const y = Math.floor(Math.random() * 4) * 128 + 16
    const w = 48 + Math.random() * 60
    const h = 40 + Math.random() * 50
    g.strokeStyle = 'rgba(48,50,45,0.45)'
    g.lineWidth = 2
    g.strokeRect(x, y, w, h)
  }
  // Rivets along the seams.
  for (let i = 0; i < 4; i++) {
    for (let j = 8; j < N; j += 26) {
      g.fillStyle = 'rgba(60,62,56,0.5)'
      g.fillRect(i * 128 + 5, j, 3, 3)
      g.fillRect(j, i * 128 + 5, 3, 3)
    }
  }
  return finish(c)
}

/** Rubber: near-black with staggered tread blocks. u runs around the tyre, v across the width. */
function treadTexture(): THREE.CanvasTexture {
  const N = 256
  const [c, g] = canvas(N)
  g.fillStyle = '#4c4c50'
  g.fillRect(0, 0, N, N)
  const img = g.getImageData(0, 0, N, N)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26
    img.data[i] += n
    img.data[i + 1] += n
    img.data[i + 2] += n
  }
  g.putImageData(img, 0, 0)
  // Chunky lugs: two staggered rows of blocks across the tread band, sidewalls left plain.
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 8; i++) {
      const x = (i + (row ? 0.5 : 0)) * (N / 8)
      const y = 40 + row * 92
      g.fillStyle = 'rgba(122,124,128,0.85)'
      g.fillRect(x + 6, y, N / 8 - 12, 72)
      g.fillStyle = 'rgba(24,24,26,0.6)'
      g.fillRect(x + 6, y + 66, N / 8 - 12, 6)
    }
  }
  // Sidewall bands.
  g.fillStyle = 'rgba(30,30,32,0.55)'
  g.fillRect(0, 0, N, 26)
  g.fillRect(0, N - 26, N, 26)
  return finish(c)
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers.
// ---------------------------------------------------------------------------------------------

type V2 = readonly [number, number]

/**
 * Stitch a run of closed loops into a shell. Every part of this model that is not a three.js
 * primitive comes through here: the hull lofts, the fender arches and the tyres.
 *
 * Winding is fixed afterwards by pushing every triangle's normal away from the shell's centroid,
 * which is exact for the convex-ish pieces built here and saves threading orientation by hand.
 */
function sweep(loops: THREE.Vector3[][], capStart = true, capEnd = true): THREE.BufferGeometry {
  const pos: number[] = []
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  }
  const n = loops[0].length
  for (let k = 0; k < loops.length - 1; k++) {
    const A = loops[k]
    const B = loops[k + 1]
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      tri(A[i], A[j], B[j])
      tri(A[i], B[j], B[i])
    }
  }
  const cap = (loop: THREE.Vector3[]) => {
    for (let i = 1; i < n - 1; i++) tri(loop[0], loop[i], loop[i + 1])
  }
  if (capStart) cap(loops[0])
  if (capEnd) cap(loops[loops.length - 1])

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  orientOutward(geo)
  geo.computeVertexNormals()
  return geo
}

/** Flip any triangle whose normal points back at the shell's centre. */
function orientOutward(geo: THREE.BufferGeometry): void {
  const p = geo.getAttribute('position') as THREE.BufferAttribute
  const arr = p.array as Float32Array
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < arr.length; i += 3) {
    cx += arr[i]
    cy += arr[i + 1]
    cz += arr[i + 2]
  }
  const m = arr.length / 3
  cx /= m
  cy /= m
  cz /= m
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  for (let t = 0; t < arr.length; t += 9) {
    a.fromArray(arr, t)
    b.fromArray(arr, t + 3)
    c.fromArray(arr, t + 6)
    nrm.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a))
    const outX = (a.x + b.x + c.x) / 3 - cx
    const outY = (a.y + b.y + c.y) / 3 - cy
    const outZ = (a.z + b.z + c.z) / 3 - cz
    if (nrm.x * outX + nrm.y * outY + nrm.z * outZ < 0) {
      // swap b and c
      for (let k = 0; k < 3; k++) {
        const tmp = arr[t + 3 + k]
        arr[t + 3 + k] = arr[t + 6 + k]
        arr[t + 6 + k] = tmp
      }
    }
  }
  p.needsUpdate = true
}

/**
 * Triplanar-ish box UVs in world units, applied per triangle after everything is positioned.
 * One texture tile covers 2 m, so panel lines are the same size on the bonnet and on the bumper
 * and nothing has to carry hand-authored UVs.
 */
function boxUV(geo: THREE.BufferGeometry, scale = 0.5): void {
  const p = geo.getAttribute('position') as THREE.BufferAttribute
  const n = p.count
  const uv = new Float32Array(n * 2)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  for (let t = 0; t < n; t += 3) {
    a.fromBufferAttribute(p, t)
    b.fromBufferAttribute(p, t + 1)
    c.fromBufferAttribute(p, t + 2)
    nrm.crossVectors(b.clone().sub(a), c.clone().sub(a))
    const ax = Math.abs(nrm.x)
    const ay = Math.abs(nrm.y)
    const az = Math.abs(nrm.z)
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? a : k === 1 ? b : c
      let u: number
      let w: number
      if (ax >= ay && ax >= az) {
        u = v.z
        w = v.y
      } else if (ay >= az) {
        u = v.x
        w = v.z
      } else {
        u = v.x
        w = v.y
      }
      uv[(t + k) * 2] = u * scale
      uv[(t + k) * 2 + 1] = w * scale
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}

/** A chamfered hull cross-section: flat bottom, kicked-out mid flank, narrower top. */
interface Station {
  z: number
  y0: number
  y1: number
  wb: number
  wm: number
  wt: number
  cb: number
  ct: number
}

function stationLoop(s: Station): THREE.Vector3[] {
  const pts: V2[] = [
    [s.wb, s.y0],
    [s.wm, s.y0 + s.cb],
    [s.wm, s.y1 - s.ct],
    [s.wt, s.y1],
    [-s.wt, s.y1],
    [-s.wm, s.y1 - s.ct],
    [-s.wm, s.y0 + s.cb],
    [-s.wb, s.y0],
  ]
  return pts.map(([x, y]) => new THREE.Vector3(x, y, s.z))
}

function loft(stations: Station[]): THREE.BufferGeometry {
  return sweep(stations.map(stationLoop))
}

/**
 * The tyre. A cross-section revolved about X, with the four tread points stepping between full
 * radius and 90% on alternating segments — real lugs, so the outline is visibly toothed rather
 * than a smooth black doughnut.
 */
function tyreGeometry(segments = 24): THREE.BufferGeometry {
  const hw = TYRE_HALF_W
  const prof: Array<{ r: number; x: number; tread: boolean }> = [
    { r: 0.50, x: -hw, tread: false },
    { r: 0.84, x: -hw, tread: false },
    { r: 0.95, x: -hw * 0.74, tread: true },
    { r: 1.00, x: -hw * 0.32, tread: true },
    { r: 1.00, x: hw * 0.32, tread: true },
    { r: 0.95, x: hw * 0.74, tread: true },
    { r: 0.84, x: hw, tread: false },
    { r: 0.50, x: hw, tread: false },
  ]
  const loops: THREE.Vector3[][] = []
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const lug = i % 2 === 0 ? 1 : 0.9
    loops.push(
      prof.map((p) => {
        const r = TYRE_R * p.r * (p.tread ? lug : 1)
        return new THREE.Vector3(p.x, Math.cos(a) * r, Math.sin(a) * r)
      }),
    )
  }
  // Closed ring: no caps, and the seam loop is duplicated so the last segment stitches.
  return sweep(loops, false, false)
}

/** A fender arch: a rectangular section swept over the top of a wheel. */
function fenderGeometry(rIn: number, rOut: number, xIn: number, xOut: number): THREE.BufferGeometry {
  const loops: THREE.Vector3[][] = []
  const segs = 9
  const a0 = -1.72
  const a1 = 1.72
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs
    const s = Math.sin(a)
    const co = Math.cos(a)
    const pt = (r: number, x: number) => new THREE.Vector3(x, co * r, s * r)
    // Outer lip drops a little at the ends so the arch tucks in rather than flaring flat.
    const taper = 1 - 0.12 * Math.abs(i / segs - 0.5) * 2
    loops.push([pt(rIn, xIn), pt(rIn, xOut * taper), pt(rOut, xOut * taper), pt(rOut, xIn)])
  }
  return sweep(loops)
}

// ---------------------------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------------------------

type MatKey = 'hull' | 'dark' | 'team' | 'metal' | 'tyre' | 'glass'

interface Placement {
  p?: readonly [number, number, number]
  r?: readonly [number, number, number]
}

function place(geo: THREE.BufferGeometry, t: Placement): THREE.BufferGeometry {
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(t.r ?? [0, 0, 0])))
  m.compose(new THREE.Vector3(...(t.p ?? [0, 0, 0])), q, new THREE.Vector3(1, 1, 1))
  geo.applyMatrix4(m)
  return geo
}

function buildWarthog(): THREE.Object3D {
  const parts: Array<{ key: MatKey; geo: THREE.BufferGeometry }> = []
  const add = (key: MatKey, geo: THREE.BufferGeometry) => parts.push({ key, geo })

  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rot?: readonly [number, number, number],
  ) => place(new THREE.BoxGeometry(w, h, d), { p: [x, y, z], r: rot })

  const cyl = (
    r: number,
    len: number,
    seg: number,
    x: number,
    y: number,
    z: number,
    rot?: readonly [number, number, number],
  ) => place(new THREE.CylinderGeometry(r, r, len, seg), { p: [x, y, z], r: rot })

  const mirrorX = (key: MatKey, make: (sx: number) => THREE.BufferGeometry) => {
    add(key, make(1))
    add(key, make(-1))
  }

  // -- Hull -------------------------------------------------------------------------------------
  // Lower body: one continuous tub from nose to tail, top deck at 0.98 m so the cab can be an
  // open well between the sills rather than a lid.
  add(
    'hull',
    loft([
      { z: -HALF_LEN + 0.15, y0: 0.72, y1: 0.96, wb: 0.78, wm: 0.90, wt: 0.84, cb: 0.10, ct: 0.08 },
      { z: -2.70, y0: 0.52, y1: 0.98, wb: 0.90, wm: 1.06, wt: 0.98, cb: 0.14, ct: 0.10 },
      { z: -1.00, y0: 0.50, y1: 0.98, wb: 0.92, wm: 1.10, wt: 1.02, cb: 0.14, ct: 0.10 },
      { z: 0.60, y0: 0.50, y1: 0.98, wb: 0.92, wm: 1.10, wt: 1.02, cb: 0.14, ct: 0.10 },
      { z: 2.10, y0: 0.54, y1: 0.98, wb: 0.88, wm: 1.06, wt: 0.98, cb: 0.14, ct: 0.10 },
      { z: 2.85, y0: 0.62, y1: 0.96, wb: 0.78, wm: 0.94, wt: 0.86, cb: 0.12, ct: 0.10 },
      { z: 3.10, y0: 0.74, y1: 0.92, wb: 0.60, wm: 0.72, wt: 0.64, cb: 0.08, ct: 0.06 },
    ]),
  )

  // Bonnet: long, gently falling, narrowing to a blunt nose.
  add(
    'hull',
    loft([
      { z: 0.70, y0: 0.94, y1: 1.34, wb: 1.00, wm: 1.04, wt: 0.84, cb: 0.06, ct: 0.16 },
      { z: 1.30, y0: 0.94, y1: 1.25, wb: 0.98, wm: 1.02, wt: 0.82, cb: 0.06, ct: 0.13 },
      { z: 2.20, y0: 0.94, y1: 1.17, wb: 0.92, wm: 0.98, wt: 0.74, cb: 0.06, ct: 0.12 },
      { z: 2.88, y0: 0.92, y1: 1.06, wb: 0.78, wm: 0.84, wt: 0.56, cb: 0.05, ct: 0.09 },
      { z: 3.10, y0: 0.90, y1: 0.98, wb: 0.58, wm: 0.66, wt: 0.44, cb: 0.04, ct: 0.05 },
    ]),
  )

  // Engine deck: the raised block behind the cab that the gun stands on.
  add(
    'hull',
    loft([
      { z: -0.52, y0: 0.94, y1: 1.20, wb: 1.02, wm: 1.06, wt: 0.90, cb: 0.06, ct: 0.10 },
      { z: -0.95, y0: 0.94, y1: 1.44, wb: 1.02, wm: 1.08, wt: 0.92, cb: 0.06, ct: 0.16 },
      { z: -2.10, y0: 0.94, y1: 1.46, wb: 1.02, wm: 1.08, wt: 0.92, cb: 0.06, ct: 0.16 },
      { z: -2.78, y0: 0.94, y1: 1.34, wb: 0.94, wm: 1.00, wt: 0.84, cb: 0.06, ct: 0.14 },
      { z: -3.14, y0: 0.92, y1: 1.14, wb: 0.78, wm: 0.84, wt: 0.68, cb: 0.05, ct: 0.10 },
    ]),
  )

  // Cab sills: the high door tops you sit down inside of.
  mirrorX('hull', (s) => box(0.24, 0.14, 1.34, s * 1.0, 1.04, 0.06))

  // Cockpit floor and firewall, dark so the well reads as a hole from any angle.
  add('dark', box(1.86, 0.06, 1.30, 0, 0.99, 0.06))
  add('dark', box(1.86, 0.30, 0.08, 0, 1.12, -0.56))

  // -- Bumpers and lights ------------------------------------------------------------------------
  add('dark', box(2.14, 0.26, 0.26, 0, 0.86, 3.17))
  mirrorX('dark', (s) => box(0.16, 0.40, 0.20, s * 0.92, 0.96, 3.14))
  add('dark', box(1.86, 0.28, 0.22, 0, 0.94, -3.19))
  mirrorX('dark', (s) => box(0.18, 0.34, 0.16, s * 0.80, 1.02, -3.24))
  // Headlamp blocks tucked under the nose lip.
  mirrorX('metal', (s) => box(0.26, 0.16, 0.10, s * 0.40, 1.00, 3.13))

  // Team panels: rear lamp clusters, deck flanks and a nose chevron. Nothing else is tinted, so a
  // red hog and a blue hog differ by exactly these four surfaces.
  mirrorX('team', (s) => box(0.20, 0.16, 0.08, s * 0.52, 1.06, -3.24))
  mirrorX('team', (s) => box(0.06, 0.26, 1.05, s * 1.07, 1.20, -1.52))
  add('team', box(0.62, 0.10, 0.10, 0, 1.04, 3.14))

  // -- Wheels ------------------------------------------------------------------------------------
  for (const sz of [1, -1]) {
    for (const sx of [1, -1]) {
      const x = sx * WHEEL_X
      const z = sz * AXLE_Z
      add('tyre', place(tyreGeometry(), { p: [x, TYRE_R, z] }))
      // Rim dish and hub, in hull paint like the reference's tan wheel centres.
      add('hull', cyl(0.34, 0.30, 14, x, TYRE_R, z, [0, 0, Math.PI / 2]))
      add('metal', cyl(0.14, 0.36, 10, x, TYRE_R, z, [0, 0, Math.PI / 2]))
      // Twin A-arms out to the hub: the Warthog's legs are visible and that matters.
      add('dark', box(0.42, 0.13, 0.16, sx * 1.14, 0.58, z))
      add('dark', box(0.42, 0.11, 0.13, sx * 1.14, 0.86, z))
      // Fender arch over each wheel.
      add(
        'hull',
        place(fenderGeometry(0.70, 0.80, sx * 0.94, sx * 1.46), { p: [0, TYRE_R, z] }),
      )
    }
  }

  // -- Cab furniture -----------------------------------------------------------------------------
  for (const sx of [-1, 1]) {
    add('dark', box(0.46, 0.12, 0.48, sx * 0.44, 1.06, 0.12))
    add('dark', place(new THREE.BoxGeometry(0.46, 0.46, 0.12), { p: [sx * 0.44, 1.28, -0.12], r: [0.22, 0, 0] }))
  }
  add('metal', place(new THREE.TorusGeometry(0.15, 0.028, 5, 10), { p: [-0.44, 1.30, 0.62], r: [1.15, 0, 0] }))
  add('metal', cyl(0.035, 0.30, 6, -0.44, 1.22, 0.72, [1.15, 0, 0]))

  // -- Windscreen frame --------------------------------------------------------------------------
  const TILT = -0.30
  mirrorX('dark', (s) => box(0.10, 0.60, 0.10, s * 0.74, 1.52, 0.80, [TILT, 0, 0]))
  add('dark', box(1.58, 0.10, 0.10, 0, 1.79, 0.72))
  add('glass', box(1.46, 0.52, 0.03, 0, 1.52, 0.79, [TILT, 0, 0]))

  // -- Roll bar over the back of the cab ---------------------------------------------------------
  mirrorX('metal', (s) => box(0.10, 0.66, 0.10, s * 0.86, 1.52, -0.44))
  add('metal', box(1.82, 0.10, 0.10, 0, 1.83, -0.44))
  mirrorX('metal', (s) => box(0.08, 0.08, 0.52, s * 0.86, 1.79, -0.72))

  // -- Chaingun turret ---------------------------------------------------------------------------
  const GZ = -1.56
  add('metal', cyl(0.30, 0.12, 16, 0, 1.50, GZ))
  add('metal', cyl(0.15, 0.44, 12, 0, 1.74, GZ))
  add('dark', box(0.46, 0.32, 0.44, 0, 2.06, GZ))
  add('metal', box(0.34, 0.32, 0.74, 0, 2.16, GZ + 0.30))
  // The swept fin above the breech — the piece that makes the turret readable from the side.
  add('metal', place(new THREE.BoxGeometry(1.06, 0.44, 0.05), { p: [0, 2.30, GZ - 0.12], r: [0.62, 0, 0] }))
  mirrorX('metal', (s) => box(0.05, 0.30, 0.34, s * 0.30, 2.20, GZ - 0.30, [0.3, 0, 0]))
  // Triple barrels and muzzle collar.
  const barrels: V2[] = [
    [0, 0.055],
    [-0.05, -0.03],
    [0.05, -0.03],
  ]
  for (const [bx, by] of barrels) {
    add('metal', cyl(0.036, 1.02, 6, bx, 2.16 + by, GZ + 1.16, [Math.PI / 2, 0, 0]))
  }
  add('metal', cyl(0.10, 0.10, 10, 0, 2.16, GZ + 1.62, [Math.PI / 2, 0, 0]))
  // Ammo drum on the left of the breech.
  add('dark', cyl(0.16, 0.26, 10, -0.28, 2.10, GZ - 0.02, [0, 0, Math.PI / 2]))

  // -- Antenna off the left rear corner ------------------------------------------------------------
  add('dark', box(0.14, 0.22, 0.14, -0.98, 1.20, -2.86))
  const whipBase = 1.26
  add('metal', cyl(0.022, ANTENNA_TOP - whipBase, 5, -0.98, (ANTENNA_TOP + whipBase) / 2, -2.86))

  // -- Spare-wheel / tow gear on the tail deck ---------------------------------------------------
  add('dark', box(0.70, 0.16, 0.30, 0, 1.50, -2.62))
  mirrorX('metal', (s) => box(0.09, 0.09, 0.44, s * 0.52, 1.42, -0.90))

  // -- Merge ---------------------------------------------------------------------------------------
  const panel = panelTexture()
  const materials: Record<MatKey, THREE.Material> = {
    hull: new THREE.MeshStandardMaterial({ map: panel, color: 0xd8dacb, roughness: 0.82, metalness: 0.12 }),
    dark: new THREE.MeshStandardMaterial({ map: panel, color: 0x3f4245, roughness: 0.95, metalness: 0.1 }),
    team: teamMaterial('red', panel),
    metal: new THREE.MeshStandardMaterial({ map: panel, color: 0x8d939a, roughness: 0.5, metalness: 0.55 }),
    tyre: new THREE.MeshStandardMaterial({ map: treadTexture(), color: 0x4a4a4d, roughness: 1, metalness: 0 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x2a3238,
      roughness: 0.18,
      metalness: 0.4,
      transparent: true,
      opacity: 0.42,
    }),
  }

  const group = new THREE.Group()
  group.name = 'warthog'
  const buckets = new Map<MatKey, THREE.BufferGeometry[]>()
  for (const { key, geo } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo
    if (g !== geo) geo.dispose()
    // Tyres get cylindrical UVs from the sweep order instead of box mapping, so the tread
    // pattern wraps the way rubber does.
    if (key === 'tyre') tyreUV(g)
    else boxUV(g, 0.5)
    const list = buckets.get(key)
    if (list) list.push(g)
    else buckets.set(key, [g])
  }
  for (const [key, list] of buckets) {
    const merged = mergeGeometries(list, false)
    if (!merged) continue
    for (const g of list) g.dispose()
    merged.computeVertexNormals()
    const mesh = new THREE.Mesh(merged, materials[key])
    mesh.name = `warthog:${key}`
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }
  return group
}

/** Cylindrical UVs for the tyre band: u around the circumference, v across the width. */
function tyreUV(geo: THREE.BufferGeometry): void {
  const p = geo.getAttribute('position') as THREE.BufferAttribute
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i) - TYRE_R
    const z = p.getZ(i)
    uv[i * 2] = (Math.atan2(z, y) / (Math.PI * 2)) * 5
    uv[i * 2 + 1] = x / (TYRE_HALF_W * 2) + 0.5
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}

// ---------------------------------------------------------------------------------------------
// Team tint.
// ---------------------------------------------------------------------------------------------

const teamMaterials = new Map<Team, THREE.MeshStandardMaterial>()

function teamMaterial(team: Team, map?: THREE.Texture): THREE.MeshStandardMaterial {
  let m = teamMaterials.get(team)
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      map,
      color: TEAM_TINT[team],
      roughness: 0.68,
      metalness: 0.2,
    })
    m.name = `team-${team}`
    m.userData.teamTint = true
    teamMaterials.set(team, m)
  } else if (map && !m.map) {
    m.map = map
    m.needsUpdate = true
  }
  return m
}

/**
 * Swap a built Warthog's tinted surfaces to a team colour. Clones share materials, so the tint
 * lives in one material per team and a hog is pointed at the right one rather than recoloured.
 */
export function setTeam(root: THREE.Object3D, team: Team): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mat = mesh.material as THREE.Material
    if (Array.isArray(mesh.material) || !mat?.userData?.teamTint) return
    const src = mat as THREE.MeshStandardMaterial
    mesh.material = teamMaterial(team, src.map ?? undefined)
  })
}

registerModel('warthog', buildWarthog)
