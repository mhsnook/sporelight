import { createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { openSignIn } from '../components/SignIn.tsx'
import { setDisplayName, signOut, useSignedIn } from '../lib/auth.ts'
import { formatDate } from '../lib/position.ts'

export const Route = createFileRoute('/profile')({ component: Profile })

const ROLE_NOTE = {
  member: 'Members propose statements, comment and review the news.',
  editor: 'Editors also manage questions and people, and run the news search.',
} as const

function Profile() {
  const { signedIn, role, person, isPending } = useSignedIn()
  if (isPending) return null
  if (!signedIn) {
    return (
      <div className="card mx-auto max-w-md space-y-4 p-6">
        <h1 className="h-card">Your profile</h1>
        <p>Sign in to see your profile.</p>
        <button type="button" className="btn btn-primary" onClick={openSignIn}>
          Sign in
        </button>
      </div>
    )
  }
  return (
    <div className="space-y-6">
      <h1 className="h-page">Your profile</h1>
      <div className="grid items-start gap-8 md:grid-cols-[minmax(0,26rem)_1fr]">
        <div className="card space-y-5 p-5">
          <DisplayName name={person?.display_name ?? null} />
          <div>
            <p className="label">Role</p>
            {role === 'editor' ? <span className="editor-tag">Editor</span> : <span className="tag rounded-full border-2 border-ink px-2.5 py-0.5">Member</span>}
            <p className="mt-2 text-sm text-muted">{ROLE_NOTE[role ?? 'member']}</p>
          </div>
          {person && (
            <div>
              <p className="label">Joined</p>
              <p>{formatDate(person.created_at.slice(0, 10))}</p>
            </div>
          )}
          <button type="button" className="btn" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
        <div className="space-y-6">
          <section>
            <h2 className="mb-3 text-xl font-extrabold">Your reviews</h2>
            <p className="rounded-xl border-2 border-dashed border-line p-5 text-center text-muted">Reviews you make will be listed here, newest first.</p>
          </section>
          <section>
            <h2 className="mb-3 text-xl font-extrabold">Your proposals</h2>
            <p className="rounded-xl border-2 border-dashed border-line p-5 text-center text-muted">Statements you propose will be listed here, with whether they reached the record.</p>
          </section>
        </div>
      </div>
    </div>
  )
}

function DisplayName({ name }: { name: string | null }) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    const failed = await setDisplayName(String(new FormData(e.currentTarget).get('display_name')))
    setSaving(false)
    setError(failed)
    if (!failed) setEditing(false)
  }

  if (!editing && name) {
    return (
      <div>
        <p className="label">Display name</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xl font-extrabold">{name}</p>
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
      </div>
    )
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <label className="label" htmlFor="profile-name">
        Display name
      </label>
      <div className="flex flex-wrap gap-2">
        <input id="profile-name" name="display_name" required maxLength={60} autoComplete="nickname" defaultValue={name ?? ''} className="field min-w-0 flex-1 basis-40" />
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {name && (
          <button type="button" className="btn" onClick={() => (setEditing(false), setError(null))}>
            Cancel
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-oppose">{error}</p>}
    </form>
  )
}
