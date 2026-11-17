// Every network call the competition makes. The browser talks straight to
// Postgres through Neon's Data API: the SDK attaches the signed-in user's JWT,
// and the policies in db/migrations decide what that user may do.

import { createClient } from '@neondatabase/neon-js'
import { listSessions, type SessionMeta } from '../db'
import { summarizeFocus } from '../focus/types'
import { localDay, type DailyTotal } from './stats'

const neon = createClient({
  auth: { url: import.meta.env.VITE_NEON_AUTH_URL },
  dataApi: { url: import.meta.env.VITE_NEON_DATA_API_URL },
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

// Leaves the page for Google, then returns to the tab it left from (Compete
// unless told otherwise). Anything already in the URL, like an invite code,
// survives the round trip.
export async function signIn(tab: 'compete' | 'room' = 'compete'): Promise<void> {
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

export async function addFriend(code: string): Promise<string> {
  const { data, error } = await neon.rpc('add_friend', { code })
  if (error) fail(error)
  return data as string
}

// Group study (db/migrations/010): a session studied together, live.
export interface RoomPreview {
  hostName: string
  members: number
  started: boolean
  joined: boolean
  expired: boolean
}

export interface RoomMember {
  id: string
  name: string
  avatar: string | null
  isHost: boolean
  here: boolean // has the lobby or a session open
  liveSince: number | null // start of a session running now
  bankedMs: number // time already studied in this group study
}

export interface RoomState {
  hostName: string
  startedAt: number | null
  members: RoomMember[]
}

export async function createRoom(): Promise<string> {
  const { data, error } = await neon.rpc('create_room')
  if (error) fail(error)
  return data as string
}

export async function roomPreview(code: string): Promise<RoomPreview | null> {
  const { data, error } = await neon.rpc('room_preview', { room_code: code })
  if (error) fail(error)
  const row = (
    data as { host_name: string; members: number; started: boolean; joined: boolean; expired: boolean }[]
  )[0]
  return row
    ? { hostName: row.host_name, members: row.members, started: row.started, joined: row.joined, expired: row.expired }
    : null
}

// Joins, and connects with everyone in the room. Returns how many new friends.
export async function joinRoom(code: string): Promise<number> {
  const { data, error } = await neon.rpc('join_room', { room_code: code })
  if (error) fail(error)
  return data as number
}

export async function roomState(code: string): Promise<RoomState> {
  const { data, error } = await neon.rpc('room_state', { room_code: code })
  if (error) fail(error)
  const rows = data as {
    user_id: string
    display_name: string
    avatar: string | null
    is_host: boolean
    here: boolean
    live_since: string | null
    banked_ms: number | string
    host_name: string
    started_at: string | null
  }[]
  return {
    hostName: rows[0]?.host_name ?? '',
    startedAt: rows[0]?.started_at ? Date.parse(rows[0].started_at) : null,
    members: rows.map((r) => ({
      id: r.user_id,
      name: r.display_name,
      avatar: r.avatar,
      isHost: r.is_host,
      here: r.here,
      liveSince: r.live_since ? Date.parse(r.live_since) : null,
      bankedMs: Number(r.banked_ms),
    })),
  }
}

export async function startRoom(code: string): Promise<void> {
  const { error } = await neon.rpc('start_room', { room_code: code })
  if (error) fail(error)
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

// "I'm in a session that started at studyingSince" (null: not anymore).
// Friends see a green dot on Compete while the last beat is under 90 s old.
export async function liveBeat(studyingSince: number | null): Promise<void> {
  const { error } = await neon.rpc('live_beat', {
    studying: studyingSince === null ? null : new Date(studyingSince).toISOString(),
  })
  if (error) fail(error)
}

// Ids of you and your friends who are in a session right now.
export async function studyingNow(): Promise<Set<string>> {
  const { data, error } = await neon.rpc('studying_now')
  if (error) fail(error)
  return new Set((data as { user_id: string }[]).map((r) => r.user_id))
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

// Experimental: on-task time from the session's current analysis, or null if
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
