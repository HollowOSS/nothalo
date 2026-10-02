import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { GUARDIAN_SOLIDS, GUARDIAN_SNIPER_PATH, GUARDIAN_SNIPER_UPPER_PATH, GUARDIAN_CAMO_PATH, surface } from './guardian-legacy-solids.ts'
import { guardianMaterial, architecturalUV, scannedSurface } from './halo3-materials.ts'
import { attachImportedGuardian, createGuardianCollisionDebug, type GuardianCollisionDebug } from './guardian-imported.ts'
import { createGuardianLiftFx } from './guardian-lift-fx.ts'
import { createGuardianSky, createGuardianAmbientFx, GUARDIAN_FOG } from './guardian-lighting.ts'
import type { VolumeSettings } from './volumetric-light.ts'
import { preloadLevelData } from '../../shared/level-data.ts'
import { MOVE } from '../../shared/constants.ts'

/** Authored Halo 3 reconstruction. Shared collision slabs, profile-modeled architecture,
 * metre-scale PBR surfaces, radial deck inlays and a branching, instanced jungle canopy. */
export function createGuardian(scene:THREE.Scene,renderer:THREE.WebGLRenderer,signal?:AbortSignal):THREE.Group {
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1
  // Guardian uses authored textures plus directional/hemisphere lights. Avoid a PMREM
  // environment lookup on every PBR fragment; it adds a large startup bake and a continuous
  // texture sample across the whole imported architecture for little gameplay benefit.
  scene.environment=null
  // Halo 3's teal-green haze. The sky dome (guardian-lighting.ts) is drawn over the background
  // colour; the colour stays as the fallback for anything the dome does not cover.
  scene.background=new THREE.Color(0x2c6254)
  const fog=new THREE.FogExp2(GUARDIAN_FOG,.0105)
  scene.fog=fog
  // Ground bounce raised from near black (#15261d): shaded sides and undersides read mid-grey-green.
  scene.add(new THREE.HemisphereLight(0xb5dccf,0x31503f,1.6))
  // Glow on the restored lights (guardian-lighting.ts) and the launchers: a little lower and
  // wider than the generic default, so strips, lamps and plumes bloom softly as in Halo 3.
  // A light grade (bloom.ts): Guardian's interiors are lit to their target brightness, and the default S-curve and vignette
  // would take ~10 points back off them.
  scene.userData.bloom={threshold:.8,knee:.16,strength:.6,grade:[.06,.12,.12]}
  // The architecture never moves, so its shadow map is rendered once (and again whenever
  // the quality tier resizes it) instead of re-drawing 113k double-sided triangles every frame.
  // Player characters do not cast shadows; vehicles retain the world map shadow pass.
  const sun=new THREE.DirectionalLight(0xfff1ca,1.9);sun.position.set(-38,75,22);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-48,right:48,top:48,bottom:-48,near:1,far:160});sun.shadow.normalBias=.09;sun.shadow.bias=-.0002;sun.shadow.autoUpdate=false;sun.shadow.needsUpdate=true;scene.add(sun)
  // God rays: sunlight scattered through the canopy and the gaps between the buildings, marched
  // against the sun's static shadow map (volumetric-light.ts, run by bloom.ts; desktop only).
  // Pale green-white like Halo 3's shafts; thin enough that open air stays clear, not a fog wall.
  scene.userData.volume={sun,color:new THREE.Color(0xd4f0cc),density:.007,intensity:3.4,anisotropy:.8,distance:70,ceiling:.3,resolution:.5} satisfies VolumeSettings
  const fill=new THREE.DirectionalLight(0x6aa39c,.75);fill.position.set(25,20,-30);scene.add(fill)
  // Sky dome (sky pixels only), plus light shafts and holograms in one additive draw. On the
  // scene, not the map root, which drops everything but the imported model once it loads.
  const sky=createGuardianSky(),ambientFx=createGuardianAmbientFx(fog,sun.position)
  scene.add(sky,ambientFx.mesh)
  const root=new THREE.Group();root.name='guardian'
  // Fetch the detailed model while the first visible scenery is being built.
  root.userData.ready=attachImportedGuardian(root,signal)
  const wind={value:0}
  // Collision debug overlay: `?collision` in the URL or the C key while playing.
  let collisionDebug:GuardianCollisionDebug|null=null
  root.userData.toggleCollision=(show?:boolean)=>{
    collisionDebug??=createGuardianCollisionDebug()
    if(!collisionDebug.group.parent)root.add(collisionDebug.group)
    collisionDebug.group.visible=show??!collisionDebug.group.visible
    return collisionDebug.group.visible
  }
  if(new URLSearchParams(location.search).has('collision'))void preloadLevelData('guardian').then(()=>root.userData.toggleCollision(true)).catch(error=>console.warn('Collision debug unavailable:',error))
  // The Gold lift's glow and haze, the man cannon plumes and the booster discs and jets, plus a
  // puff where anyone actually launches (triggered from Match, which is what sees a lift fire).
  const liftFx=createGuardianLiftFx(scene.fog)
  root.add(liftFx.group)
  root.userData.liftBurst=(x:number,y:number,z:number)=>liftFx.burst(x,y,z)
  root.userData.update=(time:number,_focus?:THREE.Vector3,player?:{x:number;y:number;z:number;crouched?:boolean})=>{
    wind.value=time
    liftFx.update(time)
    ambientFx.update(time)
    if(player&&collisionDebug)collisionDebug.update(player,MOVE.playerHeight*(player.crouched?.62:1))
  }
  root.userData.bakeShadows=()=>{sun.shadow.needsUpdate=true}
  // The menu already has a still backdrop. Do not build and upload thousands of temporary
  // meshes/textures that are discarded as soon as the real Guardian finishes downloading.
  if (!new URLSearchParams(location.search).has('guardian-placeholder')) { scene.add(root); return root }
  const solids=new THREE.Group();solids.name='guardian-solids';root.add(solids)
  const alloy=guardianMaterial('alloy',0x788580),floor=guardianMaterial('floor',0x8a9185)
  const dark=guardianMaterial('alloy',0x303e3d),gold=guardianMaterial('alloy',0x858570)
  const blue=guardianMaterial('alloy',0x687e85),bark=guardianMaterial('bark',0x697451)
  const moss=guardianMaterial('bark',0x536047)
  for(const mat of [alloy,floor,dark,gold,blue]){
    const panelMap=mat.map
    scannedSurface(mat,'concrete_floor_worn_02',.18);mat.roughness=.73;mat.metalness=.48
    mat.onBeforeCompile=shader=>{shader.uniforms.guardianPanel={value:panelMap};shader.fragmentShader='uniform sampler2D guardianPanel;\n'+shader.fragmentShader;shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\n diffuseColor.rgb=mix(vec3(dot(diffuseColor.rgb,vec3(.2126,.7152,.0722))),diffuseColor.rgb,.18); diffuseColor.rgb *= .35 + 1.25*texture2D(guardianPanel,vMapUv).r;')}
    mat.customProgramCacheKey=()=> 'guardian-desaturated-alloy'
  }
  alloy.color.setHex(0xa2adb0);floor.color.setHex(0xb7c0bd);dark.color.setHex(0x526267);gold.color.setHex(0xb3ae98);blue.color.setHex(0x879eac)
  scannedSurface(bark,'bark_brown_02',1.3);bark.color.setHex(0x859477)
  scannedSurface(moss,'mossy_rock',.8)
  const glass=new THREE.MeshPhysicalMaterial({color:0x8dbec6,transparent:true,opacity:.22,roughness:.12,metalness:.08,side:THREE.DoubleSide,depthWrite:false})
  const edge=new THREE.MeshStandardMaterial({color:0x233a38,roughness:.78,metalness:.48})
  const white=new THREE.MeshBasicMaterial({color:0xd3fff4}),cyan=new THREE.MeshBasicMaterial({color:0x67d9f0}),amber=new THREE.MeshBasicMaterial({color:0xffe6a9})
  const batch=new Map<THREE.Material,THREE.BufferGeometry[]>()
  let seed=1303;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296}
  const put=(geo:THREE.BufferGeometry,mat:THREE.Material,x=0,y=0,z=0,ry=0,rx=0,rz=0,uv=true)=>{
    geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),new THREE.Quaternion().setFromEuler(new THREE.Euler(rx,ry,rz)),new THREE.Vector3(1,1,1)))
    if(uv)architecturalUV(geo)
    const g=geo.index?geo.toNonIndexed():geo;if(g!==geo)geo.dispose()
    const list=batch.get(mat)??[];list.push(g);batch.set(mat,list)
  }
  const box=(w:number,h:number,d:number,x:number,y:number,z:number,mat:THREE.Material=alloy,ry=0,bevel=0)=>put(bevel?new RoundedBoxGeometry(w,h,d,1,Math.min(bevel,w/4,h/4,d/4)):new THREE.BoxGeometry(w,h,d),mat,x,y,z,ry)
  // Side profile extruded across thickness; local coordinates are horizontal X and vertical Y.
  const profile=(points:number[][],depth:number,mat:THREE.Material,x:number,y:number,z:number,ry=0)=>{
    const s=new THREE.Shape();points.forEach(([px,py],i)=>i?s.lineTo(px,py):s.moveTo(px,py));s.closePath()
    put(new THREE.ExtrudeGeometry(s,{depth,steps:1,bevelEnabled:true,bevelThickness:.045,bevelSize:.045,bevelSegments:1}).translate(0,0,-depth/2),mat,x,y,z,ry)
  }
  const line=(points:number[][],radius:number,mat:THREE.Material)=>{
    const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p as [number,number,number])))
    const segments=Math.max(4,points.length*5),geo=new THREE.TubeGeometry(curve,segments,radius,7,false)
    if(radius>1){const p=geo.getAttribute('position');for(let i=0;i<p.count;i++){const t=Math.floor(i/8)/segments,center=curve.getPointAt(t),v=new THREE.Vector3().fromBufferAttribute(p,i).sub(center).multiplyScalar(1-t*.97).add(center);p.setXYZ(i,v.x,v.y,v.z)}geo.computeVertexNormals()}
    put(geo,mat)
  }
  const lamp=(x:number,y:number,z:number,color:number,intensity=12,distance=13)=>{const l=new THREE.PointLight(color,intensity,distance,2);l.name='guardian-placeholder-light';l.position.set(x,y,z);root.add(l)}
  for(const s of GUARDIAN_SOLIDS){
    // These shapes are collision proxies for the detailed meshes authored below.
    // Rendering them as solid boxes hid the beacon chamfers and battery glow.
    if(s.name.startsWith('Mid beacon')||s.name.startsWith('Blue battery'))continue
    const mat=s.name.includes('stump')?bark:s.glass?glass:s.zone==='green'&&s.h===1?moss:s.h>1?s.zone==='gold'?gold:s.zone==='blue'?blue:alloy:floor
    if(s.outline){
      const pts:number[]=[],n=s.outline.length
      const vertex=(i:number,top:boolean)=>{const [x,z]=s.outline![i];return [s.x+x,surface(s,s.x+x,s.z+z)-(top?0:s.h),s.z+z]}
      for(let i=1;i<n-1;i++){pts.push(...vertex(0,true),...vertex(i+1,true),...vertex(i,true));pts.push(...vertex(0,false),...vertex(i,false),...vertex(i+1,false))}
      for(let i=0;i<n;i++){const j=(i+1)%n;pts.push(...vertex(i,false),...vertex(i,true),...vertex(j,true),...vertex(i,false),...vertex(j,true),...vertex(j,false))}
      const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));geo.computeVertexNormals();put(geo,mat);continue
    }
    const geo=s.octagon?new THREE.CylinderGeometry(s.w/2/Math.cos(Math.PI/8),s.w/2/Math.cos(Math.PI/8),s.h,8).rotateY(Math.PI/8):new THREE.BoxGeometry(s.w,s.h,s.d)
    if(s.ramp){const p=geo.getAttribute('position');for(let i=0;i<p.count;i++)p.setY(i,p.getY(i)+surface(s,p.getX(i)+s.x,p.getZ(i)+s.z)-s.y-s.h);geo.computeVertexNormals()}
    architecturalUV(geo);const slab=new THREE.Mesh(geo,mat);slab.position.set(s.x,s.y+s.h/2,s.z);slab.rotation.y=s.yaw??0;slab.name=s.name;slab.castShadow=true;slab.receiveShadow=true;solids.add(slab)
    if(s.glass){
      box(.23,.12,s.d,s.x,s.y+s.h-.06,s.z,alloy)
      for(const z of [s.z-s.d/2,s.z+s.d/2])box(.22,s.h,.16,s.x,s.y+s.h/2,z,alloy)
      box(.205,.025,s.d-.2,s.x,s.y+.15,s.z,cyan)
    }
    if(s.name.includes('parapet')){
      const alongX=s.w>s.d,len=alongX?s.w:s.d,steps=Math.ceil(len/1.7)
      for(let i=0;i<steps;i++){
        const t=(i+.5)/steps-.5,x=s.x+(alongX?t*s.w:0),z=s.z+(alongX?0:t*s.d),y=surface(s,x,z)
        box(alongX?len/steps-.04:.49,.18,alongX?.49:len/steps-.04,x,y-.05,z,alloy,0,.045)
        box(alongX?.055:.38,1.02,alongX?.38:.055,x,y-.56,z,dark)
        for(const side of [-1,1])box(alongX?len/steps-.17:.015,.045,alongX?.015:len/steps-.17,x+(alongX?0:side*.17),y-.9,z+(alongX?side*.17:0),white)
      }
    }
    if(s.h!==1||s.octagon)continue
    // Thick layered undersides and machined edge fascias, including sloped decks.
    for(const side of [-1,1]){
      const length=s.w>=s.d?s.w:s.d,steps=Math.ceil(length/2.5)
      for(let i=0;i<steps;i++){
        const t=(i+.5)/steps-.5,x=s.x+(s.w>=s.d?t*s.w:side*(s.w/2-.12)),z=s.z+(s.w>=s.d?side*(s.d/2-.12):t*s.d),y=surface(s,x,z)
        box(s.w>=s.d?length/steps-.04:.27,.52,s.w>=s.d?.27:length/steps-.04,x,y-.38,z,dark)
        box(s.w>=s.d?length/steps-.1:.31,.08,s.w>=s.d?.31:length/steps-.1,x,y-.15,z,alloy)
      }
    }
    if(!s.ramp&&s.zone!=='green')for(let x=-s.w/2+1;x<s.w/2-1;x+=2.4)for(let z=-s.d/2+.8;z<s.d/2-1.3;z+=3){
      box(1.85,.015,2.55,s.x+x,s.y+1.015,s.z+z,alloy)
      box(.45,.018,.045,s.x+x-.45,s.y+1.027,s.z+z-.98,edge)
    }
  }
  // Curved Sniper deck fascias, segmented armor, and continuous recessed footlights.
  // The exact same samples form the triangular collision floor above.
  for(const path of [GUARDIAN_SNIPER_PATH,GUARDIAN_SNIPER_UPPER_PATH]){
    for(let i=0;i<path.length-1;i++)for(const side of [-1,1]){
      const points=[path[i],path[i+1]].map(p=>[p.x+(p.x+25)/8.5*2*side,p.y-.23,p.z+p.z/8.5*2*side])
      line(points,.12,alloy);line(points.map(([x,y,z])=>[x,y-.4,z]),.13,dark)
      line(points.map(([x,y,z])=>[x,y+.15,z]),.035,white)
    }
  }
  for(let i=0;i<GUARDIAN_CAMO_PATH.length-1;i++)for(const side of [-1,1]){
    const points=[GUARDIAN_CAMO_PATH[i],GUARDIAN_CAMO_PATH[i+1]].map(p=>[p.x+(p.x-35)/7*2.5*side,p.y-.18,p.z+(p.z-8.5)/7*2.5*side])
    line(points,.14,alloy);line(points.map(([x,y,z])=>[x,y-.48,z]),.18,dark)
    line(points.map(([x,y,z])=>[x,y+.1,z]),.035,white)
  }
  // Raised roots form Green's ramp toward Top Mid. The bark follows the actual
  // walkable slope, with a broken end grain at the jump-off rather than a metal shelf.
  const greenRamp=GUARDIAN_SOLIDS.find(s=>s.name==='Green stump ramp')!
  for(const side of [-1,1]){
    const points=[25,22,18,14].map(z=>[-4+side*2.3,surface(greenRamp,-4,z)-.14,z])
    line(points,.20,bark)
    line(points.map(([x,y,z])=>[x-side*.3,y+.11,z]),.065,moss)
  }
  for(let i=0;i<5;i++){
    const x=-6.2+i*1.1
    line([25,22,18,14].map(z=>[x,surface(greenRamp,x,z)+.02,z]),.028,dark)
  }
  for(const [path,cx,cz,radius,halfWidth] of [[GUARDIAN_SNIPER_PATH,-25,0,8.5,2],[GUARDIAN_SNIPER_UPPER_PATH,-25,0,8.5,2],[GUARDIAN_CAMO_PATH,35,8.5,7,2.5]] as const){
    for(let i=2;i<path.length-3;i++){
      if(path===GUARDIAN_CAMO_PATH&&i>=4)continue
      const points=[path[i],path[i+1]].map(p=>[p.x+(p.x-cx)/radius*halfWidth,p.y+1.1,p.z+(p.z-cz)/radius*halfWidth])
      line(points,.1,alloy)
      line(points.map(([x,y,z])=>[x+(cx-x)*.013,y-.86,z+(cz-z)*.013]),.035,white)
      const p=path[i],dx=(p.x-cx)/radius,dz=(p.z-cz)/radius
      box(.12,1.12,.4,p.x+dx*halfWidth,p.y+.56,p.z+dz*halfWidth,edge,Math.atan2(dx,dz))
    }
  }
  // The lower ring has its own room treatment and landmarks, visible from below.
  for(const [x,z,zone] of [[18,-23,'blue'],[-25,17,'green'],[-13,24,'green']] as const){
    const mat=zone==='blue'?blue:alloy
    for(let k=-1;k<=1;k++){
      box(zone==='blue'?7:3.4,.16,.28,x,12.65,z+k*(zone==='blue'?2.3:1.3),mat)
      box(zone==='blue'?4.4:2.5,.035,.10,x,12.54,z+k*(zone==='blue'?2.3:1.3),zone==='blue'?cyan:white)
    }
    lamp(x,11.7,z,zone==='blue'?0x78c7e5:0xa8cab6,24,12)
  }
  portalLowerMarkers()
  function portalLowerMarkers(){
    // Inset ribs sit on shared walls; doorway centres remain free.
    for(const x of [15.35]){
      box(.16,2.9,.13,x,10.5,-17.45,blue)
      box(.055,2.4,.035,x,10.4,-17.53,cyan)
    }
    for(let z=-27;z<-19;z+=1.4){
      box(.035,.7,.58,25.15,10.5,z,edge)
      box(.04,.05,.46,25.12,10.3,z,cyan)
    }
  }
  // Radial Top Mid: eight segmented outer armor wedges around a recessed octagonal core.
  put(new THREE.CylinderGeometry(8.58,6.1,.88,8).rotateY(Math.PI/8),dark,0,13.48,0)
  put(new THREE.CylinderGeometry(2.35,2.35,.025,8),dark,0,14.025,0)
  put(new THREE.CylinderGeometry(2.16,2.16,.03,8),alloy,0,14.046,0)
  for(let i=0;i<8;i++){
    const a=i*Math.PI/4,c=Math.cos(a),s=Math.sin(a)
    const wedge=new THREE.Shape();wedge.moveTo(-.62,2.7);wedge.lineTo(.62,2.7);wedge.lineTo(2.45,7.2);wedge.lineTo(1.9,7.8);wedge.lineTo(-1.9,7.8);wedge.lineTo(-2.45,7.2);wedge.closePath()
    const wg=new THREE.ShapeGeometry(wedge).rotateX(-Math.PI/2);put(wg,alloy,0,14.04,0,a)
    for(const side of [-1,1]){
      // Broken luminous white floor fins taper toward the central rosette.
      const fin=new THREE.Shape();fin.moveTo(side*.36,3.35);fin.lineTo(side*.60,3.6);fin.lineTo(side*1.62,6.83);fin.lineTo(side*.67,6.48);fin.closePath()
      put(new THREE.ShapeGeometry(fin).rotateX(-Math.PI/2),white,0,14.07,0,a)
    }
    box(.12,.025,4.8,s*5.4,14.075,c*5.4,edge,-a)
    // Corner beacon pylons leave the cardinal bridge approaches open.
    if(i%2===1){
      const x=s*7.75,z=c*7.75
      profile([[-.78,0],[.78,0],[.68,1.8],[.40,2.1],[-.40,2.1],[-.68,1.8]],.65,dark,x,14,z,a)
      profile([[-.57,.13],[.57,.13],[.46,1.7],[.3,1.86],[-.3,1.86],[-.46,1.7]],.69,alloy,x,14,z,a)
      for(const side of [-1,1])box(.12,1.22,.03,x+Math.cos(a)*side*.31,14.95,z-Math.sin(a)*side*.31-.36*Math.cos(a),white,a)
      for(const face of [-1,1]){
        const px=x+s*.43*face,pz=z+c*.43*face
        box(.095,1.36,.025,px,15.04,pz,white,a)
        for(const side of [-1,1]){
          box(.13,.55,.027,px+Math.cos(a)*side*.29,15.35,pz-Math.sin(a)*side*.29,white,a)
          for(let k=0;k<3;k++)put(new THREE.BoxGeometry(.25,.065,.026),white,px+Math.cos(a)*side*.18,14.55+k*.18,pz-Math.sin(a)*side*.18,a,0,side*.55)
        }
      }
      put(new THREE.CylinderGeometry(.25,.25,.04,16),cyan,x,16.13,z)
    }
    box(1.85,.28,.60,s*7.3,13.7,c*7.3,dark,a)
  }
  for(let i=0;i<16;i++){
    const a=i*Math.PI/8,cs=Math.cos(a),sn=Math.sin(a)
    const local=(x:number,y:number,z:number)=>[x*cs+z*sn,y,-x*sn+z*cs] as [number,number,number]
    const p=local(0,13.25,7.7)
    profile([[-.57,-.5],[.57,-.5],[.72,.38],[.62,.68],[-.62,.68],[-.72,.38]],.42,dark,...p,a)
    for(const side of [-1,1]){
      const q=local(side*.43,13.2,7.97);box(.065,.66,.035,...q,alloy,a)
    }
    for(let j=0;j<3;j++){const q=local((j-1)*.2,13.4,7.97);box(.045,.23,.04,...q,edge,a)}
  }
  // Large cantilever seen above Mid in the H3 environmental still. Angular stepped masses
  // originate in Gold's tower and project inward; the underside clears every jump arc.
  for(const side of [-1,1]){
    profile([[31,28],[31,34],[23,34],[20,32],[9,32],[6,30],[1,30],[-3,27],[-3,25],[1,25],[4,27],[12,27],[15,29],[23,29],[25,28]],2.0,dark,0,0,side*6.8)
    profile([[30,29],[30,32.7],[23,32.7],[20,30.8],[8.5,30.8],[5.5,28.8],[.5,28.8],[-2,26.7],[-2,26.1],[1,26.1],[4,28],[12.5,28],[15.5,30],[23,30],[25,29]],2.15,alloy,0,0,side*6.8)
    for(let x=0;x<25;x+=3.2){box(2.6,.16,2.25,x,29.1+(x>12?1:0),side*6.8,edge);box(1.8,.035,.18,x,25.75,side*6.8,white)}
  }
  box(19,1.4,14,19.5,32,0,dark)
  for(let x=12;x<=28;x+=4)box(.5,1.7,15,x,32,0,alloy)
  // Chamfered Forerunner portal kit: layered jamb profiles, shadowed recesses, ribbed trims.
  const portal=(x:number,y:number,z:number,width:number,height:number,ry:number,mat:THREE.Material=alloy)=>{
    const local=(lx:number,ly:number,lz:number)=>[x+lx*Math.cos(ry)+lz*Math.sin(ry),y+ly,z-lx*Math.sin(ry)+lz*Math.cos(ry)]
    for(const side of [-1,1]){
      const pts=[[side*(width/2+.95),0],[side*(width/2+.95),height],[side*(width/2-.35),height],[side*(width/2-.35),height-.55],[side*width/2,height-1.65],[side*width/2,0]]
      profile(pts,.75,dark,x,y,z,ry)
      profile(pts.map(([a,b])=>[a+side*.14,b]),.60,mat,x,y,z-.03,ry)
      const inner=pts.map(([a,b])=>[a+side*.25,b*.97+.12]);profile(inner,.79,mat,x,y,z,ry)
      for(let k=0;k<height-.6;k+=.23){const p=local(side*(width/2+.55),k+.12,-.42);box(.28,.075,.06,...p as [number,number,number],edge,ry)}
      const p=local(side*(width/2+.11),(height-1.7)/2,-.42);box(.065,height-1.7,.025,...p as [number,number,number],white,ry)
    }
    const p=local(0,height-.21,0);box(width+1.3,.65,.85,...p as [number,number,number],mat,ry,.08)
  }
  portal(19.4,9,0,4.4,9.5,Math.PI/2,gold)
  portal(-19.8,9,0,4.4,9.7,Math.PI/2)
  portal(19,14,-17,5.6,5,0,blue)
  portal(10,14,-23,5.2,5,Math.PI/2,blue)
  // Gold's enormous tall, sloping pylons and deeply ribbed lift enclosure.
  for(const side of [-1,1]){
    profile([[18,9],[18,21],[21,26],[21,32],[24,32],[24,25],[21,19],[21,9]],1.7,dark,0,0,side*5.3)
    profile([[18.15,10],[18.15,21],[21.2,26],[21.2,31],[22.5,31],[22.5,25.4],[19.6,20],[19.6,10]],1.84,alloy,0,0,side*5.3)
    for(let y=10;y<31;y+=.3)box(.18,.08,1.9,y<21?18.35:21.4,y,side*5.3,edge)
    box(.12,15,.13,30.38,21,side*4.7,amber)
    box(.18,14.5,.18,30.2,21,side*3.9,alloy)
  }
  for(const side of [-1,1]){
    for(let level=0;level<3;level++){
      const yy=10+level*3.2,zz=side*6.25
      profile([[18.38,yy],[19.3,yy],[19.3,yy+1.9],[18.88,yy+2.6],[18.38,yy+2.6]],.07,edge,0,0,zz)
      profile([[18.48,yy+.13],[19.18,yy+.13],[19.18,yy+1.86],[18.83,yy+2.43],[18.48,yy+2.43]],.085,alloy,0,0,zz)
    }
    profile([[20.3,22],[22.05,25.7],[22.05,30.7],[21.53,30.7],[21.53,25.85],[19.85,22.3]],.08,edge,0,0,side*6.25)
    profile([[20.48,22.15],[22.19,25.85],[22.19,30.75],[22.08,30.75],[22.08,25.9],[20.4,22.25]],.095,alloy,0,0,side*6.25)
  }
  // Gold's original lift is a tall recessed illuminated panel, not floating light
  // strips. The stacked herringbone engravings sit against the shared rear wall.
  for(const side of [-1,1]){
    const z=side*2.3
    box(.12,17,1.8,30.41,23.5,z,edge)
    box(.15,16.5,1.55,30.30,23.5,z,gold)
    box(.04,16,.09,30.20,23.4,z+side*.63,amber)
    box(.04,16,.09,30.20,23.4,z-side*.63,amber)
    for(let y=16;y<31;y+=.72){
      for(const wing of [-1,1]){
        const g=new THREE.BoxGeometry(.045,.075,.75)
        put(g,edge,30.19,y,z+wing*.25,0,wing*.55)
      }
    }
  }
  for(const [x,z] of [[21.5,-7],[28.9,-7],[22,7],[30,7]]){
    box(.08,2.7,.025,x,15.55,z+Math.sign(z)*.52,amber)
  }
  // Fine upper armor grooves follow the heavy over-Mid cantilever profiles.
  for(const side of [-1,1])for(let tier=0;tier<3;tier++){
    profile([[1,26.4+tier*.42],[4,28.1+tier*.42],[12,28.1+tier*.42],[15.5,30.1+tier*.42],[23,30.1+tier*.42]],.032,edge,0,0,side*7.9)
  }
  // Sniper's continuous vertical shaft is the tower's main silhouette in the
  // reference, not a short floating drum. Its octagonal core is also collidable.
  for(let i=0;i<8;i++){
    const a=i*Math.PI/4,dx=Math.sin(a),dz=Math.cos(a)
    for(let y=-10;y<34;y+=4.2){
      box(1.48,3.9,.045,-29+dx*2.32,y,-1+dz*2.32,alloy,a)
      box(.045,3.6,.055,-29+dx*2.36+Math.cos(a)*.58,y,-1+dz*2.36-Math.sin(a)*.58,edge,a)
      box(.58,.045,.06,-29+dx*2.37,y+1.45,-1+dz*2.37,edge,a)
    }
  }
  for(const y of [5.9,12.8,24.8,30.4,34.7]){
    put(new THREE.CylinderGeometry(2.62,2.52,.24,8).rotateY(Math.PI/8),dark,-29,y,-1)
    put(new THREE.CylinderGeometry(2.57,2.57,.07,8).rotateY(Math.PI/8),alloy,-29,y+.15,-1)
  }
  // Deep metal shafts anchor rooms into living trunks, with recessed collar bands.
  for(const [x,z,r,top] of [[30,0,3.3,30],[21,-27,3.6,26],[30,20,2.8,13]]){
    // Structural roots end at floor undersides; upper tower begins above room ceiling.
    // The previous unbroken cylinders visually filled playable rooms without collision.
    put(new THREE.CylinderGeometry(r,r*.62,23,12),dark,x,-3.5,z)
    const towerBase=x===-29?25:x===30&&z===0?34:20 // S3 floor is 19 m: clear standing heads and jump arcs.
    if(top>towerBase)put(new THREE.CylinderGeometry(r,r,top-towerBase,12),dark,x,(top+towerBase)/2,z)
    for(let a=0;a<12;a++){
      const angle=(a+.5)*Math.PI/6,faceRadius=r*Math.cos(Math.PI/12)+.024,px=x+Math.sin(angle)*faceRadius,pz=z+Math.cos(angle)*faceRadius
      for(let yy=0;yy+3.9<top;yy+=4){
        if(yy+3.9>8&&yy<towerBase)continue
        box(.045,3.7,.035,px,yy+1.9,pz,edge,angle)
        box(r*.40,.05,.05,px,yy+.35,pz,alloy,angle)
        for(const side of [-1,1])box(.035,1.4,.045,px+Math.cos(angle)*side*r*.23,yy+2.3,pz-Math.sin(angle)*side*r*.23,edge,angle)
      }
    }
    for(let y=-10;y<top;y+=3.2){if(y>7.5&&y<towerBase+.5)continue;put(new THREE.CylinderGeometry(r+.18,r+.18,.28,12),alloy,x,y,z);put(new THREE.CylinderGeometry(r+.23,r+.23,.08,12),edge,x,y+.22,z)}
  }
  for(let x=11;x<=25;x+=3.4){box(.35,.5,12.8,x,19,-23,alloy);box(.065,.028,4.5,x,18.94,-23,white)}
  lamp(24,16,0,0xffd68a,50,18);lamp(18,16.8,-23,0x8ccfea,32,16)
  lamp(0,11.5,0,0x7db9c7,18,14)
  // Blue room plasma batteries are visually specific rather than untextured cover cubes.
  for(const x of [12.5,24]){
    put(new THREE.CylinderGeometry(.30,.34,1.6,8),edge,x,14.8,-26)
    for(let i=0;i<3;i++)put(new THREE.TorusGeometry(.38,.07,4,12).rotateX(Math.PI/2),cyan,x,14.25+i*.48,-26)
    for(let i=0;i<4;i++)box(.12,1.9,.12,x+Math.sin(i*Math.PI/2)*.42,14.95,-26+Math.cos(i*Math.PI/2)*.42,alloy)
  }
  // Launcher pads are authored once by guardian-lift-fx from the generated navigation data.
  // Keeping the old placeholder pads out of this group is important: the imported Guardian
  // mesh already contains the real housings, and a second set at a stale height makes a pad
  // appear offset from its floor while the GLB is still loading.
  // Bark mesh bends, flutes and buttresses independently at each ring: no straight tree poles.
  const trunk=(x:number,z:number,r:number,h:number,base=-28,lean=4)=>{
    const rings=22,sides=13,p:number[]=[],uv:number[]=[],idx:number[]=[],colors:number[]=[]
    const phase=rand()*6.28
    for(let j=0;j<=rings;j++)for(let k=0;k<=sides;k++){
      const t=j/rings,a=k/sides*Math.PI*2,flute=1+.13*Math.sin(a*7+phase+t*4)+.075*Math.sin(a*3-t*7),radius=r*(1-t*.77)*(1+.8*Math.exp(-t*15))*flute
      p.push(x+Math.cos(a)*radius+Math.sin(t*3+phase)*lean*t,base+t*h+Math.pow(t,8)*Math.sin(a*3+phase)*r,z+Math.sin(a)*radius+Math.cos(t*3+phase)*lean*t)
      uv.push(k/sides*r*.6,t*h/7)
      const shade=.60+.32*t+.08*Math.sin(a*5);colors.push(shade,shade,shade*.91)
      if(j<rings&&k<sides){const n=j*(sides+1)+k;idx.push(n,n+sides+1,n+1,n+1,n+sides+1,n+sides+2)}
    }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.setIndex(idx);g.computeVertexNormals()
    // Bark material is shared with non-vertex-colored branches, so color is baked separately below.
    g.deleteAttribute('color');put(g,bark,0,0,0,0,0,0,false)
  }
  // Foreground giants wrap the architecture. Their bases sit outside all playable slabs.
  for(const [x,z,r,h] of [[-50,-12,9,118],[43,-8,11,129],[20,-41,9,105],[-16,-43,8,120],[-42,33,8,112],[20,44,8,122]])trunk(x,z,r,h)
  // Broken hollow stump surrounds Green; jagged vertical fingers leave its deck and ramp open.
  for(let i=0;i<13;i++){
    const a=i/13*Math.PI*2;if(Math.cos(a)<-.48)continue
    const x=Math.sin(a)*11.8,z=28+Math.cos(a)*10.5
    // Cut the stump's west opening back from the lower Elbow and the Green ramp.
    if(x<0&&z<30)continue
    trunk(x,z,2.9,42+rand()*14,-29,1.8)
  }
  for(let i=0;i<38;i++){const a=i*2.39996,r=70+rand()*115;trunk(Math.cos(a)*r,Math.sin(a)*r,3+rand()*4,110+rand()*75,-35,8)}
  // Curved rooted branches span above the arena; none crosses the playable head space.
  for(const [x,z,dx,dz] of [[-50,-12,39,7],[43,-8,-30,12],[20,-41,-10,30],[-42,33,24,-12]]){
    line([[x,39,z],[x+dx*.25,42,z+dz*.2],[x+dx*.6,45,z+dz*.55],[x+dx,50,z+dz]],2.4,bark)
    line([[x,29,z],[x+dx*.2,37,z+dz*.3],[x+dx*.6,41,z+dz]],1.4,bark)
  }
  // Cutout foliage atlas: tapered leaf silhouettes with midribs. Instancing keeps the dense
  // ivy and canopy affordable, with alpha testing instead of opaque polygon foliage blobs.
  const lc=document.createElement('canvas');lc.width=lc.height=128;const cx=lc.getContext('2d')!
  const grad=cx.createLinearGradient(28,0,105,128);grad.addColorStop(0,'#8eaa54');grad.addColorStop(.5,'#51703b');grad.addColorStop(1,'#1e422d')
  cx.fillStyle=grad;cx.beginPath();cx.moveTo(63,4);cx.bezierCurveTo(8,34,18,99,63,124);cx.bezierCurveTo(107,99,123,42,63,4);cx.fill();cx.strokeStyle='#a1a46b';cx.lineWidth=1.4;cx.beginPath();cx.moveTo(63,10);cx.lineTo(63,122);cx.stroke()
  cx.strokeStyle='#819454';cx.lineWidth=.65;for(let y=32;y<112;y+=12){cx.beginPath();cx.moveTo(63,y);cx.lineTo(38,y-15);cx.moveTo(63,y);cx.lineTo(88,y-15);cx.stroke()}
  const leafTex=new THREE.CanvasTexture(lc);leafTex.colorSpace=THREE.SRGBColorSpace
  const leafMat=new THREE.MeshStandardMaterial({map:leafTex,alphaTest:.45,side:THREE.DoubleSide,roughness:1})
  leafMat.onBeforeCompile=shader=>{shader.uniforms.guardianWind=wind;shader.vertexShader='uniform float guardianWind;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n transformed.x += sin(guardianWind*1.1 + instanceMatrix[3].x*.23 + instanceMatrix[3].z*.18) * .055 * (position.y+.5);')}
  leafMat.customProgramCacheKey=()=> 'guardian-leaf-wind'
  const matrices:THREE.Matrix4[]=[],leafColors:THREE.Color[]=[]
  const leaf=(x:number,y:number,z:number,size:number,angle:number)=>{matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),new THREE.Quaternion().setFromEuler(new THREE.Euler((rand()-.5)*1.8,angle,(rand()-.5)*2)),new THREE.Vector3(size*.48,size,1)));leafColors.push(new THREE.Color().setHSL(.21+rand()*.045,.25+rand()*.18,.45+rand()*.2))}
  const vine=(x:number,y:number,z:number,len:number)=>{
    const pts:number[][]=[];for(let j=0;j<=6;j++)pts.push([x+Math.sin(j*.65)*.5,y-j/6*len,z+Math.sin(j*.9)*.27]);line(pts,.035,moss)
    for(let j=0;j<len/.24;j++){const t=j*.24;for(const side of [-1,1])leaf(x+Math.sin(t/len*3.9)*.5+side*.2,y-t,z+Math.sin(t/len*5.4)*.27,.38+rand()*.38,side*.8+rand())}
  }
  for(let i=0;i<65;i++){
    const side=i%2?1:-1,x=side*((side<0?44:34)+rand()*9),z=-30+rand()*62,y=21+rand()*30
    vine(x,y,z,4+rand()*11)
  }
  for(let i=0;i<28;i++){const x=rand()*29-1,z=i%2?6.9:-6.9;vine(x,28+rand()*3,z,3+rand()*5)}
  for(let i=0;i<20;i++)vine(11+rand()*16,19.8,-29.4,2+rand()*5)
  for(const [tx,tz,r] of [[-50,-12,9],[43,-8,11],[20,-41,9],[-16,-43,8],[-42,33,8],[20,44,8]]){
    for(let j=0;j<100;j++){
      const a=rand()*6.28,y=4+rand()*61,rr=r*(1-(y+28)/120*.77)*1.08
      const x=tx+Math.cos(a)*rr,z=tz+Math.sin(a)*rr
      for(let k=0;k<7;k++)leaf(x+(rand()-.5)*1.5,y+(rand()-.5)*2,z+(rand()-.5)*1.5,.6+rand()*.75,a)
    }
  }
  // Epiphyte clumps at tree crotches and light-catching canopy leaves overhead.
  for(let i=0;i<105;i++){
    const a=rand()*Math.PI*2,r=43+rand()*65,x=Math.sin(a)*r,z=Math.cos(a)*r,y=34+rand()*62
    for(let twig=0;twig<3;twig++){
      const angle=a+twig*1.3,len=5+rand()*5,dx=Math.cos(angle)*len,dz=Math.sin(angle)*len
      line([[x,y,z],[x+dx*.5,y+1,z+dz*.5],[x+dx,y+2,z+dz]],.07,bark)
      for(let j=0;j<22;j++){const t=j/22;for(const side of [-1,1])leaf(x+dx*t-Math.sin(angle)*side*.65,y+t*2,z+dz*t+Math.cos(angle)*side*.65,1+rand()*1.2,angle+side*.8)}
    }
  }
  for(let i=0;i<160;i++){
    const x=(rand()-.5)*18,z=20+rand()*15;if(Math.abs(x)<3&&z<27)continue
    for(let j=0;j<5;j++)leaf(x+(rand()-.5),9.15+rand()*.55,z+(rand()-.5),.5+rand()*.6,rand()*6.28)
  }
  const foliage=new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1),leafMat,matrices.length);foliage.name='guardian-instanced-ivy-and-canopy'
  matrices.forEach((m,i)=>{foliage.setMatrixAt(i,m);foliage.setColorAt(i,leafColors[i])});foliage.computeBoundingSphere();root.add(foliage)
  for(const [mat,geos] of batch){const mesh=new THREE.Mesh(mergeGeometries(geos),mat);mesh.name='guardian-authored-detail';mesh.castShadow=mat!==white&&mat!==cyan&&mat!==amber;mesh.receiveShadow=true;root.add(mesh);for(const g of geos)g.dispose()}
  scene.add(root)
  // The downloaded Halo Online Guardian mesh becomes the visible architecture as soon as
  // its textures finish loading. Gameplay collision is the generated mesh in shared code.
  // Keep the cinematic usable while the imported mesh decodes; main.ts waits on this promise
  // before enabling gameplay so the first active frames do not hitch during the upload.
  return root
}
