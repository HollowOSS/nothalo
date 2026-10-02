/** One quiet status beside Play; camera/scripted pages use the same status in the corner. */
export function showLoading(_level: string) {
  let root = document.querySelector<HTMLElement>('.level-loading')
  if (!root) {
    root = document.createElement('div')
    root.className = 'level-loading'
    root.setAttribute('role', 'status')
    root.setAttribute('aria-live', 'polite')
    root.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span><span class="loading-status"></span><button class="loading-retry" hidden>Try again</button><a href="/" hidden>All levels</a>'
    document.body.append(root)
  }
  const status = root.querySelector<HTMLElement>('.loading-status')!
  const retry = root.querySelector<HTMLButtonElement>('.loading-retry')!
  retry.onclick = () => location.reload()
  let failed = false
  return {
    reset() {
      failed = false
      root.classList.remove('failed')
      retry.hidden = true
      root.querySelector<HTMLAnchorElement>('a')!.hidden = true
    },
    stage(stage: string | null) {
      if (failed) return
      root.hidden = stage === null
      if (stage) status.textContent = stage
    },
    fail() {
      failed = true
      root.classList.add('failed')
      root.hidden = false
      status.textContent = 'Could not prepare this level.'
      retry.hidden = false
      root.querySelector<HTMLAnchorElement>('a')!.hidden = false
    },
  }
}
