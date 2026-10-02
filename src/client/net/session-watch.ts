import type { Connection } from './connection.ts'

/**
 * Keeps an online match alive across a deploy, and the player on the current build.
 *
 * Every push deploys, and a deploy restarts the match server, closing every socket. The
 * connection rejoins by itself (connection.ts) and the server seats each player again with their
 * kills, team and the match clock; all this has to do is say so on screen.
 *
 * A deploy also leaves this tab running the old build. If the server now speaks a different
 * protocol, the old client cannot play on, so it reloads at once (the rejoin token survives the
 * reload, so does the seat). Otherwise the old build keeps playing and the update waits for the
 * match to end, so nobody is pulled out of a fight to download it.
 */

/** How often to look for a new build besides after each reconnect. */
const UPDATE_CHECK_MS = 10 * 60 * 1000

/**
 * Whether the server now serves a different build. Each build's entry script has its own hashed
 * name; if the page the server hands out no longer loads ours, a deploy happened. In development
 * the entry is the unhashed source, so this never fires.
 */
async function newBuildAvailable(): Promise<boolean> {
  const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src')
  if (!entry || !/-[\w-]{6,}\.js$/.test(entry)) return false
  try {
    const page = await fetch('/', { cache: 'no-store' })
    return page.ok && !(await page.text()).includes(entry)
  } catch { return false }
}

export function watchSession(net: Connection, matchOver: () => boolean): void {
  const banner = document.createElement('div')
  banner.style.cssText = 'position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:30;padding:10px 18px;border-radius:6px;'
    + 'background:rgba(6,18,30,.82);color:#c3e7ff;font:600 15px ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;'
    + 'pointer-events:none;display:none;box-shadow:0 2px 12px #0008'
  const notice = document.createElement('div')
  notice.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:30;padding:6px 12px;border-radius:5px;background:rgba(6,18,30,.7);'
    + 'color:#9fd2ff;font:12px ui-sans-serif,system-ui,sans-serif;letter-spacing:.04em;pointer-events:none;display:none'
  notice.textContent = 'Update ready · applies after this match'
  document.body.append(banner, notice)
  const show = (text: string | null) => { banner.textContent = text ?? ''; banner.style.display = text ? 'block' : 'none' }

  let updatePending = false, reloading = false
  const reload = (text: string) => {
    if (reloading) return
    reloading = true
    show(text)
    location.reload()
  }
  const checkForUpdate = async () => {
    if (updatePending || reloading) return
    if (await newBuildAvailable()) { updatePending = true; notice.style.display = 'block' }
  }

  net.onStatus = status => {
    if (status === 'reconnecting') show('Reconnecting…')
    else if (status === 'connected') { show(null); void checkForUpdate() }
    else if (status === 'outdated') reload('Updating…')
    else if (status === 'reseated') reload('Rejoining…')
    else if (status === 'lost') {
      show('Connection lost')
      banner.style.pointerEvents = 'auto'
      const again = document.createElement('button')
      again.textContent = 'Rejoin'
      again.style.cssText = 'margin-left:12px;padding:4px 12px;font:inherit;cursor:pointer'
      again.onclick = () => reload('Rejoining…')
      banner.append(again)
    }
  }
  net.onClose = reason => console.warn(`Disconnected from the match: ${reason}`)

  // The update waits for the final whistle: the match is over, and the next one has not begun.
  setInterval(() => { if (updatePending && matchOver()) reload('Updating…') }, 1000)
  setInterval(() => void checkForUpdate(), UPDATE_CHECK_MS)
}
