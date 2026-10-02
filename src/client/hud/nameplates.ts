import { assetUrl } from '../../shared/runtime-config.ts'
import * as THREE from 'three'
import { MOVE } from '../../shared/constants.ts'
import type { Match } from '../game/match.ts'

// Reference: Halo 3 GC07 gameplay, https://www.gamersyde.com/video_halo_3_gc07_multiplayer_gameplay-4354_en.html
// Barlow is a bundled OFL approximation of the narrow HUD lettering, not a ripped game font.
export const NAMEPLATE_CSS = `
@font-face { font-family: 'Player HUD'; src: url('${assetUrl('/assets/fonts/BarlowSemiCondensed-Medium.ttf')}') format('truetype'); font-style: normal; font-weight: 500; font-display: swap; }
.hud .plates { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.hud .nameplate { --plate-color: #a4dfff; position: absolute; display: flex; flex-direction: column; align-items: center;
  transform: translate(-50%, -100%); color: var(--plate-color); white-space: nowrap;
  font: 500 clamp(13px, 2.2vh, 20px)/1.1 'Player HUD', 'Arial Narrow', sans-serif;
  letter-spacing: .015em; text-shadow: 0 1px 2px #071523, 0 0 3px #081828;
  user-select: none; -webkit-user-select: none; }
.hud .nameplate.enemy { --plate-color: #ff7770; }
.hud .nameplate span { max-width: min(240px, 38vw); overflow: hidden; text-overflow: ellipsis; }
.hud .nameplate::after { content: ''; width: 13px; height: 7px; margin-top: 3px;
  background: var(--plate-color); clip-path: polygon(0 0, 100% 0, 50% 100%); }
.hud .nameplate[hidden] { display: none; }
`

/** Project the smoothed character position every frame; keep names as text, never HTML. */
export function createNameplates(root: HTMLElement, match: Match): () => void {
  const labels = new Map<string, { el: HTMLElement; text: HTMLElement }>()
  const anchor = new THREE.Vector3(), body = new THREE.Vector3(), projected = new THREE.Vector3(), target = new THREE.Vector3()
  const present = new Set<string>()
  return () => {
    present.clear()
    for (const { name, player } of match.nameplatePlayers()) {
      present.add(player.id)
      let label = labels.get(player.id)
      if (!label) {
        const el = document.createElement('div'), text = document.createElement('span')
        el.className = 'nameplate'; el.dataset.playerId = player.id
        el.append(text); root.append(el)
        label = { el, text }; labels.set(player.id, label)
      }
      const { el, text } = label
      el.hidden = true
      if (!player.alive || !player.object.visible) continue
      const friendly = !match.hostile(match.you, player)
      const height = MOVE.playerHeight * (player.state.crouched ? .62 : 1)
      anchor.copy(player.object.position); anchor.y += height + .22
      const distance = anchor.distanceTo(match.camera.position)
      if (distance > 80) continue
      projected.copy(anchor).project(match.camera)
      if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > .98 || Math.abs(projected.y) > .98) continue
      if (!friendly) {
        // Halo-style target identification: enemies only near the reticle and in clear sight.
        body.copy(player.object.position); body.y += height * .75
        target.copy(body).project(match.camera)
        if (Math.hypot(target.x * match.camera.aspect, target.y) > .24 || !match.nameplateVisible(body)) continue
      }
      if (text.textContent !== name) text.textContent = name
      el.classList.toggle('enemy', !friendly)
      el.style.left = `${(projected.x * .5 + .5) * 100}%`
      el.style.top = `${(-projected.y * .5 + .5) * 100}%`
      el.style.opacity = String(Math.max(.55, 1 - Math.max(0, distance - 25) / 100))
      el.hidden = false
    }
    for (const [id, label] of labels) if (!present.has(id)) { label.el.remove(); labels.delete(id) }
  }
}
