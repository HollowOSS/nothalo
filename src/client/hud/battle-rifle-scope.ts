/** Authored from Halo 3 gameplay: File:Halo3_123639242_Full.jpg on Halopedia.
 * The optical disk stays circular on every aspect ratio, centered on our camera ray.
 * Halo 3's original lowered crosshair is deliberately not copied as a cosmetic offset.
 */
export const BATTLE_RIFLE_SCOPE_CSS = `
.hud .br-scope { display:none;position:absolute;left:50%;top:50%;width:min(38.5vh,80vw);height:min(38.5vh,80vw);aspect-ratio:1;transform:translate(-50%,-50%);border-radius:50%;box-shadow:0 0 0 150vmax #050b121c;animation:br-scope-in .12s ease-out; }
.hud .br-scope svg {display:block;width:100%;height:100%;overflow:visible;}
.hud .br-scope .aim-mark {stroke:#7ac7fb;fill:none;stroke-width:1.4;}
.hud .br-scope.target-ready .aim-mark {stroke:#ff5048;}
.hud.scoped.br-scoped .zoom {left:calc(50% + min(12vh,25vw));top:calc(50% + min(12vh,25vw));font-size:13px;}
@keyframes br-scope-in {from{opacity:0;transform:translate(-50%,-50%) scale(1.08)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
`

export const BATTLE_RIFLE_SCOPE_HTML = `<div class="br-scope" id="br-scope" aria-label="Battle Rifle 2x optical scope"><svg viewBox="0 0 200 200" aria-hidden="true">
<circle cx="100" cy="100" r="99" fill="#90b9dc06" stroke="#071015" stroke-width="1"/>
<g stroke="#071015" fill="none">
<path d="M100 5V48 M100 152V195 M5 100H48 M152 100H195" stroke-width="2"/>
<path d="M53 100H80 M120 100H147 M100 53V80 M100 120V147" stroke-width=".65" stroke-dasharray=".7 1.8"/>
<path d="M53 94V106 M65 97V103 M78 98V102 M147 94V106 M135 97V103 M122 98V102 M94 53H106 M97 65H103 M98 78H102 M94 147H106 M97 135H103 M98 122H102" stroke-width=".65"/>
<path d="M28 155Q58 154 80 140 M28 159H80 M29 146V152 M36 148V152 M42 143V150 M49 144V150 M55 140V146 M62 140V146 M68 136V142 M74 133V139 M80 130V136" stroke-width=".5" opacity=".7"/>
</g>
<g fill="#071015" font-family="monospace" font-size="3.8" opacity=".8"><text x="49" y="113">0.0</text><text x="144" y="113">0.0</text><text x="26" y="144">10</text><text x="40" y="141">8</text><text x="53" y="138">6</text><text x="66" y="133">4</text><text x="78" y="128">2</text><text x="79" y="170">1.7</text></g>
<path class="aim-mark" d="M88.5 98A12 12 0 0 1 98 88.5 M102 88.5A12 12 0 0 1 111.5 98 M111.5 102A12 12 0 0 1 102 111.5 M98 111.5A12 12 0 0 1 88.5 102 M100 83V94 M100 106V117 M83 100H94 M106 100H117"/>
</svg></div>`
