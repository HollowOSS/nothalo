import { MedalAnnouncer } from './medal-announcer.ts'
import { HIT_BEHIND, HIT_BULLTRUE, HIT_HEADSHOT, HIT_KILLJOY, HIT_MELEE } from '../../shared/protocol.ts'
import { CAUSE_SPLATTER, CAUSE_STICK, KILL_HOLDING_BALL, KILL_HOLDING_FLAG, KILL_VICTIM_BOMB, KILL_VICTIM_FLAG, type KillInfo } from '../../shared/kill-info.ts'
import { LOADOUT } from '../../shared/loadout.ts'

/** `info` says how it was done (kill-info.ts); `wipedOut` that it left no opponent standing. */
export interface KillRecord { time: number; victimId: string; victimTeam: string; killId?: string; info?: KillInfo; wipedOut?: boolean }
/** multi: kills inside four seconds. spree: kills without dying. weapon: a weapon or vehicle spree.
 * style: how the kill was made. objective: the flag, the bomb, the ball. game: the match as a whole. */
export type MedalCategory = 'multi' | 'spree' | 'weapon' | 'style' | 'objective' | 'game'
export interface MedalAward {
  id: string; label: string; category: MedalCategory; count: number; time: number
  /** The announcer recording (medal-announcer.ts), or null: Halo 3 left these medals unvoiced. */
  voice: string | null
  detail: string
}

interface Medal { id: string; label: string; voice: string | null; detail: string }
const medal = (id: string, label: string, detail: string, voice: string | null = id): Medal => ({ id, label, voice, detail })

// Halo 3's ladders. A multikill chains kills no more than four seconds apart.
const MULTI: Readonly<Record<number, Medal>> = {
  2: medal('double-kill', 'Double Kill', '2 kills · 4 second chain'),
  3: medal('triple-kill', 'Triple Kill', '3 kills · 4 second chain'),
  4: medal('overkill', 'Overkill', '4 kills · 4 second chain'),
  5: medal('killtacular', 'Killtacular', '5 kills · 4 second chain'),
  6: medal('killtrocity', 'Killtrocity', '6 kills · 4 second chain'),
  7: medal('killimanjaro', 'Killimanjaro', '7 kills · 4 second chain'),
  8: medal('killtastrophe', 'Killtastrophe', '8 kills · 4 second chain'),
  9: medal('killpocalypse', 'Killpocalypse', '9 kills · 4 second chain'),
  10: medal('killionaire', 'Killionaire', '10 kills · 4 second chain'),
}
const SPREES: Readonly<Record<number, Medal>> = {
  5: medal('killing-spree', 'Killing Spree', '5 kills without dying'),
  10: medal('killing-frenzy', 'Killing Frenzy', '10 kills without dying'),
  15: medal('running-riot', 'Running Riot', '15 kills without dying'),
  20: medal('rampage', 'Rampage', '20 kills without dying'),
  25: medal('untouchable', 'Untouchable', '25 kills without dying'),
  30: medal('invincible', 'Invincible', '30 kills without dying'),
}
const slot = (model: string) => LOADOUT.findIndex(s => s.model === model)
/** Weapon and vehicle sprees: five, then ten, kills of one kind without dying. */
const WEAPON_SPREES: readonly { family: string; matches: (cause: number) => boolean; five: Medal; ten: Medal }[] = [
  { family: 'sniper', matches: c => c === slot('sniper'),
    five: medal('sniper-spree', 'Sniper Spree', '5 sniper kills without dying'), ten: medal('sharpshooter', 'Sharpshooter', '10 sniper kills without dying') },
  { family: 'shotgun', matches: c => c === slot('shotgun'),
    five: medal('shotgun-spree', 'Shotgun Spree', '5 shotgun kills without dying'), ten: medal('open-season', 'Open Season', '10 shotgun kills without dying') },
  { family: 'sword', matches: c => c === slot('energy-sword'),
    five: medal('sword-spree', 'Sword Spree', '5 sword kills without dying'), ten: medal('slice-n-dice', "Slice 'N Dice", '10 sword kills without dying') },
  { family: 'splatter', matches: c => c === CAUSE_SPLATTER,
    five: medal('splatter-spree', 'Splatter Spree', '5 splatters without dying'), ten: medal('vehicular-manslaughter', 'Vehicular Manslaughter', '10 splatters without dying') },
]
const STYLE = {
  headshot: medal('headshot', 'Headshot', 'Kill with a shot to the head', null),
  splatter: medal('splatter', 'Splatter', 'Run down an enemy with a vehicle', null),
  beatDown: medal('beat-down', 'Beat Down', 'Melee kill', null),
  assassin: medal('assassin', 'Assassin', 'Melee kill from behind'),
  stick: medal('grenade-stick', 'Grenade Stick', 'Kill with a stuck plasma grenade', null),
  killjoy: medal('killjoy', 'Killjoy', "End an enemy's killing spree"),
  bulltrue: medal('bulltrue', 'Bulltrue', 'Kill an enemy mid sword lunge'),
}
const OBJECTIVE = {
  flagCarrier: medal('killed-flag-carrier', 'Killed Flag Carrier', 'Kill the enemy carrying your flag', 'carrier-kill'),
  bombCarrier: medal('killed-bomb-carrier', 'Killed Bomb Carrier', 'Kill the enemy carrying the bomb', 'carrier-kill'),
  flagKill: medal('flag-kill', 'Flag Kill', 'Melee kill with the flag'),
  oddballKill: medal('oddball-kill', 'Oddball Kill', 'Melee kill with the ball'),
  flagScore: medal('flag-score', 'Flag Score', 'Capture the enemy flag'),
  bombPlanted: medal('bomb-planted', 'Bomb Planted', 'Detonate the bomb in their base'),
}
const GAME = {
  extermination: medal('extermination', 'Extermination', 'Wipe out the enemy team with an Overkill or better'),
  perfection: medal('perfection', 'Perfection', 'Win a Slayer game with 15 kills and no deaths'),
}

const award = (m: Medal, category: MedalCategory, count: number, time: number): MedalAward =>
  ({ id: m.id, label: m.label, category, count, time, voice: m.voice, detail: m.detail })

/** Pure medal rules; the caller supplies monotonic seconds and confirmed local kills. */
export class MedalTracker {
  private lastKill=-Infinity
  private multikill=0
  private streak=0
  private readonly weaponStreaks=new Map<string,number>()
  private readonly recent=new Map<string,number>()
  private readonly playerId: string
  private readonly team: string
  constructor(playerId: string, team: string) {this.playerId=playerId;this.team=team}
  get currentStreak(): number {return this.streak}
  get currentMultikill(): number {return this.multikill}
  recordKill(event: KillRecord): MedalAward[] {
    const {time,victimId,victimTeam}=event
    if(!Number.isFinite(time)||time<0||time<this.lastKill||!victimId||victimId===this.playerId||victimTeam===this.team)return[]
    const key=event.killId ? `event:${event.killId}` : `victim:${victimId}`
    const previous=this.recent.get(key)
    if(previous!==undefined&&(event.killId || time-previous<.35))return[]
    this.recent.set(key,time)
    while(this.recent.size>64)this.recent.delete(this.recent.keys().next().value!)
    this.multikill=time-this.lastKill<=4?this.multikill+1:1
    this.lastKill=time;this.streak++
    const result: MedalAward[]=[]
    const info=event.info, flags=info?.flags??0, context=info?.context??0, cause=info?.cause??255
    // How it was done.
    if(flags&HIT_HEADSHOT)result.push(award(STYLE.headshot,'style',1,time))
    if(cause===CAUSE_SPLATTER)result.push(award(STYLE.splatter,'style',1,time))
    if(cause===CAUSE_STICK)result.push(award(STYLE.stick,'style',1,time))
    if(flags&HIT_MELEE)result.push(award(flags&HIT_BEHIND?STYLE.assassin:STYLE.beatDown,'style',1,time))
    if(flags&HIT_BULLTRUE)result.push(award(STYLE.bulltrue,'style',1,time))
    if(flags&HIT_KILLJOY)result.push(award(STYLE.killjoy,'style',1,time))
    // Who it was, and what you were holding.
    if(context&KILL_VICTIM_FLAG)result.push(award(OBJECTIVE.flagCarrier,'objective',1,time))
    if(context&KILL_VICTIM_BOMB)result.push(award(OBJECTIVE.bombCarrier,'objective',1,time))
    if(flags&HIT_MELEE&&context&KILL_HOLDING_FLAG)result.push(award(OBJECTIVE.flagKill,'objective',1,time))
    if(flags&HIT_MELEE&&context&KILL_HOLDING_BALL)result.push(award(OBJECTIVE.oddballKill,'objective',1,time))
    // Ladders.
    const multi=MULTI[this.multikill]
    if(multi)result.push(award(multi,'multi',this.multikill,time))
    if(this.multikill>=4&&event.wipedOut)result.push(award(GAME.extermination,'game',this.multikill,time))
    const spree=SPREES[this.streak]
    if(spree)result.push(award(spree,'spree',this.streak,time))
    for(const s of WEAPON_SPREES){
      if(!s.matches(cause))continue
      const count=(this.weaponStreaks.get(s.family)??0)+1
      this.weaponStreaks.set(s.family,count)
      if(count===5)result.push(award(s.five,'weapon',count,time))
      if(count===10)result.push(award(s.ten,'weapon',count,time))
    }
    return result
  }
  /** Your own flag capture or bomb detonation. */
  recordObjective(kind: 'flag-score' | 'bomb-planted', time: number): MedalAward[] {
    if(!Number.isFinite(time))return[]
    return [award(kind==='flag-score'?OBJECTIVE.flagScore:OBJECTIVE.bombPlanted,'objective',1,time)]
  }
  /** At the end of a Slayer game you won: Perfection for 15 or more kills without a death. */
  recordGameWon(kills: number, deaths: number, time: number): MedalAward[] {
    return Number.isFinite(time)&&kills>=15&&deaths===0?[award(GAME.perfection,'game',kills,time)]:[]
  }
  resetOnDeath():void{this.lastKill=-Infinity;this.multikill=0;this.streak=0;this.weaponStreaks.clear()}
}

const GOLD: ReadonlySet<MedalCategory> = new Set(['spree', 'game'])
/** Centre glyphs in the 72 x 80 frame, drawn in the medal's light colour; `face` cuts details out of them. */
const GLYPHS: Readonly<Record<string, (light: string, face: string) => string>> = {
  headshot: l => `<circle cx="36" cy="32" r="13" fill="none" stroke="${l}" stroke-width="2.5"/><path d="M36 14V24M36 40V50M18 32H28M44 32H54" stroke="${l}" stroke-width="2.5"/><circle cx="36" cy="32" r="3" fill="${l}"/>`,
  splatter: l => `<circle cx="36" cy="33" r="14" fill="none" stroke="${l}" stroke-width="4" stroke-dasharray="4 3"/><circle cx="36" cy="33" r="5" fill="${l}"/>`,
  'beat-down': (l, f) => `<path d="M24 26H46A4 4 0 0 1 50 30V40A8 8 0 0 1 42 48H30A6 6 0 0 1 24 42Z" fill="${l}"/><path d="M30 26V34M36 26V34M42 26V34" stroke="${f}" stroke-width="1.6"/>`,
  assassin: l => `<path d="M36 13L41 38H31Z" fill="${l}"/><path d="M27 38H45V41H27ZM34 41H38V50H34Z" fill="${l}"/>`,
  'grenade-stick': (l, f) => `<circle cx="36" cy="34" r="12" fill="${l}"/><path d="M27 28C31 25 41 25 45 28" stroke="${f}" stroke-width="1.6" fill="none"/><path d="M36 22V15M30 17L33 22M42 17L39 22" stroke="${l}" stroke-width="2"/>`,
  killjoy: (l, f) => `<path d="M35 15C40 27 27 28 35 38C32 23 48 21 43 10C58 25 58 42 47 47C44 50 40 51 36 51C20 49 16 36 25 27C23 37 31 38 29 33C25 27 35 23 35 15Z" fill="${l}"/><path d="M22 20L50 48" stroke="${f}" stroke-width="4"/>`,
  bulltrue: l => `<path d="M22 46L46 18M50 46L26 18" stroke="${l}" stroke-width="4" stroke-linecap="round"/>`,
  'sniper': l => `<circle cx="36" cy="32" r="15" fill="none" stroke="${l}" stroke-width="2"/><path d="M36 13V51M17 32H55" stroke="${l}" stroke-width="1.5"/>`,
  'shotgun': (l, f) => `<rect x="29" y="17" width="14" height="22" rx="2" fill="${l}"/><rect x="27" y="39" width="18" height="8" fill="${l}"/><path d="M29 39H43" stroke="${f}" stroke-width="1.6"/>`,
  'sword': l => `<path d="M30 50C28 36 31 22 38 13C36 24 36 36 40 50Z" fill="${l}"/><path d="M42 50C44 36 41 22 34 13C36 24 36 36 32 50Z" fill="${l}" opacity=".7"/>`,
  'flag': l => `<path d="M26 14V52" stroke="${l}" stroke-width="3"/><path d="M28 15H50L44 23L50 31H28Z" fill="${l}"/>`,
  'bomb': (l, f) => `<circle cx="36" cy="35" r="13" fill="${l}"/><path d="M36 22V15H43" stroke="${l}" stroke-width="2.5" fill="none"/><path d="M30 35H42" stroke="${f}" stroke-width="2"/>`,
  'ball': (l, f) => `<circle cx="36" cy="33" r="14" fill="${l}"/><circle cx="31" cy="30" r="2.6" fill="${f}"/><circle cx="41" cy="30" r="2.6" fill="${f}"/><path d="M30 39H42" stroke="${f}" stroke-width="2"/>`,
  perfection: l => `<path d="M36 13L41.5 27H56L44.5 36L49 50L36 41.5L23 50L27.5 36L16 27H30.5Z" fill="${l}"/>`,
}
const GLYPH_FOR: Readonly<Record<string, string>> = {
  'sniper-spree': 'sniper', sharpshooter: 'sniper', 'shotgun-spree': 'shotgun', 'open-season': 'shotgun',
  'sword-spree': 'sword', 'slice-n-dice': 'sword', 'splatter-spree': 'splatter', 'vehicular-manslaughter': 'splatter',
  'killed-flag-carrier': 'flag', 'flag-kill': 'flag', 'flag-score': 'flag',
  'killed-bomb-carrier': 'bomb', 'bomb-planted': 'bomb', 'oddball-kill': 'ball',
}

function medalSvg(medal: MedalAward): string {
  const gold=GOLD.has(medal.category)||medal.count>=4&&medal.category==='multi'||medal.category==='weapon'&&medal.count>=10
  const light=gold?'#ffe6a5':'#c3e7ff',edge=gold?'#b18a48':'#528ab0',face=gold?'#5c4527':'#23465f'
  const skull=(x:number,y:number,s:number)=>`<g transform="translate(${x} ${y}) scale(${s})"><path d="M-10 2V-3C-10-15 10-15 10-3V2L6 6V12H-6V6Z" fill="${light}"/><path d="M-7-2L-2 0-3 4-7 3ZM7-2L2 0 3 4 7 3ZM0 2-2 6H2Z" fill="${face}"/><path d="M-3 8V12M1 8V12" stroke="${face}" stroke-width="1.4"/></g>`
  const glyph=GLYPHS[GLYPH_FOR[medal.id]??medal.id]
  const center=glyph?glyph(light,face)
    : medal.category==='spree'
    ? `<path d="M35 17C40 29 27 30 35 40C32 25 48 23 43 12C58 27 58 44 47 49C59 28 45 25 47 35C48 43 43 51 36 53C20 51 16 38 25 29C23 39 31 40 29 35C25 29 35 25 35 17Z" fill="${light}"/>`
    : medal.id==='extermination'?skull(22,30,.6)+skull(36,30,.6)+skull(50,30,.6)+skull(29,44,.6)+skull(43,44,.6)
    : medal.count===2?skull(27,34,.78)+skull(45,34,.78):medal.count===3?skull(23,36,.62)+skull(49,36,.62)+skull(36,28,.76):`<path d="M9 30L22 34V40L10 38ZM63 30L50 34V40L62 38ZM14 41L23 43V48L17 46ZM58 41L49 43V48L55 46Z" fill="${edge}"/>`+skull(36,34,1.1)
  // A number plate only where a count means something: the ladders and the sprees.
  const plate=['multi','spree','weapon'].includes(medal.category)
    ?`<path d="M27 58H45V71H27Z" fill="#15232e" stroke="${edge}"/><text x="36" y="68" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="800" fill="${light}">${medal.count}</text>`:''
  return `<svg viewBox="0 0 72 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M20 44L15 76 30 69 36 76 42 69 57 76 52 44" fill="#22455d" stroke="${edge}" stroke-width="2"/><path d="M36 3L62 17 65 45 49 62H23L7 45 10 17Z" fill="#101e2a" stroke="${light}" stroke-width="2"/><path d="M36 9L57 21 59 43 46 56H26L13 43 15 21Z" fill="${face}" stroke="${edge}" stroke-width="2"/>${center}${plate}</svg>`
}

const STYLE_SHEET=`
.combat-medals{position:fixed;top:30%;left:5%;width:min(285px,40vw);pointer-events:none;z-index:4;font-family:ui-sans-serif,system-ui,sans-serif;color:#c3e7ff}
.combat-medal{display:flex;align-items:center;gap:12px;margin:0 0 6px;padding:5px 13px 5px 0;background:linear-gradient(90deg,rgba(7,20,33,.55),rgba(7,20,33,0));animation:combat-medal-in .18s ease-out;filter:drop-shadow(0 1px 3px #00101e)}
.combat-medal svg{width:52px;height:58px;flex:none;overflow:visible}.combat-medal strong{display:block;font-size:16px;letter-spacing:.055em;line-height:1.2;text-transform:uppercase;font-weight:650}.combat-medal small{display:block;margin-top:4px;font-size:11px;letter-spacing:.06em;opacity:.72}
.combat-medal[data-category=spree],.combat-medal[data-category=game]{color:#ffe6a5}.combat-medals-status{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@keyframes combat-medal-in{from{opacity:0;transform:translateX(-7px) scale(.96)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.combat-medal{animation:none;transition:none}}
@media(max-width:700px){.combat-medals{left:3%;width:44vw;top:28%}.combat-medal{gap:7px}.combat-medal svg{width:40px;height:46px}.combat-medal strong{font-size:12px}.combat-medal small{font-size:9px}}
`
/** At most this many rows on screen: the sight line and the radar stay clear. */
const MAX_ROWS = 4
export interface CombatMedalsOptions { playerId: string; team: string; getMuted: ()=>boolean; isAlive?: ()=>boolean; voice?: MedalAnnouncer }
/** Compact original SVG medals plus an independently bounded, mute-aware announcer. */
export class CombatMedals {
  readonly tracker: MedalTracker
  readonly element: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly voice: MedalAnnouncer
  private readonly style: HTMLStyleElement
  private readonly visible: {award:MedalAward;row:HTMLDivElement}[]=[]
  private readonly options: CombatMedalsOptions
  /** A medal earned at the final whistle keeps the HUD and the voice up this long. */
  private holdUntil=-Infinity
  constructor(parent: HTMLElement, options: CombatMedalsOptions) {
    this.options=options
    this.tracker=new MedalTracker(options.playerId,options.team)
    this.voice=options.voice ?? new MedalAnnouncer(options.getMuted)
    this.style=document.createElement('style');this.style.textContent=STYLE_SHEET
    this.element=document.createElement('div');this.element.className='combat-medals';this.element.setAttribute('aria-hidden','true')
    this.status=document.createElement('div');this.status.className='combat-medals-status';this.status.setAttribute('role','status');this.status.setAttribute('aria-live','polite');this.status.setAttribute('aria-atomic','true')
    parent.append(this.style,this.element,this.status)
  }
  recordKill(event: KillRecord): readonly MedalAward[] {
    if(this.options.isAlive&&!this.options.isAlive())return[]
    return this.show(this.tracker.recordKill(event))
  }
  recordObjective(kind: 'flag-score' | 'bomb-planted', time: number): readonly MedalAward[] {
    return this.show(this.tracker.recordObjective(kind,time))
  }
  recordGameWon(kills: number, deaths: number, time: number): readonly MedalAward[] {
    const awards=this.show(this.tracker.recordGameWon(kills,deaths,time))
    if(awards.length)this.holdUntil=time+4
    return awards
  }
  private show(awards: readonly MedalAward[]): readonly MedalAward[] {
    for(const medal of awards){
      // Each family shows its newest award; one kill can still earn several families at once.
      for(let i=this.visible.length-1;i>=0;i--){
        const shown=this.visible[i].award
        if(shown.category===medal.category&&(shown.time!==medal.time||shown.category==='multi'||shown.category==='spree')){this.visible[i].row.remove();this.visible.splice(i,1)}
      }
      while(this.visible.length>=MAX_ROWS){this.visible[0].row.remove();this.visible.shift()}
      const row=document.createElement('div');row.className='combat-medal';row.dataset.category=medal.category
      row.innerHTML=medalSvg(medal)
      const text=document.createElement('div'),label=document.createElement('strong'),detail=document.createElement('small')
      label.textContent=medal.label;detail.textContent=medal.detail
      text.append(label,detail);row.append(text);this.element.append(row);this.visible.push({award:medal,row})
      if(medal.voice)this.voice.enqueue({id:medal.voice,label:medal.label,category:medal.category,time:medal.time})
    }
    if(awards.length)this.status.textContent=awards.map(m=>m.label).join('. ')
    return awards
  }
  update(time: number, muted=this.options.getMuted(), active=true):void {
    if(!Number.isFinite(time))return
    active||=time<this.holdUntil
    this.element.hidden=!active
    for(let i=this.visible.length-1;i>=0;i--)if(time-this.visible[i].award.time>4){this.visible[i].row.remove();this.visible.splice(i,1)}
    if(!this.visible.length)this.status.textContent=''
    this.voice.update(time,muted,active)
  }
  resetOnDeath():void {
    this.tracker.resetOnDeath();this.voice.clear();this.visible.length=0;this.element.replaceChildren();this.status.textContent=''
  }
  dispose():void{this.voice.dispose();this.element.remove();this.status.remove();this.style.remove()}
}
