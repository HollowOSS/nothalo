import {arenaData} from './level-data.ts'
import {ARENA_STEP,arenaMeta,arenaCollision,arenaFloor as mapFloor,arenaBlocked as mapBlocked,type ArenaId} from './arena.ts'
import {traceArenaWalk} from './arena-walking.ts'
import {MOVE} from './constants.ts'
export function createArenaNavigation(map:ArenaId) {
const DATA=arenaMeta(map)
// Marked maps bake corridor clearance into graph edges, keeping A* inexpensive.
const corridor='navigationCorridor' in DATA?Number(DATA.navigationCorridor):0
const arenaFloor=(x:number,z:number,y:number,step:number=ARENA_STEP)=>mapFloor(map,x,z,y,step)
const arenaBlocked=(x:number,z:number,y:number,height:number)=>mapBlocked(map,x,z,y,height)
/**
 * Bot navigation over the generated walkable grid (tools/import-arena-maps.mjs). The grid is
 * derived from the same collision mesh that moves players, so a route never crosses a wall
 * the player would hit, and only cells in the main connected arena exist.
 */
interface ArenaNavPoint {x:number;y:number;z:number;label?:string}
interface Node {x:number;y:number;z:number;ix:number;iz:number;links:number;clearance:number;wall:number}
const DIRECTIONS=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]] as const
const distance=(a:ArenaNavPoint,b:ArenaNavPoint)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)

let decoded:{nodes:Node[];cells:Map<number,number[]>}|undefined
function graph(){
  if(decoded)return decoded
  const binary=atob(arenaData(map).nodes),bytes=new Uint8Array(binary.length)
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i)
  const packed=new Int32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4)
  const nodes:Node[]=[],cells=new Map<number,number[]>()
  for(let i=0;i<DATA.count;i++){
    const ix=packed[i*4],iz=packed[i*4+1],flags=packed[i*4+3]
    nodes.push({ix,iz,x:DATA.originX+ix*DATA.cell,z:DATA.originZ+iz*DATA.cell,y:packed[i*4+2]/1000,links:flags&255,clearance:((flags>>8)&255)/100,wall:((flags>>16)&255)/100})
    const key=ix*DATA.rows+iz,list=cells.get(key);if(list)list.push(i);else cells.set(key,[i])
  }
  return decoded={nodes,cells}
}
function cellNodes(ix:number,iz:number):number[]{return graph().cells.get(ix*DATA.rows+iz)??[]}
function neighbour(id:number,bit:number):number{
  const {nodes}=graph(),n=nodes[id],[dx,dz]=DIRECTIONS[bit]
  let best=-1
  for(const other of cellNodes(n.ix+dx,n.iz+dz))if(best<0||Math.abs(nodes[other].y-n.y)<Math.abs(nodes[best].y-n.y))best=other
  return best
}
/** Nearest walkable cell to a point on roughly the same floor, or -1. */
function arenaNavNode(p:ArenaNavPoint,radius=1.6,maxDy=1):number{
  const {nodes}=graph(),ix=Math.round((p.x-DATA.originX)/DATA.cell),iz=Math.round((p.z-DATA.originZ)/DATA.cell),span=Math.ceil(radius/DATA.cell)
  let best=-1,bestD=Infinity
  for(let dx=-span;dx<=span;dx++)for(let dz=-span;dz<=span;dz++)for(const id of cellNodes(ix+dx,iz+dz)){
    const n=nodes[id],dy=Math.abs(n.y-p.y);if(dy>maxDy)continue
    const d=Math.hypot(n.x-p.x,n.z-p.z)+dy*2;if(d<bestD){bestD=d;best=id}
  }
  return best
}
/** Diagnostic: the walkable cell under a point, if any. */
function arenaNavigationSample(x:number,y:number,z:number):{floor:number;blocked:boolean;node:ArenaNavPoint|null}{
  const id=arenaNavNode({x,y,z},.36,1),n=id>=0?graph().nodes[id]:null
  return {floor:arenaFloor(x,z,y),blocked:arenaBlocked(x,z,y,MOVE.playerHeight),node:n?{x:n.x,y:n.y,z:n.z}:null}
}

/** A grounded capsule may walk this straight segment: every sample along it stands on a
 * floor reached by steps or ramps with the standing capsule clear of the mesh, and stays on
 * a walkable cell. A corridor either side is tested at walls and exposed ramp edges too.
 * Local checks stay on controller-validated graph edges; route smoothing additionally
 * executes the player controller before accepting a shortcut. */
function arenaCanWalk(from:ArenaNavPoint,to:ArenaNavPoint,validateController=false):boolean {
  if(![from.x,from.y,from.z,to.x,to.y,to.z].every(Number.isFinite))return false
  graph()
  let previousId=arenaNavNode(from,.55,.9)
  if(previousId<0)return false
  // The floor query already includes the step allowance. Adding a starting-height
  // margin let smoothing teleport onto a deck above a ramp's actual reachable step.
  let y=arenaFloor(from.x,from.z,from.y)
  if(Math.abs(y-from.y)>ARENA_STEP+.005||arenaBlocked(from.x,from.z,y,MOVE.playerHeight))return false
  const length=Math.hypot(to.x-from.x,to.z-from.z),steps=Math.max(1,Math.ceil(length/.1))
  const sideX=length?-(to.z-from.z)/length:0,sideZ=length?(to.x-from.x)/length:0
  for(let i=1;i<=steps;i++){
    const x=from.x+(to.x-from.x)*i/steps,z=from.z+(to.z-from.z)*i/steps
    const floor=arenaFloor(x,z,y)
    if(floor<y-(corridor?ARENA_STEP+.005:.6)||floor>y+ARENA_STEP+.01)return false
    const id=arenaNavNode({x,y:floor,z},.55,.9)
    if(id<0)return false
    if(id!==previousId){
      const previous=graph().nodes[previousId],next=graph().nodes[id]
      const bit=DIRECTIONS.findIndex(([dx,dz])=>previous.ix+dx===next.ix&&previous.iz+dz===next.iz)
      if(bit<0||!(previous.links&(1<<bit))||neighbour(previousId,bit)!==id)return false
      previousId=id
    }
    if(arenaBlocked(x,z,floor,MOVE.playerHeight))return false
    // Steering accepts a small waypoint radius, so near walls a shoulder-width corridor must also stand.
    // Exposed edges need the same corridor as walls: a waypoint may be reached a
    // few centimetres early, which must not turn a ramp shortcut into a fall.
    // Epitaph raised trim needs that margin even across one or two grid cells.
    if(length>1.5||corridor)for(const side of [-(corridor||.3),corridor||.3]){
      const px=x+sideX*side,pz=z+sideZ*side
      const support=arenaFloor(px,pz,floor)
      if(Math.abs(support-floor)>.5||arenaBlocked(px,pz,support,MOVE.playerHeight))return false
    }
    y=floor
  }
  if(Math.abs(y-to.y)>=.15)return false
  // Only route smoothing pays for a bounded controller walk. Frequent local combat
  // and steering checks use the validated graph transitions above instead.
  return !validateController||traceArenaWalk(map,from,to,arenaCollision(map),DATA.bounds).ok
}

/** Patrol destinations sampled across rooms and floors by the nav build. */
const arenaPatrolPoints:readonly ArenaNavPoint[]=DATA.patrol.map(([x,y,z],i)=>({x,y,z,label:DATA.patrolLabels[i]}))

// A* scratch space is reused across calls: a generation stamp marks which entries are live.
let gCost:Float64Array|undefined,fScore:Float64Array|undefined,parent:Int32Array|undefined,stamp:Int32Array|undefined,closedStamp:Int32Array|undefined,generation=0
class Heap {
  private items:number[]=[]
  private readonly key:Float64Array
  constructor(key:Float64Array){this.key=key}
  get size(){return this.items.length}
  push(id:number){const a=this.items;a.push(id);let i=a.length-1;while(i>0){const p=(i-1)>>1;if(this.key[a[p]]<=this.key[a[i]])break;[a[p],a[i]]=[a[i],a[p]];i=p}}
  pop():number{const a=this.items,top=a[0],last=a.pop()!;if(a.length){a[0]=last;let i=0;for(;;){const l=2*i+1,r=l+1;let m=i;if(l<a.length&&this.key[a[l]]<this.key[a[m]])m=l;if(r<a.length&&this.key[a[r]]<this.key[a[m]])m=r;if(m===i)break;[a[m],a[i]]=[a[i],a[m]];i=m}}return top}
}

/** A* over the grid, then greedy smoothing with `arenaCanWalk`. Empty means unreachable. */
function arenaRoute(from:ArenaNavPoint,to:ArenaNavPoint):ArenaNavPoint[]{
  // A direct walk is worth testing only when it is plausibly short; long ones nearly always fail.
  if(Math.hypot(to.x-from.x,to.z-from.z)<14&&arenaCanWalk(from,to,true))return [{...to}]
  const {nodes}=graph(),count=nodes.length
  if(!gCost||gCost.length!==count){gCost=new Float64Array(count);fScore=new Float64Array(count);parent=new Int32Array(count);stamp=new Int32Array(count);closedStamp=new Int32Array(count)}
  const start=arenaNavNode(from),goal=arenaNavNode(to)
  if(start<0||goal<0)return []
  generation++
  const g=gCost,f=fScore!,prev=parent!,live=stamp!,closed=closedStamp!,gen=generation
  const heap=new Heap(f)
  live[start]=gen;g[start]=0;f[start]=distance(nodes[start],nodes[goal]);prev[start]=-1;heap.push(start)
  let found=start===goal
  while(heap.size&&!found){
    const current=heap.pop()
    if(closed[current]===gen)continue
    if(current===goal){found=true;break}
    closed[current]=gen
    const n=nodes[current]
    for(let bit=0;bit<8;bit++){
      if(!(n.links&(1<<bit)))continue
      const next=neighbour(current,bit);if(next<0||closed[next]===gen)continue
      const m=nodes[next],tentative=g[current]+distance(n,m)+(m.wall<.6?.6:0)
      if(live[next]!==gen||tentative<g[next]){
        live[next]=gen;g[next]=tentative;prev[next]=current;f[next]=tentative+distance(m,nodes[goal])
        heap.push(next)
      }
    }
  }
  if(!found)return []
  const chain:ArenaNavPoint[]=[]
  for(let id=goal;id>=0;id=prev[id]){const n=nodes[id];chain.unshift({x:n.x,y:n.y,z:n.z})}
  chain.push({...to})
  // Smooth: keep the farthest waypoint reachable in a straight walk from the current one,
  // halving the look-ahead on failure so long corridors cost a handful of walk tests.
  const result:ArenaNavPoint[]=[]
  let anchor:ArenaNavPoint=from
  for(let i=0;i<chain.length;){
    let far=i,reach=Math.min(chain.length-1-i,32)
    // Long straight walks are expensive to test and rarely pass: look no further than 10 m.
    while(reach>1&&Math.hypot(chain[i+reach].x-anchor.x,chain[i+reach].z-anchor.z)>10)reach--
    while(reach>0){if(arenaCanWalk(anchor,chain[i+reach],true)){far=i+reach;break}reach=reach>4?reach>>1:reach-1}
    result.push(chain[far]);anchor=chain[far];i=far+1
    if(far===chain.length-1)break
  }
  return result
}

return {patrol:arenaPatrolPoints,route:arenaRoute,canWalk:arenaCanWalk,floor:arenaFloor,sample:arenaNavigationSample}
}
