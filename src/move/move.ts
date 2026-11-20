// The app answers at two addresses, calenduel.com and timelapse.study, and a
// browser keeps what each one saved to itself: sessions made at one (their
// recordings, names, subjects and focus scores) don't show at the other. This
// carries them across inside the browser. The address that has them opens in a
// small window and hands them to the page that asked. Nothing goes through a
// server, and the sessions stay where they were too.
//
// Each side talks only to its partner address. The sender posts to that origin
// and no other, so another site that opens the window is sent nothing; the
// receiver takes messages only from the window it opened, at that origin.
// It depends on window.opener, so vercel.json must not send a
// Cross-Origin-Opener-Policy header.
import { SESSION_NAME_MAX, type SessionMeta } from '../db'
import type { SavedSubject } from '../subjects/sort'
import { ABOUT_MAX, cleanSubject } from '../subjects/subjects'

const PARTNERS: Record<string, string> = {
  'https://timelapse.study': 'https://calenduel.com',
  'https://calenduel.com': 'https://timelapse.study',
  // Two local dev servers, to try it without the real sites.
  ...(import.meta.env.DEV
    ? { 'http://localhost:5173': 'http://127.0.0.1:5174', 'http://127.0.0.1:5174': 'http://localhost:5173' }
    : {}),
}

// The other address, or null where there isn't one (the www. names, previews).
export function partnerOrigin(origin: string = window.location.origin): string | null {
  return PARTNERS[origin] ?? null
}

// ?send=1 on the address that has the sessions: main.tsx shows SendSessions.
export const SEND_PARAM = 'send'

const APP = 'calenduel-move'

export type MoveMessage =
  | { app: typeof APP; kind: 'session'; meta: SessionMeta; clip: Blob | null }
  | { app: typeof APP; kind: 'ack'; id: string }
  | { app: typeof APP; kind: 'settings'; subjects: SavedSubject[]; ipadHelper: boolean }
  | { app: typeof APP; kind: 'done' }

export const sessionMessage = (meta: SessionMeta, clip: Blob | null): MoveMessage =>
  ({ app: APP, kind: 'session', meta, clip })
export const ackMessage = (id: string): MoveMessage => ({ app: APP, kind: 'ack', id })
export const settingsMessage = (subjects: SavedSubject[], ipadHelper: boolean): MoveMessage =>
  ({ app: APP, kind: 'settings', subjects, ipadHelper })
export const doneMessage = (): MoveMessage => ({ app: APP, kind: 'done' })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0

// What arrived, checked field by field, or null if it isn't one of ours. The
// partner runs this same code, but a message is still someone else's data.
export function readMessage(data: unknown): MoveMessage | null {
  if (!isObject(data) || data.app !== APP) return null
  switch (data.kind) {
    case 'session': {
      const m = data.meta
      if (!isObject(m) || typeof m.id !== 'string' || !UUID.test(m.id)) return null
      if (!isTime(m.startedAt) || !isTime(m.elapsedMs) || typeof m.task !== 'string') return null
      const clip = data.clip instanceof Blob && data.clip.size > 0 ? data.clip : null
      const meta: SessionMeta = {
        id: m.id.toLowerCase(),
        startedAt: m.startedAt,
        task: m.task.slice(0, SESSION_NAME_MAX),
        goalMs: isTime(m.goalMs) ? m.goalMs : 0,
        elapsedMs: m.elapsedMs,
        hasClip: clip !== null,
        ...(isObject(m.focus) ? { focus: m.focus as unknown as SessionMeta['focus'] } : {}),
        ...(Array.isArray(m.layout) ? { layout: m.layout as SessionMeta['layout'] } : {}),
        ...(isObject(m.subject) ? { subject: m.subject as unknown as SessionMeta['subject'] } : {}),
      }
      return { app: APP, kind: 'session', meta, clip }
    }
    case 'ack':
      return typeof data.id === 'string' ? { app: APP, kind: 'ack', id: data.id } : null
    case 'settings': {
      const subjects = (Array.isArray(data.subjects) ? data.subjects : []).flatMap((s): SavedSubject[] =>
        isObject(s) && typeof s.name === 'string' && cleanSubject(s.name)
          ? [{ name: cleanSubject(s.name), about: typeof s.about === 'string' ? s.about.slice(0, ABOUT_MAX) : '' }]
          : [],
      ).slice(0, 100)
      return { app: APP, kind: 'settings', subjects, ipadHelper: data.ipadHelper === true }
    }
    case 'done':
      return { app: APP, kind: 'done' }
    default:
      return null
  }
}
