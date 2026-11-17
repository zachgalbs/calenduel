// Tells your study groups you're studying while a session runs: a heartbeat
// every 15 s with the session's start time, and a sign-off when it stops. If
// the tab just closes, the room drops you after 45 s on its own. Only the start
// time leaves the device, never the session name. Signed-out users send nothing.
import { HEARTBEAT_MS } from '../session/activeSession'

// Returns the function that ends it. Every failure is ignored: presence is a
// nicety, and must never get in the way of the session itself.
export function startPresence(startedAt: number): () => void {
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  const api = import('../compete/api')

  void api
    .then(async ({ isSignedIn, heartbeat }) => {
      if (stopped || !(await isSignedIn())) return
      const beat = () => heartbeat(startedAt).catch(() => {})
      void beat()
      timer = setInterval(beat, HEARTBEAT_MS)
    })
    .catch(() => {})

  return () => {
    stopped = true
    clearInterval(timer)
    void api.then(({ endLive }) => endLive()).catch(() => {})
  }
}
