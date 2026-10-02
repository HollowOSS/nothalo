let sharedContext: AudioContext | null = null

/** iOS/WebKit is more reliable when the game uses one user-unlocked audio graph. */
export function getSharedAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContext()
  return sharedContext
}

/** Capture gestures before touch controls stop propagation. Touch release also covers iOS. */
export function onAudioActivation(activate: () => void): () => void {
  const events = ['pointerdown', 'touchend', 'keydown'] as const
  for (const event of events) addEventListener(event, activate, { capture: true, passive: true })
  const foreground = () => { if (!document.hidden) activate() }
  addEventListener('focus', foreground)
  addEventListener('pageshow', foreground)
  document.addEventListener('visibilitychange', foreground)
  return () => {
    for (const event of events) removeEventListener(event, activate, true)
    removeEventListener('focus', foreground)
    removeEventListener('pageshow', foreground)
    document.removeEventListener('visibilitychange', foreground)
  }
}

export function resumeAudio(context: AudioContext): Promise<void> {
  // WebKit also exposes "interrupted" after calls, screen locking and app switching.
  return context.state !== 'running' && context.state !== 'closed' ? context.resume() : Promise.resolve()
}
