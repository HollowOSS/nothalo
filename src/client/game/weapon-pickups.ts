import * as THREE from 'three'
import {LOADOUT} from '../../shared/loadout.ts'
import type {WeaponPickup} from '../../shared/weapon-pickups.ts'
import {loadAuthoredWeapon} from '../render/models/authored-weapons.ts'
/** Shared source geometry/textures; no parsing or model creation when a weapon is collected. */
export class WeaponPickupView {
 readonly ready:Promise<void>
 private models=new Map<number,THREE.Group>()
 constructor(scene:THREE.Scene,pickups:readonly WeaponPickup[]){
  this.ready=Promise.all(pickups.map(async p=>{
   const model=await loadAuthoredWeapon(LOADOUT[p.slot].model)
   model.object.name=`weapon-pickup:${p.id}`;model.object.position.set(p.x,p.y+.45,p.z);model.object.rotation.z=Math.PI/2
   this.models.set(p.id,model.object);scene.add(model.object)
  })).then(()=>{})
 }
 update(pickups:readonly WeaponPickup[],now:number):void {for(const p of pickups){const model=this.models.get(p.id);if(model){model.visible=p.availableAt<=now;model.rotation.y=now*.00035}}}
}
