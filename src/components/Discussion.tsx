import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { pairId, type Decider, type Question } from '../../shared/schema.ts'
import { db } from '../lib/db.ts'
import { postAsReader, useIsEditor, useSignedIn } from '../lib/auth.ts'
import { askForName } from './NameDialog.tsx'
import { SignedInOnly } from './SignIn.tsx'

const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function Discussion({ question, decider }: { question: Question; decider: Decider }) {
  const threadId = pairId(question.id, decider.id)
  const hash = useLocation({ select: (l) => l.hash })
  const section = useRef<HTMLElement>(null)
  // The router scrolls to a hash before this page has synced and rendered the section.
  useEffect(() => {
    if (hash === 'discussion') section.current?.scrollIntoView()
  }, [hash])
  // The `where` is the subscription: only this thread is loaded and listened to.
  const { data, isReady } = useLiveQuery(
    (q) =>
      q
        .from({ c: db.comments })
        .where(({ c }) => eq(c.thread_id, threadId))
        .leftJoin({ p: db.people }, ({ c, p }) => eq(c.person_id, p.id))
        .orderBy(({ c }) => c.created_at, 'asc')
        .select(({ c, p }) => ({ id: c.id, body: c.body, created_at: c.created_at, display_name: p?.display_name })),
    [threadId],
  )
  const { person, peopleReady } = useSignedIn()
  const editor = useIsEditor()
  const name = person?.display_name ?? ''
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  // Set when someone signs in from the prompt below; the box takes focus once the form has rendered.
  const [focusComment, setFocusComment] = useState(false)
  useEffect(() => {
    const box = form.current?.elements.namedItem('body')
    if (!focusComment || !(box instanceof HTMLTextAreaElement)) return
    box.focus()
    setFocusComment(false)
  }, [focusComment, peopleReady, person])

  async function send(f: FormData) {
    setError(null)
    setSending(true)
    try {
      const res = await postAsReader('/api/comments', { question_id: question.id, decider_id: decider.id, body: String(f.get('body')).trim(), website: f.get('website') })
      if (!res.ok) return setError(((await res.json()) as { error?: string }).error ?? 'Something went wrong.')
      form.current?.reset()
    } catch {
      setError('Could not reach the server. Try again in a moment.')
    } finally {
      setSending(false)
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    if (!String(f.get('body')).trim()) return setError('Write a comment first.')
    // A comment shows its person's name, so someone without one picks it first, and the comment is sent once it is saved.
    if (!name) return askForName(() => void send(f))
    void send(f)
  }

  return (
    <section id="discussion" ref={section} className="scroll-mt-6">
      <h2 className="mb-1 text-xl font-semibold">Discussion</h2>
      <p className="mb-4 text-sm text-muted">
        Talk about {decider.name} and this question. To add something to the record itself, use “Add to the record” so an editor can check it.
      </p>

      {isReady && data.length === 0 && <p className="mb-4 rounded-lg border border-dashed border-line p-4 text-center text-sm text-muted">No comments yet.</p>}
      <ol className="mb-5 space-y-3">
        {data.map((c) => (
          <li key={c.id} className="rounded-xl border-2 border-ink bg-surface p-3">
            <p className="mb-1 flex flex-wrap items-baseline gap-2 text-xs text-muted">
              <span className="text-sm font-semibold text-ink">{c.display_name}</span>
              <time dateTime={c.created_at}>{timeFmt.format(new Date(c.created_at))}</time>
              {editor && (
                <span className="editor-inline ml-auto">
                  <span className="editor-inline-label">Editors</span>
                  <button type="button" className="hover:text-oppose" onClick={() => db.comments.delete(c.id)}>
                    Remove
                  </button>
                </span>
              )}
            </p>
            <p className="text-sm whitespace-pre-wrap">{c.body}</p>
          </li>
        ))}
      </ol>

      <SignedInOnly lead="Sign in to join the discussion." detail="Reading needs no account." action="Sign in to comment" then={() => setFocusComment(true)}>
        {peopleReady && (
          <form ref={form} onSubmit={onSubmit} className="space-y-3">
            <textarea name="body" required maxLength={2000} rows={3} className="field" aria-label="Comment" placeholder="Add a comment" />
            <div className="hidden" aria-hidden="true">
              <label>
                Website
                <input name="website" tabIndex={-1} autoComplete="off" />
              </label>
            </div>
            {error && <p className="text-sm text-oppose">{error}</p>}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <button type="submit" className="btn" disabled={sending}>
                {sending ? 'Posting…' : 'Post comment'}
              </button>
              {name && (
                <p className="text-xs text-muted">
                  Posting as <span className="font-semibold text-ink">{name}</span> ·{' '}
                  <Link to="/profile" className="underline underline-offset-2 hover:text-ink">
                    change on your profile
                  </Link>
                </p>
              )}
            </div>
          </form>
        )}
      </SignedInOnly>

    </section>
  )
}
