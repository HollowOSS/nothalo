import * as THREE from 'three'
import {crouchRagdoll} from '../render/ragdolls.ts'

interface Croucher { id:string; alive:boolean; seated:boolean; state:{x:number;y:number;z:number;yaw:number;crouched:boolean;onGround:boolean} }
/** Read existing local/predicted and remote crouch states; corpses remain cosmetic per client. */
export class CorpseCrouchContacts {
  private previous=new Map<string,{crouched:boolean;last:number;x:number;y:number;z:number}>()
  update(players:readonly Croucher[],time:number,visible:(a:THREE.Vector3,b:THREE.Vector3)=>boolean):THREE.Vector3[] {
    const contacts:THREE.Vector3[]=[],present=new Set<string>()
    for(const player of players){
      present.add(player.id)
      const s=player.state,old=this.previous.get(player.id)
      let last=old?.last??-Infinity
      if(old && !old.crouched && s.crouched && player.alive && !player.seated && s.onGround && time-last>=.32
        && Math.hypot(s.x-old.x,s.y-old.y,s.z-old.z)<2){
        const hit=crouchRagdoll(s,s.yaw,visible)
        if(hit){contacts.push(hit);last=time}
      }
      this.previous.set(player.id,{crouched:s.crouched,last,x:s.x,y:s.y,z:s.z})
    }
    for(const id of this.previous.keys())if(!present.has(id))this.previous.delete(id)
    return contacts
  }
}
