import { useId, useState, useSyncExternalStore } from 'react'
import { DIRECTIONS, WEIGHTS, type Act, type Direction, type Question, type Review, type Weight } from '../../shared/schema.ts'
import { useSession } from '../lib/auth.ts'
import { db } from '../lib/db.ts'
import { newReview, reviewToConfirm, type Answers } from '../lib/own-review.ts'
import { DIRECTION_LABEL, WEIGHT_HINT, WEIGHT_LABEL } from '../lib/position.ts'
import { useTracker } from '../lib/tracker.tsx'

const answersOf = (r: Pick<Review, 'position' | 'weight'>) => (r.position && r.weight ? `${DIRECTION_LABEL[r.position]} · ${WEIGHT_LABEL[r.weight]}` : 'says nothing on this question')

// Saving can move the act between the record and the list of acts said to say
// nothing, which remounts this component, so a failed save's message is kept
// here by act and question rather than in its state.
const failures = new Map<string, string>()
const listeners = new Set<() => void>()
const setFailure = (key: string, message: string | null) => {
  if (message) failures.set(key, message)
  else failures.delete(key)
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

// A member's own review of an act on a question: confirming the reading
// shown, giving their own answers, or changing or removing what they gave.
// Editors review in the queue, where publishing also settles the proposal.
export function OwnReview({ act, question }: { act: Act; question: Question }) {
  const { tracker } = useTracker()
  const { id: reviewerId, role } = useSession()
  const [editing, setEditing] = useState(false)
  const key = `${act.id} ${question.id}`
  const error = useSyncExternalStore(subscribe, () => failures.get(key) ?? null)
  if (!reviewerId || role === 'editor') return null
  const reviews = tracker.reviewsOn(act.id, question.id)
  const mine = reviews.find((r) => r.review.reviewer_id === reviewerId)?.review
  const toConfirm = reviewToConfirm(reviews, reviewerId)
  const on = ` on ${question.short_title}`

  const failed = (err: unknown) => setFailure(key, err instanceof Error ? err.message : String(err))

  function save(answers: Answers, started: Review | null = null) {
    setFailure(key, null)
    const now = new Date().toISOString()
    const write = mine
      ? db.reviews.update(mine.id, (r) => void Object.assign(r, answers, { updated_at: now }))
      : db.reviews.insert(newReview(reviewerId!, act.id, question.id, answers, now, crypto.randomUUID(), started))
    setEditing(false)
    write.isPersisted.promise.catch(failed)
  }

  function remove() {
    if (!mine || !window.confirm('Remove your review? The reading shown goes back to what the other reviews say.')) return
    setFailure(key, null)
    db.reviews.delete(mine.id).isPersisted.promise.catch(failed)
  }

  return (
    <div className="mt-3 border-t border-line pt-2 text-sm">
      {editing ? (
        <AnswersForm question={question} start={mine ?? toConfirm} onSave={(answers) => save(answers)} onCancel={() => setEditing(false)} />
      ) : mine ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
          <span>
            Your review{on}: <span className="font-medium text-ink">{answersOf(mine)}</span>
          </span>
          <button type="button" className="link" onClick={() => setEditing(true)}>
            Change
          </button>
          <button type="button" className="link" onClick={remove}>
            Remove
          </button>
        </p>
      ) : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {toConfirm && toConfirm.position && toConfirm.weight && (
            <button type="button" className="btn btn-sm" onClick={() => save({ position: toConfirm.position!, weight: toConfirm.weight! }, toConfirm)}>
              Confirm: {answersOf(toConfirm)}
            </button>
          )}
          <button type="button" className="link" onClick={() => setEditing(true)}>
            Review it yourself{on}
          </button>
        </p>
      )}
      {error && <p className="mt-1 text-xs text-oppose">Not saved: {error}</p>}
    </div>
  )
}

function AnswersForm({ question, start, onSave, onCancel }: { question: Question; start: Pick<Review, 'position' | 'weight'> | null; onSave: (a: Answers) => void; onCancel: () => void }) {
  const [position, setPosition] = useState<Direction | null>(start?.position ?? null)
  const [weight, setWeight] = useState<Weight>(start?.weight ?? 'clear')
  const [saysNothing, setSaysNothing] = useState(start !== null && start.position === null)
  const name = useId()
  const ready = saysNothing || position !== null
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSave(saysNothing || !position ? { position: null, weight: null } : { position, weight })
      }}
    >
      <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <legend className="mb-1 font-medium">What this act shows on {question.short_title}</legend>
        {DIRECTIONS.map((d) => (
          <label key={d} className="flex items-center gap-1">
            <input
              type="radio"
              name={name}
              checked={!saysNothing && position === d}
              onChange={() => {
                setSaysNothing(false)
                setPosition(d)
              }}
            />
            {DIRECTION_LABEL[d]}
          </label>
        ))}
        <label className="flex items-center gap-1">
          <input type="radio" name={name} checked={saysNothing} onChange={() => setSaysNothing(true)} />
          Says nothing on this question
        </label>
      </fieldset>
      {!saysNothing && (
        <label className="flex flex-wrap items-center gap-2">
          How much it counts
          <select className="field w-auto py-1" value={weight} onChange={(e) => setWeight(e.target.value as Weight)}>
            {WEIGHTS.map((w) => (
              <option key={w} value={w}>
                {WEIGHT_LABEL[w]}
              </option>
            ))}
          </select>
        </label>
      )}
      {!saysNothing && <p className="text-xs text-muted">{WEIGHT_HINT[weight]}</p>}
      <div className="flex gap-3">
        <button type="submit" className="btn btn-sm btn-primary" disabled={!ready}>
          Save your review
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
