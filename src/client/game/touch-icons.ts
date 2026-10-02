import type { TouchControlId } from './touch-layout.ts'

// Small, high-contrast silhouettes stay readable over scenery without text on the hit target.
const bullet = '<g transform="rotate(-43 24 24)"><path d="M20 36V17L24 8L28 17V36Z" fill="currentColor" stroke="none"/><path d="M19 39H29M20 32H28"/></g>'
const figures = {
  jump: '<circle cx="29" cy="9" r="4" fill="currentColor" stroke="none"/><path d="M25 17L31 23L38 21M24 17L18 22L12 16M27 22L23 29L16 29L12 38M24 28L31 34L37 30" stroke-width="4.5"/>',
  crouch: '<circle cx="28" cy="11" r="4" fill="currentColor" stroke="none"/><path d="M26 19L20 25L31 28L31 38H39M21 25L16 34L9 34M26 19L33 22L38 17M24 20L15 19L10 24" stroke-width="4.5"/>',
}
const shapes: Record<TouchControlId | 'settings' | 'pickup-right' | 'board', string> = {
  'pickup-left': '<path d="M30 10H18V34H30M10 25L18 33L26 25"/><text x="30" y="39" fill="currentColor" stroke="none" font-size="14">L</text>',
  // Use while a weapon is in reach: the right-hand pickup, the mirror of pickup-left.
  'pickup-right': '<path d="M18 10H30V34H18M38 25L30 33L22 25"/><text x="8" y="39" fill="currentColor" stroke="none" font-size="14">R</text>',
  fire: bullet, 'left-fire': bullet,
  jump: figures.jump, crouch: figures.crouch,
  aim: '<circle cx="24" cy="24" r="12"/><path d="M24 5V17M24 31V43M5 24H17M31 24H43"/><circle cx="24" cy="24" r="2" fill="currentColor" stroke="none"/>',
  reload: '<g transform="rotate(-25 24 24)"><path d="M12 35V15L15 9L18 15V35ZM22 35V15L25 9L28 15V35ZM32 35V15L35 9L38 15V35Z" fill="currentColor" stroke="none"/></g>',
  swap: '<path d="M10 18H35L28 11M35 18V29M38 32H13L20 39M13 32V21" stroke-width="3.4"/>',
  melee: '<path d="M14 30L33 9L38 7L37 15L20 33Z" fill="currentColor" stroke="none"/><path d="M11 28L23 38M9 40L16 33" stroke-width="4"/>',
  grenade: '<path d="M21 12H28V18H21ZM20 18C9 29 16 40 25 40C35 40 40 28 29 18Z"/><path d="M28 12L34 14L36 25M20 25H31M18 31H34M25 19V39"/>',
  use: '<path d="M23 8H37V40H23M7 24H29M22 17L29 24L22 31" stroke-width="3"/>',
  // Use while a vehicle is in reach: step in (the use arrow, into a seat).
  board: '<path d="M7 20H23M17 14L23 20L17 26" stroke-width="3"/><path d="M29 9V27H40L43 38M26 33H39" stroke-width="3.4"/>',
  seat: '<path d="M17 10V27H32L36 38M13 15V31H27M11 38H28" stroke-width="4"/>',
  boost: '<path d="M12 22L24 11L36 22M12 32L24 21L36 32M12 42L24 31L36 42" stroke-width="4.2"/>',
  horn: '<path d="M11 20H20L31 11V37L20 28H11ZM36 17Q43 24 36 31"/>',
  move: '<path d="M24 5L20 10H28ZM43 24L38 20V28ZM24 43L20 38H28ZM5 24L10 20V28Z" fill="currentColor" stroke="none"/>',
  settings: '<path d="M20 5H28L29 10L33 12L38 10L42 17L38 21V27L42 31L38 38L33 36L29 38L28 43H20L19 38L15 36L10 38L6 31L10 27V21L6 17L10 10L15 12L19 10Z"/><circle cx="24" cy="24" r="7"/>',
}

export function touchIcon(id: keyof typeof shapes): string {
  return `<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${shapes[id]}</svg>`
}
