import { DefaultLoadingManager } from 'three'
import css from '../style.css?inline'
import { assetUrl, loadRuntimeConfig } from './shared/runtime-config.ts'

const config = await loadRuntimeConfig()
const style = document.createElement('style')
style.textContent = css.replace(/url\((['"]?)(\/assets\/[^)'"\s]+)\1\)/g, (_, _quote, path) => config.assetsBase ? `url("${assetUrl(path)}")` : 'none')
document.head.append(style)
DefaultLoadingManager.setURLModifier(assetUrl)
if (!config.assetsBase || !config.dataBase) {
  document.body.innerHTML = ''
  const panel = document.createElement('main')
  panel.style.cssText = 'max-width:720px;margin:12vh auto;padding:32px;color:#e8edf3;font:18px/1.6 system-ui;overflow:auto'
  panel.innerHTML = `<h1>Not Halo client</h1>
    <p>The source is installed. Set your media and map-data URLs to play.</p>
    <p>Copy <code>public/runtime-config.example.json</code> to <code>public/runtime-config.json</code> and set <code>assetsBase</code> and <code>dataBase</code> to your HTTP or IPFS directory URLs.</p>
    <p>This repository includes no game images, models, audio, or encoded map data. See docs/setup.md for configuration.</p>`
  document.body.append(panel)
} else {
  try { await import('./client/main.ts') }
  catch (error) {
    console.error(error)
    const status = document.querySelector('.loading-status')
    if (status) status.textContent = `Unable to load the configured asset pack: ${error instanceof Error ? error.message : String(error)}`
  }
}
