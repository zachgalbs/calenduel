// Every network call the competition makes. The browser talks straight to
// Postgres through Neon's Data API: the SDK attaches the signed-in user's JWT,
// and the policies in db/migrations decide what that user may do.

import { createClient } from '@neondatabase/neon-js'
import { listSessions, type SessionMeta } from '../db'
import { summarizeFocus } from '../focus/types'
import { localDay, type DailyTotal, type LiveSession } from './stats'

// The headers of the last Data API request (the token among them), kept so a
// closing page can still send one last request: by then there's no time to
// fetch a token. See leaveOnExit.
let lastHeaders: HeadersInit | undefined
const remembering: typeof fetch = (input, init) => {
  lastHeaders = init?.headers
  return fetch(input, init)
}

const neon = createClient({
  // Signed out, requests carry an anonymous token, which reaches only the
  // guest functions of db/migrations/014: a room link works without signing in.
  auth: { url: import.meta.env.VITE_NEON_AUTH_URL, allowAnonymous: true },
  dataApi: {
    url: import.meta.env.VITE_NEON_DATA_API_URL,
    options: { global: { fetch: remembering } },
  },
})

// The database refuses longer sessions, so don't keep offering them.
const MAX_SESSION_MS = 24 * 60 * 60 * 1000
const UNIQUE_VIOLATION = '23505'

export interface Profile {
  id: string
  name: string
  inviteCode: string
  avatar: string | null // a small JPEG data URL
}

export interface Friend {
  id: string
  name: string
  avatar: string | null
  since: string // YYYY-MM-DD: the head-to-head record starts here
}

export interface FriendSession {
  id: string
  startedAt: string
  elapsedMs: number
}

// PostgREST and auth errors are plain objects, not Error instances.
function fail(error: { message?: string }): never {
  throw new Error(error.message ?? 'Something went wrong. Please try again.')
}

export async function isSignedIn(): Promise<boolean> {
  const { data, error } = await neon.auth.getSession()
  if (error) fail(error)
  return Boolean(data?.session)
}

export async function focusToken(): Promise<string | null> {
  const { data, error } = await neon.auth.getSession()
  if (error) fail(error)
  return data?.session?.token ?? null
}

// Leaves the page for Google, then returns to the tab it left from (Friends
// unless told otherwise). Anything already in the URL, like an invite code,
// survives the round trip.
export async function signIn(tab: 'friends' | 'timer' | 'account' = 'friends'): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  params.set('tab', tab)
  const { error } = await neon.auth.signIn.social({
    provider: 'google',
    callbackURL: `${window.location.origin}/?${params}`,
  })
  if (error) fail(error)
}

export async function signOut(): Promise<void> {
  const { error } = await neon.auth.signOut()
  if (error) fail(error)
}

export async function ensureProfile(): Promise<Profile> {
  const { data, error } = await neon.rpc('ensure_profile').single()
  if (error) fail(error)
  const row = data as {
    user_id: string
    display_name: string
    invite_code: string
    avatar: string | null
  }
  return {
    id: row.user_id,
    name: row.display_name,
    inviteCode: row.invite_code,
    avatar: row.avatar,
  }
}

// Sets or, with null, removes the caller's picture. The policy in
// db/migrations only lets this reach the caller's own row, whatever id is sent.
export async function setAvatar(userId: string, avatar: string | null): Promise<void> {
  const { error } = await neon.from('profiles').update({ avatar }).eq('user_id', userId)
  if (error) fail(error)
}

export async function listFriends(): Promise<Friend[]> {
  const { data: links, error } = await neon
    .from('friendships')
    .select('friend_id, since')
  if (error) fail(error)
  const rows = links as { friend_id: string; since: string }[]
  if (rows.length === 0) return []

  const { data: profiles, error: profileError } = await neon
    .from('profiles')
    .select('user_id, display_name, avatar')
    .in('user_id', rows.map((r) => r.friend_id))
  if (profileError) fail(profileError)

  const byId = new Map(
    (
      profiles as { user_id: string; display_name: string; avatar: string | null }[]
    ).map((p) => [p.user_id, p]),
  )
  return rows.map((r) => ({
    id: r.friend_id,
    name: byId.get(r.friend_id)?.display_name ?? 'Unknown',
    avatar: byId.get(r.friend_id)?.avatar ?? null,
    since: r.since,
  }))
}

// Study rooms (db/migrations/010, 013, 014): every signed-in session is in
// one, friends can join it, and anyone with your ?with= link can sit in, as a
// guest if signed out. A room disbands when the last person leaves.

// Someone at a study table; live = their lamp is lit.
export interface TableSeat {
  id: string
  name: string
  avatar: string | null
  live: boolean
}

// Who's at the table of a room you're in, or null once it has disbanded.
export async function roomPeek(code: string): Promise<TableSeat[] | null> {
  const { data, error } = await neon.rpc('room_peek', { room_code: code })
  if (error) fail(error)
  return data ? (data as { people: TableSeat[] }).people : null
}

// What a ?with=<username> link leads to: who that is, and while they're in a
// session, their room and its table. Open to anyone holding the link.
export interface PersonPeek {
  name: string
  avatar: string | null
  isMe: boolean
  room: string | null // null: not in a session right now
  joined: boolean // you (or this browser's guest) are at that table already
  people: TableSeat[]
}

export async function personPeek(username: string, guestSecret: string | null): Promise<PersonPeek | null> {
  const { data, error } = await neon.rpc('person_peek', { username, guest_secret: guestSecret })
  if (error) fail(error)
  const row = data as {
    name: string
    avatar: string | null
    is_me: boolean
    room: string | null
    joined: boolean
    people: TableSeat[]
  } | null
  return row
    ? { name: row.name, avatar: row.avatar, isMe: row.is_me, room: row.room, joined: row.joined, people: row.people }
    : null
}

// Your username, which is also your name everywhere and your link. Returns it
// as stored (lowercase); throws with the reason if it's taken or malformed.
export async function setUsername(username: string): Promise<string> {
  const { data, error } = await neon.rpc('set_username', { username })
  if (error) fail(error)
  return data as string
}

// The link that brings someone to study with you.
export function personLink(username: string): string {
  return `${window.location.origin}/?with=${encodeURIComponent(username)}`
}

// Guests: signed out, at a friend's table. The secret is this browser's own
// (see room/guest.ts); the returned id is the one everyone else sees.
export async function guestJoin(code: string, secret: string): Promise<string> {
  const { data, error } = await neon.rpc('guest_join', { room_code: code, guest_secret: secret })
  if (error) fail(error)
  return data as string
}

export async function guestBeat(code: string, secret: string, studyingSince: number | null): Promise<void> {
  const { error } = await neon.rpc('guest_beat', {
    room_code: code,
    guest_secret: secret,
    studying: studyingSince === null ? null : new Date(studyingSince).toISOString(),
  })
  if (error) fail(error)
}

// Leaves a study room as the page closes, so the others see you go at once
// rather than after 90 s. keepalive lets the request outlive the page.
// Synchronous, with the token from the last request: there's no time to wait.
export function leaveOnExit(code: string, guestSecret: string | null): void {
  if (!lastHeaders) return
  const headers = new Headers(lastHeaders)
  headers.set('Content-Type', 'application/json')
  const [fn, body] = guestSecret
    ? ['guest_leave', { room_code: code, guest_secret: guestSecret }]
    : ['leave_room', { room_code: code }]
  void fetch(`${import.meta.env.VITE_NEON_DATA_API_URL}/rpc/${fn}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {})
}

export async function guestLeave(code: string, secret: string): Promise<void> {
  const { error } = await neon.rpc('guest_leave', { room_code: code, guest_secret: secret })
  if (error) fail(error)
}

export async function createRoom(): Promise<string> {
  const { data, error } = await neon.rpc('create_room')
  if (error) fail(error)
  return data as string
}

// Joins, and connects with everyone in the room. Returns how many new friends.
export async function joinRoom(code: string): Promise<number> {
  const { data, error } = await neon.rpc('join_room', { room_code: code })
  if (error) fail(error)
  return data as number
}

// "I'm here", with the start of my running session, or null between sessions.
export async function roomBeat(code: string, studyingSince: number | null): Promise<void> {
  const { error } = await neon.rpc('room_beat', {
    room_code: code,
    studying: studyingSince === null ? null : new Date(studyingSince).toISOString(),
  })
  if (error) fail(error)
}

export async function leaveRoom(code: string): Promise<void> {
  const { error } = await neon.rpc('leave_room', { room_code: code })
  if (error) fail(error)
}

// "I'm in a session" (see db/migrations/012, 013), or null: not anymore.
// Friends see the time count up on Compete, the green dot while it isn't
// frozen, and a Join button while it has a room.
export interface LiveBeat {
  since: number
  frozenAt: number | null
  day: string
  startedAt: number
  room: string | null
}

export async function liveBeat(beat: LiveBeat | null): Promise<void> {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
  // All five, always: the Data API picks the overload by the names sent.
  const { error } = await neon.rpc('live_beat', {
    studying: iso(beat?.since ?? null),
    frozen: iso(beat?.frozenAt ?? null),
    on_day: beat?.day ?? null,
    started: iso(beat?.startedAt ?? null),
    room_code: beat?.room ?? null,
  })
  if (error) fail(error)
}

// You and your friends in a session right now, with how far each has got.
export async function liveTimes(): Promise<LiveSession[]> {
  const { data, error } = await neon.rpc('live_times')
  if (error) fail(error)
  return (
    data as {
      user_id: string
      studying_since: string
      frozen_at: string | null
      day: string | null
    }[]
  ).map((r) => ({
    userId: r.user_id,
    since: Date.parse(r.studying_since),
    frozenAt: r.frozen_at === null ? null : Date.parse(r.frozen_at),
    day: r.day,
  }))
}

// Friends in a session right now, and the study room to join each one in.
export async function joinableRooms(): Promise<Map<string, string>> {
  const { data, error } = await neon.rpc('joinable_rooms')
  if (error) fail(error)
  return new Map((data as { user_id: string; room_code: string }[]).map((r) => [r.user_id, r.room_code]))
}

export async function removeFriend(friendId: string): Promise<void> {
  const { error } = await neon.rpc('remove_friend', { friend: friendId })
  if (error) fail(error)
}

export async function fetchDailyTotals(): Promise<DailyTotal[]> {
  const { data, error } = await neon.rpc('daily_totals')
  if (error) fail(error)
  return (
    data as {
      user_id: string
      day: string
      total_ms: number
      focus_ms: number
      analyzed_ms: number
    }[]
  ).map((r) => ({
    userId: r.user_id,
    day: r.day,
    totalMs: r.total_ms,
    focusMs: r.focus_ms,
    analyzedMs: r.analyzed_ms,
  }))
}

// The server returns at most this many, newest first.
export const FRIEND_SESSION_LIMIT = 50

export async function fetchFriendSessions(friendId: string): Promise<FriendSession[]> {
  const { data, error } = await neon.rpc('friend_sessions', { friend: friendId })
  if (error) fail(error)
  return (data as { id: string; started_at: string; elapsed_ms: number }[]).map(
    (r) => ({ id: r.id, startedAt: r.started_at, elapsedMs: r.elapsed_ms }),
  )
}

// On-task time from the session's current analysis, or null if
// it hasn't been analyzed under its current name. Capped at the uploaded length.
function focusMs(s: SessionMeta): number | null {
  if (!s.focus || s.focus.task !== s.task) return null
  return Math.min(Math.round(summarizeFocus(s.focus.samples).onMs), Math.round(s.elapsedMs))
}

// Uploads local sessions the server doesn't have yet and returns how many it
// couldn't upload. Anything missed is retried next time, so a session recorded
// offline or before signing in still counts. Only times are sent, never clips
// or names.
export async function syncSessions(): Promise<number> {
  if (!(await isSignedIn())) return 0

  const { data, error } = await neon.from('study_sessions').select('id, focus_ms')
  if (error) fail(error)
  const uploaded = new Map(
    (data as { id: string; focus_ms: number | null }[]).map((r) => [r.id, r.focus_ms]),
  )

  const local = (await listSessions()).filter((s) => s.elapsedMs <= MAX_SESSION_MS)
  const pending = local.filter((s) => !uploaded.has(s.id))

  // Analysis, corrections and renames all happen after upload. A failed update
  // is simply tried again next time: it can't stop the session counting.
  await Promise.all(
    local
      .filter((s) => uploaded.has(s.id) && uploaded.get(s.id) !== focusMs(s))
      .map((s) =>
        neon.from('study_sessions').update({ focus_ms: focusMs(s) }).eq('id', s.id),
      ),
  )

  // One at a time, because a batch insert would let a single rejected session
  // stop all the others from counting.
  const results = await Promise.all(
    pending.map((s) =>
      neon.from('study_sessions').insert({
        id: s.id,
        day: localDay(s.startedAt),
        started_at: new Date(s.startedAt).toISOString(),
        elapsed_ms: Math.round(s.elapsedMs),
        focus_ms: focusMs(s),
      }),
    ),
  )
  // A duplicate means another tab beat this one to it, which is still a success.
  return results.filter((r) => r.error && r.error.code !== UNIQUE_VIOLATION).length
}

// The database only accepts this much, so the box stops there too.
export const MAX_FEEDBACK_LENGTH = 2000

// Write-only: the database takes the message and the sender from the token,
// and nobody can read feedback back through the app.
export async function sendFeedback(message: string): Promise<void> {
  const { error } = await neon.from('feedback').insert({ message: message.trim() })
  if (error) fail(error)
}

// Takes a deleted session out of the competition. Throws on failure so the
// caller can keep the local copy rather than leave a phantom score behind.
export async function deleteUploadedSession(id: string): Promise<void> {
  if (!(await isSignedIn())) return
  const { error } = await neon.from('study_sessions').delete().eq('id', id)
  if (error) fail(error)
}
