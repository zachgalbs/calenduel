// Tells friends you're studying (the green dot on Compete) while a session
// runs. Signed-out users send nothing. Failures are quiet: the dot is a nicety,
// and it clears by itself 90 s after the last beat.
import { useEffect } from 'react'

const BEAT_MS = 30_000

async function send(studyingSince: number | null): Promise<void> {
  try {
    const { isSignedIn, liveBeat } = await import('./api')
    if (await isSignedIn()) await liveBeat(studyingSince)
  } catch (err) {
    console.error('live status failed', err)
  }
}

export function useLiveBeat(studyingSince: number | null): void {
  useEffect(() => {
    if (studyingSince === null) return
    void send(studyingSince)
    const timer = setInterval(() => void send(studyingSince), BEAT_MS)
    return () => {
      clearInterval(timer)
      void send(null)
    }
  }, [studyingSince])
}
