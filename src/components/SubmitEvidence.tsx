import { useState, type FormEvent } from 'react'
import { Button } from '@ui-sdk/react/button'
import { Field, FieldError, FieldLabel } from '@ui-sdk/react/field'
import { Input } from '@ui-sdk/react/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui-sdk/react/select'
import { Textarea } from '@ui-sdk/react/textarea'
import { ACT_KINDS, DIRECTIONS, type Decider, type Direction, type Question } from '../../shared/schema.ts'
import { DIRECTION_LABEL, KIND_CHOICE } from '../lib/position.ts'
import { useTracker } from '../lib/tracker.tsx'
import { Notice, NoticeDescription, NoticeTitle } from './Notice.tsx'
import { AcrossNotice } from './Story.tsx'

type State =
  | { status: 'idle' | 'sending' }
  | { status: 'sent'; duplicate: boolean; proposalId: string | null; reading: Direction }
  | { status: 'error'; message: string; refusedField?: string }

const FIELDS_ON_FORM = ['quote', 'source_url', 'source_title', 'occurred_on', 'submitter_note']

// The Worker answers a refused value as "<field>: <message>".
function errorState(error: string | undefined): State {
  const [, refusedField, message] = /^(\w+): (.+)$/s.exec(error ?? '') ?? []
  return refusedField && FIELDS_ON_FORM.includes(refusedField) ? { status: 'error', refusedField, message } : { status: 'error', message: error ?? 'Something went wrong.' }
}

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
      const res = await fetch('/api/proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
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
        }),
      })
      const body = (await res.json()) as { error?: string; duplicate?: boolean; proposal_id?: string | null }
      if (!res.ok) return setState(errorState(body.error))
      const reading = f.get('reading') as Direction
      form.reset()
      setState({ status: 'sent', duplicate: !!body.duplicate, proposalId: body.proposal_id ?? null, reading })
    } catch {
      setState({ status: 'error', message: 'Could not reach the server. Try again in a moment.' })
    }
  }

  if (state.status === 'sent') {
    const across = tracker.acrossFor(question, decider.id, state.reading)
    const link = state.proposalId ? `${window.location.origin}/latest?proposal=${state.proposalId}` : null
    return (
      <div className="flex flex-col gap-3.5 rounded-2xl border-2 border-dashed border-ink bg-paper p-4 text-sm">
        <Notice>
          <NoticeTitle className="tag text-muted">{state.duplicate ? 'Already in the queue' : 'Sent · not checked yet'}</NoticeTitle>
          <NoticeDescription className="mt-1 font-display text-[22px] leading-[1.15] font-black">
            {state.duplicate ? 'We already have that source in the queue.' : 'Thank you. Your report is waiting for an editor.'}
          </NoticeDescription>
        </Notice>
        {!state.duplicate && across && <AcrossNotice decider={decider} question={question} set={across} yours />}
        {link && (
          <div className="flex flex-col gap-2.5">
            <p className="text-[15px] leading-normal">Others can check it too. Send them the link: they can compare the words with the source and say what is wrong in the discussion on {decider.name}’s page.</p>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
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
              </Button>
              <span className="font-mono text-[13px] break-all text-muted select-all">{link.replace(/^https?:\/\//, '')}</span>
              {copied === 'refused' && <span className="w-full text-[13px] font-semibold">The browser did not allow the copy. Select the address above to copy it.</span>}
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <Button
            className="btn btn-primary"
            onClick={() => {
              setState({ status: 'idle' })
              onDone()
            }}
          >
            Done
          </Button>
          <Button className="btn" onClick={() => setState({ status: 'idle' })}>
            Send another
          </Button>
        </div>
      </div>
    )
  }

  const fieldError = state.status === 'error' && state.refusedField ? state : null
  const errorOn = (name: string) => (fieldError?.refusedField === name ? true : undefined)
  const clearError = () => fieldError && setState({ status: 'idle' })

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field name="quote" invalid={errorOn('quote')}>
        <FieldLabel className="label">What did {decider.name} say or do?</FieldLabel>
        <Textarea required minLength={10} maxLength={2000} rows={3} className="field" placeholder="Their exact words, or a plain description of the act" onValueChange={clearError} />
        <FormError name="quote" error={fieldError} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="source_url" invalid={errorOn('source_url')} className="sm:col-span-2">
          <FieldLabel className="label">Link to the source</FieldLabel>
          <Input type="url" required className="field" placeholder="https://" onValueChange={clearError} />
          <FormError name="source_url" error={fieldError} />
        </Field>
        <Field name="source_title" invalid={errorOn('source_title')}>
          <FieldLabel className="label">
            Source name <span className="font-normal normal-case">(optional)</span>
          </FieldLabel>
          <Input maxLength={300} className="field" placeholder="Outlet and headline" onValueChange={clearError} />
          <FormError name="source_title" error={fieldError} />
        </Field>
        <Field name="occurred_on" invalid={errorOn('occurred_on')}>
          <FieldLabel className="label">Date it happened</FieldLabel>
          <Input type="date" className="field" onValueChange={clearError} />
          <FormError name="occurred_on" error={fieldError} />
        </Field>
        <Choice name="kind" label="Kind" choices={ACT_KINDS.map((k) => ({ value: k, label: KIND_CHOICE[k] }))} />
        <Choice name="reading" label="What it shows" choices={DIRECTIONS.map((d) => ({ value: d, label: DIRECTION_LABEL[d] }))} />
      </div>
      <Field name="submitter_note" invalid={errorOn('submitter_note')}>
        <FieldLabel className="label">
          Anything the editor should know? <span className="font-normal normal-case">(optional)</span>
        </FieldLabel>
        <Input maxLength={1000} className="field" onValueChange={clearError} />
        <FormError name="submitter_note" error={fieldError} />
      </Field>
      {/* The honeypot stays a plain input: the bridge lists only ui-sdk
          components, and data-agent-hidden refuses any step that names it. */}
      <div className="hidden" aria-hidden="true" data-agent-hidden>
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {state.status === 'error' && !state.refusedField && (
        <Notice className="text-sm text-oppose">
          <NoticeTitle className="font-bold">Not sent</NoticeTitle>
          <NoticeDescription>{state.message}</NoticeDescription>
        </Notice>
      )}
      <div className="flex gap-2">
        <Button type="submit" className="btn btn-primary" disabled={state.status === 'sending'}>
          {state.status === 'sending' ? 'Sending…' : 'Send for review'}
        </Button>
        <Button className="btn" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

// The browser's own message for a value it refuses, and the Worker's for one it refuses.
function FormError({ name, error }: { name: string; error: { refusedField?: string; message: string } | null }) {
  return (
    <>
      <FieldError className="mt-1.5 text-sm text-oppose" />
      {error?.refusedField === name && (
        <FieldError match className="mt-1.5 text-sm text-oppose">
          {error.message}
        </FieldError>
      )}
    </>
  )
}

function Choice({ name, label, choices }: { name: string; label: string; choices: { value: string; label: string }[] }) {
  return (
    <Field name={name}>
      <FieldLabel className="label">{label}</FieldLabel>
      <Select items={choices} defaultValue={choices[0].value}>
        <SelectTrigger className="field flex items-center justify-between gap-2 text-left">
          <SelectValue />
          <span aria-hidden="true">▾</span>
        </SelectTrigger>
        <SelectContent className="z-50 min-w-(--anchor-width) rounded-[10px] border-2 border-ink bg-surface p-1 shadow-hard-sm">
          {choices.map((c) => (
            <SelectItem key={c.value} value={c.value} className="cursor-pointer rounded-lg px-3 py-2 data-highlighted:bg-paper data-selected:font-bold">
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
