import * as THREE from 'three'
import { RED_BASE, BLUE_BASE, SNIPER_RIDGE, BASE_DECK_HEIGHT } from '../../shared/map.ts'

/**
 * Named vantage points, each matched to one reference frame in `reference/frames/`.
 *
 * These were dialled in against their reference frames rather than derived from the map
 * layout: two critics independently reported that the earlier arithmetic put the sniper ridge
 * in the wrong corner and pushed the ring out of frame, which meant every comparison was partly
 * judging composition instead of the thing being built. Framing is dialled with ?eye=&aim=
 * and then written back here.
 * `npm run shot -- <id>` renders ours from here; `./tools/ab.sh <id>` puts the two
 * side by side blind.
 *
 * These are eyeballed from the reference frames against the layout in shared/map.ts.
 * If a critic says the framing does not line up with its reference, fix it here — a
 * mismatched camera makes the comparison meaningless.
 */
export interface Vantage {
  id: string
  shows: string
  position: [number, number, number]
  lookAt: [number, number, number]
  fov?: number
}

export const VANTAGES: Vantage[] = [
  {
    id: 'base-exterior-red',
    shows:
      'Red base from the canyon floor at middle distance. Big cliff face fills the left edge, ' +
      'the gas giant hangs low in the upper left, grass-and-sand floor sweeps across the bottom.',
    // Near eye level, not a downward pitch: in the frame the horizon runs across the
    // middle, the base sits right of centre and Threshold hangs well off to its left.
    position: [-69, 10, -64],
    lookAt: [-11, 9.4, -146],
  },
  {
    id: 'base-exterior-blue',
    shows:
      'Blue base sitting under the far cliff wall, the Halo ring band arcing up the sky at right, ' +
      'a near cliff dark in the left foreground.',
    // Eye height, pitched slightly *up*. The reference puts the far cliff top at ~44%
    // of frame height with open sky above it; the old camera stood at 10 m looking
    // down and left barely a tenth of the frame as sky, which made the whole skybox
    // impossible to judge. Hugging the -X wall also gives the near cliff that fills
    // the left foreground in the reference.
    position: [-76, 2.6, 38],
    lookAt: [BLUE_BASE.x + 4, BASE_DECK_HEIGHT + 14, BLUE_BASE.z - 1],
  },
  {
    id: 'ridge-overlook',
    shows:
      'From the sniper ridge looking down the canyon at a base. Halo ring rises behind the far ' +
      'mesa left of centre, braided sand paths run through green grass across the whole floor, ' +
      'the sandy ridge top with a pistol on it fills the right third.',
    // The reference looks *down* the canyon, not across it: a quarter of the frame is
    // sky, the far wall tops out around a quarter of the way down, and two more mesa
    // ranks show behind it. Standing on the ridge and facing the near end wall put that
    // wall 40 m away and filled the frame with it, so the vantage faces the long axis
    // instead — which is also the lit direction, as the reference's warm far wall is.
    position: [SNIPER_RIDGE.x - 5, SNIPER_RIDGE.y, SNIPER_RIDGE.z - 8],
    lookAt: [23, 9.2, BLUE_BASE.z + 6],
  },
  {
    id: 'midfield',
    shows: 'Canyon floor at midfield, standing eye height, looking down the long axis',
    position: [0, 1.7, 0],
    lookAt: [0, 1.7, -60],
  },
  {
    id: 'overview',
    shows: 'Wide high view of the whole canyon',
    position: [-120, 55, 0],
    lookAt: [0, 0, 0],
  },
]

const byId = new Map(VANTAGES.map((v) => [v.id, v]))

export function applyVantage(camera: THREE.PerspectiveCamera, id: string): Vantage | undefined {
  const v = byId.get(id)
  if (!v) return undefined
  camera.position.set(...v.position)
  camera.lookAt(new THREE.Vector3(...v.lookAt))
  camera.fov = v.fov ?? 70
  camera.updateProjectionMatrix()
  return v
}

/** Dev hooks so the shot tool and a critic can drive the camera. */
export function installVantageHooks(camera: THREE.PerspectiveCamera): void {
  const w = window as unknown as Record<string, unknown>
  w.__cam = (id: string) => applyVantage(camera, id)?.shows ?? `unknown vantage: ${id}`
  w.__cams = () => VANTAGES.map((v) => `${v.id} — ${v.shows}`)
  const params = new URLSearchParams(location.search)
  const fromUrl = params.get('cam')
  if (fromUrl) applyVantage(camera, fromUrl)

  // ?eye=x,y,z&aim=x,y,z overrides the camera so a vantage can be dialled in against its
  // reference frame without an edit-reload cycle. Matching framing matters: a critic comparing
  // two differently-framed images is judging composition, not the thing being built.
  const eye = params.get('eye')?.split(',').map(Number)
  const aim = params.get('aim')?.split(',').map(Number)
  if (eye?.length === 3 && aim?.length === 3) {
    camera.position.set(eye[0], eye[1], eye[2])
    camera.lookAt(new THREE.Vector3(aim[0], aim[1], aim[2]))
  }
}
