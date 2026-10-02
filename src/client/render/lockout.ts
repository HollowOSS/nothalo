import * as THREE from 'three'
import { loadResource } from './load-resource.ts'
import { LOCKOUT_IMPORT } from '../../shared/lockout.ts'
import { lockoutScale } from '../../shared/lockout-transform.ts'

/** The CC BY Lockout mesh is the visible map; the shared analytic decks remain the authority for
 * player movement and server validation. Keeping the mesh in one GLB avoids the OBJ's many
 * material fetches and keeps the 1k runtime textures within the browser budget. */
/** Sky, fog and snow for a frozen Forerunner facility on an overcast day: the retail map is
 * lit by a bright grey-white sky with pale blue fog thickening toward the cliffs, snow drifting
 * straight down, and a green glow where the stasis chambers stand. Sky and fog share one colour
 * family so the horizon dissolves instead of drawing a line. */
const SKY_ZENITH=new THREE.Color(0x66809e),SKY_HORIZON=new THREE.Color(0xc9d5e0),SKY_BELOW=new THREE.Color(0x7f8d9c),FOG=0xb4c2d0
function createSkyDome():THREE.Mesh {
  const material=new THREE.ShaderMaterial({
    side:THREE.BackSide,depthWrite:false,fog:false,toneMapped:false,
    uniforms:{uZenith:{value:SKY_ZENITH},uHorizon:{value:SKY_HORIZON},uBelow:{value:SKY_BELOW},uSun:{value:new THREE.Vector3(-.45,.72,.53).normalize()}},
    vertexShader:`varying vec3 vDir;void main(){vDir=normalize(position);vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_Position=vec4(p.xy,p.w*.99999,p.w);}`,
    fragmentShader:`uniform vec3 uZenith,uHorizon,uBelow,uSun;varying vec3 vDir;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
      float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.07+9.1;a*=0.5;}return v;}
      void main(){
        float h=vDir.y;
        // Overcast: most of the brightness sits low, the zenith stays a shade darker.
        vec3 sky=mix(uHorizon,uZenith,smoothstep(0.0,0.55,h));
        vec3 below=mix(uHorizon,uBelow,smoothstep(0.0,0.25,-h));
        vec3 c=h>=0.0?sky:below;
        // A broad, soft brightening around the sun: the disc never shows through the cloud.
        float glow=pow(max(dot(normalize(vDir),uSun),0.0),6.0);
        c+=vec3(0.16,0.14,0.11)*glow;
        // A heavy, uneven cloud deck rather than a clean gradient: brighter billows and grey troughs, fading into the haze
        // toward the horizon, brightest toward the hidden sun.
        if(h>0.0){
          vec2 uv=vDir.xz/(h+0.15)*1.3;
          float n=fbm(uv)*0.7+fbm(uv*3.1+3.7)*0.3;
          float deck=smoothstep(0.02,0.35,h);
          c=mix(c,c*mix(0.82,1.14,smoothstep(0.3,0.75,n))+vec3(0.05,0.05,0.045)*glow*n,deck);
        }
        gl_FragColor=vec4(c,1.0);
      }`,
  })
  const dome=new THREE.Mesh(new THREE.SphereGeometry(900,32,20),material)
  dome.name='lockout-sky';dome.frustumCulled=false;dome.renderOrder=-100
  return dome
}
/** Falling snow around the viewer: one Points cloud wrapped into a box around the camera, flakes that leave the bottom
 * re-enter at the top, with a slow sideways sway. Animated entirely in the vertex shader (the CPU used to walk all 3200
 * flakes and re-upload their buffer every frame); flakes stay put in the world as the viewer moves through them, and each
 * is a soft round disc rather than a square. Nothing about it touches gameplay. */
const SNOW_COUNT=3200,SNOW_BOX=new THREE.Vector3(70,36,70)
function createSnow(renderer:THREE.WebGLRenderer):{points:THREE.Points;update(time:number,focus:THREE.Vector3):void} {
  const seeds=new Float32Array(SNOW_COUNT*3),motion=new Float32Array(SNOW_COUNT*2)
  for(let i=0;i<SNOW_COUNT;i++){seeds[i*3]=Math.random()*SNOW_BOX.x;seeds[i*3+1]=Math.random()*SNOW_BOX.y;seeds[i*3+2]=Math.random()*SNOW_BOX.z;motion[i*2]=Math.random()*Math.PI*2;motion[i*2+1]=.9+Math.random()*.9}
  const geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.BufferAttribute(seeds,3))
  geometry.setAttribute('motion',new THREE.BufferAttribute(motion,2))
  const uniforms={time:{value:0},eye:{value:new THREE.Vector3()},scale:{value:450},color:{value:new THREE.Color(0xf4f8fc)}}
  const material=new THREE.ShaderMaterial({
    transparent:true,depthWrite:false,fog:true,uniforms:{...THREE.UniformsLib.fog,...uniforms},
    vertexShader:`uniform float time; uniform vec3 eye; uniform float scale; attribute vec2 motion; varying float vFade;
#include <fog_pars_vertex>
void main() {
  const vec3 box = vec3(${SNOW_BOX.x.toFixed(1)}, ${SNOW_BOX.y.toFixed(1)}, ${SNOW_BOX.z.toFixed(1)});
  // Fall at the flake's own speed with a gentle sway, wrapped into the box around the eye. Each pass through the box
  // shifts the flake sideways by a hash of the pass, so the same columns do not repeat.
  float fallen = time * motion.y;
  // Counted relative to the eye, so the sideways jump happens where the flake wraps (faded out at the box's floor).
  float pass = floor((position.y - fallen - eye.y + box.y * 0.5) / box.y);
  vec3 p = position + vec3(fract(sin(pass * 12.9898 + motion.x) * 43758.5453) * box.x - cos(time * 0.7 + motion.x) * 0.36, -fallen,
    fract(sin(pass * 78.233 + motion.x * 3.1) * 12543.37) * box.z);
  p = mod(p - eye + box * 0.5, box) - box * 0.5 + eye;
  vec3 rel = (p - eye) / (box * 0.5);
  vFade = 1.0 - smoothstep(0.75, 1.0, max(abs(rel.x), max(abs(rel.y), abs(rel.z))));
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // About 15 cm across (the soft disc's visible core is smaller): scale is half the drawing buffer's height.
  gl_PointSize = 0.15 * scale / max(-mvPosition.z, 0.1);
  #include <fog_vertex>
}`,
    fragmentShader:`uniform vec3 color; varying float vFade;
#include <fog_pars_fragment>
void main() {
  float a = smoothstep(0.5, 0.2, length(gl_PointCoord - 0.5)) * 0.85 * vFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(color, a);
  #include <fog_fragment>
}`,
  })
  const points=new THREE.Points(geometry,material)
  points.name='lockout-snow';points.frustumCulled=false
  const size=new THREE.Vector2()
  return {points,update(time,focus){
    uniforms.time.value=time;uniforms.eye.value.copy(focus)
    uniforms.scale.value=renderer.getDrawingBufferSize(size).y/2
  }}
}
/** Stasis-chamber glass (lct_glass_01) and the lift shaft, located on the imported mesh. */
const GREEN_GLOW=[[-0.7,27.3,-18.0],[-0.7,15.6,-13.1],[-0.7,15.6,-17.9],[-13.4,23.1,-37.0],[-21.1,23.1,-34.3],[11.8,29.3,-28.9]] as const
const LIFT_SHAFT={x:-0.7,y:19.7,z:-4.0}

export function createLockout(scene:THREE.Scene,renderer:THREE.WebGLRenderer,signal?:AbortSignal):THREE.Group {
  renderer.shadowMap.enabled=true
  renderer.shadowMap.type=THREE.PCFSoftShadowMap
  renderer.toneMapping=THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure=1.12
  scene.background=null
  scene.fog=new THREE.FogExp2(FOG,.014)
  // Overcast light: a bright sky dome does most of the work, the sun is soft and cool-white.
  scene.add(new THREE.HemisphereLight(0xe3ebf3,0x596471,1.35))
  const sun=new THREE.DirectionalLight(0xfff4e6,1.45)
  sun.position.set(-60,96,70);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048)
  Object.assign(sun.shadow.camera,{left:-60,right:60,top:60,bottom:-60,near:1,far:280})
  sun.shadow.normalBias=.08;sun.shadow.bias=-.0002
  scene.add(sun)
  const fill=new THREE.DirectionalLight(0x8fa9c6,.55);fill.position.set(50,36,-60);scene.add(fill)
  const root=new THREE.Group();root.name='lockout';scene.add(root)
  root.add(createSkyDome())
  const snow=createSnow(renderer);root.add(snow.points)
  const k=lockoutScale()
  for(const [x,y,z] of GREEN_GLOW){const light=new THREE.PointLight(0x8df58f,7,11*k,2);light.position.set(x*k,y*k,z*k);light.name='lockout-stasis-glow';light.userData.staticLight=true;root.add(light)}
  const shaft=new THREE.PointLight(0xa9d8ff,9,14,2);shaft.position.set(LIFT_SHAFT.x*k,(LIFT_SHAFT.y+4)*k,LIFT_SHAFT.z*k);shaft.name='lockout-lift-glow';shaft.userData.staticLight=true;root.add(shaft)
  root.userData.update=(time:number,focus:THREE.Vector3)=>snow.update(time,focus)
  // The shipped GLB is meshopt-compressed (30.7 MB → 14.8 MB, under Cloudflare's 25 MiB asset limit).
  root.userData.ready=loadResource('/assets/maps/lockout.glb',signal).then(gltf=>{
    const model=gltf.scene
    model.name='lockout-imported-reference'
    model.scale.setScalar(LOCKOUT_IMPORT.scale*k)
    model.position.set(LOCKOUT_IMPORT.offset.x*k,LOCKOUT_IMPORT.offset.y*k,LOCKOUT_IMPORT.offset.z*k)
    model.rotation.set(LOCKOUT_IMPORT.rotation.x,LOCKOUT_IMPORT.rotation.y,LOCKOUT_IMPORT.rotation.z)
    model.traverse(object=>{
      if(!(object as THREE.Mesh).isMesh)return
      const mesh=object as THREE.Mesh
      // Under an overcast sky the architecture throws no hard shadows of its own, and drawing
      // 348k triangles into the shadow map every frame was the single largest cost. Only the
      // moving Spartans cast; the decks still receive them.
      mesh.castShadow=false;mesh.receiveShadow=true
      for(const material of (Array.isArray(mesh.material)?mesh.material:[mesh.material])){
        // The source is a closed environment mesh. Keep back-face culling on so
        // interior rock shells do not overdraw the playable decks from inside.
        material.side=THREE.FrontSide
        // The stasis-chamber glass glows green in the retail map; the export only carries a
        // diffuse texture, so the glow is added here where the same material is found.
        if(material.name==='lct_glass_01'&&'emissive' in material){(material as THREE.MeshStandardMaterial).emissive.set(0x3fbf4a);(material as THREE.MeshStandardMaterial).emissiveIntensity=.9}
        // The export left some surfaces near-mirror (main_wall_blend_01, the rock/ice blend, arrives at roughness 0.1): under
        // the sun and bloom they read as wet plastic smeared over their textures. Rock, ice and concrete are matte.
        const standard=material as THREE.MeshStandardMaterial
        if(standard.isMeshStandardMaterial&&!/glass/i.test(standard.name)&&!standard.roughnessMap&&standard.roughness<.6){standard.roughness=.82;standard.metalness=Math.min(standard.metalness,.1)}
        material.needsUpdate=true
      }
    })
    root.add(model)
    root.userData.importedReference=model
  }).catch(error=>{if(signal?.aborted)throw error;root.userData.importedError=error instanceof Error?error.message:String(error);console.warn('Lockout mesh failed to load',error)})
  return root
}
