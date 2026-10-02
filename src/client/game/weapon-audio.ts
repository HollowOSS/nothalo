import {HALO2_SOUNDS} from './halo2-audio-catalog.ts'
import {HALO_SOUNDS} from './halo-audio-catalog.ts'
/** Original Halo archive WAVs. See public/assets/audio/combat/halo-original/manifest.json.
 * Preserve source pitch, sample data and recorded variants; no synthetic layers.
 */
export type WeaponSoundEntry = {files: readonly string[]; gain: number; variation?: number}
export type ReloadCue = {at: number; sound: string; gain: number; rate?: number}
export const WEAPON_SOUNDS:Record<string,WeaponSoundEntry> = {...HALO_SOUNDS,...HALO2_SOUNDS}
for(const id of ['smg','plasma-pistol','plasma-rifle'])WEAPON_SOUNDS[`melee-impact:${id}`]=HALO_SOUNDS['body-hit']
const full=(weapon:string):ReloadCue[]=>[{at:0,sound:`${weapon}:reload`,gain:1}]
export const WEAPON_RELOAD_CUES:Readonly<Record<string,readonly ReloadCue[]>>={
 'assault-rifle':full('assault-rifle'),
 magnum:full('magnum'),
 smg:full('smg'),
 sniper:full('sniper'),
 'rocket-launcher':full('rocket-launcher'),
 'battle-rifle':full('battle-rifle'),
 needler:full('needler'),
 // CE separates the shell-loading Foley from the fire/pump animation track.
 shotgun:[{at:0,sound:'shotgun:open',gain:1},{at:.5189333333/2.8,sound:'shotgun:in',gain:1},{at:.80,sound:'shotgun:close',gain:1}],
}
