import { MAP_NAMES, type MapId } from '../../shared/maps.ts'
import { OBJECTIVE_HUD_CSS, createObjectiveHud } from './objective-hud.ts'
import * as THREE from 'three'
import { VITALS } from '../../shared/constants.ts'
import { RETICLE_CSS, setReticle } from './reticles.ts'
import { CombatMedals } from './combat-medals.ts'
import { createNameplates, NAMEPLATE_CSS } from './nameplates.ts'
import { BATTLE_RIFLE_SCOPE_CSS, BATTLE_RIFLE_SCOPE_HTML } from './battle-rifle-scope.ts'
import type { Match } from '../game/match.ts'
import type { TouchControls } from '../game/touch.ts'
import type { MedalAnnouncer } from './medal-announcer.ts'

/**
 * The visor: shield bar, health, ammo, reticle.
 *
 * DOM rather than in-scene geometry — it costs no draw calls, stays crisp at any resolution,
 * and CE's HUD is flat anyway.
 */
/**
 * What follows a finished game. `match`: a matchmade game — after the results, search again, which rolls the
 * next map, and everyone from this game searching at the same moment lands together. `map`: a bot match —
 * on to a different map. `stay`: a custom game, which restarts where it is.
 */
export type AfterMatch = 'match' | 'map' | 'stay'
/** Seconds of results before moving on; always inside the server's ten-second restart. */
const POSTGAME_S = 8

export function createHud(match: Match, isLocked: () => boolean, touch?: TouchControls, playerName = '', voice?: MedalAnnouncer, after: AfterMatch = 'stay'): () => void {
  const hideOverlay = new URLSearchParams(location.search).has('nooverlay')
  const root = document.createElement('div')
  root.innerHTML = `
    <style>
      .hud { position: fixed; inset: 0; pointer-events: none; font-family: ui-sans-serif, system-ui, sans-serif; color: #86c6ff; }
      ${RETICLE_CSS}
      /* Floating words over the world like Halo's pickup prompt, no panel behind them; the shadow keeps them legible. */
      .hud .pickup-prompt {position:absolute;top:59%;left:50%;transform:translateX(-50%);width:max-content;max-width:70vw;color:#e0f2ff;text-align:center;
        text-shadow:0 0 3px #000,0 1px 2px #000,0 0 8px #000a;font-size:14px;letter-spacing:.02em;}
      .hud .pickup-prompt[hidden],.hud .pickup-prompt button[hidden] {display:none;}
      .hud .pickup-prompt strong {display:block;margin-bottom:5px;font-size:14px;}
      .hud .pickup-actions {display:flex;justify-content:center;gap:18px;}
      .hud .pickup-prompt button {border:0;background:none;color:inherit;font:inherit;padding:2px;text-shadow:inherit;}
      .hud .pickup-prompt kbd {display:inline-grid;place-items:center;min-width:22px;height:22px;margin-right:5px;border:1.5px solid #c4e8ff;border-radius:4px;
        background:#0a1c2a99;font:700 13px ui-monospace,monospace;box-shadow:0 1px 3px #000;}
      .hud .pickup-prompt small {display:block;margin-top:5px;color:#b4d4e8;font-size:11px;}
      /* Phones get no prompt: the pickup buttons pop up on the pad instead (touch.ts). */
      .hud.touch .pickup-prompt {display:none;}

      .hud .shield { position: absolute; right: 5%; top: 5%; width: min(260px, 32vw); }
      .hud .shield .track { height: 9px; border: 1px solid #3f8f7d; background: rgba(8,26,24,.55); }
      .hud .shield .fill { height: 100%; background: linear-gradient(90deg,#557ed5,#a5d7ff); transition: width .08s linear; filter: brightness(1); }
      .hud .shield.charging .track { animation: shield-charge 1.1s ease-in-out infinite; }
      @keyframes shield-charge { 0%, 100% { box-shadow: none; } 50% { box-shadow: 0 0 9px 1px rgba(165,215,255,.6); } }
      .hud .health { display: flex; gap: 3px; margin-top: 5px; justify-content: flex-end; }
      .hud .health i { width: 26px; height: 5px; background: #2c8f7c; }
      .hud .health i.off { background: rgba(50,80,76,.4); }
      .hud .ammo { position: absolute; left: 5%; top: 5%; text-align: left; font-variant-numeric: tabular-nums; }
      .hud .ammo b { font-size: 40px; font-weight: 600; letter-spacing: .02em; display: block; line-height: 1; }
      .hud .ammo small {display:block;font-size:11px;letter-spacing:.08em;margin-top:7px;opacity:.8;}
      .hud.touch .ammo {max-width:28vw;}
      .hud.touch .ammo b {font-size:clamp(22px,3.4vw,32px);white-space:nowrap;}
      .hud.touch .ammo small {max-width:28vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .hud .ammo span { font-size: 13px; opacity: .65; }
      .hud .prompt { position: absolute; inset: 0; display: grid; place-content: center; background: rgba(4,10,18,.72); pointer-events: none; }
      .hud .prompt p { font-size: 15px; letter-spacing: .04em; text-align: center; line-height: 1.9; }
      .hud .prompt b { display: block; font-size: 22px; margin-bottom: 10px; }
      .hud .prompt kbd { border: 1px solid #3f8f7d; padding: 1px 6px; margin: 0 2px; font-family: ui-monospace, monospace; font-size: 12px; }
      .hud .feed { position: absolute; right: 5%; top: 16%; text-align: right; font-size: 13px; opacity: .9; }
      .hud .feed div { margin-bottom: 3px; }
      .hud .hit { position: absolute; left: 50%; top: 50%; width: 40px; height: 40px; margin: -20px 0 0 -20px; opacity: 0; }
      .hud .hit span { position: absolute; width: 10px; height: 2px; background: #ff6a4d; }
      .hud .scope.target-ready .aim-mark {stroke:#ff5048;}
      .hud .radar { position: absolute; left: 5%; bottom: 6%; width: 140px; height: 140px; border-radius: 50%; border: 2px solid #6ca6e0; background: repeating-radial-gradient(circle, transparent 0 22px, #6ba7d72b 23px 24px), radial-gradient(circle, #406fa066, #0c224699); overflow: hidden; }
      /* Touch HUD mirrors COD:Mobile: a compact UAV sits top-right while the vital bar is a
         small, centered strip along the bottom. Desktop keeps the larger CE-style radar/bar. */
      .hud.touch .radar { left: auto; right: calc(env(safe-area-inset-right, 0px) + 64px); top: calc(env(safe-area-inset-top, 0px) + 3vh); bottom: auto;
        width: min(96px, 20vh); height: min(96px, 20vh); border-width: 1px; opacity: .86; }
      .hud.touch .radar:before, .hud.touch .radar:after { opacity: .7; }
      .hud.touch .radar i { width: 4px; height: 4px; margin: -2px; }
      .hud.touch .radar .self { width: 5px; height: 5px; }
      .hud.touch .shield { left: 50%; right: auto; top: auto; bottom: calc(env(safe-area-inset-bottom, 0px) + 3vh);
        transform: translateX(-50%); width: min(190px, 32vw); }
      .hud.touch .shield .track { height: 5px; }
      .hud.touch .health { gap: 2px; margin-top: 3px; justify-content: center; }
      .hud.touch .health i { width: 12px; height: 3px; }
      .hud .radar:before { content: ''; position: absolute; width: 1px; height: 100%; left: 50%; background: #72acf344; }
      .hud .radar:after { content: ''; position: absolute; height: 1px; width: 100%; top: 50%; background: #72acf344; }
      .hud .radar i { position: absolute; width: 6px; height: 6px; margin: -3px; border-radius: 50%; background: #ffd36b; }
      .hud .radar .self { left: 50%; top: 50%; background: #f2df81; width: 7px; height: 7px; }
      .hud .scope { position: absolute; inset: 0; display: none; animation: scope-in .08s ease-out; }
      .hud .scope svg { width:100%; height:100%; }
      ${BATTLE_RIFLE_SCOPE_CSS}
      @keyframes scope-in { from { opacity:0; transform:scale(1.025); } to { opacity:1; transform:scale(1); } }
      .hud .scope-readout { position:absolute;left:52%;top:78%;font:italic 14px monospace;color:#55baff; }
      .hud.br-scoped .reticle { display:none; }
      .hud .drive-reticle { position:absolute; left:50%; top:50%; width:min(12vh,6.8vw); height:min(12vh,6.8vw); transform:translate(-50%,-50%);
        display:none; color:#62b4f4; filter:drop-shadow(0 0 1px #06243c); pointer-events:none; }
      .hud .drive-reticle svg { display:block; width:100%; height:100%; overflow:visible; }
      .hud.scoped .zoom { left:66%;top:69%;font-size:22px; }
      .hud .zoom { position: absolute; left: 53%; top: 54%; font-size: 13px; }
      .hud .score-strip { position: absolute; left: 50%; top: 2.5%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
        min-width: 136px; justify-content: center; padding: 4px 12px; border: 1px solid #6fb6ff55; border-radius: 999px;
        background: rgba(4,16,27,.58); font: 600 12px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .08em; text-shadow: 0 1px 2px #000; }
      .hud .score-strip .blue { color: #9fd4ff; }
      .hud .score-strip .red { color: #ffaaa0; }
      .hud .score-strip b { font-size: 16px; margin-left: 3px; }
      .hud .score-strip .dash { color: #86c6ff77; font-weight: 400; }
      /* Which side is yours: a lit dot in that team's own colour, plus heavier text. Both
         cues are on the team you are on rather than dimming the other, so the enemy score
         stays just as readable at a glance. */
      .hud .score-strip .mine { font-weight: 800; }
      .hud .score-strip .mine::before { content: ''; display: inline-block; width: 5px; height: 5px; margin-right: 5px;
        border-radius: 50%; vertical-align: middle; background: currentColor; box-shadow: 0 0 6px currentColor; }
      .hud .scoreboard { position: absolute; left: 50%; top: 12%; transform: translateX(-50%); display: none; width: min(650px, 82vw);
        padding: 16px 18px 12px; border: 1px solid #6fb6ff88; border-radius: 10px; background: rgba(4,12,22,.92);
        box-shadow: 0 12px 50px #0009; color: #d8efff; }
      .hud .scoreboard.open { display: block; }
      .hud .postgame { position: absolute; left: 50%; bottom: 12%; transform: translateX(-50%); display: none; text-align: center; pointer-events: auto;
        width: min(420px, 88vw); padding: 14px 18px 16px; background: rgba(4,12,22,.82); border: 1px solid #6fb6ff44; border-radius: 6px; }
      .hud .postgame.open { display: block; }
      .hud .postgame-verdict { font-size: 22px; font-weight: 700; letter-spacing: .2em; color: #d8f2ff; }
      .hud .postgame-next { margin: 4px 0 12px; font-size: 13px; color: #9fcbe8; }
      .hud .postgame-actions { display: flex; gap: 8px; justify-content: center; }
      .hud .postgame button { font: inherit; font-weight: 600; cursor: pointer; padding: 10px 16px; border-radius: 5px; border: 0; background: #bfeee0; color: #102824; }
      .hud .postgame button.secondary { background: rgba(12,34,50,.9); color: #bfe4ff; border: 1px solid #3f8f7d; }
      .hud .scoreboard h2 { margin: 0 0 10px; text-align: center; font-size: 13px; font-weight: 600; letter-spacing: .18em; }
      .hud .scoreboard-head, .hud .score-row { display: grid; grid-template-columns: 70px 1fr 58px 58px; gap: 10px; align-items: center; }
      .hud .scoreboard-head { padding: 0 10px 5px; border-bottom: 1px solid #6fb6ff44; color: #86c6ff99; font-size: 10px; letter-spacing: .12em; }
      .hud .scoreboard-head span:nth-last-child(-n+2), .hud .score-row span:nth-last-child(-n+2) { text-align: right; }
      .hud .score-row { padding: 7px 10px; border-bottom: 1px solid #6fb6ff18; font-size: 13px; }
      .hud .score-row:last-child { border-bottom: 0; }
      .hud .score-row .team { font-size: 10px; font-weight: 700; letter-spacing: .1em; }
      .hud .score-row .team.blue { color: #9fd4ff; }
      .hud .score-row .team.red { color: #ffaaa0; }
      .hud .score-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hud .scoreboard-hint { margin-top: 9px; text-align: center; color: #86c6ff88; font-size: 10px; letter-spacing: .08em; }
      .hud.touch .score-strip { top: 2%; }
      .hud.touch .scoreboard { top: 10%; width: min(600px, 88vw); }
      .hud .prompt input { pointer-events: auto; font: inherit; font-size: 15px; text-align: center; width: 190px;
        padding: 9px 10px; margin-bottom: 12px; color: #d8f2ff; background: rgba(8,26,36,.85);
        border: 1px solid #3f8f7d; border-radius: 4px; }
      .hud .prompt input:focus { outline: none; border-color: #7fd8ff; }
      ${NAMEPLATE_CSS}
      ${OBJECTIVE_HUD_CSS}
    </style>
    <div class="hud">
      <div class="scope" id="scope"><svg viewBox="0 0 1000 600" preserveAspectRatio="none">
        <path fill="#020609d9" fill-rule="evenodd" d="M0 0H1000V600H0Z M220 150H780Q805 150 805 175V425Q805 450 780 450H220Q195 450 195 425V175Q195 150 220 150Z"/>
        <rect x="195" y="150" width="610" height="300" rx="25" fill="#15323b12" stroke="#030909" stroke-width="3"/>
        <path d="M290 165V435 M710 165V435" stroke="#43b9ff" stroke-width="7" stroke-dasharray="1 10"/>
        <path d="M280 285L290 300L280 315 M720 285L710 300L720 315" fill="none" stroke="#57c6ff"/>
        <path class="aim-mark" d="M370 300H489 M511 300H630 M500 218V289 M500 311V382" stroke="#071418" stroke-width="1"/>
      </svg><div class="scope-readout">SRS99C-S2 · SMART-LINK</div></div>
      ${BATTLE_RIFLE_SCOPE_HTML}
      <div class="zoom" id="zoom"></div>
      <div class="score-strip" id="score-strip"><span class="blue" id="score-side-blue">BLUE <b id="score-blue">0</b></span><span class="dash">—</span><span class="red" id="score-side-red">RED <b id="score-red">0</b></span></div>
      <div class="scoreboard" id="scoreboard">
        <h2>SCOREBOARD</h2>
        <div class="scoreboard-head"><span>TEAM</span><span>PLAYER</span><span>K</span><span>D</span></div>
        <div id="scoreboard-rows"></div>
        <div class="scoreboard-hint">HOLD TAB TO CLOSE</div>
      </div>
      <div class="postgame" id="postgame">
        <div class="postgame-verdict" id="postgame-verdict"></div>
        <div class="postgame-next" id="postgame-next"></div>
        <div class="postgame-actions"><button id="postgame-go"></button><button id="postgame-menu" class="secondary">Main menu</button></div>
      </div>
      <div class="radar" id="radar"><i class="self"></i></div>
      <div class="reticle"></div>
      <div class="drive-reticle" id="drive-reticle"><svg viewBox="-50 -50 100 100" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M-12.5 5L0 -6L12.5 5"/></svg></div>
      <div class="hit" id="hitmark">
        <span style="left:2px;top:8px;transform:rotate(45deg)"></span>
        <span style="right:2px;top:8px;transform:rotate(-45deg)"></span>
        <span style="left:2px;bottom:8px;transform:rotate(-45deg)"></span>
        <span style="right:2px;bottom:8px;transform:rotate(45deg)"></span>
      </div>
      <div class="shield">
        <div class="track"><div class="fill" id="shieldfill" style="width:100%"></div></div>
        <div class="health" id="health"></div>
      </div>
      <div class="ammo"><b id="mag">12</b><span id="reserve">120</span><small id="weapon-name"></small></div>
      <div class="plates" id="plates"></div>
      <div id="pickup-prompt" class="pickup-prompt" role="status" aria-live="polite" hidden>
        <strong id="pickup-name"></strong><div class="pickup-actions">
          <button id="pickup-left" aria-label="Pick up in left hand"><kbd>Q</kbd> Left hand</button>
          <button id="pickup-right" aria-label="Pick up in right hand"><kbd>E</kbd> Right hand</button>
        </div><small id="pickup-transfer" hidden>E also moves current weapon to left hand</small>
      </div>
      <div id="vehicle-prompt" class="pickup-prompt" role="status" aria-live="polite" hidden>
        <div class="pickup-actions"><button id="vehicle-board"><kbd>E</kbd> <span id="vehicle-name"></span></button></div>
      </div>
      <div id="controlhint" style="position:absolute;bottom:12px;left:5%;font-size:12px"></div>
      <div class="feed" id="feed"></div>
      <div class="prompt" id="prompt">
        <p><b>${MAP_NAMES[match.map]} · ${match.objectives.spec.name}</b>
          <button id="play" style="pointer-events:auto;cursor:pointer;padding:12px 30px;background:#bfeee0;color:#102824;border:0;border-radius:4px;font:inherit">Play</button><br>
          <a href="/" style="pointer-events:auto;color:#bfeee0;display:inline-block;margin:12px 0">← All levels</a><br>
          <span id="keyhints"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move &nbsp; <kbd>space</kbd> jump &nbsp; <kbd>shift</kbd> crouch<br>
          <kbd>mouse</kbd> look &nbsp; <kbd>click</kbd> fire &nbsp; <kbd>R</kbd> reload &nbsp; <kbd>Q</kbd> weapon &nbsp; <kbd>Right click / Z</kbd> zoom<br>
          <kbd>F/V</kbd> melee · <kbd>G</kbd> throw grenade · <kbd>B</kbd> grenade type<br><kbd>E</kbd> enter/exit vehicle · <kbd>T</kbd> view / Warthog seat · <kbd>M</kbd> sound · <kbd>Esc</kbd> pause</span>
          <span id="touchhints" style="display:none">left thumb moves · right thumb looks<br>buttons fire, jump, reload, swap, melee, grenade and board vehicles</span>
          <span id="mode" style="display:block;margin-top:10px;opacity:.7;font-size:13px"></span>
        </p>
      </div>
    </div>`
  document.body.appendChild(root)
  const hud = root.querySelector<HTMLElement>('.hud')!
  hud.classList.toggle('touch', Boolean(touch))

  const mode = root.querySelector<HTMLElement>('#mode')!
  // The menu already asked; tell the server before the first snapshot so nobody sees a default.
  if (playerName) match.setName(playerName)
  const who = playerName ? `${playerName} · ` : ''
  mode.textContent = match.net
    ? `${who}${match.you.team} team · match "${new URLSearchParams(location.search).get('room') ?? 'gulch'}" · share this link to play together`
    : `${who}offline · bots · reload for the menu`
  root.querySelector<HTMLButtonElement>('#play')!.addEventListener('click', match.input.start)
  if (touch) {
    root.querySelector<HTMLElement>('#keyhints')!.style.display = 'none'
    root.querySelector<HTMLElement>('#touchhints')!.style.display = 'block'
  }
  const hint = root.querySelector<HTMLElement>('#controlhint')!
  const pickupPrompt=root.querySelector<HTMLElement>('#pickup-prompt')!
  const pickupName=root.querySelector<HTMLElement>('#pickup-name')!
  const pickupLeft=root.querySelector<HTMLButtonElement>('#pickup-left')!
  const pickupRight=root.querySelector<HTMLButtonElement>('#pickup-right')!
  const pickupTransfer=root.querySelector<HTMLElement>('#pickup-transfer')!
  if(touch){pickupLeft.querySelector('kbd')!.textContent='L';pickupRight.querySelector('kbd')!.textContent='R';pickupTransfer.textContent='Right pickup moves current weapon to left hand'}
  pickupLeft.onclick=()=>{match.input.pickupLeftPressed=true}
  pickupRight.onclick=()=>{match.input.interactPressed=true}
  let lastPickup=''
  // Boarding a vehicle gets the same floating words (desktop; phones pop the Use button instead, touch.ts).
  const vehiclePrompt=root.querySelector<HTMLElement>('#vehicle-prompt')!
  const vehicleName=root.querySelector<HTMLElement>('#vehicle-name')!
  root.querySelector<HTMLButtonElement>('#vehicle-board')!.onclick=()=>{match.input.interactPressed=true}
  const VEHICLE_NAMES={warthog:'Warthog',ghost:'Ghost',banshee:'Banshee',mongoose:'Mongoose',chopper:'Chopper'} as const
  let lastVehicle=''

  const plates = root.querySelector<HTMLElement>('#plates')!
  const updateNameplates = createNameplates(plates, match)
  const shieldFill = root.querySelector<HTMLElement>('#shieldfill')!
  const shieldBox = root.querySelector<HTMLElement>('.shield')!
  const healthRow = root.querySelector<HTMLElement>('#health')!
  const weaponName = root.querySelector<HTMLElement>('#weapon-name')!
  const mag = root.querySelector<HTMLElement>('#mag')!
  const reserve = root.querySelector<HTMLElement>('#reserve')!
  const prompt = root.querySelector<HTMLElement>('#prompt')!
  const feed = root.querySelector<HTMLElement>('#feed')!
  const hitmark = root.querySelector<HTMLElement>('#hitmark')!

  const reticle = root.querySelector<HTMLElement>('.reticle')!
  const driveReticle = root.querySelector<HTMLElement>('#drive-reticle')!
  const zoom = root.querySelector<HTMLElement>('#zoom')!
  const scope = root.querySelector<HTMLElement>('#scope')!
  const brScope = root.querySelector<HTMLElement>('#br-scope')!
  const radar = root.querySelector<HTMLElement>('#radar')!
  // SWAT and the like play without a motion tracker.
  if (match.objectives.spec.radar === false) radar.style.display = 'none'
  const grenadesOn = match.objectives.spec.grenades !== false
  // Online the roster changes as people join and leave, so the dots follow the list.
  const contacts: HTMLElement[] = []
  const syncContacts = () => {
    while (contacts.length < match.bots.length) { const dot = document.createElement('i'); radar.appendChild(dot); contacts.push(dot) }
    while (contacts.length > match.bots.length) contacts.pop()!.remove()
  }
  const status = document.createElement('div')
  status.style.cssText = 'position:absolute;top:calc(2.5% + 47px);left:50%;transform:translateX(-50%);max-width:38vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px;opacity:.75;letter-spacing:.04em'
  hud.append(status)
  const scoreboard = root.querySelector<HTMLElement>('#scoreboard')!
  const postgame = root.querySelector<HTMLElement>('#postgame')!
  const postgameVerdict = root.querySelector<HTMLElement>('#postgame-verdict')!
  const postgameNext = root.querySelector<HTMLElement>('#postgame-next')!
  const postgameGo = root.querySelector<HTMLButtonElement>('#postgame-go')!
  /** When the results give way to the next game (ms, performance clock), or 0 while none is showing. */
  let postgameUntil = 0
  /** A different map for the next bot match. */
  const anotherMap = () => { const maps = (Object.keys(MAP_NAMES) as MapId[]).filter(m => m !== match.map); return maps[Math.floor(Math.random() * maps.length)] }
  const moveOn = () => {
    if (after === 'match') location.assign('/?next=match')
    else if (after === 'map') location.assign(`/${anotherMap()}?next=bots`)
    else { postgame.classList.remove('open'); postgameUntil = -1 }
  }
  postgameGo.textContent = after === 'match' ? 'Next match' : after === 'map' ? 'Next map' : 'Play again'
  postgameGo.addEventListener('click', moveOn)
  root.querySelector<HTMLButtonElement>('#postgame-menu')!.addEventListener('click', () => location.assign('/'))
  const scoreRows = root.querySelector<HTMLElement>('#scoreboard-rows')!
  const scoreBlue = root.querySelector<HTMLElement>('#score-blue')!
  const scoreRed = root.querySelector<HTMLElement>('#score-red')!
  const scoreSideBlue = root.querySelector<HTMLElement>('#score-side-blue')!
  const scoreSideRed = root.querySelector<HTMLElement>('#score-side-red')!
  let lastScoreSignature = ''
  const renderScoreboard = () => {
    const rows = match.scoreboard().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name))
    // Team modes show the game type's own score: kills in Slayer, captures, seconds, detonations.
    scoreBlue.textContent = String(match.objectives.scores.blue)
    scoreRed.textContent = String(match.objectives.scores.red)
    // Re-applied each render rather than set once: a player can change team between rounds.
    scoreSideBlue.classList.toggle('mine', match.you.team === 'blue')
    scoreSideRed.classList.toggle('mine', match.you.team === 'red')
    const signature = rows.map(row => `${row.id}:${row.team}:${row.kills}:${row.deaths}:${row.name}`).join('|')
    if (signature === lastScoreSignature) return
    lastScoreSignature = signature
    scoreRows.replaceChildren()
    for (const row of rows) {
      const line = document.createElement('div')
      line.className = 'score-row'
      const team = document.createElement('span')
      const ffa = !match.objectives.spec.teams
      team.className = ffa ? 'team' : `team ${row.team}`
      team.textContent = ffa ? '—' : row.team.toUpperCase()
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = row.name
      const kills = document.createElement('span')
      kills.textContent = String(row.kills)
      const deaths = document.createElement('span')
      deaths.textContent = String(row.deaths)
      line.append(team, name, kills, deaths)
      scoreRows.append(line)
    }
  }
  const updateObjectives = createObjectiveHud(hud, match, !!touch)
  root.querySelector('#scoreboard h2')!.textContent = match.objectives.spec.name.toUpperCase()
  const setScoreboardOpen = (open: boolean) => {
    scoreboard.classList.toggle('open', open)
    if (open) renderScoreboard()
  }
  const onScoreKeyDown = (event: KeyboardEvent) => {
    if (event.code !== 'Tab' || !match.input.active) return
    event.preventDefault()
    setScoreboardOpen(true)
  }
  const onScoreKeyUp = (event: KeyboardEvent) => {
    if (event.code === 'Tab') setScoreboardOpen(false)
  }
  addEventListener('keydown', onScoreKeyDown)
  addEventListener('keyup', onScoreKeyUp)
  const pushFeed = (text: string) => {
    const line = document.createElement('div')
    line.textContent = text
    feed.prepend(line)
    setTimeout(() => line.remove(), 4000)
  }
  match.onFeed = pushFeed
  const PIPS = 8
  for (let i = 0; i < PIPS; i++) healthRow.appendChild(document.createElement('i'))
  const pips = [...healthRow.children] as HTMLElement[]

  const damageWash = document.createElement('div')
  damageWash.style.cssText = 'position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse,transparent 40%,rgba(190,30,15,.65));opacity:0;transition:opacity .08s'
  root.append(damageWash)
  const deathNotice = document.createElement('div')
  deathNotice.style.cssText = 'position:fixed;top:74%;left:0;right:0;text-align:center;color:#bddcf5;font:24px monospace;text-shadow:0 0 6px #000;pointer-events:none'
  root.append(deathNotice)
  let previousVitals = match.you.health + match.you.shield, damageFade = 0
  // The shield bar gets its own quick flash on a hit or a break, and a soft pulse while it
  // recharges - Halo's visor gives the shields a distinct visual voice from raw health.
  let previousShield = match.you.shield, shieldFlash = 0, shieldBroke = false
  // First person cannot see its own silhouette light up, so the shield reports itself around
  // the edges of the visor instead: warm and orange while it is holding, a brighter, whiter
  // flare across the whole screen the moment it fails.
  const shieldWash = document.createElement('div')
  shieldWash.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity .05s linear'
  root.append(shieldWash)
  // Both keep the middle of the visor clear: this has to read at a glance without ever being
  // something you have to shoot through.
  const SHIELD_HELD = 'radial-gradient(ellipse at center, transparent 30%, rgba(255,168,42,.62) 100%)'
  const SHIELD_FAILED = 'radial-gradient(ellipse at center, rgba(255,242,214,.08) 18%, rgba(255,192,74,.92) 100%)'
  const medals = new CombatMedals(root, {playerId:match.you.id,team:match.you.team,getMuted:()=>match.effects.muted,isAlive:()=>match.you.alive,voice})
  let wasAlive=match.you.alive
  let hitFade = 0
  match.onHit = (target, killed, info) => {
    hitFade = 1
    if (killed) {
      medals.recordKill({time:match.elapsedSeconds,victimId:target.id,victimTeam:match.hostile(match.you,target)?'enemy':target.team,info,wipedOut:match.enemyTeamWipedOut(target)})
      // Online the server's death notice carries the line, so it is not written twice.
      if (!match.net) pushFeed(`you killed ${target.id}`)
    }
  }

  // Objective medals: your own flag capture or detonation, and Perfection when a Slayer game you won ends.
  match.onObjectiveMedal = e => {
    const me = match.numberOf(match.you), time = match.elapsedSeconds
    if (e.player === me && (e.kind === 'captured' || e.kind === 'detonated')) medals.recordObjective(e.kind === 'captured' ? 'flag-score' : 'bomb-planted', time)
    if (e.kind === 'won' && match.objectives.spec.unit === 'kills' && (e.team ? e.team === match.you.team : e.player === me)) {
      const row = match.scoreboard().find(r => r.name === 'you')
      if (row) medals.recordGameWon(row.kills, row.deaths, time)
    }
  }

  return () => {
    touch?.setVisible(isLocked())
    touch?.setContext({
      vehicleBrake:!!match.vehicles.occupied&&!match.vehicleGunner&&(match.vehicles.occupied.kind==='mongoose'||match.vehicles.occupied.kind==='chopper'),
      passenger:match.vehicles.occupied?.kind==='mongoose'&&match.vehicleGunner,
      pickupLeft:match.canPickupLeft,
      pickup:!!match.pickupPrompt,
      board:!!match.vehiclePrompt,
      dualWield:!!match.offhand,
      vehicle: !!match.interactionHint(),
      seated: !!match.vehicles.occupied,
      vehicleCanFire: !!match.vehicles.occupied && !match.vehicles.isExiting && (match.vehicles.occupied.kind === 'ghost' || match.vehicles.occupied.kind === 'banshee' || match.vehicles.occupied.kind==='chopper' || (match.vehicleGunner&&(match.vehicles.occupied.kind==='warthog'||match.vehicles.occupied.kind==='mongoose'))),
      jump: !match.vehicles.occupied,
      // Ghost and Chopper burst on Space; the Banshee's afterburner is Shift held with the stick forward.
      boost: match.vehicles.occupied&&!match.vehicleGunner&&!match.vehicles.isExiting
        ? ({ghost:'Space',chopper:'Space',banshee:'ShiftLeft'} as Record<string,string>)[match.vehicles.occupied.kind] : undefined,
      horn: match.vehicles.occupied?.kind === 'warthog' && !match.vehicleGunner && !match.vehicles.isExiting,
      seat: match.vehicles.occupied?.kind === 'warthog'||match.vehicles.occupied?.kind==='mongoose',
      zoom: !match.offhand && !match.vehicles.occupied && (match.weapon.slot.spec.zoom?.length ?? 0) > 0,
      grenades: grenadesOn,
      aiming: match.zoom > 1,
    })
    // The thumb pad already says what every button does; the hint line is then only worth the
    // things it cannot show, which is the vehicle prompt and what is in the grenade pouch.
    const chargeHint=match.weapon.slot.id==='plasma-pistol'||match.offhand?.slot.id==='plasma-pistol'?' · Hold fire to charge; release to shoot':''
    const keyboardHints = match.offhand ? 'LMB left · RMB right · R reload both · 1 stow left'+chargeHint : grenadesOn ? 'F/V melee · R reload · Q / 1 weapon · G throw · B grenade type' : 'F/V melee · R reload · Q / 1 weapon'
    // Phones say nothing about pickups: the popped-up L/R buttons are the whole prompt.
    const board = match.vehiclePrompt
    const base = touch ? match.pickupPrompt || board ? '' : match.interactionHint(false) : match.interactionHint() || keyboardHints
    const pouch = grenadesOn ? `${match.grenades.selected.toUpperCase()} ${match.grenades.inventory[match.grenades.selected]}` : ''
    hint.textContent = `${base}${base && pouch ? ' · ' : ''}${pouch}${touch ? '' : ' · M sound'}${!touch && match.map === 'guardian' ? ' · C collision' : ''}`
    const pickup=match.pickupPrompt
    const pickupKey=pickup?`${pickup.name}:${pickup.left}:${pickup.transfer}`:''
    if(pickupKey!==lastPickup){
      lastPickup=pickupKey;pickupPrompt.hidden=!pickup
      if(pickup){pickupName.textContent=`Pick up ${pickup.name}`;pickupLeft.hidden=!pickup.left;pickupTransfer.hidden=!pickup.transfer}
    }
    const boardKey=board?`${board.kind}:${board.seat}`:''
    if(boardKey!==lastVehicle){
      lastVehicle=boardKey;vehiclePrompt.hidden=!board
      // Halo's words: you drive a Ghost, pilot a Banshee, and take a Warthog's gun or ride on the back of a Mongoose.
      if(board)vehicleName.textContent=board.seat==='gunner'?board.kind==='warthog'?'Warthog gunner':'Ride Mongoose':`${board.kind==='banshee'?'Pilot':'Drive'} ${VEHICLE_NAMES[board.kind]}`
    }
    const you = match.you
    renderScoreboard()
    if(wasAlive&&!you.alive)medals.resetOnDeath()
    wasAlive=you.alive
    medals.update(match.elapsedSeconds,match.effects.muted,match.input.active&&you.alive)
    const vitals = you.health + you.shield
    if (vitals < previousVitals) damageFade = 0.7
    previousVitals = vitals
    damageFade *= 0.90
    damageWash.style.opacity = String(damageFade)
    const respawnIn = Math.ceil(match.respawnCountdown)
    deathNotice.textContent = you.alive ? '' : respawnIn > 0 ? `Respawn in ${respawnIn}` : 'Respawning…'
    reticle.style.visibility = you.alive ? '' : 'hidden'

    const vehicle = match.vehicles.occupied
    const personalPassenger=vehicle?.kind==='mongoose'&&match.vehicleGunner
    const vehicleAim = !!vehicle && (vehicle.kind === 'ghost' || vehicle.kind === 'banshee' || vehicle.kind==='chopper' || (match.vehicleGunner&&(vehicle.kind==='warthog'||vehicle.kind==='mongoose')))
    setReticle(reticle, vehicleAim ? 'vehicle' : match.weapon.slot.id)
    const targetReady=match.targetInRange
    reticle.classList.toggle('target-ready', targetReady)
    scope.classList.toggle('target-ready',targetReady)
    reticle.classList.toggle('vehicle', vehicleAim)
    reticle.classList.toggle('obstructed', vehicleAim && match.vehicleAimObstructed)
    const point = match.vehicleReticle
    const inView = point.z >= -1 && point.z <= 1 && Math.abs(point.x) < .98 && Math.abs(point.y) < .98
    reticle.style.display = vehicle && (!vehicleAim || !inView) ? 'none' : ''
    // The Warthog/Mongoose driver has no gun, just the camera, and the hull steers toward wherever it looks (Halo's
    // aim-steering; W/S throttle, A/D unused). Halo 3's one small open chevron marks that point (reference/halo3/driving).
    const driving = !!vehicle && !vehicleAim && !personalPassenger && !match.vehicles.isExiting && you.alive && (vehicle.kind === 'warthog' || vehicle.kind === 'mongoose')
    driveReticle.style.display = driving ? 'block' : 'none'
    reticle.style.left = `${vehicleAim ? (point.x * .5 + .5) * 100 : 50}%`
    reticle.style.top = `${vehicleAim ? (-point.y * .5 + .5) * 100 : 50}%`
    hitmark.style.left = reticle.style.left; hitmark.style.top = reticle.style.top
    zoom.textContent = match.zoom > 1 ? `${match.zoom}×` : ''
    const scoped = !vehicle && match.zoom > 1 && match.weapon.slot.id === 'sniper'
    const brScoped = !vehicle && match.zoom > 1 && match.weapon.slot.id === 'battle-rifle'
    hud.classList.toggle('scoped', scoped || brScoped)
    hud.classList.toggle('br-scoped', brScoped)
    scope.style.display = scoped ? 'block' : 'none'
    brScope.style.display = brScoped ? 'block' : 'none'
    brScope.classList.toggle('target-ready', targetReady)
    status.textContent = `${MAP_NAMES[match.map]} · ${match.objectives.spec.name} · ${match.status}`
    syncContacts()
    const yaw = match.input.yaw
    match.bots.forEach((bot, i) => {
      const dx = bot.state.x - you.state.x, dz = bot.state.z - you.state.z
      const visible = bot.alive && Math.hypot(dx, dz) < 15 && Math.hypot(bot.state.vx, bot.state.vz) > 0.5
      const dot = contacts[i]; dot.style.display = visible ? 'block' : 'none'
      if (!visible) return
      dot.style.left = `${50 + (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / 15 * 46}%`
      dot.style.top = `${50 + (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / 15 * 46}%`
      dot.style.background = !match.hostile(you, bot) ? '#f2d96e' : '#f04b39'
    })
    updateNameplates()
    updateObjectives()

    shieldFill.style.width = `${(you.shield / VITALS.shield) * 100}%`
    const shieldDelta = you.shield - previousShield
    if (shieldDelta < -0.01) {
      const broke = previousShield > 0 && you.shield <= 0
      // A break outranks a graze already fading, and sets the colour for the whole fade.
      if (broke || shieldFlash <= 0.02) shieldBroke = broke
      shieldFlash = Math.max(shieldFlash, broke ? 1 : 0.5)
      shieldWash.style.background = shieldBroke ? SHIELD_FAILED : SHIELD_HELD
    }
    shieldBox.classList.toggle('charging', you.alive && shieldDelta > 0.0005 && you.shield < VITALS.shield - 0.01)
    previousShield = you.shield
    shieldFlash *= shieldBroke ? 0.90 : 0.84
    shieldFill.style.filter = shieldFlash > 0.02 ? `brightness(${(1 + shieldFlash * 2.4).toFixed(2)})` : ''
    shieldWash.style.opacity = shieldFlash > 0.02 ? (shieldFlash * (shieldBroke ? 0.72 : 0.5)).toFixed(3) : '0'
    const lit = Math.ceil((you.health / VITALS.health) * PIPS)
    pips.forEach((p, i) => p.classList.toggle('off', i >= lit))
    const infiniteAmmo = match.weapon.isMeleeWeapon
    weaponName.textContent=vehicle&&!personalPassenger?'':match.offhand?`${match.offhand.slot.spec.name} + ${match.weapon.slot.spec.name}`:match.weapon.slot.spec.name
    const ammoLabel=(w:typeof match.weapon)=>['plasma-pistol','plasma-rifle'].includes(w.slot.id)?`${Math.ceil(w.slot.ammo/w.slot.spec.magazine*100)}%`:String(w.slot.ammo)
    mag.textContent = (vehicle&&!personalPassenger) || infiniteAmmo ? '∞' : match.offhand?`${ammoLabel(match.offhand)} | ${ammoLabel(match.weapon)}`:ammoLabel(match.weapon)
    reserve.textContent = vehicle&&!personalPassenger ? (vehicleAim ? 'VEHICLE' : 'DRIVER') : infiniteAmmo ? '∞' : match.offhand?`${match.offhand.slot.reserve} | ${match.weapon.slot.reserve}`:String(match.weapon.slot.reserve)
    // ?nooverlay lets the screenshot tools photograph the game without the click-to-play scrim.
    // Results: when the game ends, the scoreboard and what comes next, with the mouse free to choose.
    const over = match.objectives.over
    if (over && postgameUntil === 0) {
      postgameUntil = performance.now() + Math.min(POSTGAME_S, Math.max(3, match.objectives.restartIn - 1.5)) * 1000
      setScoreboardOpen(true)
      postgame.classList.add('open')
      if (document.pointerLockElement) document.exitPointerLock()
      const winner = match.objectives.winner
      const mine = winner && typeof winner === 'object' && 'team' in winner ? winner.team === match.you.team : null
      postgameVerdict.textContent = mine === null ? 'GAME OVER' : mine ? 'VICTORY' : 'DEFEAT'
    }
    if (!over && postgameUntil !== 0) { postgameUntil = 0; postgame.classList.remove('open'); setScoreboardOpen(false) }
    if (postgameUntil > 0) {
      const left = Math.max(0, Math.ceil((postgameUntil - performance.now()) / 1000))
      postgameNext.textContent = after === 'match' ? `Next match in ${left}` : after === 'map' ? `Next map in ${left}` : `Next game here in ${Math.max(0, Math.ceil(match.objectives.restartIn))}`
      if (after !== 'stay' && left <= 0) { postgameUntil = -1; moveOn() }
    }
    const resultsOpen = postgame.classList.contains('open')
    prompt.style.display = isLocked() || hideOverlay || resultsOpen ? 'none' : 'grid'
    hitFade = Math.max(0, hitFade - 0.06)
    hitmark.style.opacity = String(hitFade)
  }
}
