import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { CodeSignIn } from '../components/SignIn.tsx'
import { setDisplayName, useSignedIn } from '../lib/auth.ts'

// A new deployment has no editor. The first person to sign in here becomes one.
export const Route = createFileRoute('/setup')({ component: Setup })

type Stage = 'checking' | 'taken' | 'sign-in' | 'name' | 'done'

function Setup() {
  const { signedIn, role, person, isPending } = useSignedIn()
  const [needed, setNeeded] = useState<boolean | null>(null)
  const [granted, setGranted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetch('/api/setup')
      .then((res) => res.json() as Promise<{ needed: boolean }>)
      .then((answer) => setNeeded(answer.needed))
  }, [])

  // Once signed in, ask to be made the first editor.
  useEffect(() => {
    if (!signedIn || !needed || granted) return
    void fetch('/api/setup', { method: 'POST' }).then(async (res) => {
      if (res.ok) return setGranted(true)
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Something went wrong.')
      setNeeded(false)
    })
  }, [signedIn, needed, granted])

  const stage: Stage =
    needed === null || isPending ? 'checking' : !needed && !granted ? 'taken' : !signedIn ? 'sign-in' : !granted || role !== 'editor' ? 'checking' : person?.display_name ? 'done' : 'name'

  return (
    <div className="card mx-auto mt-8 max-w-md space-y-4 p-6">
      <h1 className="text-[28px] font-black">Set up this site</h1>
      {stage === 'checking' && <p>Checking this site…</p>}
      {stage === 'taken' && (
        <>
          <p>{error ?? 'This site already has an editor.'}</p>
          <Link to="/" className="link">
            Go to the home page
          </Link>
        </>
      )}
      {stage === 'sign-in' && (
        <>
          <p>This site is being set up. Enter your email address and you will be its first editor.</p>
          <CodeSignIn onSignedIn={() => {}} />
        </>
      )}
      {stage === 'name' && <PickName />}
      {stage === 'done' && (
        <>
          <p>You are this site's first editor.</p>
          <Link to="/news/review" className="btn btn-primary">
            Open the review queue
          </Link>
        </>
      )}
    </div>
  )
}

function PickName() {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setError(await setDisplayName(String(new FormData(e.currentTarget).get('display_name'))))
    setSaving(false)
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p>You are signed in. Pick the name others see you as.</p>
      <div>
        <label className="label" htmlFor="setup-name">
          Display name
        </label>
        <input id="setup-name" name="display_name" required maxLength={60} autoComplete="nickname" className="field" />
      </div>
      {error && <p className="text-sm text-oppose">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}
