import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import Avatar from '../Avatar'
import {
  ensureProfile,
  isSignedIn,
  personLink,
  setAvatar,
  setUsername,
  signIn,
  type Profile,
} from '../compete/api'
import CopyLink from '../room/CopyLink'
import { XIcon } from '../icons'
import { toAvatar } from './avatar'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

const USERNAME = /^[a-z0-9_]{3,20}$/

// The top of Account: you. The picture and the name are the controls: click
// the picture to change it (× on hover removes it), click the name to rename.
// It imports the auth and database SDK, so Account loads it on demand.
export default function ProfileSection() {
  // null = still finding out.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The name being typed, or null when not renaming.
  const [draft, setDraft] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let closed = false
    async function load() {
      const active = await isSignedIn()
      if (closed) return
      setSignedIn(active)
      if (!active) return
      const mine = await ensureProfile()
      if (!closed) setProfile(mine)
    }
    load().catch((err) => {
      if (!closed) setError(errorText(err))
    })
    return () => {
      closed = true
    }
  }, [])

  async function save(avatar: string | null) {
    if (!profile) return
    setError(null)
    setSaving(true)
    try {
      await setAvatar(profile.id, avatar)
      setProfile({ ...profile, avatar })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Cleared so choosing the same file again still fires a change.
    event.target.value = ''
    if (!file) return
    try {
      await save(await toAvatar(file))
    } catch (err) {
      setError(errorText(err))
    }
  }

  // Enter or clicking away saves; Escape, or no change, just closes it.
  async function rename() {
    if (!profile || draft === null) return
    const wanted = draft.trim()
    if (wanted === profile.name || wanted === '') {
      setDraft(null)
      return
    }
    if (!USERNAME.test(wanted)) {
      setError('3–20 letters, numbers or _')
      return
    }
    try {
      const name = await setUsername(wanted)
      setProfile({ ...profile, name })
      setDraft(null)
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }

  if (signedIn === false) {
    return (
      <section className="account-section">
        <button type="button" className="account-btn" onClick={() => void signIn('account')}>
          Sign in with Google
        </button>
      </section>
    )
  }

  if (!profile) {
    return error ? <p className="account-error" role="alert">{error}</p> : null
  }

  return (
    <section className="account-section">
      <div className="profile">
        <div className="profile-photo reveal">
          <button
            type="button"
            className="profile-photo-pick"
            aria-label={profile.avatar ? 'Change picture' : 'Add a picture'}
            title={profile.avatar ? 'Change picture' : 'Add a picture'}
            disabled={saving}
            onClick={() => fileInputRef.current?.click()}
          >
            <Avatar name={profile.name} src={profile.avatar} size={64} />
          </button>
          {profile.avatar && !saving && (
            <button
              type="button"
              className="icon-btn profile-photo-remove reveal-item"
              aria-label="Remove picture"
              title="Remove picture"
              onClick={() => void save(null)}
            >
              <XIcon size={12} />
            </button>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleFile} />
        </div>

        {draft === null ? (
          <button
            type="button"
            className="profile-name"
            title="Change username"
            onClick={() => setDraft(profile.name)}
          >
            {profile.name}
          </button>
        ) : (
          <input
            className="profile-name profile-name-input"
            aria-label="Username"
            autoFocus
            value={draft}
            maxLength={20}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value.toLowerCase())}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setError(null)
                setDraft(null)
              }
            }}
          />
        )}

        <CopyLink link={personLink(profile.name)} />
      </div>

      {error && <p className="account-error" role="alert">{error}</p>}
    </section>
  )
}
