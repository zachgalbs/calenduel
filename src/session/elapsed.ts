// Study time, worked out from timestamps rather than added up, so it can't
// drift. Breaks are taken out: pausedMs is every finished pause so far, and
// pausedAt is when the current one began (null while studying).
export interface PauseState {
  pausedMs: number
  pausedAt: number | null
}

export const NOT_PAUSED: PauseState = { pausedMs: 0, pausedAt: null }

// All the time paused up to `at`, the current break included.
export function pausedUntil(pause: PauseState, at: number): number {
  return pause.pausedMs + (pause.pausedAt === null ? 0 : Math.max(0, at - pause.pausedAt))
}

export function studiedMs(startedAt: number, at: number, pause: PauseState): number {
  return Math.max(0, at - startedAt - pausedUntil(pause, at))
}

// What the live beat sends (see db/migrations/012): a start moved later by the
// finished breaks, so that (now - since) is the time studied, and the moment
// the clock stopped, if it has (a break, or Stop). Either way,
// (frozenAt ?? now) - since equals studiedMs.
export function liveSpan(
  startedAt: number,
  pause: PauseState,
  stoppedAt: number | null,
): { since: number; frozenAt: number | null } {
  return { since: startedAt + pause.pausedMs, frozenAt: pause.pausedAt ?? stoppedAt }
}
