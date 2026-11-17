import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  ensureProfile,
  groupPreview,
  groupRoom,
  isSignedIn,
  joinGroup,
  leaveGroup,
  myGroupCode,
  myGroups,
  renameGroup,
  signIn,
  type GroupPreview,
  type RoomMember,
  type StudyGroup,
} from '../compete/api'
import { formatStudyTime, localDay } from '../compete/stats'
import Avatar from '../Avatar'
import './Group.css'

// How often a room re-reads who's studying. Presence heartbeats every 15 s.
const ROOM_POLL_MS = 15_000

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`
}

// 1:05:09, the way the timer shows a running session.
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

// The ?group= code from a study group link, if this page was opened with one.
function linkedGroupCode(): string | null {
  return new URLSearchParams(window.location.search).get('group')
}

// A ticking clock, only while something on screen is live.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

// Shown when the page was opened from someone's group link. Joining shares your
// sessions with the whole group, so it takes a click, not just the link.
function GroupJoin({ code, onJoined }: { code: string; onJoined: () => void }) {
  const [preview, setPreview] = useState<GroupPreview | null | undefined>(undefined)
  const [joining, setJoining] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let closed = false
    groupPreview(code)
      .then((p) => {
        if (!closed) setPreview(p)
      })
      .catch((err) => {
        if (!closed) setError(errorText(err))
      })
    return () => {
      closed = true
    }
  }, [code])

  async function handleJoin() {
    setError(null)
    setJoining(true)
    try {
      const added = await joinGroup(code)
      setDone(
        added > 0
          ? `You're in, and now friends with ${plural(added, 'more person', 'more people')}.`
          : "You're in.",
      )
      window.history.replaceState(null, '', '/?tab=group')
      onJoined()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setJoining(false)
    }
  }

  if (done) return <p className="group-note group-flash" role="status">{done}</p>
  if (preview === undefined && !error) return null

  return (
    <section className="group-invite">
      {preview === null && <p className="group-note">This group link doesn't match any group.</p>}
      {preview?.joined && (
        <p className="group-note">You're already in {preview.ownerName}'s study group.</p>
      )}
      {preview && !preview.joined && (
        <>
          <p className="group-invite-title">Join {preview.ownerName}'s study group?</p>
          <p className="group-note">
            {plural(preview.members, 'person', 'people')} studying together. You'll
            see when each other are studying and how long, never what.
          </p>
          <button
            type="button"
            className="group-btn primary"
            onClick={handleJoin}
            disabled={joining}
          >
            {joining ? 'Joining...' : 'Join group'}
          </button>
        </>
      )}
      {error && <p className="group-error" role="alert">{error}</p>}
    </section>
  )
}

function MemberTile({
  member,
  me,
  top,
  now,
}: {
  member: RoomMember
  me: boolean
  top: boolean
  now: number
}) {
  const live = member.studyingSince !== null
  const liveMs = live ? now - member.studyingSince! : 0
  const total = member.todayMs + liveMs
  return (
    <li className={live ? 'member live' : 'member'}>
      <div className="member-face">
        <Avatar name={member.name} src={member.avatar} size={44} />
        {live && <span className="member-dot" aria-hidden="true" />}
      </div>
      <div className="member-name">
        {member.name}
        {me && <span className="member-you"> (you)</span>}
      </div>
      <div className="member-status">
        {live ? (
          <span className="member-live">
            Studying <span className="member-clock">{clock(liveMs)}</span>
          </span>
        ) : total > 0 ? (
          'Taking a break'
        ) : (
          'Not yet today'
        )}
      </div>
      <div className="member-total">
        {total > 0 ? formatStudyTime(total) : '—'}
        {top && <span className="member-top">Most today</span>}
      </div>
    </li>
  )
}

function Room({
  group,
  myId,
  onStudy,
  onChanged,
}: {
  group: StudyGroup
  myId: string
  onStudy: () => void
  onChanged: () => void
}) {
  const [members, setMembers] = useState<RoomMember[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState(group.name)
  const [confirmLeave, setConfirmLeave] = useState(false)

  const load = useCallback(async () => {
    try {
      setMembers(await groupRoom(group.id, localDay(Date.now())))
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [group.id])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data on mount
    void load()
    const timer = setInterval(() => void load(), ROOM_POLL_MS)
    // Back on the tab: catch up at once rather than on the next tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const studying = members?.filter((m) => m.studyingSince !== null).length ?? 0
  const now = useNow(studying > 0)
  const totalOf = (m: RoomMember) =>
    m.todayMs + (m.studyingSince !== null ? now - m.studyingSince : 0)
  const sorted = [...(members ?? [])].sort((a, b) => totalOf(b) - totalOf(a))
  const together = sorted.reduce((sum, m) => sum + totalOf(m), 0)
  const topId = sorted.length > 1 && totalOf(sorted[0]) > 0 ? sorted[0].id : null

  async function handleCopy() {
    const link = `${window.location.origin}/?group=${group.code}`
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError(`Couldn't copy the link. Here it is: ${link}`)
    }
  }

  async function handleRename(event: FormEvent) {
    event.preventDefault()
    try {
      await renameGroup(group.id, newName)
      setRenaming(false)
      onChanged()
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function handleLeave() {
    try {
      await leaveGroup(group.id)
      onChanged()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="room">
      <header className="room-head">
        {renaming ? (
          <form className="room-rename" onSubmit={handleRename}>
            <input
              className="group-input"
              aria-label="Group name"
              maxLength={40}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <button type="submit" className="group-btn">Save</button>
            <button type="button" className="group-link" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <h2 className="room-name">
            {group.name}
            {group.isOwner && (
              <button
                type="button"
                className="group-link room-rename-btn"
                onClick={() => {
                  setNewName(group.name)
                  setRenaming(true)
                }}
              >
                Rename
              </button>
            )}
          </h2>
        )}
        <span className={studying > 0 ? 'room-live on' : 'room-live'}>
          <span className="room-live-dot" aria-hidden="true" />
          {studying > 0 ? `${studying} studying now` : 'Nobody studying right now'}
        </span>
      </header>

      {members === null && !error && <p className="group-note">Loading...</p>}

      {members && (
        <>
          <ul className="members">
            {sorted.map((m) => (
              <MemberTile key={m.id} member={m} me={m.id === myId} top={m.id === topId} now={now} />
            ))}
          </ul>

          <div className="room-together">
            <span className="room-together-label">Together today</span>
            <span className="room-together-time">
              {together > 0 ? formatStudyTime(together) : '—'}
            </span>
          </div>
        </>
      )}

      {members?.length === 1 && (
        <p className="group-note">
          Just you so far. Copy the invite link and post it in your group chat.
        </p>
      )}

      <div className="room-actions">
        <button type="button" className="group-btn primary" onClick={onStudy}>
          Start studying
        </button>
        <button type="button" className="group-btn" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy invite link'}
        </button>
        {!group.isOwner &&
          (confirmLeave ? (
            <>
              <button type="button" className="group-link danger" onClick={handleLeave}>
                Leave {group.name}
              </button>
              <button type="button" className="group-link" onClick={() => setConfirmLeave(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="group-link" onClick={() => setConfirmLeave(true)}>
              Leave group
            </button>
          ))}
      </div>

      {error && <p className="group-error" role="alert">{error}</p>}
    </section>
  )
}

// The Group tab: each study group you're in, as a room you share. Collaborative
// first (your time adds up together), with who's put in the most today marked.
export default function Group({ onStudy }: { onStudy: () => void }) {
  // null = still finding out.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [myId, setMyId] = useState<string | null>(null)
  const [groups, setGroups] = useState<StudyGroup[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Read once: joining clears it from the URL, but the result should stay up.
  const [groupCode] = useState(linkedGroupCode)

  const refresh = useCallback(async () => {
    try {
      const active = await isSignedIn()
      setSignedIn(active)
      if (!active) return
      // Also makes sure the profile exists, which presence and groups need.
      const [profile, list] = await Promise.all([ensureProfile(), myGroups()])
      setMyId(profile.id)
      setGroups(list)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data on mount
    void refresh()
  }, [refresh])

  async function handleCreate() {
    setError(null)
    setCreating(true)
    try {
      await myGroupCode()
      await refresh()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setCreating(false)
    }
  }

  async function handleSignIn() {
    try {
      await signIn('group')
    } catch (err) {
      setError(errorText(err))
    }
  }

  const ownsOne = groups?.some((g) => g.isOwner) ?? false

  return (
    <main className="group">
      <h1>Group</h1>

      {error && <p className="group-error" role="alert">{error}</p>}
      {signedIn === null && !error && <p className="group-note">Loading...</p>}

      {signedIn === false && (
        <section className="group-empty">
          <p className="group-lead">
            Study together, wherever everyone is. See who's studying right now, and
            watch your hours add up as a group.
          </p>
          {groupCode && <p className="group-note">Sign in to join the study group you were sent.</p>}
          <button type="button" className="group-btn primary" onClick={handleSignIn}>
            Sign in with Google
          </button>
        </section>
      )}

      {signedIn && groupCode && <GroupJoin code={groupCode} onJoined={refresh} />}

      {signedIn && groups && myId && (
        <>
          {groups.map((g) => (
            <Room key={g.id} group={g} myId={myId} onStudy={onStudy} onChanged={refresh} />
          ))}

          {groups.length === 0 && (
            <section className="group-empty">
              <p className="group-lead">
                Start a study group and post its link in your group chat. Everyone
                who joins shows up here: who's studying right now, and your hours
                adding up together.
              </p>
              <button
                type="button"
                className="group-btn primary"
                onClick={handleCreate}
                disabled={creating}
              >
                {creating ? 'Starting...' : 'Start a study group'}
              </button>
            </section>
          )}

          {groups.length > 0 && !ownsOne && (
            <button
              type="button"
              className="group-link group-start-own"
              onClick={handleCreate}
              disabled={creating}
            >
              Start your own group
            </button>
          )}
        </>
      )}
    </main>
  )
}
