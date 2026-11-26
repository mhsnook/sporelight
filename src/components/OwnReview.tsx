import { useId, useState } from 'react'
import { DIRECTIONS, WEIGHTS, type Act, type Direction, type Question, type Review, type Weight } from '../../shared/schema.ts'
import { useSession } from '../lib/auth.ts'
import { db } from '../lib/db.ts'
import { newReview, reviewToConfirm, type Answers } from '../lib/own-review.ts'
import { DIRECTION_LABEL, WEIGHT_HINT, WEIGHT_LABEL } from '../lib/position.ts'
import { useTracker } from '../lib/tracker.tsx'

const answersOf = (r: Pick<Review, 'position' | 'weight'>) => (r.position && r.weight ? `${DIRECTION_LABEL[r.position]} · ${WEIGHT_LABEL[r.weight]}` : 'says nothing on this question')
const failed = (setError: (e: string) => void) => (err: unknown) => setError(err instanceof Error ? err.message : String(err))

// A signed-in person's own review of an act on the question it is read on:
// confirming the reading shown, giving their own answers, or changing or
// removing what they gave.
export function OwnReview({ act, question }: { act: Act; question: Question }) {
  const { tracker } = useTracker()
  const reviewerId = useSession().id
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!reviewerId) return null
  const reviews = tracker.reviewsOn(act.id, question.id)
  const mine = reviews.find((r) => r.review.reviewer_id === reviewerId)?.review
  const toConfirm = reviewToConfirm(reviews, reviewerId)
  const on = ` on ${question.short_title}`

  function save(answers: Answers, started: Review | null = null) {
    setError(null)
    const now = new Date().toISOString()
    const write = mine
      ? db.reviews.update(mine.id, (r) => void Object.assign(r, answers, { updated_at: now }))
      : db.reviews.insert(newReview(reviewerId!, act.id, question.id, answers, now, crypto.randomUUID(), started))
    setEditing(false)
    write.isPersisted.promise.catch(failed(setError))
  }

  function remove() {
    if (!mine || !window.confirm('Remove your review? The reading shown goes back to what the other reviews say.')) return
    setError(null)
    db.reviews.delete(mine.id).isPersisted.promise.catch(failed(setError))
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
