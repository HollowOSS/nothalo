/** Cosmetic bullet impulse data carried with an authoritative lethal hit. */
export interface BulletImpact {
  point:{x:number;y:number;z:number}
  direction:{x:number;y:number;z:number}
  strength:number
}
export function bulletImpulseStrength(weapon:string,pellets=1):number{
  const base=({sniper:6,magnum:1.8,shotgun:.35,warthog:1.2,'assault-rifle':.9,ghost:1.1} as Record<string,number>)[weapon]??1
  return base*(weapon==='shotgun'?Math.max(1,Math.min(8,pellets)):1)
}
