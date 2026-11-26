import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { CodeSignIn } from '../components/SignIn.tsx'
import { postAsReader, setDisplayName, useSignedIn } from '../lib/auth.ts'

// A new deployment has no editor. The first person to sign in here becomes one.
export const Route = createFileRoute('/setup')({ component: Setup })

function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="tag text-faint">Step {n} of 3</p>
      <h1 className="h-card">{title}</h1>
      {children && <p>{children}</p>}
    </div>
  )
}

function Setup() {
  const { signedIn, role, isPending } = useSignedIn()
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
    void postAsReader('/api/setup', {}).then(async (res) => {
      if (res.ok) return setGranted(true)
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Something went wrong.')
      setNeeded(false)
    })
  }, [signedIn, needed, granted])

  const taken = needed === false && !granted
  const waiting = needed === null || isPending || (signedIn && !taken && role !== 'editor')

  return (
    <div className="card mx-auto mt-4 max-w-md space-y-4 p-6 sm:mt-12">
      {taken ? (
        <>
          <h1 className="h-card">Set up this site</h1>
          <p>{error ?? 'This site already has an editor.'}</p>
          <Link to="/" className="link">
            Go to the home page
          </Link>
        </>
      ) : waiting ? (
        <p>Checking this site…</p>
      ) : !signedIn ? (
        <>
          <CodeSignIn
            signInLabel="Continue"
            heading={(step) =>
              step === 'email' ? <Step n={1} title="Set up this site">This site is being set up. Enter your email and you will be its first editor.</Step> : <Step n={2} title="Enter the code" />
            }
          />
          <p className="text-sm text-faint">This page is shown only while the site has no editor.</p>
        </>
      ) : (
        <PickName />
      )}
    </div>
  )
}

function PickName() {
  const navigate = useNavigate()
  const { person } = useSignedIn()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    const failed = await setDisplayName(String(new FormData(e.currentTarget).get('display_name')))
    setSaving(false)
    if (failed) return setError(failed)
    void navigate({ to: '/news/review', state: { setUp: true } })
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
      <Step n={3} title="Pick a username">
        It shows next to your reviews and comments. Your email address is never shown.
      </Step>
      <div>
        <label className="label" htmlFor="setup-name">
          Username
        </label>
        <input id="setup-name" name="display_name" required maxLength={60} autoComplete="nickname" defaultValue={person?.display_name ?? ''} className="field" />
      </div>
      <p className="flex items-center gap-2 text-sm">
        You will be an <span className="editor-tag">Editor</span>
      </p>
      {error && <p className="text-sm text-oppose">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? 'Saving…' : 'Finish setting up'}
      </button>
    </form>
  )
}
