import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { registerModel } from '../models.ts'
registerModel('rocket-launcher',()=>{
 const group=new THREE.Group();group.name='rocket-launcher'
 const parts=new Map<string,THREE.BufferGeometry[]>()
 const add=(kind:string,geometry:THREE.BufferGeometry,x:number,y:number,z:number)=>{geometry=geometry.index?geometry.toNonIndexed():geometry;geometry.translate(x,y,z);const list=parts.get(kind)??[];list.push(geometry);parts.set(kind,list)}
 const box=(kind:string,x:number,y:number,z:number,w:number,h:number,d:number)=>add(kind,new RoundedBoxGeometry(w,h,d,1,.008),x,y,z)
 for(const x of [-.115,.115]) {
  add('olive',new THREE.CylinderGeometry(.10,.10,1.25,16,1,true).rotateX(Math.PI/2),x,.065,0)
  for(const z of [-.60,-.39,.36,.61])add('metal',new THREE.TorusGeometry(.103,.013,6,16),x,.065,z)
  for(const z of [-.61,.62])add('black',new THREE.CircleGeometry(.084,16).rotateY(z<0?Math.PI:0),x,.065,z)
  box('metal',x,.17,-.22,.024,.025,.44)
 }
 const tubeParts=new Map(parts);parts.clear()
 box('black',0,-.06,-.22,.15,.11,.48)
 box('olive',0,.20,-.14,.12,.09,.25)
 box('black',0,.21,-.272,.085,.05,.009)
 box('black',0,-.19,-.27,.055,.18,.085)
 box('metal',0,-.17,-.16,.075,.025,.15)
 box('black',0,-.10,.26,.15,.08,.18)
 box('metal',0,-.09,-.51,.24,.04,.17)
 for(let i=0;i<4;i++)box('black',0,-.19+i*.027,-.315,.058,.008,.008)
 const materials={olive:new THREE.MeshStandardMaterial({color:0x687044,roughness:.7,metalness:.3}),metal:new THREE.MeshStandardMaterial({color:0x454b4b,roughness:.45,metalness:.65}),black:new THREE.MeshStandardMaterial({color:0x171c1b,roughness:.8})}
 const tubes=new THREE.Group();tubes.name='rocket-tubes';group.add(tubes)
 for(const [kind,list] of tubeParts){const mesh=new THREE.Mesh(mergeGeometries(list,false),materials[kind as keyof typeof materials]);mesh.castShadow=true;tubes.add(mesh)}
 for(const [kind,list] of parts){const mesh=new THREE.Mesh(mergeGeometries(list,false),materials[kind as keyof typeof materials]);mesh.castShadow=true;group.add(mesh)}
 return group
})
