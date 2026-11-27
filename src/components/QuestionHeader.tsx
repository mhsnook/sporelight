import { Link, useNavigate } from '@tanstack/react-router'
import type { Body, Question } from '../../shared/schema.ts'
import { today, useTracker, useViewedBody } from '../lib/tracker.tsx'
import { formatDate } from '../lib/position.ts'

// The broad question and its specific measures are one family; the tabs move
// between them without leaving the page you're on.
export function QuestionHeader({ question, deciderSlug }: { question: Question; deciderSlug?: string }) {
  const { tracker } = useTracker()
  const root = question.parent_id ? (tracker.questionById.get(question.parent_id) ?? question) : question
  // An ask is put to named people, so its tab only appears where it applies:
  // on those people's pages, and on the ask's own page.
  const deciderId = deciderSlug ? tracker.deciderBySlug.get(deciderSlug)?.id : undefined
  const { body, choices } = useViewedBody(question, deciderId)
  const asks = (tracker.asksOf.get(root.id) ?? []).filter((a) => a.id === question.id || (deciderId && tracker.appliesTo(a, deciderId)))
  const family = [root, ...(body ? tracker.measuresIn(root, body.id) : []), ...asks]

  return (
    <header className="space-y-3">
      <p className="tag">
        {body?.name}
        {body?.is_demo && ' · demo data, not real'}
      </p>
      <h1 className="h-section max-w-3xl">{question.title}</h1>
      {question.description && <p className="max-w-2xl text-muted">{question.description}</p>}
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {question.reference_url && (
          <a href={question.reference_url} target="_blank" rel="noreferrer" className="link">
            Read the measure ↗
          </a>
        )}
        <Link to="/news" search={{ question: question.slug }} className="link">
          Latest on this question
        </Link>
      </p>
      {body && choices.length > 1 && <BodySwitch body={body} choices={choices} home={question.body_id} />}
      {body && <TermToggle body={body} />}
      {family.length > 1 && (
        <nav className="flex flex-wrap gap-2 pt-1" aria-label="Related questions">
          {family.map((q) => {
            const className = `rounded-full border px-3 py-1 text-sm ${q.id === question.id ? 'border-ink bg-ink text-paper' : 'border-line bg-surface hover:border-ink'}`
            const label = q.id === root.id ? `In general` : q.short_title
            return deciderSlug ? (
              <Link key={q.id} to="/q/$slug/$decider" params={{ slug: q.slug, decider: deciderSlug }} className={className}>
                {label}
              </Link>
            ) : (
              <Link key={q.id} to="/q/$slug" params={{ slug: q.slug }} className={className}>
                {label}
              </Link>
            )
          })}
        </nav>
      )}
    </header>
  )
}

// Switches between the body as it stands and as it will stand once its next
// term starts. Seats, key roles and the asks put to them all follow the day.
export function TermToggle({ body }: { body: Body }) {
  const { tracker } = useTracker()
  const navigate = useNavigate()
  const now = today()
  if (!body.next_term_on || body.next_term_on <= now) return null
  const isNext = tracker.asOf >= body.next_term_on
  const view = (as: string | undefined) => navigate({ to: '.', search: (prev) => ({ ...prev, as }), replace: true })
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
      <div className="flex flex-wrap gap-2" role="group" aria-label="When">
        <button type="button" aria-pressed={!isNext} className={`btn btn-sm ${isNext ? '' : 'btn-primary'}`} onClick={() => view(undefined)}>
          Now
        </button>
        <button type="button" aria-pressed={isNext} className={`btn btn-sm ${isNext ? 'btn-primary' : ''}`} onClick={() => view(body.next_term_on!)}>
          {body.next_term_label ?? 'Next term'}
        </button>
      </div>
      <p className="text-sm text-muted">
        {isNext
          ? `As it is expected to stand from ${formatDate(body.next_term_on)}.`
          : `${body.next_term_label ?? 'The next term'} starts ${formatDate(body.next_term_on)}.`}
      </p>
    </div>
  )
}

// A question put to several bodies is looked at through one of them at a time.
// The answers are each person's own, so they are the same in every body.
function BodySwitch({ body, choices, home }: { body: Body; choices: Body[]; home: string }) {
  const navigate = useNavigate()
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Body">
      {choices.map((b) => (
        <button
          key={b.id}
          type="button"
          aria-pressed={b.id === body.id}
          className={`btn btn-sm ${b.id === body.id ? 'btn-primary' : ''}`}
          onClick={() => navigate({ to: '.', search: (prev) => ({ ...prev, body: b.id === home ? undefined : b.slug }), replace: true })}
        >
          {b.name}
        </button>
      ))}
    </div>
  )
}
