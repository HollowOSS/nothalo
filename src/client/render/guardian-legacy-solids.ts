/** Legacy hand-authored Guardian volumes. They were the procedural map's collision and art
 * before the downloaded Halo Online mesh became both the visible architecture and, through
 * the generated collision data, the gameplay collider. They now only drive the procedural
 * placeholder art that shows until the imported model finishes loading, so they live with
 * the renderer and never reach the Worker bundle. */
export interface GuardianSolid { name: string; x: number; z: number; w: number; d: number; y: number; h: number; ramp?: 'x' | 'z'; rise?: number; octagon?: boolean; yaw?: number; zone?: 'gold' | 'blue' | 'green'; glass?: boolean; outline?: [number,number][]; slope?: [number,number] }
// Metres. Render meshes and collision consume exactly these slabs and ramps.
export const GUARDIAN_SOLIDS: GuardianSolid[] = [
  {name:'Bottom Mid',octagon:true,x:0,z:0,w:13,d:13,y:8,h:1},
  {name:'Top Mid',octagon:true,x:0,z:0,w:16,d:16,y:13,h:1},
  {name:'S1',x:-25,z:0,w:13,d:15,y:8,h:1},
  {name:'S2',x:-22.6,z:0,w:8.2,d:15,y:13,h:1},
  {name:'S3',x:-24.35,z:-5,w:4.7,d:5,y:18,h:1},
  {name:'Sniper bridge',x:-14,z:0,w:13,d:4,y:13,h:1},
  {name:'Lower sniper bridge',x:-13,z:4,w:16,d:4,y:8,h:1},
  {name:'Gold 1',x:25,z:0,w:13,d:15,y:8,h:1,zone:'gold'},
  {name:'Gold 2',x:23,z:0,w:9,d:15,y:13,h:1,zone:'gold'},
  {name:'Gold lift lip',x:29,z:-3,w:4,d:9,y:13,h:1,zone:'gold'},
  {name:'Gold jump ledge',x:17,z:0,w:4,d:4,y:13,h:1,zone:'gold'},
  {name:'Gold bridge',x:14,z:0,w:15,d:4,y:8,h:1,zone:'gold'},
  {name:'Blue Room',x:18,z:-21.5,w:16,d:10,y:13,h:1,zone:'blue'},
  // Rear drop leaves a real opening into Shotgun / Bottom Blue, not a solid upper slab.
  {name:'Blue rear landing',x:22,z:-28,w:8,d:3,y:13,h:1,zone:'blue'},
  {name:'Bottom Blue',x:18,z:-23,w:16,d:13,y:8,h:1,zone:'blue'},
  {name:'Blue bridge',x:4,z:-16,w:5,d:19,y:13,h:1,zone:'blue'},
  {name:'Blue link',x:10,z:-23,w:12,d:4,y:13,h:1,zone:'blue'},
  {name:'Blue cannon ledge',x:8,z:-31,w:6,d:5,y:8,h:1,zone:'blue'},
  {name:'Blue front landing',x:22,z:-15,w:10,d:4,y:13,h:1,zone:'blue'},
  {name:'Blue to gold',x:25,z:-12,w:5,d:16,y:13,h:1,zone:'blue'},
  {name:'Lower blue to gold',x:25,z:-12,w:5,d:16,y:8,h:1,zone:'blue'},
  {name:'Green',x:0,z:25,w:17,d:15,y:8,h:1,zone:'green'},
  {name:'Green bridge',x:0,z:14,w:4,d:16,y:8,h:1,zone:'green'},
  {name:'Green stump ramp',x:-4,z:19.5,w:5,d:11,y:8,h:1,ramp:'z',rise:-5,zone:'green'},
  {name:'Top Green stump',x:-4,z:12.5,w:5,d:3,y:13,h:1,zone:'green'},
  {name:'Elbow neck',x:-25,z:9.5,w:5,d:5,y:13,h:1,zone:'green'},
  {name:'Elbow',x:-25,z:23,w:5,d:24,y:13,h:1,zone:'green'},
  {name:'Elbow link',x:-12.25,z:28,w:20.5,d:5,y:8,h:1,ramp:'x',rise:-5,zone:'green'},
  {name:'Camo',octagon:true,x:30,z:18,w:10,d:10,y:13,h:1,zone:'gold'},
  {name:'Camo link',x:28,z:6.5,w:5,d:6,y:13,h:1,zone:'gold'},
  // Continuous lower circulation: enclosed Bottom Blue / Shotgun, a lower elbow,
  // and open Bottom Mid spokes. Upper floors are actual ceilings, with separate exits.
  {name:'Bottom Blue approach',x:4,z:-15,w:5,d:21,y:8,h:1,zone:'blue'},
  {name:'Bottom Blue link',x:10,z:-23,w:12,d:4,y:8,h:1,zone:'blue'},
  {name:'Shotgun tunnel',x:13,z:-28,w:10,d:4,y:8,h:1,zone:'blue'},
  {name:'Blue cannon threshold',x:8,z:-27,w:4,d:6,y:8,h:1,zone:'blue'},
  {name:'Lower Elbow',x:-25,z:16,w:5,d:19,y:8,h:1,zone:'green'},
  {name:'Lower Elbow turn',x:-14,z:24,w:24,d:4,y:8,h:1,zone:'green'},
  {name:'Bottom Blue back',x:18,z:-29.8,w:16,d:.8,y:9,h:5,zone:'blue'},
  {name:'Bottom Blue east wall',x:25.6,z:-24,w:.8,d:10,y:9,h:4,zone:'blue'},
  {name:'Bottom Blue front left',x:13,z:-17,w:5,d:.8,y:9,h:4,zone:'blue'},
  {name:'Shotgun return',x:10,z:-27.7,w:.65,d:3.6,y:9,h:4,zone:'blue'},
  {name:'Bottom Blue approach west wall',x:1.65,z:-15,w:.65,d:16,y:9,h:3.8,zone:'blue'},
  {name:'Lower Elbow outside wall',x:-27.4,z:16,w:.6,d:18,y:9,h:3.8,zone:'green'},
  {name:'Lower Elbow turn outside wall',x:-14,z:25.85,w:24,d:.6,y:9,h:3.8,zone:'green'},
  {name:'Lower Elbow roof',x:-17.5,z:24,w:17,d:4,y:12.8,h:.2,zone:'green'},
  // Walls are deliberately broken into door-width pieces; no invisible collision shell.
  {name:'Blue back',x:18,z:-29,w:16,d:1,y:14,h:5,zone:'blue'},
  {name:'Blue cover',x:15,z:-20,w:4,d:1,y:14,h:2,zone:'blue'},
  {name:'Gold back',x:31,z:0,w:1,d:15,y:9,h:10,zone:'gold'},
  // Split the north entry around the Blue walkway; the old 4 m jamb sealed it.
  {name:'Gold jamb north west',x:21.5,z:-7,w:2,d:1,y:14,h:4,zone:'gold'},
  {name:'Gold jamb north east',x:28.9,z:-7,w:2.2,d:1,y:14,h:4,zone:'gold'},
  {name:'Gold north lintel',x:25,z:-7,w:5.6,d:1,y:18,h:.7,zone:'gold'},
  {name:'Gold tower back',x:31,z:0,w:1,d:15,y:19,h:14,zone:'gold'},
  {name:'Gold jamb south west',x:22,z:7,w:2,d:1,y:14,h:4,zone:'gold'},
  {name:'Gold jamb south east',x:30,z:7,w:1,d:1,y:14,h:4,zone:'gold'},
  {name:'Gold south lintel',x:26,z:7,w:7,d:1,y:18,h:.7,zone:'gold'},
  {name:'Sniper tower core',octagon:true,x:-29,z:-1,w:4.6,d:4.6,y:-18,h:53},
  {name:'Center support west',x:-5,z:0,w:1,d:3,y:9,h:4},
  {name:'Center support east',x:5,z:0,w:1,d:3,y:9,h:4},
]
/** Reference-guided route shapes. Samples are shared by floors, shots, bodies and art. */
export const GUARDIAN_SNIPER_PATH = Array.from({length:19},(_,i)=>{
 const a=-Math.PI/2-i*Math.PI/18
 return {x:-25+8.5*Math.cos(a),z:8.5*Math.sin(a),y:9+i*5/18+Math.sin(Math.PI*i/18)*.65}
})
export const GUARDIAN_SNIPER_UPPER_PATH = Array.from({length:19},(_,i)=>{const t=i/18,a=Math.PI/2-t*Math.PI;return {x:-25+8.5*Math.cos(a),z:8.5*Math.sin(a),y:14+t*5+Math.sin(Math.PI*t)*.7}})
/** A triangle has a single exact surface plane, avoiding cracks at curved ramp joins. */
function deckTriangle(name:string,points:{x:number;y:number;z:number}[],zone?:GuardianSolid['zone'],height=1){
 let [a,b,c]=points
 if((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x)<0)[b,c]=[c,b]
 const x=(a.x+b.x+c.x)/3,z=(a.z+b.z+c.z)/3,y=(a.y+b.y+c.y)/3
 const det=(b.x-a.x)*(c.z-a.z)-(c.x-a.x)*(b.z-a.z)
 const sx=((b.y-a.y)*(c.z-a.z)-(c.y-a.y)*(b.z-a.z))/det
 const sz=((b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y))/det
 const outline:[number,number][]=[a,b,c].map(p=>[p.x-x,p.z-z])
 GUARDIAN_SOLIDS.push({name,x,z,y:y-height,h:height,w:2*Math.max(...outline.map(p=>Math.abs(p[0]))),d:2*Math.max(...outline.map(p=>Math.abs(p[1]))),outline,slope:[sx,sz],zone})
}
for(const [level,path] of [['lower',GUARDIAN_SNIPER_PATH],['upper',GUARDIAN_SNIPER_UPPER_PATH]] as const){
 for(let i=0;i<path.length-1;i++){
  const ends=[path[i],path[i+1]].map(p=>{
   const dx=(p.x+25)/8.5,dz=p.z/8.5
   return [{x:p.x-dx*2,y:p.y,z:p.z-dz*2},{x:p.x+dx*2,y:p.y,z:p.z+dz*2}]
  })
  const [a,b]=ends[0],[d,c]=ends[1]
  deckTriangle(`Sniper ${level} curve ${i}a`,[a,b,c]);deckTriangle(`Sniper ${level} curve ${i}b`,[a,c,d])
 }
}
GUARDIAN_SOLIDS.push(
 {name:'Sniper curved bottom landing',x:-25,z:-8.5,w:4,d:4,y:8,h:1},
 {name:'Sniper curved middle landing',x:-25,z:8.5,w:4,d:4,y:13,h:1},
 {name:'Sniper curved top landing',x:-25,z:-8.5,w:4,d:4,y:18,h:1},
)
// Curving Gold/Camo approach replaces the square corridor's projecting corner.
export const GUARDIAN_CAMO_PATH=Array.from({length:13},(_,i)=>{
 const a=Math.PI-i/12*Math.PI/2
 return {x:35+7*Math.cos(a),z:8.5+7*Math.sin(a),y:14}
})
for(let i=0;i<12;i++){
 const ends=[GUARDIAN_CAMO_PATH[i],GUARDIAN_CAMO_PATH[i+1]].map(p=>{
  const dx=(p.x-35)/7,dz=(p.z-8.5)/7
  return [{x:p.x-dx*2.5,y:14,z:p.z-dz*2.5},{x:p.x+dx*2.5,y:14,z:p.z+dz*2.5}]
 })
 const [a,b]=ends[0],[d,c]=ends[1]
 deckTriangle(`Camo curve ${i}a`,[a,b,c],'gold');deckTriangle(`Camo curve ${i}b`,[a,c,d],'gold')
}
// Curved outer parapets follow the same ramp planes; end openings admit players.
for(const [name,path,cx,cz,radius,halfWidth] of [
 ['Sniper lower',GUARDIAN_SNIPER_PATH,-25,0,8.5,2],
 ['Sniper upper',GUARDIAN_SNIPER_UPPER_PATH,-25,0,8.5,2],
 ['Camo',GUARDIAN_CAMO_PATH,35,8.5,7,2.5],
] as const){
 for(let i=2;i<path.length-3;i++){
  if(name==='Camo'&&i>=4)continue // the curved path opens onto the Camo landing
  const ends=[path[i],path[i+1]].map(p=>{
   const dx=(p.x-cx)/radius,dz=(p.z-cz)/radius
   return [-.16,.16].map(offset=>({x:p.x+dx*(halfWidth+offset),y:p.y+1.08,z:p.z+dz*(halfWidth+offset)}))
  })
  const [a,b]=ends[0],[d,c]=ends[1]
  deckTriangle(`${name} curved parapet ${i}a`,[a,b,c],undefined,1.08)
  deckTriangle(`${name} curved parapet ${i}b`,[a,c,d],undefined,1.08)
 }
}
// Rails and room frames are shared with the server: visible cover stops players and shots.
for (const name of ['Sniper bridge','Gold bridge','Blue bridge','Elbow','Elbow link','Blue to gold','Camo link','Lower sniper bridge']) {
  const deck=GUARDIAN_SOLIDS.find(s=>s.name===name)!,alongX=deck.w>deck.d
  for(const side of [-1,1]){
    // A rail belongs only to an exposed edge. Cut actual junction openings instead
    // of putting a continuous wall through an overlapping floor at a turn.
    let spans:[number,number][]=[[-(alongX?deck.w:deck.d)/2,(alongX?deck.w:deck.d)/2]]
    const cuts:[number,number][]=[]
    if(name==='Blue bridge'&&side===1)cuts.push([-9.5,-4.7]) // turn into Blue link
    if(name==='Elbow'&&side===1)cuts.push([2.2,8.0]) // turn down to Green
    if(name==='Elbow link'&&side===-1)cuts.push([-10.25,-6.45]) // upper Elbow entry
    if(name==='Blue to gold'&&side===-1)cuts.push([-8,-2.5]) // Blue front doorway
    if(name==='Camo link'&&side===-1)cuts.push([-3,1.5]) // Gold exit into Camo
    for(const [lo,hi] of cuts)spans=spans.flatMap(([a,b])=>hi<=a||lo>=b?[[a,b]]:([[a,Math.max(a,lo)],[Math.min(b,hi),b]] as [number,number][]).filter(([a,b])=>b-a>.05))
    spans.forEach(([a,b],part)=>{
      const mid=(a+b)/2,x=deck.x+(alongX?mid:side*(deck.w/2-.16)),z=deck.z+(alongX?side*(deck.d/2-.16):mid)
      // Keep segmented sloped rails on the original deck's plane.
      const rise=deck.ramp?(deck.rise??0)*(b-a)/(alongX?deck.w:deck.d):0
      const y=deck.ramp?Math.min(surface(deck,deck.x+(alongX?a:0),deck.z+(alongX?0:a)),surface(deck,deck.x+(alongX?b:0),deck.z+(alongX?0:b))):deck.y+deck.h
      GUARDIAN_SOLIDS.push({name:`${name} parapet ${side} ${part}`,x,z,w:alongX?b-a:.32,d:alongX?.32:b-a,y,h:1.08,zone:deck.zone,...(deck.ramp?{ramp:deck.ramp,rise}:{} )})
    })
  }
}
for(const side of [-1,1]){
  GUARDIAN_SOLIDS.push({name:`Gold entry pier ${side}`,x:19.4,z:side*2.8,w:.84,d:1.2,y:9,h:9.5,zone:'gold'})
  GUARDIAN_SOLIDS.push({name:`Sniper entry pier ${side}`,x:-19.8,z:side*2.8,w:.84,d:1.2,y:9,h:9.7})
}
GUARDIAN_SOLIDS.push(
  {name:'Gold entry lintel',x:19.4,z:0,w:.85,d:5.7,y:18.25,h:.65,zone:'gold'},
  {name:'Sniper entry lintel',x:-19.8,z:0,w:.85,d:5.7,y:18.45,h:.65},
  {name:'Gold pylon north',x:19.5,z:-5.3,w:3,d:1.84,y:9,h:12,zone:'gold'},
  {name:'Gold pylon south',x:19.5,z:5.3,w:3,d:1.84,y:9,h:12,zone:'gold'},
  {name:'Blue front lintel',x:19,z:-17,w:6.9,d:.85,y:18.465,h:.65,zone:'blue'},
  {name:'Blue west lintel',x:10,z:-23,w:.85,d:6.5,y:18.465,h:.65,zone:'blue'},
  {name:'Blue ceiling',x:18,z:-23,w:15.6,d:12.5,y:19,h:1.1,zone:'blue'},
  {name:'Blue west return',x:10.3,z:-27,w:.6,d:3.4,y:14,h:5,zone:'blue'},
  {name:'Blue east return',x:25.6,z:-24,w:.6,d:9,y:14,h:5,zone:'blue'},
  {name:'Blue front left',x:12.7,z:-17,w:4.8,d:.6,y:14,h:5,zone:'blue'},
  {name:'Blue front right',x:24,z:-17,w:2.8,d:.6,y:14,h:5,zone:'blue'},
)
// Guardian's Blue bridge has a shot-proof transparent screen above its rail.
GUARDIAN_SOLIDS.push({name:'Blue bridge glass',x:6.34,z:-13.2,w:.2,d:10.2,y:15.08,h:1.65,zone:'blue',glass:true})
// Reachable decorative cover uses the same oriented boxes as its visual footprint.
for(let i=1;i<8;i+=2){
 const a=i*Math.PI/4
 GUARDIAN_SOLIDS.push({name:`Mid beacon ${i}`,x:Math.sin(a)*7.75,z:Math.cos(a)*7.75,w:1.56,d:.75,y:14,h:2.1,yaw:a})
}
for(const x of [12.5,24])GUARDIAN_SOLIDS.push({name:`Blue battery ${x}`,x,z:-26,w:1.04,d:1.04,y:14,h:1.9,octagon:true,zone:'blue'})
for(const side of [-1,1]){
 GUARDIAN_SOLIDS.push({name:`Blue front portal pier ${side}`,x:19+side*3.4,z:-17,w:1.2,d:.85,y:14,h:5,zone:'blue'})
 GUARDIAN_SOLIDS.push({name:`Blue west portal pier ${side}`,x:10,z:-23+side*3.2,w:.85,d:1.2,y:14,h:5,zone:'blue'})
}
export function surface(s: GuardianSolid, x: number, z: number): number {
  if(s.slope)return s.y+s.h+s.slope[0]*(x-s.x)+s.slope[1]*(z-s.z)
  if (!s.ramp) return s.y + s.h
  const t = s.ramp === 'x' ? (x-s.x)/s.w+.5 : (z-s.z)/s.d+.5
  return s.y+s.h+(s.rise! > 0 ? t : 1-t)*Math.abs(s.rise!)
}
