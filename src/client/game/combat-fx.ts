import {bulletImpulseStrength} from '../../shared/bullet-impact.ts'
import type { CollisionVehicleKind } from './vehicle-collision-audio.ts'
import { shootRagdoll } from '../render/ragdolls.ts'
import * as THREE from 'three'
import type { VehicleSoundState } from './vehicle-audio.ts'
import { CombatAudio, type PlayedSound, type Surface, type Vocal } from './combat-audio.ts'
import { WEAPON_FX } from './weapon-fx.ts'
import { plasmaFx } from '../render/plasma-fx.ts'

export const corpseBulletStrength=bulletImpulseStrength

/** One draw call for twelve small contrails. Camera-facing, feathered ribbons
 * retain the shot line, then curl, expand and fade; no opaque cylinder survives. */
class SniperSmoke {
  readonly slots=Array.from({length:12},()=>({start:new THREE.Vector3(),end:new THREE.Vector3(),life:0,total:1,phase:0}))
  private cursor=0
  private readonly segments=32
  readonly mesh:THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>
  private readonly position:THREE.BufferAttribute
  private readonly direction:THREE.BufferAttribute
  private readonly width:THREE.BufferAttribute
  private readonly opacity:THREE.BufferAttribute
  private readonly age:THREE.BufferAttribute
  private readonly tangent=new THREE.Vector3()
  private readonly side=new THREE.Vector3()
  private readonly up=new THREE.Vector3()
  private readonly point=new THREE.Vector3()
  private readonly axis=new THREE.Vector3()
  constructor(scene:THREE.Scene){
    const count=this.slots.length*(this.segments+1)*2,geometry=new THREE.BufferGeometry(),uv=new Float32Array(count*2),edge=new Float32Array(count),indices:number[]=[]
    this.position=new THREE.BufferAttribute(new Float32Array(count*3),3).setUsage(THREE.DynamicDrawUsage)
    this.direction=new THREE.BufferAttribute(new Float32Array(count*3),3).setUsage(THREE.DynamicDrawUsage)
    this.width=new THREE.BufferAttribute(new Float32Array(count),1).setUsage(THREE.DynamicDrawUsage)
    this.opacity=new THREE.BufferAttribute(new Float32Array(count),1).setUsage(THREE.DynamicDrawUsage)
    this.age=new THREE.BufferAttribute(new Float32Array(count),1).setUsage(THREE.DynamicDrawUsage)
    for(let trail=0;trail<this.slots.length;trail++)for(let j=0;j<=this.segments;j++){
      const i=(trail*(this.segments+1)+j)*2
      for(let side=0;side<2;side++){edge[i+side]=side*2-1;uv[(i+side)*2]=j/this.segments;uv[(i+side)*2+1]=side}
      if(j<this.segments)indices.push(i,i+1,i+2,i+1,i+3,i+2)
    }
    geometry.setAttribute('position',this.position);geometry.setAttribute('trailDirection',this.direction);geometry.setAttribute('trailWidth',this.width);geometry.setAttribute('trailOpacity',this.opacity);geometry.setAttribute('trailAge',this.age)
    geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));geometry.setAttribute('trailEdge',new THREE.BufferAttribute(edge,1));geometry.setIndex(indices)
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false,
      vertexShader:`attribute vec3 trailDirection;attribute float trailWidth,trailOpacity,trailAge,trailEdge;
        varying vec2 vTrailUv;varying float vTrailOpacity,vTrailAge;
        void main(){vec4 p=modelViewMatrix*vec4(position,1.0);vec3 tangent=(modelViewMatrix*vec4(trailDirection,0.0)).xyz;
          vec2 side=vec2(-tangent.y,tangent.x);side=length(side)>.0001?normalize(side):vec2(1.0,0.0);
          p.xy+=side*trailEdge*trailWidth;gl_Position=projectionMatrix*p;vTrailUv=uv;vTrailOpacity=trailOpacity;vTrailAge=trailAge;}`,
      fragmentShader:`varying vec2 vTrailUv;varying float vTrailOpacity,vTrailAge;
        void main(){float edge=abs(vTrailUv.y*2.0-1.0);
          float feather=exp(-edge*edge*5.0)*(1.0-smoothstep(.65,1.0,edge));
          float curl=.64+.22*sin(vTrailUv.x*121.0+vTrailAge*3.0)+.14*sin(vTrailUv.x*317.0-vTrailAge*7.0+vTrailUv.y*4.0);
          float ends=smoothstep(0.0,.025,vTrailUv.x)*(1.0-smoothstep(.97,1.0,vTrailUv.x));
          float alpha=feather*curl*ends*vTrailOpacity;if(alpha<.003)discard;
          gl_FragColor=vec4(.76,.81,.84,alpha);}`})
    this.mesh=new THREE.Mesh(geometry,material);this.mesh.name='combat-sniper-smoke';this.mesh.frustumCulled=false;scene.add(this.mesh)
  }
  launch(start:THREE.Vector3,end:THREE.Vector3,life:number):void{
    const slot=this.slots[this.cursor++%this.slots.length];slot.start.copy(start);slot.end.copy(end);slot.life=slot.total=life;slot.phase=this.cursor*2.39996
  }
  update(dt:number):void{
    const {tangent:direction,side,up,point,axis}=this
    let active=false,dirty=false
    this.slots.forEach((slot,trail)=>{
      if(slot.life<=0)return
      dirty=true
      slot.life=Math.max(0,slot.life-dt);const age=slot.total-slot.life,fade=slot.life/slot.total
      active ||= slot.life>0
      direction.copy(slot.end).sub(slot.start);const distance=direction.length();direction.normalize()
      side.crossVectors(direction,Math.abs(direction.y)>.9?axis.set(1,0,0):axis.set(0,1,0)).normalize();up.crossVectors(side,direction)
      for(let j=0;j<=this.segments;j++){
        const t=j/this.segments,curl=(.004+age*.028)*Math.sin(t*17+slot.phase+age*2)
        point.copy(slot.start).lerp(slot.end,t).addScaledVector(side,curl).addScaledVector(up,age*.026+curl*.55)
        for(let edge=0;edge<2;edge++){
          const i=(trail*(this.segments+1)+j)*2+edge
          this.position.setXYZ(i,point.x,point.y,point.z);this.direction.setXYZ(i,direction.x,direction.y,direction.z)
          this.width.setX(i,.028+age*.09);this.opacity.setX(i,distance>.01?.58*Math.pow(fade,1.25):0);this.age.setX(i,age+slot.phase)
        }
      }
    })
    this.mesh.visible=active
    if(dirty)for(const attribute of [this.position,this.direction,this.width,this.opacity,this.age])attribute.needsUpdate=true
  }
}

/** Fixed-size effects pool and cached sounds: combat never grows the scene without bound. */
/**
 * Tracers, plasma bolts and sparks as glowing beams rather than coloured rods: brightest down the middle of the cylinder
 * (where it faces the eye), a hot head and a fading tail along its length, and HDR colour so the bloom picks them up.
 * Still one instanced draw for all 64.
 */
const beamMaterial=()=>new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false,
  uniforms:{hdr:{value:2.6}},
  vertexShader:`varying vec3 vBeamColor;varying float vFacing,vAlong;
    void main(){
      vBeamColor=instanceColor;
      vec4 mv=modelViewMatrix*instanceMatrix*vec4(position,1.0);
      vec3 n=normalize(normalMatrix*mat3(instanceMatrix)*normal);
      vFacing=abs(dot(n,normalize(-mv.xyz)));vAlong=uv.y;
      gl_Position=projectionMatrix*mv;}`,
  fragmentShader:`uniform float hdr;varying vec3 vBeamColor;varying float vFacing,vAlong;
    void main(){
      float body=pow(vFacing,1.4),core=pow(vFacing,7.0);
      float tail=mix(.18,1.0,vAlong*vAlong);
      gl_FragColor=vec4(vBeamColor*hdr*(body*.7+core*1.6)*tail,1.0);}`})

/**
 * Impact bursts: a hot flash where the round lands (additive, blooms) and a puff of dust or spray that hangs a moment
 * (normal blending). Camera-facing quads built in the vertex shader; one instanced draw per kind, hidden when idle.
 */
class ImpactBursts {
  private readonly size=32
  private readonly flash:THREE.InstancedMesh<THREE.PlaneGeometry,THREE.ShaderMaterial>
  private readonly dust:THREE.InstancedMesh<THREE.PlaneGeometry,THREE.ShaderMaterial>
  private readonly items=Array.from({length:32},()=>({kind:0 as 0|1,age:1,life:1,from:0,to:0,drift:new THREE.Vector3(),at:new THREE.Vector3(),color:new THREE.Color(),alpha:1,seed:0}))
  private next=0
  private readonly fade:THREE.InstancedBufferAttribute[]
  private readonly seed:THREE.InstancedBufferAttribute[]
  private readonly m=new THREE.Matrix4()
  private readonly c=new THREE.Color()
  constructor(scene:THREE.Scene){
    const make=(additive:boolean)=>{
      const geometry=new THREE.PlaneGeometry(1,1)
      const fade=new THREE.InstancedBufferAttribute(new Float32Array(this.size),1).setUsage(THREE.DynamicDrawUsage)
      const seed=new THREE.InstancedBufferAttribute(new Float32Array(this.size),1).setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute('burstFade',fade);geometry.setAttribute('burstSeed',seed)
      const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,toneMapped:false,blending:additive?THREE.AdditiveBlending:THREE.NormalBlending,
        vertexShader:`attribute float burstFade,burstSeed;varying vec2 vUv;varying float vFade,vSeed;varying vec3 vBurstColor;
          void main(){
            vec4 center=modelViewMatrix*instanceMatrix*vec4(0.0,0.0,0.0,1.0);
            float size=length(instanceMatrix[0].xyz);float a=burstSeed*6.2832;
            // pulled toward the eye by half its size, so a burst on a wall facing the camera is not buried in the wall
            center.xyz*=max(0.0,1.0-(size*.5+.05)/max(length(center.xyz),.001));
            vec2 corner=mat2(cos(a),-sin(a),sin(a),cos(a))*position.xy*size;
            gl_Position=projectionMatrix*(center+vec4(corner,0.0,0.0));
            vUv=uv;vFade=burstFade;vSeed=burstSeed;vBurstColor=instanceColor;}`,
        fragmentShader:additive
          ?`varying vec2 vUv;varying float vFade,vSeed;varying vec3 vBurstColor;
            void main(){vec2 p=vUv*2.0-1.0;float r=length(p),ang=atan(p.y,p.x);
              float star=pow(max(0.0,1.0-r*(1.0+.8*abs(sin(ang*3.0+vSeed*9.0)))),3.0);
              float glow=exp(-r*r*7.0);
              gl_FragColor=vec4(vBurstColor*(glow*2.2+star*2.5)*vFade,1.0);}`
          :`varying vec2 vUv;varying float vFade,vSeed;varying vec3 vBurstColor;
            void main(){vec2 p=vUv*2.0-1.0;float r=length(p),ang=atan(p.y,p.x);
              float lumps=.72+.18*sin(ang*5.0+vSeed*17.0)+.1*sin(ang*11.0-vSeed*29.0);
              float a=smoothstep(1.0,.25,r/lumps)*vFade;if(a<.004)discard;
              gl_FragColor=vec4(vBurstColor*(.85+.3*(1.0-r)),a*.55);}`})
      const mesh=new THREE.InstancedMesh(geometry,material,this.size)
      mesh.frustumCulled=false;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      for(let i=0;i<this.size;i++){mesh.setColorAt(i,this.c.set(0));mesh.setMatrixAt(i,this.m.makeScale(0,0,0))}
      mesh.visible=false;scene.add(mesh)
      return {mesh,fade,seed}
    }
    const a=make(true),b=make(false)
    this.flash=a.mesh;this.dust=b.mesh;this.flash.name='combat-impact-flash';this.dust.name='combat-impact-dust'
    this.fade=[a.fade,b.fade];this.seed=[a.seed,b.seed]
  }
  /** kind 0 = flash (HDR colour), 1 = puff; sizes in metres at birth and death. */
  add(kind:0|1,at:THREE.Vector3,color:THREE.ColorRepresentation,life:number,from:number,to:number,alpha=1,drift?:THREE.Vector3):void{
    const it=this.items[this.next];this.next=(this.next+1)%this.items.length
    it.kind=kind;it.at.copy(at);it.color.set(color);it.life=life;it.age=0;it.from=from;it.to=to;it.alpha=alpha;it.seed=Math.random()
    it.drift.copy(drift??ZERO)
  }
  update(dt:number):void{
    let live=[false,false]
    this.items.forEach((it,i)=>{
      const mesh=it.kind?this.dust:this.flash,other=it.kind?this.flash:this.dust
      other.setMatrixAt(i,this.m.makeScale(0,0,0))
      if(it.age>=it.life){mesh.setMatrixAt(i,this.m.makeScale(0,0,0));return}
      it.age+=dt;const k=Math.min(1,it.age/it.life)
      if(k>=1){mesh.setMatrixAt(i,this.m.makeScale(0,0,0));return}
      live[it.kind]=true
      it.at.addScaledVector(it.drift,dt)
      const size=it.from+(it.to-it.from)*(it.kind?Math.sqrt(k):k)
      this.m.makeScale(size,size,size).setPosition(it.at);mesh.setMatrixAt(i,this.m)
      mesh.setColorAt(i,it.color)
      this.fade[it.kind].setX(i,it.alpha*(it.kind?(1-k)*Math.min(1,k*10):(1-k)*(1-k)))
      this.seed[it.kind].setX(i,it.seed)
    })
    for(const [j,mesh] of [this.flash,this.dust].entries()){
      mesh.visible=live[j]
      if(!live[j]&&!mesh.userData.dirty)continue
      mesh.userData.dirty=live[j]
      mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true
      this.fade[j].needsUpdate=true;this.seed[j].needsUpdate=true
    }
  }
}
const ZERO=new THREE.Vector3(),UP_DRIFT=new THREE.Vector3(0,.35,0),DOWN_DRIFT=new THREE.Vector3(0,-.4,0)

export class CombatEffects {
  private readonly smoke: SniperSmoke
  private readonly bursts: ImpactBursts
  private readonly streaks: THREE.InstancedMesh
  private readonly slots = Array.from({length:64},()=>({start:new THREE.Vector3(),end:new THREE.Vector3(),life:0,total:1,color:new THREE.Color(),width:.005,length:0,speed:0,smoke:false,velocity:new THREE.Vector3(),spark:false}))
  private cursor = 0
  private readonly waves:{mesh:THREE.Mesh<THREE.TorusGeometry,THREE.MeshBasicMaterial>;life:number;total:number;maxScale:number}[]=[]
  private readonly scene:THREE.Scene
  private readonly transform = new THREE.Object3D()
  private readonly direction = new THREE.Vector3()
  private readonly up = new THREE.Vector3(0,1,0)
  private readonly color = new THREE.Color()
  private readonly audio: CombatAudio
  shots = 0
  get muted(): boolean { return this.audio.muted }
  set muted(value: boolean) { this.audio.muted = value }
  get soundsPlayed(): number { return this.audio.soundsPlayed }
  constructor(scene: THREE.Scene, audio = new CombatAudio()) {
    this.audio = audio
    this.scene=scene
    this.smoke=new SniperSmoke(scene)
    this.bursts=new ImpactBursts(scene)
    this.streaks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,8,1,true),beamMaterial(),64)
    this.streaks.name='combat-tracers';this.streaks.frustumCulled=false
    this.streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    for (let i=0;i<64;i++) this.streaks.setColorAt(i,new THREE.Color(0))
    this.transform.scale.setScalar(0);this.transform.updateMatrix()
    for(let i=0;i<64;i++)this.streaks.setMatrixAt(i,this.transform.matrix)
    scene.add(this.streaks);this.update(0)
  }
  unlock(): Promise<void> { return this.audio.unlock() }
  get audioReady(): boolean { return this.audio.audioReady }
  get screamReady(): boolean { return this.audio.screamReady }
  get samplesReady(): boolean { return this.audio.samplesReady }
  offhandReload(weapon:string|null,empty=false):void{this.audio.offhandReload(weapon,empty)}
  charge(hand:'right'|'left',on:boolean):void{this.audio.charge(hand,on)}
  sound(name:string,volume=1,pan=0):void { this.audio.sound(name,volume,pan) }
  startReload(weapon:string,duration:number,volume=.7,empty=false):void { this.audio.startReload(weapon,duration,volume,empty) }
  finishReload():void { this.audio.finishReload() }
  reloadProgress(weapon:string,elapsed:number,duration:number):void { this.audio.reloadProgress(weapon,elapsed,duration) }
  cancelReload():void { this.audio.cancelReload() }
  collision(kind: CollisionVehicleKind, impactSpeed: number, distance = 0, pan = 0, id?: string | number): void { this.audio.collision(kind,impactSpeed,distance,pan,id) }
  vehicles(states: readonly VehicleSoundState[]): void { this.audio.vehicles(states) }
  get activeVehicleLoops(): number { return this.audio.activeVehicleLoops }
  death(distance:number):void { this.audio.death(distance) }
  footstep(surface:Surface,kind:'step'|'land'|'land-hard',volume:number,pan=0):void { this.audio.footstep(surface,kind,volume,pan) }
  vocal(kind:Vocal,volume:number,pan=0,speaker:string|number='you'):void { this.audio.vocal(kind,volume,pan,speaker) }
  get screamedJustNow():boolean { return this.audio.screamedJustNow }
  /** The last sounds started (route and recording), newest last: for debug hooks and browser checks. */
  get recentSounds():readonly PlayedSound[] { return this.audio.recent }
  shot(start:THREE.Vector3,end:THREE.Vector3,weapon:string,volume=1,pan=0,affectCorpses=true):void {
    const corpseHit=affectCorpses?shootRagdoll(start,end,corpseBulletStrength(weapon)):null
    if(corpseHit)this.impact(corpseHit,false,'body')
    this.shots++;this.sound(weapon,volume,pan)
    const profile=WEAPON_FX[weapon]??WEAPON_FX['assault-rifle']!
    if(profile.smoke){this.smoke.launch(start,corpseHit??end,profile.life);return}
    // plasma: a glowing bolt with a comet tail and sparks (plasma-fx.ts), not a streak
    if(weapon==='plasma-pistol'||weapon==='plasma-rifle'){plasmaFx(this.scene).bolt(start,corpseHit??end,profile.color,weapon==='plasma-pistol'?70:90);return}
    const slot=this.slots[this.cursor++%this.slots.length]
    slot.start.copy(start);slot.end.copy(corpseHit??end)
    slot.life=slot.total=profile.smoke||!profile.speed?profile.life:Math.max(profile.life,Math.min(.3,slot.start.distanceTo(slot.end)/profile.speed));slot.width=profile.width;slot.length=profile.length;slot.speed=profile.speed;slot.smoke=!!profile.smoke;slot.spark=false
    slot.color.set(profile.color)
  }
  impact(point:THREE.Vector3,shield:boolean,surface:'world'|'body'='world',weapon=''):void {
    const energy=weapon.startsWith('plasma-')||weapon==='needler'
    const tint=WEAPON_FX[weapon]?.color
    // the burst: plasma splashes in its own colour, a shield flares gold, a round kicks a spark and a puff off the surface
    if(energy){this.bursts.add(0,point,this.color.set(tint!).multiplyScalar(1.6),.14,.12,.55);this.bursts.add(1,point,this.color.set(tint!).lerp(new THREE.Color(0xffffff),.35),.35,.08,.3,.35,UP_DRIFT)}
    else if(shield)this.bursts.add(0,point,0xffb34d,.1,.1,.4)
    else if(surface==='body')this.bursts.add(1,point,0x5a1012,.35,.05,.22,.8,DOWN_DRIFT)
    else{
      const heavy=['sniper','magnum','battle-rifle','shotgun'].includes(weapon)
      this.bursts.add(0,point,0xffc27a,.05,.06,heavy?.3:.2)
      this.bursts.add(1,point,0xb3a998,heavy?.9:.6,.06,heavy?.8:.5,heavy?.85:.7,UP_DRIFT)
    }
    for(let i=0;i<(shield?7:4);i++){
      const slot=this.slots[this.cursor++%64];slot.start.copy(point)
      slot.velocity.set((Math.random()-.5)*2,Math.random()*1.8,(Math.random()-.5)*2)
      slot.end.copy(point).addScaledVector(slot.velocity,.055)
      slot.life=slot.total=shield?.18:.15;slot.color.set(shield?0xffc265:energy?tint!:surface==='body'?0x8c2427:0xe4c48a)
      slot.width=energy?.018:surface==='body'&&!shield?.018:.005;slot.length=0;slot.smoke=false;slot.spark=true
    }
  }
  shockwave(point:THREE.Vector3,color=0x91e6ff,life=.5,maxScale=4):void {
    if(this.waves.length>=12){const old=this.waves.shift()!;this.scene.remove(old.mesh);old.mesh.geometry.dispose();old.mesh.material.dispose()}
    const mesh=new THREE.Mesh(new THREE.TorusGeometry(1,.05,6,48),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.9,depthWrite:false}))
    mesh.rotation.x=Math.PI/2;mesh.position.copy(point);this.scene.add(mesh);this.waves.push({mesh,life,total:life,maxScale})
  }
  /** A shield failing. Deliberately small: the character's own silhouette flash carries the
   * moment, and this is just the burst coming off it, in the same warm colour. */
  shieldPop(point:THREE.Vector3):void {
    this.shockwave(point,0xffcb7a,.22,.85)
    this.impact(point,true)
  }
  update(dt:number):void {
    plasmaFx(this.scene).update(dt)
    this.smoke.update(dt)
    this.bursts.update(dt)
    for(let i=this.waves.length-1;i>=0;i--){const w=this.waves[i];w.life-=dt;if(w.life<=0){this.scene.remove(w.mesh);w.mesh.geometry.dispose();w.mesh.material.dispose();this.waves.splice(i,1)}else{const fraction=w.life/w.total;w.mesh.scale.setScalar(.2+(1-fraction)*w.maxScale);w.mesh.material.opacity=fraction*.9}}
    let active=false,dirty=false
    this.slots.forEach((slot,i)=>{
      if(slot.life<=0)return
      dirty=true
      slot.life=Math.max(0,slot.life-dt)
      if(slot.life<=0)this.transform.scale.setScalar(0)
      else {
        active=true
        this.direction.copy(slot.end).sub(slot.start)
        const distance=this.direction.length(),age=slot.total-slot.life,fade=slot.life/slot.total
        let length=distance
        this.transform.position.copy(slot.start).addScaledVector(this.direction,.5)
        if(slot.spark){this.transform.position.addScaledVector(slot.velocity,age);this.transform.position.y-=2.5*age*age}
        else if(!slot.smoke&&distance>0){
          length=Math.min(slot.length,distance)
          const front=Math.min(distance,length+age*slot.speed)
          this.transform.position.copy(slot.start).addScaledVector(this.direction,(front-length/2)/distance)
        }
        this.transform.quaternion.setFromUnitVectors(this.up,this.direction.normalize())
        const width=slot.width*(slot.smoke?1+age*1.8:1)
        this.transform.scale.set(width,length,width)
        this.streaks.setColorAt(i,this.color.copy(slot.color).multiplyScalar(fade*(slot.smoke?.35:slot.spark?1.5:1)))
      }
      this.transform.updateMatrix();this.streaks.setMatrixAt(i,this.transform.matrix)
    })
    this.streaks.visible=active
    if(dirty){this.streaks.instanceMatrix.needsUpdate=true
      if(this.streaks.instanceColor)this.streaks.instanceColor.needsUpdate=true}
  }
}
