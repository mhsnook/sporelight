import { useState } from 'react'
import { EDITORS_ID, type Act } from '../../shared/schema.ts'
import { db } from '../lib/db.ts'
import { useTracker } from '../lib/tracker.tsx'
import { KIND_LABEL, actDate } from '../lib/position.ts'

const describe = (act: Act) => `${actDate(act.occurred_on)} · ${KIND_LABEL[act.kind]} · ${act.body.slice(0, 60)}`
const failed = (setError: (e: string) => void) => (err: unknown) => setError(err instanceof Error ? err.message : String(err))

// Editors only: says this act and another on file are the same thing. Both
// stay on file, and this one is shown as the other until they are separated.
export function MergeAct({ act }: { act: Act }) {
  const { tracker } = useTracker()
  const [error, setError] = useState<string | null>(null)
  const others = (tracker.actsByDecider.get(act.decider_id) ?? []).filter((a) => a.id !== act.id).sort((a, b) => (b.occurred_on ?? '').localeCompare(a.occurred_on ?? ''))
  const alsoRecordedAs = (tracker.sameActsOf.get(act.id) ?? []).flatMap((s) => tracker.actById.get(s.act_id) ?? [])

  function markSame(sameAsId: string) {
    const other = tracker.actById.get(sameAsId)
    if (!other || !window.confirm(`Show this act as the one from ${actDate(other.occurred_on)}? Its sources and reviews are counted there. It can be separated again.`)) return
    setError(null)
    db.same_acts.insert({ act_id: act.id, same_as_id: sameAsId, marked_by: EDITORS_ID, marked_at: new Date().toISOString() }).isPersisted.promise.catch(failed(setError))
  }

  function separate(actId: string) {
    setError(null)
    db.same_acts.delete(actId).isPersisted.promise.catch(failed(setError))
  }

  return (
    <div className="mt-1 flex flex-col gap-1 text-xs text-muted">
      {alsoRecordedAs.map((a) => (
        <p key={a.id}>
          Also recorded as {describe(a)} ·{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => separate(a.id)}>
            Separate
          </button>
        </p>
      ))}
      {others.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`merge-${act.id}`}>Same act as</label>
          <select id={`merge-${act.id}`} className="field w-auto max-w-full py-1 text-xs" value="" onChange={(e) => markSame(e.target.value)}>
            <option value="">Choose…</option>
            {others.map((a) => (
              <option key={a.id} value={a.id}>
                {describe(a)}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <span className="text-oppose">Not saved: {error}</span>}
    </div>
  )
}

// Editors only: a commitment can be taken back, as when a cosponsor removes
// their name. From that day it stops counting as on the record.
export function WithdrawAct({ act }: { act: Act }) {
  const [error, setError] = useState<string | null>(null)
  if (act.kind !== 'commits') return null
  const save = (withdrawn_on: string | null) => {
    setError(null)
    db.acts.update(act.id, (a) => void (a.withdrawn_on = withdrawn_on)).isPersisted.promise.catch(failed(setError))
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted"
      onSubmit={(e) => {
        e.preventDefault()
        save(new FormData(e.currentTarget).get('withdrawn_on') as string)
      }}
    >
      {act.withdrawn_on ? (
        <button type="button" className="underline underline-offset-2" onClick={() => save(null)}>
          Undo the withdrawal
        </button>
      ) : (
        <>
          <label htmlFor={`withdraw-${act.id}`}>Withdrawn on</label>
          <input id={`withdraw-${act.id}`} name="withdrawn_on" type="date" required className="field w-auto py-1 text-xs" />
          <button className="underline underline-offset-2">Save</button>
        </>
      )}
      {error && <span className="text-oppose">Not saved: {error}</span>}
    </form>
  )
}
