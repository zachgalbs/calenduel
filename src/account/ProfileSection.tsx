import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import Avatar from '../Avatar'
import {
  ensureProfile,
  isSignedIn,
  personLink,
  setAvatar,
  setUsername,
  type Profile,
} from '../compete/api'
import CopyLink from '../room/CopyLink'
import { toAvatar } from './avatar'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

// The signed-in half of the Account page. It imports the auth and database SDK,
// so Account loads it on demand, the same way App loads Compete.
export default function ProfileSection() {
  // null = still finding out.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The username being typed; it only becomes yours on Save.
  const [draft, setDraft] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let closed = false
    async function load() {
      const active = await isSignedIn()
      if (closed) return
      setSignedIn(active)
      if (!active) return
      const mine = await ensureProfile()
      if (closed) return
      setProfile(mine)
      setDraft(mine.name)
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

  async function handleRename(event: FormEvent) {
    event.preventDefault()
    if (!profile) return
    setNameError(null)
    setRenaming(true)
    try {
      const name = await setUsername(draft)
      setProfile({ ...profile, name })
      setDraft(name)
    } catch (err) {
      setNameError(errorText(err))
    } finally {
      setRenaming(false)
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

  return (
    <section className="account-section">
      <h2>Profile</h2>

      {signedIn === null && !error && <p className="account-note">Loading...</p>}

      {signedIn === false && (
        <p className="account-note">
          Sign in on the Friends tab to set a profile picture.
        </p>
      )}

      {profile && (
        <div className="profile">
          <Avatar name={profile.name} src={profile.avatar} size={64} />
          <div className="profile-info">
            <p className="profile-name">{profile.name}</p>
            <div className="profile-actions">
              {/* A real button, so the keyboard can reach it; the browser's own
                  file input is hidden and opened from here. */}
              <button
                type="button"
                className="account-btn"
                disabled={saving}
                onClick={() => fileInputRef.current?.click()}
              >
                {saving ? 'Saving...' : profile.avatar ? 'Change picture' : 'Add a picture'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={handleFile}
              />
              {profile.avatar && !saving && (
                <button type="button" className="account-link" onClick={() => save(null)}>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {profile && (
        <form className="username" onSubmit={handleRename}>
          <label className="username-label" htmlFor="username">
            Username
          </label>
          <div className="username-row">
            <input
              id="username"
              className="username-input"
              value={draft}
              maxLength={20}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value.toLowerCase())}
            />
            <button
              type="submit"
              className="account-btn"
              disabled={renaming || draft.trim() === profile.name}
            >
              {renaming ? 'Saving...' : 'Save'}
            </button>
          </div>
          {nameError && <p className="account-error" role="alert">{nameError}</p>}
          <p className="username-link">
            <span>{personLink(profile.name).replace(/^https?:\/\//, '')}</span>
            <CopyLink link={personLink(profile.name)} className="account-link" />
          </p>
          <p className="account-note">
            Your link never expires: send it to anyone, and while you're studying
            it brings them to your table, no sign-in needed. Changing your
            username changes your link, and the old one stops working.
          </p>
        </form>
      )}

      {error && <p className="account-error" role="alert">{error}</p>}
    </section>
  )
}
