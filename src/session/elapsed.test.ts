import { describe, expect, it } from 'vitest'
import { NOT_PAUSED, pausedUntil, studiedMs } from './elapsed'

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
