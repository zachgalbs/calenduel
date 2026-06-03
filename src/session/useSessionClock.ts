import { useCallback, useEffect, useRef, useState } from 'react'
import { playChime } from './chime'

// Count-up clock with a *soft* goal: it counts up forever and never stops
// itself. Crossing the goal just fires a one-time chime — no interruption, no
// "add more time." You stop when you're actually done. The goal is supplied at
// start() time, because it comes from the live calendar event (end − now), not
// a fixed preset.

// Display granularity. 1s keeps it battery-cheap; elapsed is computed from a
// start timestamp each tick, so the value never drifts even if a tick is late.
const TICK_MS = 1000

export interface SessionClock {
  elapsedMs: number
  goalMs: number
  running: boolean
  reachedGoal: boolean
  start: (goalMs: number) => void
  stop: () => void
  reset: () => void
}

export function useSessionClock(): SessionClock {
  const [elapsedMs, setElapsedMs] = useState(0)
  const [goalMs, setGoalMs] = useState(0)
  const [running, setRunning] = useState(false)
  // Wall-clock instant the run began; elapsed is always derived from this,
  // never accumulated tick-by-tick (which would drift).
  const startAtRef = useRef(0)
  // Ensures the goal chime fires exactly once per run.
  const chimedRef = useRef(false)

  const reachedGoal = goalMs > 0 && elapsedMs >= goalMs

  // Tick while running. setElapsedMs runs inside the interval callback (not the
  // effect body), so there's no synchronous cascading render.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startAtRef.current)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [running])

  // Fire the soft chime once, the moment we cross the goal mid-run.
  useEffect(() => {
    if (running && reachedGoal && !chimedRef.current) {
      chimedRef.current = true
      playChime()
    }
  }, [running, reachedGoal])

  const start = useCallback((ms: number) => {
    chimedRef.current = false
    startAtRef.current = Date.now()
    setGoalMs(ms)
    setElapsedMs(0)
    setRunning(true)
  }, [])

  const stop = useCallback(() => {
    setRunning(false)
  }, [])

  const reset = useCallback(() => {
    setRunning(false)
    setElapsedMs(0)
    setGoalMs(0)
    chimedRef.current = false
  }, [])

  return { elapsedMs, goalMs, running, reachedGoal, start, stop, reset }
}
