import type { SessionMeta } from '../db'
import { subjectKey, subjectOf } from './subjects'

// The Sessions page as a bookshelf: one book per subject, all time. Pure, so
// the page only draws what this works out.

export interface Book {
  key: string // the subject's key, or UNSORTED
  name: string | null // null: sessions without a subject yet
  ms: number
  sessions: SessionMeta[] // newest first
}

export const UNSORTED = '__unsorted__'

// Most studied first; the unsorted pile always at the end of the shelf.
// `spellings` (from knownSubjects) names each book the way you write it.
export function shelfBooks(sessions: SessionMeta[], spellings: string[] = []): Book[] {
  const books = new Map<string, Book>()
  for (const s of [...sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    const name = subjectOf(s)?.name ?? null
    const key = name === null ? UNSORTED : subjectKey(name)
    const spelled = name === null ? null : (spellings.find((n) => subjectKey(n) === key) ?? name)
    const book = books.get(key) ?? { key, name: spelled, ms: 0, sessions: [] }
    book.ms += s.elapsedMs
    book.sessions.push(s)
    books.set(key, book)
  }
  return [...books.values()].sort(
    (a, b) => Number(a.key === UNSORTED) - Number(b.key === UNSORTED) || b.ms - a.ms,
  )
}

// The book to open first: whichever holds your latest session.
export function latestBook(books: Book[]): string | null {
  let best: { key: string; at: number } | null = null
  for (const b of books) {
    const at = b.sessions[0]?.startedAt ?? 0
    if (!best || at > best.at) best = { key: b.key, at }
  }
  return best?.key ?? null
}

// A small, steady number from a subject's key, so each book keeps its own
// height and colour from visit to visit instead of reshuffling.
export function bookSeed(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// A subject needs this much time, all told, to get a book. Less than that and
// it lies flat in a small pile at the end of the shelf. A fixed amount rather
// than a share, so a subject never drops off as the others grow.
export const BOOK_MIN_MS = 60 * 60_000
export const PILE = '__pile__'

export function splitShelf(books: Book[], minMs = BOOK_MIN_MS): { standing: Book[]; pile: Book[] } {
  const standing = books.filter((b) => b.ms >= minMs)
  const pile = books.filter((b) => b.ms < minMs)
  // Nothing has an hour yet: everything stands, rather than an empty shelf.
  return standing.length > 0 ? { standing, pile } : { standing: books, pile: [] }
}
