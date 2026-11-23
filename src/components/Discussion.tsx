import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation } from '@tanstack/react-router'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { pairId, type Decider, type Question } from '../../shared/schema.ts'
import { db } from '../lib/db.ts'
import { postAsReader, setDisplayName, useSignedIn } from '../lib/auth.ts'
import { isEditor } from '../lib/editor.ts'
import { Modal } from './Modal.tsx'
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
  const name = useSignedIn().person?.display_name ?? ''
  const formRef = useRef<HTMLFormElement>(null)
  // 'post' means a comment is waiting on the person's first name: save it, then send.
  const [asking, setAsking] = useState<'post' | 'rename' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function post() {
    const form = formRef.current!
    const body = form.elements.namedItem('body') as HTMLTextAreaElement
    setError(null)
    setSending(true)
    try {
      const res = await postAsReader('/api/comments', {
        question_id: question.id,
        decider_id: decider.id,
        body: body.value.trim(),
        website: (form.elements.namedItem('website') as HTMLInputElement).value,
      })
      if (!res.ok) return setError(((await res.json()) as { error?: string }).error ?? 'Something went wrong.')
      body.value = ''
    } catch {
      setError('Could not reach the server. Try again in a moment.')
    } finally {
      setSending(false)
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (name) post()
    else setAsking('post')
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
              {isEditor() && (
                <button type="button" className="ml-auto underline underline-offset-2 hover:text-oppose" onClick={() => db.comments.delete(c.id)}>
                  Remove
                </button>
              )}
            </p>
            <p className="text-sm whitespace-pre-wrap">{c.body}</p>
          </li>
        ))}
      </ol>

      <SignedInOnly prompt="Sign in to comment. Your comments show the name you choose, never your email address.">
        <form ref={formRef} onSubmit={onSubmit} className="space-y-3">
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
          <p className="text-xs text-muted">
            {name ? (
              <>
                Posting as <span className="font-semibold text-ink">{name}</span> ·{' '}
                <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => setAsking('rename')}>
                  change
                </button>
              </>
            ) : (
              'You’ll choose the name your comments show when you post.'
            )}
          </p>
        </div>
        </form>
      </SignedInOnly>

      <Modal
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking === 'rename' ? 'Change your name' : 'Choose a name to post'}
        description="It shows next to your comments, in place of your email address. You can change it any time."
      >
        <NameForm
          name={name}
          action={asking === 'rename' ? 'Save' : 'Save and post'}
          onCancel={() => setAsking(null)}
          onSaved={() => {
            if (asking === 'post') post()
            setAsking(null)
          }}
        />
      </Modal>
    </section>
  )
}

function NameForm({ name, action, onCancel, onSaved }: { name: string; action: string; onCancel: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const chosen = (new FormData(e.currentTarget).get('display_name') as string).trim()
    if (!chosen) return
    setError(null)
    setSaving(true)
    const failed = await setDisplayName(chosen)
    setSaving(false)
    if (failed) return setError(failed)
    onSaved()
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
      <div>
        <label className="label" htmlFor="display-name">
          Name
        </label>
        <input id="display-name" name="display_name" required maxLength={60} defaultValue={name} autoComplete="nickname" className="field" />
      </div>
      {error && <p className="text-sm text-oppose">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {action}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
