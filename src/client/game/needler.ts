import * as THREE from 'three'
import {launchNeedle,stepNeedle,type Needle,type NeedleTarget} from '../../shared/needles.ts'
export class NeedlerProjectiles {
  private readonly active:{flight:Needle;mesh:THREE.Group;trail:THREE.Mesh;from:THREE.Vector3;owner:string;team:string}[]=[]
  private readonly geometry=new THREE.ConeGeometry(.035,.32,5).rotateX(Math.PI/2)
  private readonly material=new THREE.MeshBasicMaterial({color:0xff79e6,toneMapped:false})
  private readonly trailGeometry=new THREE.CylinderGeometry(.018,.002,.7,5).rotateX(Math.PI/2)
  private readonly trailMaterial=new THREE.MeshBasicMaterial({color:0xff65d6,transparent:true,opacity:.45,blending:THREE.AdditiveBlending,depthWrite:false,toneMapped:false})
  constructor(private scene:THREE.Scene,private targets:(team:string)=>NeedleTarget[],private blocked:(a:NeedleTarget,b:NeedleTarget)=>boolean,private hit:(id:string,owner:string,point:THREE.Vector3)=>void){}
  launch(origin:THREE.Vector3,dir:THREE.Vector3,owner:string,team:string):void {
    if(this.active.length>=96)return
    const flight=launchNeedle(origin,dir,this.targets(team),this.blocked),mesh=new THREE.Group()
    mesh.add(new THREE.Mesh(this.geometry,this.material))
    // the trail only reaches back as far as the needle has flown: launched from the gun half a metre ahead of the eye, a full-length trail
    // ran back through the camera and filled the screen
    const trail=new THREE.Mesh(this.trailGeometry,this.trailMaterial);trail.scale.z=0;mesh.add(trail)
    mesh.position.copy(origin);mesh.lookAt(origin.x+dir.x,origin.y+dir.y,origin.z+dir.z)
    this.scene.add(mesh);this.active.push({flight,mesh,trail,from:origin.clone(),owner,team})
  }
  update(dt:number):void {
    for(let i=this.active.length-1;i>=0;i--){const p=this.active[i],r=stepNeedle(p.flight,dt,this.targets(p.team),this.blocked)
      p.mesh.position.set(p.flight.x,p.flight.y,p.flight.z);p.mesh.lookAt(p.flight.x+p.flight.dx,p.flight.y+p.flight.dy,p.flight.z+p.flight.dz)
      const grown=Math.min(1,p.mesh.position.distanceTo(p.from)/.8);p.trail.scale.z=grown;p.trail.position.z=-(.1+.35*grown)
      if(r.hit)this.hit(r.hit,p.owner,p.mesh.position.clone())
      if(r.done){this.scene.remove(p.mesh);this.active.splice(i,1)}
    }
  }
}
