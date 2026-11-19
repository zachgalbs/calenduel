import { describe, expect, it } from 'vitest'
import { liveSpan, NOT_PAUSED, pausedUntil, studiedMs, type PauseState } from './elapsed'

describe('studiedMs', () => {
  it('is wall time when never paused', () => {
    expect(studiedMs(1_000, 61_000, NOT_PAUSED)).toBe(60_000)
  })

  it('leaves out finished breaks', () => {
    expect(studiedMs(0, 100_000, { pausedMs: 30_000, pausedAt: null })).toBe(70_000)
  })

  it('stands still during the current break', () => {
    const pause = { pausedMs: 10_000, pausedAt: 50_000 }
    expect(studiedMs(0, 50_000, pause)).toBe(40_000)
    expect(studiedMs(0, 90_000, pause)).toBe(40_000)
  })

  it('never goes negative', () => {
    expect(studiedMs(10_000, 5_000, NOT_PAUSED)).toBe(0)
  })
})

describe('pausedUntil', () => {
  it('counts the current break up to the given moment', () => {
    expect(pausedUntil({ pausedMs: 5_000, pausedAt: 20_000 }, 26_000)).toBe(11_000)
  })
})

describe('liveSpan', () => {
  const at = (startedAt: number, pause: PauseState, stoppedAt: number | null, now: number) => {
    const { since, frozenAt } = liveSpan(startedAt, pause, stoppedAt)
    return (frozenAt ?? now) - since
  }

  it('matches studiedMs while studying, on a break, and after Stop', () => {
    const cases: [PauseState, number | null][] = [
      [NOT_PAUSED, null],
      [{ pausedMs: 30_000, pausedAt: null }, null],
      [{ pausedMs: 10_000, pausedAt: 50_000 }, null],
      [{ pausedMs: 10_000, pausedAt: null }, 80_000],
      [{ pausedMs: 10_000, pausedAt: 50_000 }, 80_000],
    ]
    for (const [pause, stoppedAt] of cases) {
      for (const now of [60_000, 90_000, 200_000]) {
        const end = stoppedAt ?? now
        expect(at(1_000, pause, stoppedAt, now)).toBe(studiedMs(1_000, end, pause))
      }
    }
  })

  it('stands still on a break and after Stop', () => {
    expect(liveSpan(0, { pausedMs: 0, pausedAt: 40_000 }, null).frozenAt).toBe(40_000)
    expect(liveSpan(0, NOT_PAUSED, 70_000).frozenAt).toBe(70_000)
    expect(liveSpan(0, NOT_PAUSED, null).frozenAt).toBeNull()
  })
})
