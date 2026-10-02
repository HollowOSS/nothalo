import * as THREE from 'three'
import type { Match } from '../game/match.ts'
import type { Team } from '../../shared/map.ts'

/**
 * The game type on the visor: the clock and what it takes to win under the score strip, a
 * banner when something happens to a flag, the ball or the bomb, waypoints over whatever is
 * worth running at, and a reminder of what you are carrying.
 *
 * DOM like the rest of the HUD. Waypoints are projected through the match camera each frame
 * and pinned to the screen edge when their target is off to the side or behind you.
 */
export const OBJECTIVE_HUD_CSS = `
  .hud .obj-clock { position: absolute; left: 50%; top: calc(2.5% + 30px); transform: translateX(-50%); white-space: nowrap;
    font: 600 10px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .16em; color: #9fd0ff; text-shadow: 0 1px 2px #000; }
  .hud .obj-banner { position: absolute; left: 50%; top: 23%; transform: translateX(-50%); width: min(720px, 90vw); text-align: center;
    font: 700 22px/1.2 ui-sans-serif, system-ui, sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #e6f4ff;
    text-shadow: 0 2px 6px #000, 0 0 18px currentColor; opacity: 0; transition: opacity .25s; }
  .hud .obj-banner.show { opacity: 1; }
  .hud .obj-banner.red { color: #ffb4a8; } .hud .obj-banner.blue { color: #b1d8ff; } .hud .obj-banner.gold { color: #ffe9a6; }
  .hud .obj-banner small { display: block; margin-top: 7px; font-size: 12px; font-weight: 500; letter-spacing: .18em; opacity: .85; text-shadow: 0 1px 3px #000; }
  .hud .obj-carry { position: absolute; left: 50%; bottom: 18%; transform: translateX(-50%); white-space: nowrap; text-align: center;
    font: 600 12px/1.3 ui-sans-serif, system-ui, sans-serif; letter-spacing: .12em; color: #fff0c2; text-shadow: 0 1px 3px #000; }
  .hud .obj-arm { position: absolute; left: 50%; top: 60%; width: 220px; transform: translateX(-50%); display: none; text-align: center;
    font: 700 11px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .16em; text-shadow: 0 1px 2px #000; }
  .hud .obj-arm .bar { height: 6px; margin-top: 6px; border: 1px solid currentColor; background: rgba(0,0,0,.35); }
  .hud .obj-arm .bar i { display: block; height: 100%; width: 0; background: currentColor; }
  .hud .waypoint { position: absolute; transform: translate(-50%, -100%); text-align: center; white-space: nowrap;
    font: 700 10px/1.15 ui-sans-serif, system-ui, sans-serif; letter-spacing: .12em; text-shadow: 0 1px 2px #000, 0 0 3px #000; }
  .hud .waypoint small { display: block; font-weight: 500; letter-spacing: .06em; opacity: .85; }
  .hud .waypoint::after { content: ''; display: block; width: 8px; height: 8px; margin: 3px auto 0; transform: rotate(45deg);
    border: 2px solid currentColor; box-shadow: 0 0 6px currentColor; }
  .hud.touch .obj-banner { top: 19%; font-size: 17px; }
  .hud.touch .obj-carry { bottom: 26%; }
`

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
const clock = (seconds: number) => {
  const s = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function createObjectiveHud(hud: HTMLElement, match: Match, touch: boolean): () => void {
  const o = match.objectives
  const clockLine = document.createElement('div')
  clockLine.className = 'obj-clock'
  const banner = document.createElement('div')
  banner.className = 'obj-banner'
  const carry = document.createElement('div')
  carry.className = 'obj-carry'
  const arm = document.createElement('div')
  arm.className = 'obj-arm'
  arm.innerHTML = '<span></span><div class="bar"><i></i></div>'
  const armLabel = arm.querySelector('span')!, armFill = arm.querySelector('i')!
  const marks = document.createElement('div')
  hud.append(marks, clockLine, banner, carry, arm)
  const strip = hud.querySelector<HTMLElement>('#score-strip')!
  if (!o.spec.teams) strip.innerHTML = '<span class="blue mine">YOU <b id="ffa-you">0</b></span><span class="dash">—</span><span class="red">LEAD <b id="ffa-lead">0</b></span>'
  const ffaYou = strip.querySelector<HTMLElement>('#ffa-you'), ffaLead = strip.querySelector<HTMLElement>('#ffa-lead')

  let bannerUntil = 0
  const showBanner = (text: string, team: Team | null, seconds = 3.2, sub = '') => {
    banner.className = `obj-banner show ${team ?? 'gold'}`
    banner.innerHTML = ''
    banner.append(text)
    if (sub) { const small = document.createElement('small'); small.textContent = sub; banner.append(small) }
    bannerUntil = performance.now() + seconds * 1000
  }
  const winnerText = (): { text: string; team: Team | null; mine: boolean | null } => {
    const w = o.winner
    if (!w || w === 'tie') return { text: 'Tie game', team: null, mine: null }
    if ('player' in w) {
      const mine = w.player === match.numberOf(match.you)
      return { text: mine ? 'You win' : `${match.nameOf(w.player)} wins`, team: null, mine }
    }
    return { text: `${w.team} team wins`, team: w.team, mine: w.team === match.you.team }
  }
  match.onObjective = (e, text) => {
    if (e.kind === 'won' || e.kind === 'restart') return
    // A slayer kill is already in the feed; only objective moments earn the banner.
    showBanner(text, e.team)
  }

  const pool: HTMLElement[] = []
  const v = new THREE.Vector3()

  return () => {
    const now = performance.now()
    const limit = `${o.spec.scoreLimit} ${o.spec.unit} to win`
    clockLine.textContent = `${o.spec.short} · ${limit} · ${clock(o.timeLeft)}`.toUpperCase()

    if (ffaYou && ffaLead) {
      const rows = match.scoreboard()
      const mine = rows.find(r => r.name === 'you')?.kills ?? 0
      const lead = rows.filter(r => r.name !== 'you').reduce((best, r) => Math.max(best, r.kills), 0)
      ffaYou.textContent = String(mine)
      ffaLead.textContent = String(lead)
    }

    if (o.over) {
      const w = winnerText()
      const verdict = w.mine === null ? '' : w.mine ? 'Victory' : 'Defeat'
      showBanner(w.text, w.team, .2, `${verdict}${verdict ? ' · ' : ''}next game in ${Math.max(0, Math.ceil(o.restartIn))}`)
    }
    if (now > bannerUntil) banner.classList.remove('show')

    const held = match.carrying
    const drop = touch ? '' : ' · E drop'
    carry.textContent = !held || !match.you.alive ? ''
      : held.kind === 'flag' ? `You have the flag · take it to your base${drop}`
        : held.kind === 'ball' ? `You have the ball · hold it to score${drop}`
          : `You have the bomb · plant it in their base${drop}`

    if (o.arming.team) {
      arm.style.display = 'block'
      arm.style.color = o.arming.team === 'red' ? '#ffb4a8' : '#b1d8ff'
      armLabel.textContent = o.arming.team === match.you.team ? 'ARMING BOMB' : 'BOMB BEING ARMED'
      armFill.style.width = `${Math.round(o.arming.progress * 100)}%`
    } else arm.style.display = 'none'

    const points = match.you.alive ? match.waypoints() : []
    while (pool.length < points.length) { const el = document.createElement('div'); el.className = 'waypoint'; marks.append(el); pool.push(el) }
    for (let i = 0; i < pool.length; i++) {
      const el = pool[i], p = points[i]
      if (!p) { el.style.display = 'none'; continue }
      v.set(p.x, p.y, p.z)
      const distance = v.distanceTo(match.camera.position)
      v.project(match.camera)
      let x = v.x, y = v.y
      const behind = v.z > 1
      if (behind) { x = -x; y = -y }
      // Off-screen or behind: slide to the nearest edge so the direction still reads.
      // The top edge stops short of the score strip and clock.
      const k = Math.max(Math.abs(x) / .94, y > 0 ? y / .7 : -y / .86, behind ? 1 : 0)
      if (k > 1 || behind) { x /= k; y /= k }
      el.style.display = 'block'
      el.style.left = `${(x * .5 + .5) * 100}%`
      el.style.top = `${(-y * .5 + .5) * 100}%`
      el.style.color = hex(p.color)
      el.style.opacity = distance < 4 ? '.35' : '1'
      const text = `${p.label}|${Math.round(distance)}`
      if (el.dataset.text !== text) {
        el.dataset.text = text
        el.textContent = p.label
        const small = document.createElement('small')
        small.textContent = `${Math.round(distance)} m`
        el.append(small)
      }
    }
  }
}
