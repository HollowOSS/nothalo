/** Original vector reconstructions from CE/Halo 3 gameplay, not generic FPS crosshairs.
 * SVG canvas dimensions at 720p, calibrated against visible reference bounds (including inset shapes).
 * Fit the 1280x720 reference frame inside the viewport, including tall in-app panels.
 * See docs/weapon-reticles.md for the game/version and comparison images for each weapon.
 * Keep the optical center on the actual camera ray (our game uses a centered camera).
 */
export const RETICLES = {
  'smg': {size:65,game:'h2',shape:'<path d="M25 12H12V25 M75 12H88V25 M12 75V88H25 M88 75V88H75"/><circle cx="50" cy="50" r="3" fill="currentColor"/>'},
  'plasma-pistol': {size:43,game:'h2',shape:'<path d="M30 10A44 44 0 0 0 30 90 M70 10A44 44 0 0 1 70 90 M38 50H62 M50 38V62"/>'},
  'plasma-rifle': {size:57,game:'h2',shape:'<path d="M24 12A43 43 0 0 0 24 88 M76 12A43 43 0 0 1 76 88 M8 50H25 M75 50H92"/>'},
  'magnum': { size: 44, game: 'ce', shape: '<circle cx="50" cy="50" r="42"/><path d="M50 8V19 M50 81V92 M8 50H19 M81 50H92"/>' },
  'assault-rifle': { size: 82, game: 'ce', shape: '<path d="M28 15Q50 3 72 15 M85 28Q97 50 85 72 M72 85Q50 97 28 85 M15 72Q3 50 15 28 M50 6V0 M94 50H100 M50 94V100 M6 50H0"/>' },
  'shotgun': { size: 86, game: 'ce', shape: '<circle cx="50" cy="50" r="46"/>' },
  'sniper': { size: 17, game: 'ce', shape: '<circle cx="50" cy="50" r="37"/><circle cx="50" cy="50" r="5" fill="currentColor" stroke="none"/>' },
  'rocket-launcher': { size: 86, game: 'ce', shape: '<path d="M24 10A46 46 0 0 0 37 94 M63 94A46 46 0 0 0 76 10 M40 4H60 M40 96H60 M4 50H12 M20 50H28 M40 50H60 M72 50H80 M88 50H96 M40 18H60 M40 34H60 M40 66H60 M40 82H60"/><g fill="currentColor" stroke="none" font-family="monospace" font-size="7"><text x="24" y="8">40</text><text x="64" y="8">P:L</text></g>' },
  'energy-sword': { size: 89, game: 'h3', shape: '<path d="M22 27A36 36 0 0 1 85 55 M78 73A36 36 0 0 1 15 45"/><path d="M12 40L16 17L31 34Z M88 60L84 83L69 66Z" fill="currentColor" stroke="none"/>' },
  'needler': { size: 49, game: 'h3', shape: '<path d="M30 20C-6 30 -6 70 30 80C16 64 16 36 30 20Z M70 20C106 30 106 70 70 80C84 64 84 36 70 20Z M18 42L31 50L18 58Z M82 42L69 50L82 58Z" fill="currentColor" stroke="none"/>' },
  'battle-rifle': { size: 34, game: 'h3', shape: '<path d="M14 44A37 37 0 0 1 44 14 M56 14A37 37 0 0 1 86 44 M86 56A37 37 0 0 1 56 86 M44 86A37 37 0 0 1 14 56 M50 0V31 M50 69V100 M0 50H31 M69 50H100"/>' },
  'gravity-hammer': { size: 82, game: 'h3', shape: '<path d="M54 7V32L76 54H99 M32 29V54L54 76H77 M10 51V76L32 98H55" stroke-width="3.8"/><path d="M61 13H79L95 29V46H77L61 30Z M39 35H52 M67 57V68H55L39 52V35 M17 57H30 M45 79V90H33L17 74V57" stroke-width="1" opacity=".65"/>' },
  'vehicle': { size: 36, game: 'ce', shape: '<circle cx="50" cy="50" r="38"/><path d="M0 50H24 M76 50H100 M50 0V24 M50 76V100"/><circle cx="50" cy="50" r="4" fill="currentColor" stroke="none"/>' },
} as const

export type ReticleId = keyof typeof RETICLES

export function reticleSvg(id: ReticleId): string {
  const item = RETICLES[id]
  return `<svg viewBox="0 0 100 100" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="${id === 'magnum' ? 4 : id === 'sniper' ? 7 : id === 'battle-rifle' ? 5 : 2.2}" stroke-linecap="butt" stroke-linejoin="round">${item.shape}</svg>`
}

export const RETICLE_CSS = `
.hud .reticle {position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#58b8fa;filter:drop-shadow(0 0 1px #06243c);}
.hud .reticle[data-game="h3"] {color:#8cc7ef;}
.hud .reticle svg {display:block;width:100%;height:100%;overflow:visible;}
.hud .reticle.target-ready {color:#ff5048;}
.hud .reticle.vehicle.obstructed {color:#ffc777;}
`

/** Only swap markup on weapon/vehicle changes, never every animation frame. */
export function setReticle(element: HTMLElement, weapon: string): void {
  if (!Object.hasOwn(RETICLES, weapon)) throw new Error(`Missing weapon reticle: ${weapon}`)
  const id = weapon as ReticleId
  if (element.dataset.weapon === id) return
  const item = RETICLES[id]
  element.dataset.weapon = id
  element.dataset.game = item.game
  // Fit the reference HUD into both viewport axes. Height-only scaling balloons
  // crosshairs in tall in-app panels. CSS recomputes without a weapon swap.
  element.style.width = element.style.height = `min(${item.size / 7.2}vh, ${item.size / 12.8}vw)`
  element.innerHTML = reticleSvg(id)
}
