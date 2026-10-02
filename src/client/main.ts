/*!
MIT License

Copyright (c) 2026 Caden Burleson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { MAP_NAMES, mapFromUrl, levelUrl } from '../shared/maps.ts'
import { showLoading } from './hud/loading.ts'
import { createMenu } from './hud/menu.ts'

const url = new URL(location.href)
const routeMap = mapFromUrl(url)
const isHome = !routeMap && (url.pathname === '/' || url.pathname === '/index.html')
const selectedMap = routeMap ?? 'blood-gulch'
if (!routeMap && !isHome) {
  location.replace('/')
} else {
  if (!isHome) history.replaceState(null, '', levelUrl(selectedMap, url))
  document.title = `${MAP_NAMES[selectedMap]} · Halo`
  const scripted = ['cam', 'nooverlay', 'offline'].some(key => url.searchParams.has(key))
  const backdrop = document.querySelector<HTMLElement>('.menu-backdrop')!
  if(['blood-gulch','guardian','lockout'].includes(selectedMap))backdrop.style.backgroundImage = `url('/assets/menu/${selectedMap}.jpg')`
  if (scripted) {
    document.querySelector('#menu-shell')?.remove()
    backdrop.remove()
  }
  const loading = showLoading(MAP_NAMES[selectedMap])
  const menu = scripted ? undefined : createMenu(selectedMap, loading.stage)
  menu?.onSelect(() => loading.reset())
  try {
    loading.stage('Starting camera…')
    // Give the initial HTML (logo, fields, level still) a paint before evaluating the renderer.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const { startGame } = await import('./game-entry.ts')
    await startGame(menu?.selectedMap ?? selectedMap, loading.stage, menu, () => { menu?.fail(); loading.fail() })
  } catch (error) {
    console.error('Level startup failed:', error)
    menu?.fail()
    loading.fail()
  }
}
