import { describe, expect, it } from 'vitest'
import { ackMessage, doneMessage, partnerOrigin, readMessage, sessionMessage, settingsMessage } from './move'

const ID = '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9a2b3c'
const meta = { id: ID, startedAt: 1_795_000_000_000, task: 'chem', goalMs: 0, elapsedMs: 60_000, hasClip: true }

describe('partnerOrigin', () => {
  it('pairs the two addresses and nothing else', () => {
    expect(partnerOrigin('https://timelapse.study')).toBe('https://calenduel.com')
    expect(partnerOrigin('https://calenduel.com')).toBe('https://timelapse.study')
    for (const other of ['https://www.calenduel.com', 'https://calenduel.com.evil.example',
      'http://calenduel.com', 'https://evil.example', 'null']) {
      expect(partnerOrigin(other)).toBeNull()
    }
  })
})

describe('readMessage', () => {
  it('reads back what the sender builds', () => {
    const clip = new Blob(['x'], { type: 'video/mp4' })
    const read = readMessage(sessionMessage(meta, clip))
    expect(read).toMatchObject({ kind: 'session', meta: { ...meta, hasClip: true } })
    expect(read?.kind === 'session' && read.clip).toBe(clip)
    expect(readMessage(ackMessage(ID))).toMatchObject({ kind: 'ack', id: ID })
    expect(readMessage(doneMessage())).toMatchObject({ kind: 'done' })
    expect(readMessage(settingsMessage([{ name: 'Math 1D', about: 'calc' }], true)))
      .toMatchObject({ kind: 'settings', subjects: [{ name: 'Math 1D', about: 'calc' }], ipadHelper: true })
  })

  it('says a session has a clip only when one came with it', () => {
    const read = readMessage(sessionMessage(meta, null))
    expect(read?.kind === 'session' && read.meta.hasClip).toBe(false)
    const empty = readMessage(sessionMessage(meta, new Blob([])))
    expect(empty?.kind === 'session' && empty.meta.hasClip).toBe(false)
  })

  it('refuses anything that is not one of its own messages', () => {
    for (const bad of [null, 'done', 42, {}, { kind: 'done' }, { app: 'other', kind: 'done' },
      { app: 'calenduel-move', kind: 'nope' }, { app: 'calenduel-move', kind: 'ack' }]) {
      expect(readMessage(bad)).toBeNull()
    }
  })

  it('refuses a session with a bad id, time or name', () => {
    const session = (m: unknown) => readMessage({ app: 'calenduel-move', kind: 'session', meta: m, clip: null })
    expect(session({ ...meta, id: 'sessions' })).toBeNull()
    expect(session({ ...meta, id: 7 })).toBeNull()
    expect(session({ ...meta, startedAt: 'now' })).toBeNull()
    expect(session({ ...meta, elapsedMs: -1 })).toBeNull()
    expect(session({ ...meta, elapsedMs: Infinity })).toBeNull()
    expect(session({ ...meta, task: null })).toBeNull()
    expect(session(null)).toBeNull()
  })

  it('keeps only the fields a session has, and caps the name', () => {
    const read = readMessage({ app: 'calenduel-move', kind: 'session', clip: 'not a blob',
      meta: { ...meta, task: 'x'.repeat(500), goalMs: 'soon', extra: 'dropped', focus: 'nope', layout: {} } })
    if (read?.kind !== 'session') throw new Error('expected a session')
    expect(read.meta.task).toHaveLength(60)
    expect(read.meta.goalMs).toBe(0)
    expect(read.clip).toBeNull()
    expect(Object.keys(read.meta).sort()).toEqual(['elapsedMs', 'goalMs', 'hasClip', 'id', 'startedAt', 'task'])
  })

  it('drops subjects without a name and caps the rest', () => {
    const read = readMessage({ app: 'calenduel-move', kind: 'settings', ipadHelper: 'yes',
      subjects: [{ name: '  ' }, 'CS 10', { name: 'A'.repeat(200), about: 'b'.repeat(500) }] })
    if (read?.kind !== 'settings') throw new Error('expected settings')
    expect(read.ipadHelper).toBe(false)
    expect(read.subjects).toHaveLength(1)
    expect(read.subjects[0].name).toHaveLength(40)
    expect(read.subjects[0].about).toHaveLength(80)
  })
})
