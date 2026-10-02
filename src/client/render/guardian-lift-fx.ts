import * as THREE from 'three'
import { GUARDIAN_LIFTS, type GuardianLiftKind } from '../../shared/guardian.ts'
import { GUARDIAN_NAV_META as GUARDIAN_NAV_DATA } from '../../shared/guardian-nav-meta.ts'

/** Guardian's launcher effects, matched to Halo 3 (see reference/guardian/GAPS.md):
 *  - man cannons: a soft, tall plume that widens and leans along the launch, with fast rising
 *    wisps and motes. The pedestal's own static glyph (in the GLB) is the pad; only a plain,
 *    steady cyan underglow sits behind it, so the glyph is never doubled or spun;
 *  - boosters: three glowing glyph discs in a row on the booster plate, each firing a short
 *    tapered, flickering jet;
 *  - the Gold lift: no pad and no beam, only a warm glow in the channel on the back wall, a faint
 *    gold haze with slow motes in the lift column, and a gold wash over the screen while riding.
 *
 * Each launcher is a light source: HDR cores (plume root, jet roots, disc glyphs, channel strips)
 * past the bloom threshold, soft steady halos, and the wash they throw on floors and walls, which
 * is baked per vertex with the rooms' light in guardian-lighting.ts.
 *
 * Everything is two draw calls (one merged volume mesh, one merged particle mesh) animated
 * entirely in the vertex and fragment shaders from one time uniform; nothing is updated per
 * particle on the CPU, and no real-time light is added. Additive and untonemapped, so it reads without
 * bloom. Purely cosmetic: triggering lives in `guardianMove`. */
export interface GuardianLiftFx {
  group: THREE.Group
  /** `time` is the scene clock already threaded through `guardian`'s other per-frame effects. */
  update(time: number): void
  /** Call once, right when a rider's velocity is set by the lift, at their launch position. */
  burst(x: number, y: number, z: number): void
}

const CYAN = new THREE.Color(0x9ff4ff)
const GOLD = new THREE.Color(0xffd98f)
/** Wrap the shader clock so phases keep full float precision in long matches. */
const TIME_WRAP = 1200
const BURST_SLOTS = 4

// Volume modes (aParams.x).
const PLUME = 0, JET = 1, DISC = 2, HAZE = 3, CHANNEL = 4, SCREEN = 5, SPILL = 6
// Particle types (aParams.x).
const WISP = 0, MOTE = 1, SMOKE = 2, GOLD_MOTE = 3, PUFF = 4, HALO = 5

const NOISE = /* glsl */`
float hash21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
// Value noise that tiles every "period" cells in x, so it wraps seamlessly around a tube.
float wrapNoise(vec2 p,float period){
  vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  float i0=mod(i.x,period),i1=mod(i.x+1.0,period);
  float a=hash21(vec2(i0,i.y)),b=hash21(vec2(i1,i.y)),c=hash21(vec2(i0,i.y+1.0)),d=hash21(vec2(i1,i.y+1.0));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}`

const VOLUME_VERTEX = /* glsl */`
attribute vec2 aUv;attribute vec4 aParams;attribute vec3 aTint;
uniform vec4 uGold;uniform vec2 uGoldY;
varying vec2 vUv;varying vec4 vParams;varying vec3 vTint;varying float vFacing;varying float vDist;varying float vInside;
void main(){
  vUv=aUv;vParams=aParams;vTint=aTint;vInside=0.0;
  if(aParams.x>4.5&&aParams.x<5.5){
    // Screen wash, drawn only while the camera is inside the Gold lift column.
    float r=length(cameraPosition.xz-uGold.xy);
    float inside=(1.0-smoothstep(uGold.z*.75,uGold.z,r))*smoothstep(uGoldY.x+.3,uGoldY.x+1.2,cameraPosition.y)*(1.0-smoothstep(uGoldY.y-1.5,uGoldY.y,cameraPosition.y));
    vInside=inside;vFacing=1.0;vDist=100.0;
    gl_Position=inside>.002?vec4(aUv,-.9999,1.0):vec4(0.0,0.0,2.0,1.0);
    return;
  }
  vec3 toCamera=cameraPosition-position;
  vDist=length(toCamera);
  vFacing=abs(dot(normal,toCamera/max(vDist,1e-4)));
  gl_Position=projectionMatrix*viewMatrix*vec4(position,1.0);
}`

const VOLUME_FRAGMENT = /* glsl */`
uniform float uTime;uniform float uFogDensity;
varying vec2 vUv;varying vec4 vParams;varying vec3 vTint;varying float vFacing;varying float vDist;varying float vInside;
${NOISE}
void main(){
  float mode=vParams.x,seed=vParams.y,gain=vParams.w;
  float u=vUv.x,v=clamp(vUv.y,0.0,1.0),t=uTime;
  vec3 col=vTint;float a=0.0;float nearFade=smoothstep(.45,2.4,vDist);
  if(mode<.5){
    // Man cannon plume: fast upward streaks (about 8 m/s), a soft silhouette, white-cyan at the
    // base, through sky blue, to a grey that fades out at the top.
    float s1=wrapNoise(vec2(u*11.0,v*2.6-t*1.25+seed),11.0);
    float s2=wrapNoise(vec2(u*23.0+7.0,v*5.5-t*1.9+seed),23.0);
    float streak=s1*.62+s2*.38;streak*=streak;
    float body=smoothstep(0.0,.1,v)*pow(max(1.0-v,0.0),1.25)*(.55+.45*smoothstep(0.0,.3,v));
    float flicker=.9+.1*wrapNoise(vec2(u*5.0,t*14.0+seed),5.0);
    a=body*pow(vFacing,1.4)*(.3+.9*streak)*flicker;
    col=mix(vec3(.86,1.0,1.0),vec3(.5,.76,.98),smoothstep(.0,.22,v));
    col=mix(col,vec3(.58,.62,.63),smoothstep(.6,1.0,v));
    // HDR core at the base, past the bloom threshold, so the column reads as a light source.
    col*=1.0+.9*(1.0-smoothstep(0.0,.22,v))*(.5+.5*streak);
  }else if(mode<1.5){
    // Booster jet: a short tapered energy flame with a rapid turbulent flicker (15-20 Hz).
    float s=wrapNoise(vec2(u*9.0,v*3.0-t*6.0+seed),9.0);
    float flicker=.7+.3*wrapNoise(vec2(seed*13.0,t*17.0),64.0);
    float body=smoothstep(0.0,.08,v)*pow(max(1.0-v,0.0),1.1);
    a=body*pow(vFacing,.9)*(.7+1.0*s)*flicker;
    col=mix(vec3(.78,.96,1.0),vec3(.24,.5,.78),smoothstep(0.0,.7,v));
    col*=1.0+1.6*(1.0-smoothstep(0.0,.45,v));
  }else if(mode<2.5){
    // Booster disc: a steady cyan-white face, a bright rim and a white Forerunner cross glyph.
    vec2 p=vUv;float r=length(p);
    if(r>1.0)discard;
    float face=1.0-smoothstep(.78,.82,r);
    float rim=smoothstep(.84,.88,r)*(1.0-smoothstep(.95,1.0,r));
    vec2 q=abs(p);
    float arm=max(step(q.x,.11)*step(q.y,.56),step(q.y,.11)*step(q.x,.56));
    float cap=max(step(q.x,.25)*step(abs(q.y-.5),.07),step(q.y,.25)*step(abs(q.x-.5),.07));
    float hub=step(max(q.x,q.y),.2)*(1.0-step(max(q.x,q.y),.1));
    float glyph=clamp(arm+cap+hub,0.0,1.0);
    col=vec3(.34,.78,.9)*face*.8+vec3(.8,.97,1.0)*rim*1.1+vec3(1.0)*glyph*face*.95;
    col+=vec3(.5,.9,1.0)*(1.0-smoothstep(0.0,.8,r))*.25*face;
    col*=1.0+.9*max(glyph*face,rim);
    a=1.0;nearFade=1.0;
  }else if(mode<3.5){
    // Gold lift column: faint warm haze with slow rising variation.
    float n=wrapNoise(vec2(u*8.0,v*3.0-t*.22),8.0);
    float body=smoothstep(0.0,.08,v)*(1.0-smoothstep(.62,1.0,v));
    a=body*pow(vFacing,1.1)*(.07+.14*n);
  }else if(mode<4.5){
    // Gold channel glow on the lift's back wall: warm, brightest low, with two thin light
    // strips flanking the emblem column. Steady: no pulse, no flicker.
    float across=exp(-u*u*2.6)*(1.0-smoothstep(.8,1.0,abs(u)));
    float height=smoothstep(0.0,.02,v)*(1.0-smoothstep(.82,1.0,v))*(.45+.55*pow(max(1.0-v,0.0),1.6));
    float strip=1.0-smoothstep(.0,.03,abs(abs(u)-.9));
    a=height*(across*.45+strip*.9);
    col=mix(vTint,vec3(1.0,.95,.8),strip)*(1.0+1.2*strip+.35*across);
    nearFade=1.0;
  }else if(mode<5.5){
    // Inside the Gold lift: pale gold haze over the whole view.
    a=vInside*.3;col=vec3(1.0,.92,.6);nearFade=1.0;
  }else{
    // Floor spill of the channel's light: a soft warm pool.
    float r=length(vUv);
    a=pow(max(0.0,1.0-r),2.0)*.55;nearFade=1.0;
  }
  a*=gain*nearFade*exp(-uFogDensity*uFogDensity*vDist*vDist);
  if(a<.004)discard;
  gl_FragColor=vec4(col,a);
}`

const PARTICLE_VERTEX = /* glsl */`
attribute vec2 aCorner;attribute vec3 aOrigin;attribute vec3 aAxis;attribute vec4 aSeed;attribute vec4 aParams;attribute vec2 aShape;attribute vec3 aColor;
uniform float uTime;uniform float uFogDensity;uniform vec4 uBurst[${BURST_SLOTS}];uniform vec3 uBurstColor[${BURST_SLOTS}];
varying vec2 vCorner;varying vec3 vColor;varying float vAlpha;
void main(){
  float type=aParams.x,height=aParams.y,speed=aParams.z,size=aParams.w;
  vec3 axis=normalize(aAxis);
  vec3 side=normalize(cross(axis,abs(axis.y)<.99?vec3(0.0,1.0,0.0):vec3(1.0,0.0,0.0)));
  vec3 back=cross(axis,side);
  vec3 center;float alpha;vColor=aColor;bool streak=false;float stretch=1.0;
  if(type>4.5){
    // Steady soft glow round a launcher's bright core; speed carries its strength.
    center=aOrigin;alpha=speed;
  }else if(type<3.5){
    float t=fract(aSeed.x+uTime*speed/height);
    float angle=aSeed.y*6.2832+uTime*aSeed.w*(type>2.5?.5:1.2);
    float radius=mix(aShape.x,aShape.y,t)*aSeed.z;
    center=aOrigin+axis*(t*height)+(side*cos(angle)+back*sin(angle))*radius;
    alpha=smoothstep(0.0,.1,t)*(1.0-smoothstep(.55,1.0,t));
    if(type<.5){streak=true;stretch=10.0+6.0*aSeed.w;alpha*=.4;}
    else if(type<1.5){alpha*=.8+.2*sin(uTime*21.0+aSeed.y*40.0);}
    else if(type<2.5){
      // Turbulent smoky base: a big soft sprite that churns in place.
      center=aOrigin+axis*(.35+.25*aSeed.z)+(side*cos(angle)+back*sin(angle))*.25;
      alpha=.1+.04*sin(uTime*3.0+aSeed.y*6.0);size*=.9+.15*sin(uTime*2.3+aSeed.x*6.0);
    }else{alpha*=.9;}
  }else{
    // Launch puff: a quick upward burst of motes at the launch position.
    int slot=int(aParams.y+.5);
    vec4 b=uBurst[slot];
    float age=uTime-b.w,life=.75;
    if(age<0.0||age>life){gl_Position=vec4(0.0,0.0,2.0,1.0);return;}
    float k=age/life,angle=aSeed.y*6.2832;
    vec3 out1=vec3(cos(angle),0.0,sin(angle));
    center=b.xyz+out1*(.25+aSeed.z*.9)*(1.0-exp(-age*5.0))+vec3(0.0,(.2+speed*(1.0-exp(-age*3.0))*(.5+aSeed.w)),0.0);
    alpha=(1.0-k)*(1.0-k)*.9;vColor=uBurstColor[slot];
    streak=true;axis=vec3(0.0,1.0,0.0);stretch=3.0+3.0*aSeed.w;
  }
  vec3 toCamera=cameraPosition-center;float dist=length(toCamera);
  vec3 offset;
  if(streak){
    vec3 across=normalize(cross(axis,toCamera/max(dist,1e-4)));
    offset=across*aCorner.x*size*.5+axis*aCorner.y*size*.5*stretch;
  }else{
    vec3 right=vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0]);
    vec3 up=vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1]);
    offset=(right*aCorner.x+up*aCorner.y)*size*.5;
  }
  alpha*=smoothstep(.35,1.6,dist)*exp(-uFogDensity*uFogDensity*dist*dist);
  vAlpha=alpha;vCorner=aCorner;
  gl_Position=alpha>.002?projectionMatrix*viewMatrix*vec4(center+offset,1.0):vec4(0.0,0.0,2.0,1.0);
}`

const PARTICLE_FRAGMENT = /* glsl */`
varying vec2 vCorner;varying vec3 vColor;varying float vAlpha;
void main(){
  float d=dot(vCorner,vCorner);
  float a=vAlpha*exp(-d*3.2)*(1.0-smoothstep(.8,1.0,d));
  if(a<.004)discard;
  gl_FragColor=vec4(vColor,a);
}`

/** Collects triangles for one merged, world-space mesh. */
class Builder {
  positions: number[] = []; normals: number[] = []; uvs: number[] = []; params: number[] = []; tints: number[] = []
  index: number[] = []
  vertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, param: readonly number[], tint: THREE.Color): number {
    this.positions.push(p.x, p.y, p.z); this.normals.push(n.x, n.y, n.z); this.uvs.push(u, v)
    this.params.push(...param); this.tints.push(tint.r, tint.g, tint.b)
    return this.positions.length / 3 - 1
  }
  /** Open tube along `axis` from `base`: radius r0 at the base to r1 at the top. */
  tube(base: THREE.Vector3, axis: THREE.Vector3, length: number, r0: number, r1: number, radial: number, rings: number, param: readonly number[], tint: THREE.Color, bulge = 0): void {
    const side = new THREE.Vector3().crossVectors(axis, Math.abs(axis.y) < .99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize()
    const back = new THREE.Vector3().crossVectors(axis, side)
    const start = this.positions.length / 3
    for (let j = 0; j <= rings; j++) {
      const v = j / rings, radius = THREE.MathUtils.lerp(r0, r1, v) + bulge * Math.sin(Math.PI * v)
      for (let i = 0; i <= radial; i++) {
        const angle = i / radial * Math.PI * 2
        const n = side.clone().multiplyScalar(Math.cos(angle)).addScaledVector(back, Math.sin(angle))
        const p = base.clone().addScaledVector(axis, v * length).addScaledVector(n, radius)
        this.vertex(p, n, i / radial, v, param, tint)
      }
    }
    for (let j = 0; j < rings; j++) for (let i = 0; i < radial; i++) {
      const a = start + j * (radial + 1) + i, b = a + radial + 1
      this.index.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  /** Quad centred on `center` spanning ±halfU along `du` and ±halfV along `dv`; uv runs -1..1
   * (or 0..1 in v when `vFromZero`). */
  quad(center: THREE.Vector3, du: THREE.Vector3, dv: THREE.Vector3, halfU: number, halfV: number, param: readonly number[], tint: THREE.Color, vFromZero = false): void {
    const n = new THREE.Vector3().crossVectors(du, dv).normalize()
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) =>
      this.vertex(center.clone().addScaledVector(du, su * halfU).addScaledVector(dv, sv * halfV), n, su, vFromZero ? (sv + 1) / 2 : sv, param, tint))
    this.index.push(corners[0], corners[1], corners[2], corners[0], corners[2], corners[3])
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3))
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uvs, 2))
    g.setAttribute('aParams', new THREE.Float32BufferAttribute(this.params, 4))
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tints, 3))
    g.setIndex(this.index)
    return g
  }
}

/** Camera-facing (or axis-stretched) quads whose motion is computed in the vertex shader. */
class Particles {
  corner: number[] = []; origin: number[] = []; axis: number[] = []; seed: number[] = []; params: number[] = []; shape: number[] = []; color: number[] = []
  index: number[] = []
  private random = (() => { let s = 20260929; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 } })()
  add(count: number, type: number, origin: THREE.Vector3, axis: THREE.Vector3, height: number, speed: [number, number], size: [number, number], r0: number, r1: number, color: THREE.Color): void {
    for (let k = 0; k < count; k++) {
      const start = this.corner.length / 2, rnd = this.random
      const spd = THREE.MathUtils.lerp(speed[0], speed[1], rnd()), sz = THREE.MathUtils.lerp(size[0], size[1], rnd())
      const seed = [rnd(), rnd(), Math.sqrt(rnd()), rnd() - .5]
      for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        this.corner.push(cx, cy); this.origin.push(origin.x, origin.y, origin.z); this.axis.push(axis.x, axis.y, axis.z)
        this.seed.push(...seed); this.params.push(type, height, spd, sz); this.shape.push(r0, r1); this.color.push(color.r, color.g, color.b)
      }
      this.index.push(start, start + 1, start + 2, start, start + 2, start + 3)
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    // `position` is required by three for draw-range bookkeeping; the shader never reads it.
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.origin, 3))
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(this.corner, 2))
    g.setAttribute('aOrigin', new THREE.Float32BufferAttribute(this.origin, 3))
    g.setAttribute('aAxis', new THREE.Float32BufferAttribute(this.axis, 3))
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(this.seed, 4))
    g.setAttribute('aParams', new THREE.Float32BufferAttribute(this.params, 4))
    g.setAttribute('aShape', new THREE.Float32BufferAttribute(this.shape, 2))
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.color, 3))
    g.setIndex(this.index)
    return g
  }
}

const UP = new THREE.Vector3(0, 1, 0)

export function createGuardianLiftFx(fog?: THREE.Fog | THREE.FogExp2 | null): GuardianLiftFx {
  const group = new THREE.Group()
  group.name = 'guardian-lift-fx'
  const volumes = new Builder(), particles = new Particles()
  const emitters = GUARDIAN_NAV_DATA.liftEmitters
  const gold = { x: 0, z: 0, radius: 1.25, y0: 0, y1: 0 }
  const kinds: { x: number; z: number; kind: GuardianLiftKind }[] = []

  for (const [i, lift] of GUARDIAN_LIFTS.entries()) {
    const [ex, ey, ez] = emitters[i] ?? [lift.x, lift.y, lift.z]
    const speed = Math.hypot(lift.vx, lift.vy, lift.vz)
    const flat = new THREE.Vector3(lift.vx, 0, lift.vz)
    const heading = flat.lengthSq() > 1e-6 ? flat.clone().normalize() : new THREE.Vector3(1, 0, 0)
    kinds.push({ x: lift.x, z: lift.z, kind: lift.kind })

    if (lift.kind === 'cannon') {
      // Lean the plume toward the launch, about half the launch angle, within Halo 3's 12-22 degrees.
      const launchAngle = Math.acos(THREE.MathUtils.clamp(lift.vy / speed, -1, 1))
      const tilt = THREE.MathUtils.clamp(launchAngle * .5, THREE.MathUtils.degToRad(12), THREE.MathUtils.degToRad(22))
      const axis = UP.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(heading, Math.sin(tilt)).normalize()
      const base = new THREE.Vector3(ex, ey + .04, ez)
      volumes.tube(base, axis, 6.8, .72, 1.45, 20, 10, [PLUME, i * 1.7, 0, 1], CYAN, .12)
      particles.add(24, WISP, base, axis, 6.4, [7, 10], [.05, .09], .75, 1.2, new THREE.Color(0xb8e6ff))
      particles.add(14, MOTE, base, axis, 5.5, [3.5, 6], [.04, .08], .85, 1.3, new THREE.Color(0xe6ffff))
      particles.add(3, SMOKE, base, axis, 1, [0, 0], [1.5, 1.9], 0, 0, new THREE.Color(0x6fb9d8))
      // Glow halo round the plume's root: HDR, so bloom picks it up; soft enough to read without it.
      particles.add(1, HALO, base.clone().addScaledVector(axis, .7), axis, 1, [.16, .16], [3.8, 3.8], 0, 0, new THREE.Color(.6, 1.05, 1.25))
      // A soft, steady cyan underglow on the pedestal behind the model's own static glyph (Halo 3's
      // cyan disc body), with no pattern of its own so the glyph is never doubled.
      volumes.quad(new THREE.Vector3(ex, ey + .01, ez), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), 1.15, 1.15, [SPILL, 0, 0, 1.3], new THREE.Color(0x5fdcee))
    } else if (lift.kind === 'booster') {
      // The source booster plate: a flat 0.8 x 2.5 m top plus a sloped lip facing Top Mid along
      // world X, with its long side along Z (guardian_minilift_floor, both plates alike). The
      // marker is the plate's centroid; its flat top sits 0.065 m above it and its middle
      // 0.23 m further from Top Mid. Three discs run along the plate, each jet leaning toward
      // Top Mid like the plate's sloped lip.
      const out = Math.sign(ex) || 1
      const towardMid = new THREE.Vector3(-out, 0, 0)
      const axis = UP.clone().multiplyScalar(Math.cos(THREE.MathUtils.degToRad(26))).addScaledVector(towardMid, Math.sin(THREE.MathUtils.degToRad(26))).normalize()
      for (const k of [-1, 0, 1]) {
        const c = new THREE.Vector3(ex + out * .23, ey + .065 + .012, ez + k * .78)
        volumes.quad(c, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), .3, .3, [DISC, i + k, 0, 1], CYAN)
        volumes.tube(c.clone().addScaledVector(axis, .02), axis, 1.3, .25, .1, 12, 4, [JET, i * 3.1 + k * 1.3, 0, 1], CYAN, .03)
        particles.add(1, HALO, c.clone().addScaledVector(axis, .18), axis, 1, [.42, .42], [1.5, 1.5], 0, 0, new THREE.Color(.65, 1.05, 1.25))
      }
    } else {
      // Gold lift: the channel on the shaft's back wall (-X, 1.49 m behind the pad), and the
      // column the rider climbs, from the lower floor to just over the upper one.
      const floor = lift.y, top = GUARDIAN_NAV_DATA.liftTargets[i]?.[1] ?? floor + 7
      const wallX = ex - 1.49 + .035
      const channelTop = top + 9.5
      volumes.quad(new THREE.Vector3(wallX, (floor + channelTop) / 2, ez), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), .82, (channelTop - floor) / 2, [CHANNEL, 0, 0, .4], GOLD, true)
      volumes.quad(new THREE.Vector3(ex + .4, floor + .02, ez), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), 2.4, 2.1, [SPILL, 0, 0, .8], GOLD)
      const columnBase = new THREE.Vector3(ex - .1, floor, ez)
      volumes.tube(columnBase, UP, top + 2.5 - floor, 1.15, 1.25, 16, 6, [HAZE, 0, 0, 1], new THREE.Color(0xffe2a0))
      particles.add(22, GOLD_MOTE, columnBase, UP, top + 2 - floor, [.5, 1], [.04, .08], .3, 1.05, new THREE.Color(0xffe7a8))
      // Warm glow at the channel's foot and mid-height, where Halo 3's lift is brightest.
      for (const [h, size, strength] of [[1.1, 3.6, .3], [4.5, 3.2, .16]] as const)
        particles.add(1, HALO, new THREE.Vector3(wallX + .45, floor + h, ez), UP, 1, [strength, strength], [size, size], 0, 0, new THREE.Color(1.3, .95, .45))
      Object.assign(gold, { x: ex - .1, z: ez, radius: 1.3, y0: floor, y1: top + 1.2 })
    }
  }
  // Screen wash quad (clip-space corners), shown by the shader only inside the Gold lift column.
  volumes.quad(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), 1, 1, [SCREEN, 0, 0, 1], GOLD)
  // Launch puffs: a fixed pool of motes per burst slot, idle until `burst` starts that slot.
  for (let slot = 0; slot < BURST_SLOTS; slot++) particles.add(18, PUFF, new THREE.Vector3(), UP, slot, [2.5, 4.5], [.06, .12], 0, 0, CYAN)

  const fogDensity = { value: fog && (fog as THREE.FogExp2).isFogExp2 ? (fog as THREE.FogExp2).density : 0 }
  const time = { value: 0 }
  const volumeMaterial = new THREE.ShaderMaterial({
    name: 'guardian-lift-fx-volumes',
    uniforms: {
      uTime: time, uFogDensity: fogDensity,
      uGold: { value: new THREE.Vector4(gold.x, gold.z, gold.radius, 0) }, uGoldY: { value: new THREE.Vector2(gold.y0, gold.y1) },
    },
    vertexShader: VOLUME_VERTEX, fragmentShader: VOLUME_FRAGMENT,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
  })
  const bursts = Array.from({ length: BURST_SLOTS }, () => new THREE.Vector4(0, -1000, 0, -1000))
  const burstColors = Array.from({ length: BURST_SLOTS }, () => CYAN.clone())
  const particleMaterial = new THREE.ShaderMaterial({
    name: 'guardian-lift-fx-particles',
    uniforms: { uTime: time, uFogDensity: fogDensity, uBurst: { value: bursts }, uBurstColor: { value: burstColors } },
    vertexShader: PARTICLE_VERTEX, fragmentShader: PARTICLE_FRAGMENT,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  })
  const volumeMesh = new THREE.Mesh(volumes.geometry(), volumeMaterial)
  volumeMesh.name = 'guardian-lift-fx:volumes'
  const particleMesh = new THREE.Mesh(particles.geometry(), particleMaterial)
  particleMesh.name = 'guardian-lift-fx:particles'
  for (const mesh of [volumeMesh, particleMesh]) {
    // World-space geometry spread across the map, positioned in the shader: never cull by the
    // (meaningless) bounding sphere, and draw after the opaque world.
    mesh.frustumCulled = false
    mesh.renderOrder = 5
    mesh.matrixAutoUpdate = false
    group.add(mesh)
  }

  let cursor = 0
  return {
    group,
    update(now) {
      time.value = now % TIME_WRAP
    },
    burst(x, y, z) {
      const slot = cursor++ % BURST_SLOTS
      bursts[slot].set(x, y + .15, z, time.value)
      const nearest = kinds.reduce((best, k) => Math.hypot(k.x - x, k.z - z) < Math.hypot(best.x - x, best.z - z) ? k : best, kinds[0])
      burstColors[slot].copy(nearest?.kind === 'lift' ? GOLD : CYAN)
    },
  }
}
