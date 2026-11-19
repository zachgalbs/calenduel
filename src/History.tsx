import { useCallback, useEffect, useState } from 'react'
import {
  SESSION_NAME_MAX,
  deleteSession,
  getClip,
  listSessions,
  renameSession,
  type SessionMeta,
} from './db'
import { downloadBlob, timelapseName } from './media/share'
import './History.css'
import FocusScore from './focus/FocusScore'
import SubjectField, { SubjectOptions } from './subjects/SubjectField'
import RecheckAll from './focus/RecheckAll' // one-time, 2026-11-13
import { SUBJECTS_CHANGED, savedNames, sortSessions } from './subjects/sort'
import { knownSubjects } from './subjects/subjects'
import {
  PILE,
  UNSORTED,
  bookSeed,
  latestBook,
  shelfBooks,
  splitShelf,
  type Book,
} from './subjects/shelf'
import { addDays, localDay } from './compete/stats'

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function formatTimeOfDay(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .replace(' AM', ' am')
    .replace(' PM', ' pm')
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function SessionCard({ session, subjects, onChanged }: {
  session: SessionMeta
  subjects: string[]
  onChanged: () => void
}) {
  const [playing, setPlaying] = useState(false)
  const [clipUrl, setClipUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [name, setName] = useState(session.task)

  useEffect(() => {
    return () => { if (clipUrl) URL.revokeObjectURL(clipUrl) }
  }, [clipUrl])

  async function handlePlay() {
    if (clipUrl) {
      setPlaying(true)
      return
    }
    setLoading(true)
    const blob = await getClip(session.id)
    setLoading(false)
    if (!blob) return
    setClipUrl(URL.createObjectURL(blob))
    setPlaying(true)
  }

  async function handleDownload() {
    const blob = clipUrl
      ? await fetch(clipUrl).then((r) => r.blob())
      : await getClip(session.id)
    if (blob) downloadBlob(blob, timelapseName(blob, name.trim() || session.task))
  }

  async function handleDelete() {
    setDeleteError(null)
    // Server first: if this fails, the session is still here to retry, rather
    // than gone locally while still counting toward the competition.
    try {
      const { deleteUploadedSession } = await import('./compete/api')
      await deleteUploadedSession(session.id)
    } catch {
      setDeleteError("Couldn't remove this from what your friends see. Try again.")
      return
    }
    await deleteSession(session.id)
    onChanged()
  }

  // Saved when the field loses focus. Clearing it puts the old name back
  // rather than leaving a session with no name.
  async function handleRename() {
    const next = name.trim() || session.task
    setName(next)
    if (next === session.task) return
    await renameSession(session.id, next)
    onChanged()
    void sortSessions() // a guessed subject was for the old name
  }

  const metPct = session.goalMs > 0
    ? Math.round((session.elapsedMs / session.goalMs) * 100)
    : 0

  return (
    <li className="history-card">
      {playing && clipUrl ? (
        <div className="history-player">
          <video
            src={clipUrl}
            controls
            autoPlay
            onEnded={() => setPlaying(false)}
          />
        </div>
      ) : session.hasClip ? (
        <button
          type="button"
          className="history-play"
          onClick={handlePlay}
          disabled={loading}
        >
          {loading ? '...' : '▶'}
        </button>
      ) : null}

      <div className="history-info">
        <input
          className="history-task"
          aria-label="Session name"
          maxLength={SESSION_NAME_MAX}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <p className="history-meta">
          {formatDate(session.startedAt)} · {formatTimeOfDay(session.startedAt)}
        </p>
        <p className="history-subject">
          <SubjectField session={session} subjects={subjects} />
        </p>
        <p className="history-stats">
          <span className="history-duration">{formatDuration(session.elapsedMs)}</span>
          {session.goalMs > 0 && (
            <span className={metPct >= 100 ? 'history-goal met' : 'history-goal'}>
              {metPct >= 100 ? '✓ ' : ''}{metPct}% of goal
            </span>
          )}
        </p>
        {deleteError && <p className="history-error" role="alert">{deleteError}</p>}
      </div>

      <div className="history-actions">
        {session.hasClip && (
          <button type="button" className="history-btn" onClick={handleDownload}>
            Save
          </button>
        )}
        <button type="button" className="history-btn danger" onClick={handleDelete}>
          Delete
        </button>
      </div>
      <FocusScore session={session} onChanged={onChanged} />
    </li>
  )
}

// Spines in muted bindings; a book keeps its colour and height for good.
const BINDINGS = ['#4f8a5b', '#a8884b', '#6d7f96', '#8b7aa0', '#b07a5e', '#5f8c8a', '#9a6b7c', '#5b6d8f']

function spineTime(ms: number): string {
  const min = Math.round(ms / 60_000)
  return min >= 60 ? `${Math.round(min / 60)}h` : `${min}m`
}

function totalTime(ms: number): string {
  const min = Math.round(ms / 60_000)
  const h = Math.floor(min / 60)
  return h > 0 ? `${h}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`
}

// "Today", "Yesterday", "Tuesday", or "Nov 12".
function whenLabel(ms: number): string {
  const day = localDay(ms)
  const today = localDay(Date.now())
  if (day === today) return 'Today'
  if (day === addDays(today, -1)) return 'Yesterday'
  const d = new Date(ms)
  return day > addDays(today, -7)
    ? d.toLocaleDateString([], { weekday: 'long' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function Shelf({ books, pile, open, onOpen }: {
  books: Book[]
  pile: Book[]
  open: string | null
  onOpen: (key: string) => void
}) {
  const most = Math.max(...books.map((b) => b.ms), 1)
  // Each book its own binding: its usual one if it's free, else the next free.
  const taken = new Set<number>()
  const binding = new Map<string, string>()
  for (const b of [...books, ...pile]) {
    if (b.key === UNSORTED) continue
    let i = bookSeed(b.key) % BINDINGS.length
    for (let n = 0; n < BINDINGS.length && taken.has(i); n++) i = (i + 1) % BINDINGS.length
    taken.add(i)
    binding.set(b.key, BINDINGS[i])
  }
  return (
    <div className="shelf">
      <div className="shelf-books">
        {books.map((b) => {
          const seed = bookSeed(b.key)
          const unsorted = b.key === UNSORTED
          const label = b.name ?? 'Unsorted'
          return (
            <button
              key={b.key}
              type="button"
              className="shelf-book"
              data-open={b.key === open}
              data-unsorted={unsorted}
              aria-pressed={b.key === open}
              aria-label={`${label}, ${totalTime(b.ms)}, ${b.sessions.length} ${b.sessions.length === 1 ? 'session' : 'sessions'}`}
              onClick={() => onOpen(b.key)}
              style={{
                width: Math.round(30 + 64 * Math.sqrt(b.ms / most)),
                height: 168 + (seed % 48),
                background: binding.get(b.key),
              }}
            >
              <span className="shelf-title">{label}</span>
              <span className="shelf-hours">{spineTime(b.ms)}</span>
            </button>
          )
        })}
        {/* The small subjects, lying flat: a pile you open like a book. */}
        {pile.length > 0 && (
          <button
            type="button"
            className="shelf-pile"
            data-open={open === PILE}
            aria-pressed={open === PILE}
            aria-label={`Everything else: ${pile.map((b) => b.name ?? 'Unsorted').join(', ')}`}
            onClick={() => onOpen(PILE)}
          >
            {pile.slice(0, 7).map((b, i) => (
              <span
                key={b.key}
                className="shelf-flat"
                data-unsorted={b.key === UNSORTED}
                style={{
                  background: binding.get(b.key),
                  width: 58 + (bookSeed(b.key) % 22),
                  marginLeft: i % 2 ? 6 : 0,
                }}
              />
            ))}
          </button>
        )}
      </div>
      <div className="shelf-board" aria-hidden="true" />
    </div>
  )
}

// A session, folded to one line until you open it.
function SessionRow({ session, subjects, onChanged, subject }: {
  session: SessionMeta
  subjects: string[]
  onChanged: () => void
  // Shown in the pile, where sessions from several subjects sit together.
  subject?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className="book-session" data-open={open}>
      <button
        type="button"
        className="book-line"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="book-name">{session.task}</span>
        {subject && <span className="book-subject">{subject}</span>}
        <span className="book-when">{whenLabel(session.startedAt)}</span>
        <span className="book-length">{totalTime(session.elapsedMs)}</span>
      </button>
      {open && (
        <ul className="history-list">
          <SessionCard session={session} subjects={subjects} onChanged={onChanged} />
        </ul>
      )}
    </li>
  )
}

export default function History() {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)

  const refresh = useCallback(async () => {
    setSessions(await listSessions())
  }, [])

  // refresh() only setStates after its await, so this is an async data fetch,
  // not a synchronous cascading render — same pattern as App's auto-load.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { refresh() }, [refresh])

  // Subjects change in the background (the sorter) and from the field itself.
  useEffect(() => {
    window.addEventListener(SUBJECTS_CHANGED, refresh)
    void sortSessions()
    return () => window.removeEventListener(SUBJECTS_CHANGED, refresh)
  }, [refresh])
  const subjects = sessions ? knownSubjects(sessions, savedNames()) : []
  const allBooks = sessions ? shelfBooks(sessions, subjects) : []
  const { standing, pile } = splitShelf(allBooks)
  // The pile, opened, reads like one more book holding all its sessions.
  const pileBook: Book | null =
    pile.length > 0
      ? {
          key: PILE,
          name: 'Everything else',
          ms: pile.reduce((sum, b) => sum + b.ms, 0),
          sessions: pile.flatMap((b) => b.sessions).sort((a, b) => b.startedAt - a.startedAt),
        }
      : null
  const subjectFor = new Map(pile.flatMap((b) => b.sessions.map((s) => [s.id, b.name ?? 'Unsorted'] as const)))
  // Opens on the book you studied in last; a choice holds while it exists.
  const [picked, setPicked] = useState<string | null>(null)
  const openable = [...standing, ...(pileBook ? [pileBook] : [])]
  const latest = latestBook(allBooks)
  const openKey = openable.some((b) => b.key === picked)
    ? picked
    : pile.some((b) => b.key === latest)
      ? PILE
      : latest
  const book = openable.find((b) => b.key === openKey) ?? null

  return (
    <main className="history">
      <h1>Sessions</h1>

      {sessions === null && <p className="history-hint">Loading...</p>}

      {sessions !== null && sessions.length === 0 && (
        <p className="history-hint">No sessions yet. Complete a study session to see it here.</p>
      )}

      {sessions !== null && <RecheckAll sessions={sessions} />}

      {allBooks.length > 0 && (
        <Shelf books={standing} pile={pile} open={openKey} onOpen={setPicked} />
      )}

      {book && (
        <section className="book" aria-label={book.name ?? 'Unsorted'}>
          <header className="book-head">
            <h2>{book.name ?? 'Unsorted'}</h2>
            <span>
              {totalTime(book.ms)} · {book.sessions.length}{' '}
              {book.sessions.length === 1 ? 'session' : 'sessions'}
            </span>
          </header>
          <ul className="book-sessions">
            {book.sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                subjects={subjects}
                onChanged={refresh}
                subject={book.key === PILE ? subjectFor.get(s.id) : undefined}
              />
            ))}
          </ul>
        </section>
      )}
      <SubjectOptions subjects={subjects} />
    </main>
  )
}
