/** Centers measured from the supplied 1280 × 591 mobile HUD reference. */
export const TOUCH_DEFAULTS = {
  fire: { x: .828, y: .697, diameter: 17, label: 'Fire' },
  jump: { x: .892, y: .545, diameter: 12, label: 'Jump' },
  horn: { x: .892, y: .545, diameter: 12, label: 'Horn' },
  // Jump, horn and boost never show together (on foot, Warthog driver, boosting vehicles), so they share a spot.
  boost: { x: .892, y: .545, diameter: 12, label: 'Boost' },
  crouch: { x: .734, y: .782, diameter: 12, label: 'Crouch' },
  aim: { x: .767, y: .520, diameter: 10, label: 'Aim' },
  reload: { x: .742, y: .630, diameter: 10, label: 'Reload' },
  swap: { x: .819, y: .480, diameter: 10, label: 'Switch weapon' },
  melee: { x: .577, y: .900, diameter: 10, label: 'Melee' },
  grenade: { x: .675, y: .910, diameter: 10, label: 'Grenade' },
  seat: { x: .930, y: .355, diameter: 10, label: 'Change seat' },
  'pickup-left': {x:.795,y:.355,diameter:10,label:'Pick up in left hand'},
  use: { x: .868, y: .355, diameter: 10, label: 'Right pickup / use' },
  // Give the off-hand fire control a real thumb-sized target. Its position stays above the
  // movement stick so the two controls remain distinct on narrow landscape phones.
  'left-fire': { x: .089, y: .478, diameter: 16.5, label: 'Left fire' },
  move: { x: .170, y: .746, diameter: 23, label: 'Movement stick' },
} as const

export type TouchControlId = keyof typeof TOUCH_DEFAULTS
export interface ControlPlacement { x: number; y: number; scale: number; opacity: number }
export type TouchLayout = Record<TouchControlId, ControlPlacement>
export interface TouchBounds { left: number; top: number; width: number; height: number }
export const TOUCH_LAYOUT_KEY = 'halo.touch-layout.v1'
export const TOUCH_CONTROL_IDS = Object.keys(TOUCH_DEFAULTS) as TouchControlId[]

export function defaultTouchLayout(): TouchLayout {
  return Object.fromEntries(TOUCH_CONTROL_IDS.map(id => [id, {
    x: TOUCH_DEFAULTS[id].x, y: TOUCH_DEFAULTS[id].y, scale: 1, opacity: .80,
  }])) as TouchLayout
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

/** Ignore unknown controls and invalid fields so old or damaged saves stay playable. */
export function parseTouchLayout(raw: string | null): TouchLayout {
  const layout = defaultTouchLayout()
  try {
    const saved = JSON.parse(raw ?? 'null')
    if (saved?.version !== 1 || !saved.controls || typeof saved.controls !== 'object') return layout
    for (const id of TOUCH_CONTROL_IDS) {
      const value = saved.controls[id]
      if (!value || typeof value !== 'object') continue
      for (const field of ['x', 'y', 'scale', 'opacity'] as const) {
        const number = value[field]
        if (typeof number !== 'number' || !Number.isFinite(number)) continue
        const [min, max] = field === 'scale' ? [.65, 1.6] : field === 'opacity' ? [.25, 1] : [0, 1]
        layout[id][field] = clamp(number, min, max)
      }
    }
  } catch { /* Storage from another version or a partial write: use the reference layout. */ }
  return layout
}

export function serializeTouchLayout(layout: TouchLayout): string {
  return JSON.stringify({ version: 1, controls: layout })
}

/** Keep the entire hit target inside the safe area at every screen size and rotation. */
export function placeTouchControl(id: TouchControlId, layout: TouchLayout, bounds: TouchBounds): { x: number; y: number; size: number } {
  const placement = layout[id]
  const shortSide = Math.min(bounds.width, bounds.height)
  const base = clamp(shortSide * TOUCH_DEFAULTS[id].diameter / 100, id === 'move' ? 96 : 44, id === 'move' ? 160 : 120)
  const size = Math.min(Math.max(40, base * placement.scale), Math.max(1, shortSide - 16))
  const radius = size / 2 + 6
  return {
    x: bounds.left + clamp(placement.x * bounds.width, radius, Math.max(radius, bounds.width - radius)),
    y: bounds.top + clamp(placement.y * bounds.height, radius, Math.max(radius, bounds.height - radius)),
    size,
  }
}
