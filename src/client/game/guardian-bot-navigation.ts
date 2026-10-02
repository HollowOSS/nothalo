import {guardianRoute,guardianCanWalk,guardianPatrolPoints} from '../../shared/guardian-navigation.ts'
import {guardianFloor} from '../../shared/guardian.ts'

interface Navigation {patrol:readonly Point[];route:(a:Point,b:Point)=>Point[];canWalk:(a:Point,b:Point)=>boolean;floor:(x:number,z:number,y:number)=>number}
interface Point {x:number;y:number;z:number}
interface Peer extends Point {id:string;alive:boolean}
interface Journey {path:Point[];next:number;goal:Point|null;stuck:number;last:Point;plansIn:number;visits:Map<string,number>;serial:number;fightCheckAt:number;fightReachable:boolean;steerAt:number;steerX:number;steerZ:number}
/**
 * Plans off the rendering thread (the arenas' worker). Answers whether `aim` is a straight walk
 * away when `nearby`, and when `plan` is set a route to it or else to the first reachable of
 * `destinations`.
 */
export interface RoutePlanner {
  plan(from:Point,aim:Point|null,nearby:boolean,plan:boolean,destinations:Point[]):Promise<{reachable:boolean;path:Point[];goal:Point|null}>
}
/** Route planning is the expensive step; at most this many bots plan in one frame. */
const PLANS_PER_FRAME=1
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
const key=(p:Point)=>`${p.x},${p.y},${p.z}`
const seed=(id:string)=>[...id].reduce((n,c)=>((n*31+c.charCodeAt(0))>>>0),0)

/** Floor-aware path following and local separation; aim remains independent from movement. */
export class GuardianBotNavigator {
  private readonly navigation:Navigation
  private readonly planner:RoutePlanner|null
  private readonly pending=new Set<string>()
  constructor(navigation:Navigation={patrol:guardianPatrolPoints,route:guardianRoute,canWalk:guardianCanWalk,floor:guardianFloor},planner:RoutePlanner|null=null) {this.navigation=navigation;this.planner=planner}

  private journeys=new Map<string,Journey>()
  private planFrame=-1
  private plansThisFrame=0
  reset(id:string):void {this.journeys.delete(id);this.pending.delete(id)}
  /** Patrol points in the order this bot would try them. */
  private destinations(id:string,from:Point,j:Journey):Point[] {
    const offset=(seed(id)+j.serial++*7)%this.navigation.patrol.length
    return this.navigation.patrol.map((p,i)=>({p,score:
      (j.visits.get(key(p))??0)*35+
      [...this.journeys].filter(([other,s])=>other!==id&&s.goal&&distance(s.goal,p)<5).length*50+
      (Math.abs(from.y-p.y)<2?12:0)+distance(from,p)*.03+
      ((i-offset+this.navigation.patrol.length)%this.navigation.patrol.length)*.2
    })).filter(c=>distance(c.p,from)>5).sort((a,b)=>a.score-b.score).map(c=>c.p)
  }
  /** Hand planning to the worker; the bot keeps its current route until the answer lands. */
  private ask(id:string,j:Journey,from:Point,aim:Point|null,nearby:boolean,plan:boolean):void {
    this.pending.add(id)
    void this.planner!.plan({...from},aim?{...aim}:null,nearby,plan,plan?this.destinations(id,from,j):[]).then(result=>{
      this.pending.delete(id)
      if(this.journeys.get(id)!==j)return
      if(nearby)j.fightReachable=result.reachable
      if(plan&&!result.reachable){
        j.path=result.path;j.goal=result.goal;j.next=0;j.stuck=0;j.plansIn=.65
        if(result.goal)j.visits.set(key(result.goal),(j.visits.get(key(result.goal))??0)+1)
      }
    },()=>{this.pending.delete(id)})
  }
  private destination(id:string,from:Point,j:Journey):Point[] {
    const offset=(seed(id)+j.serial++*7)%this.navigation.patrol.length
    const candidates=this.navigation.patrol.map((p,i)=>({p,score:
      (j.visits.get(key(p))??0)*35+
      [...this.journeys].filter(([other,s])=>other!==id&&s.goal&&distance(s.goal,p)<5).length*50+
      (Math.abs(from.y-p.y)<2?12:0)+distance(from,p)*.03+
      ((i-offset+this.navigation.patrol.length)%this.navigation.patrol.length)*.2
    })).filter(c=>distance(c.p,from)>5).sort((a,b)=>a.score-b.score)
    for(const {p} of candidates){
      const route=this.navigation.route(from,p)
      if(route.length){j.goal=p;j.visits.set(key(p),(j.visits.get(key(p))??0)+1);return route}
    }
    j.goal=null;return []
  }
  /**
   * Returns a normalized world-space walking vector, not a teleport or a velocity override.
   * `objective` is somewhere to go when there is nobody to fight: a flag, the ball, a plate.
   */
  steer(id:string,from:Point,dt:number,peers:readonly Peer[],target:Point|null,time:number,objective:Point|null=null):{x:number;z:number} {
    let j=this.journeys.get(id)
    if(!j){j={path:[],next:0,goal:null,stuck:0,last:{...from},plansIn:0,visits:new Map(),serial:0,fightCheckAt:-Infinity,fightReachable:false,steerAt:-Infinity,steerX:0,steerZ:0};this.journeys.set(id,j)}
    // Floor queries walk the shared Guardian triangle BVH. A bot does not need to redo that
    // work at display rate: retain its validated local steering direction for 1/15 s, while
    // the movement integrator continues to advance every frame. This keeps a dozen bots from
    // turning collision queries into a CPU spike and is below the visible reaction interval.
    if(time<j.steerAt)return {x:j.steerX,z:j.steerZ}
    if(time!==this.planFrame){this.planFrame=time;this.plansThisFrame=0}
    // Steering is sampled at 15 Hz; timers must include the skipped simulation steps.
    const elapsed=Number.isFinite(j.steerAt)?Math.max(dt,time-(j.steerAt-1/15)):dt
    const moved=distance(from,j.last);j.last={...from};j.plansIn=Math.max(0,j.plansIn-elapsed)
    j.stuck=moved>elapsed*.3?0:j.stuck+elapsed
    if(j.stuck>1.3){j.fightReachable=false;j.fightCheckAt=time+.8}
    let dx=0,dz=0,probe=.8
    const range=target?Math.hypot(target.x-from.x,target.z-from.z):Infinity
    // Engage only on an actually connected local surface; seeing another floor is not a route.
    // The straight-walk test to a visible enemy is re-evaluated a few times a second, not every frame.
    const nearby=!!target&&Math.abs(target.y-from.y)<1&&range<25
    if(nearby){if(time-j.fightCheckAt>.3&&!this.pending.has(id)){
      j.fightCheckAt=time
      // With a worker, the answer (and any plan that turns out to be needed) arrives later.
      if(this.planner)this.ask(id,j,from,target,true,false)
      else j.fightReachable=this.navigation.canWalk(from,target!)
    }}else j.fightReachable=false
    const localFight=target&&j.fightReachable
    const seek=target?null:objective
    const seekRange=seek?Math.hypot(seek.x-from.x,seek.z-from.z):Infinity
    if(localFight){
      const approach=range>19?.65:range<8?-.45:0
      const side=Math.sin(time*.9+seed(id))*.28
      dx=(target.x-from.x)/Math.max(range,.1)*approach-(target.z-from.z)/Math.max(range,.1)*side
      dz=(target.z-from.z)/Math.max(range,.1)*approach+(target.x-from.x)/Math.max(range,.1)*side
    }else if(seek&&seekRange<2.5&&Math.abs(seek.y-from.y)<1.5){
      // Standing on it already: step the last metre rather than planning a route to here.
      if(seekRange>.3){dx=(seek.x-from.x)/seekRange;dz=(seek.z-from.z)/seekRange;probe=Math.min(.8,seekRange)}
      j.stuck=0
    }else{
      const aim=target??seek
      const exhausted=j.next>=j.path.length
      const targetMoved=aim&&(!j.goal||distance(aim,j.goal)>(target?5:3))
      if(this.planner){
        if(j.plansIn<=0&&(exhausted||j.stuck>1.3||targetMoved)&&!this.pending.has(id)&&this.plansThisFrame<PLANS_PER_FRAME){
          this.plansThisFrame++;j.plansIn=.65
          this.ask(id,j,from,aim,false,true)
        }
      }else if(j.plansIn<=0&&(exhausted||j.stuck>1.3||targetMoved)&&this.plansThisFrame<PLANS_PER_FRAME){
        this.plansThisFrame++
        const chase=aim?this.navigation.route(from,aim):[]
        if(chase.length){j.path=chase;j.goal={...aim!}}
        else j.path=this.destination(id,from,j)
        j.next=0;j.stuck=0;j.plansIn=.65
      }
      while(j.next<j.path.length&&distance(from,j.path[j.next])<.20)j.next++
      const next=j.path[j.next]
      if(next){const length=Math.hypot(next.x-from.x,next.z-from.z);probe=Math.min(.8,length);dx=(next.x-from.x)/Math.max(length,.001);dz=(next.z-from.z)/Math.max(length,.001)}
    }
    // Other floors must never repel each other. Keep shoulders apart on shared walkways.
    let sx=0,sz=0
    for(const p of peers){
      if(p.id===id||!p.alive||Math.abs(p.y-from.y)>1.3)continue
      const x=from.x-p.x,z=from.z-p.z,d=Math.hypot(x,z)
      if(d<2.2&&d>.001){const force=(2.2-d)/2.2;sx+=x/d*force;sz+=z/d*force}
    }
    const candidate=(x:number,z:number)=>{
      const length=Math.hypot(x,z),scale=length>1?1/length:1
      x*=scale;z*=scale
      const px=from.x+x*probe,pz=from.z+z*probe
      const y=this.navigation.floor(px,pz,from.y+.35)
      return this.navigation.canWalk(from,{x:px,y,z:pz})?{x,z}:null
    }
    // Separation may point off a narrow ramp: fall back to its validated route direction.
    let result=candidate(dx+sx*.7,dz+sz*.7)??candidate(dx,dz)
    // A blocked strafe or shoulder separation must not pin a bot against a wall.
    // Try a short, floor-validated tangent; the controller still owns all motion.
    if(!result && Math.hypot(dx,dz)>.01){
      for(const angle of [.6,-.6,1.2,-1.2,1.8,-1.8,Math.PI]){
        result=candidate(dx*Math.cos(angle)-dz*Math.sin(angle),dx*Math.sin(angle)+dz*Math.cos(angle))
        if(result)break
      }
    }
    result??={x:0,z:0}
    j.steerX=result.x;j.steerZ=result.z;j.steerAt=time+1/15
    return result
  }
  debug(id:string):Readonly<Journey>|undefined{return this.journeys.get(id)}
}
