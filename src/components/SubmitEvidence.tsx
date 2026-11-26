import { useState, type FormEvent } from 'react'
import { ACT_KINDS, DIRECTIONS, type Decider, type Direction, type Question } from '../../shared/schema.ts'
import { DIRECTION_LABEL, KIND_CHOICE } from '../lib/position.ts'
import { useTracker } from '../lib/tracker.tsx'
import { postAsReader } from '../lib/auth.ts'
import { SignedInOnly } from './SignIn.tsx'
import { AcrossNotice } from './Story.tsx'

type State = { status: 'idle' | 'sending' } | { status: 'sent'; duplicate: boolean; proposalId: string | null; reading: Direction } | { status: 'error'; message: string }

export function SubmitEvidence({ question, decider, onDone }: { question: Question; decider: Decider; onDone: () => void }) {
  const [state, setState] = useState<State>({ status: 'idle' })
  const [copied, setCopied] = useState<'no' | 'yes' | 'refused'>('no')
  const { tracker } = useTracker()

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    const text = (name: string) => (f.get(name) as string).trim()
    setState({ status: 'sending' })
    try {
      const res = await postAsReader('/api/proposals', {
        question_id: question.id,
        decider_id: decider.id,
        kind: f.get('kind'),
        reading: f.get('reading'),
        quote: text('quote'),
        source_url: text('source_url'),
        source_title: text('source_title') || null,
        occurred_on: text('occurred_on') || null,
        submitter_note: text('submitter_note') || null,
        website: text('website'),
      })
      const body = (await res.json()) as { error?: string; duplicate?: boolean; proposal_id?: string | null }
      if (!res.ok) return setState({ status: 'error', message: body.error ?? 'Something went wrong.' })
      const reading = f.get('reading') as Direction
      form.reset()
      setState({ status: 'sent', duplicate: !!body.duplicate, proposalId: body.proposal_id ?? null, reading })
    } catch {
      setState({ status: 'error', message: 'Could not reach the server. Try again in a moment.' })
    }
  }

  if (state.status === 'sent') {
    const across = tracker.acrossFor(question, decider.id, state.reading)
    const link = state.proposalId ? `${window.location.origin}/news?proposal=${state.proposalId}` : null
    return (
      <div className="flex flex-col gap-3.5 rounded-2xl border-2 border-dashed border-ink bg-paper p-4 text-sm">
        <div>
          <p className="tag text-muted">{state.duplicate ? 'Already in the queue' : 'Sent · not checked yet'}</p>
          <p className="mt-1 font-display text-[22px] leading-[1.15] font-black">{state.duplicate ? 'We already have that source in the queue.' : 'Thank you. It is on the record as your reading, and an editor will check it.'}</p>
        </div>
        {!state.duplicate && across && <AcrossNotice decider={decider} question={question} set={across} yours />}
        {link && (
          <div className="flex flex-col gap-2.5">
            <p className="text-[15px] leading-normal">Others can check it too. Send them the link: they can compare the words with the source and say what is wrong in the discussion on {decider.name}’s page.</p>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  // No clipboard on a page not served securely, and a browser may refuse it.
                  Promise.resolve()
                    .then(() => navigator.clipboard.writeText(link))
                    .then(
                      () => setCopied('yes'),
                      () => setCopied('refused'),
                    )
                }}
              >
                {copied === 'yes' ? 'Link copied' : 'Copy link'}
              </button>
              <span className="font-mono text-[13px] break-all text-muted select-all">{link.replace(/^https?:\/\//, '')}</span>
              {copied === 'refused' && <span className="w-full text-[13px] font-semibold">The browser did not allow the copy. Select the address above to copy it.</span>}
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setState({ status: 'idle' })
              onDone()
            }}
          >
            Done
          </button>
          <button type="button" className="btn" onClick={() => setState({ status: 'idle' })}>
            Send another
          </button>
        </div>
      </div>
    )
  }

  return (
    <SignedInOnly prompt="Sign in to send something for review. Your email address is never shown to anyone.">
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="label" htmlFor="quote">
            What did {decider.name} say or do?
          </label>
          <textarea id="quote" name="quote" required minLength={10} maxLength={2000} rows={3} className="field" placeholder="Their exact words, or a plain description of the act" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="source_url">
              Link to the source
            </label>
            <input id="source_url" name="source_url" type="url" required className="field" placeholder="https://" />
          </div>
          <div>
            <label className="label" htmlFor="source_title">
              Source name <span className="font-normal normal-case">(optional)</span>
            </label>
            <input id="source_title" name="source_title" maxLength={300} className="field" placeholder="Outlet and headline" />
          </div>
          <div>
            <label className="label" htmlFor="occurred_on">
              Date it happened
            </label>
            <input id="occurred_on" name="occurred_on" type="date" className="field" />
          </div>
          <div>
            <label className="label" htmlFor="kind">
              Kind
            </label>
            <select id="kind" name="kind" className="field">
              {ACT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_CHOICE[k]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="reading">
              What it shows
            </label>
            <select id="reading" name="reading" className="field">
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {DIRECTION_LABEL[d]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="submitter_note">
            Anything the editor should know? <span className="font-normal normal-case">(optional)</span>
          </label>
          <input id="submitter_note" name="submitter_note" maxLength={1000} className="field" />
        </div>
        <div className="hidden" aria-hidden="true">
          <label>
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        {state.status === 'error' && <p className="text-sm text-oppose">{state.message}</p>}
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary" disabled={state.status === 'sending'}>
            {state.status === 'sending' ? 'Sending…' : 'Send for review'}
          </button>
          <button type="button" className="btn" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </SignedInOnly>
  )
}
