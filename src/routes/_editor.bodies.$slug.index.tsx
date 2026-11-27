import { Link, createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import type { Body } from '../../shared/schema.ts'
import { db } from '../lib/db.ts'
import { bodyDependents } from '../lib/body-form.ts'
import { commit } from '../lib/review.ts'
import { holderNames } from '../lib/role-form.ts'
import { SEAT_LIMITS, chamberUse, renameChamber, renameProblems } from '../lib/seat-form.ts'
import { textField } from '../lib/form-input.ts'
import { useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { BodyForm } from '../components/BodyForm.tsx'
import { Field, Section, notSaved } from '../components/form.tsx'

// Enough to find a seat by its label; the search narrows the rest.
const SHOWN = 50

export const Route = createFileRoute('/_editor/bodies/$slug/')({
  component: EditBody,
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({ q: typeof s.q === 'string' && s.q ? s.q : undefined }),
})

function EditBody() {
  const { slug } = Route.useParams()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />
  const body = tracker.bodyBySlug.get(slug)
  if (!body) return <NotFound what="body" />

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Link to="/bodies" className="link text-sm">
          ← Bodies
        </Link>
        <h1 className="h-page">{body.name}</h1>
        {body.is_demo && <p className="text-muted">Demo data, not real.</p>}
      </div>
      <BodyForm key={body.id} editing={body} />
      <Chambers body={body} />
      <Seats body={body} />
      <Questions body={body} />
      <DeleteBody body={body} />
    </div>
  )
}

function Chambers({ body }: { body: Body }) {
  const { tracker } = useTracker()
  const [problems, setProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const putHere = tracker.questions.filter((q) => tracker.appliesIn(q, body.id))
  const chambers = chamberUse(body.id, tracker, putHere)
  const inNone = tracker.seats.filter((s) => s.body_id === body.id && !s.chamber).length
  if (chambers.length === 0) return null

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    const from = textField(f, 'from')
    const to = textField(f, 'to')
    const found = renameProblems(from, to, chambers.map((c) => c.name))
    setProblems(found)
    if (found.length) return
    if (chambers.some((c) => c.name === to) && !window.confirm(`${body.name} already has a chamber called ${to}. Put the seats of ${from} in it? The two cannot be told apart afterwards.`)) return
    setSaving(true)
    commit(renameChamber(body.id, from, to, tracker)).then(
      () => (setSaving(false), form.reset()),
      (err: unknown) => (setSaving(false), setProblems([notSaved(err)])),
    )
  }

  const uses = (c: (typeof chambers)[number]) =>
    [
      c.seats === 1 ? '1 seat' : `${c.seats} seats`,
      c.questions > 0 && (c.questions === 1 ? '1 question' : `${c.questions} questions`),
      c.offices > 0 && (c.offices === 1 ? '1 office' : `${c.offices} offices`),
    ]
      .filter(Boolean)
      .join(', ')

  return (
    <Section id="chambers" title="Chambers" hint="A chamber is a name on each seat. Questions and offices can be narrowed to one by the same name.">
      <ul className="divide-y divide-line border-y border-line">
        {chambers.map((c) => (
          <li key={c.name} className="py-2 text-sm">
            <span className="font-medium">{c.name}</span>
            <span className="text-muted"> · {uses(c)}</span>
            {c.fromElsewhere > 0 && (
              <span className="block text-xs text-muted">
                {c.fromElsewhere === 1 ? 'A question put to this body from another names' : `${c.fromElsewhere} questions put to this body from others name`} a chamber {c.name} too. Renaming
                leaves {c.fromElsewhere === 1 ? 'it' : 'them'} as {c.fromElsewhere === 1 ? 'it is' : 'they are'}.
              </span>
            )}
            {c.sharedOut > 0 && (
              <span className="block text-xs text-muted">
                {c.sharedOut === 1 ? 'A question listed here that names it is' : `${c.sharedOut} questions listed here that name it are`} also put to other bodies. Renaming changes the
                chamber {c.sharedOut === 1 ? 'it is' : 'they are'} narrowed to there too.
              </span>
            )}
          </li>
        ))}
      </ul>
      {inNone > 0 && (
        <p role="note" className="text-sm font-semibold text-oppose">
          {inNone === 1 ? 'One seat has' : `${inNone} seats have`} no chamber, so {inNone === 1 ? 'it is' : 'they are'} left off the seat charts. Give {inNone === 1 ? 'it' : 'each'} a chamber from{' '}
          {inNone === 1 ? 'its' : 'their'} own page.
        </p>
      )}
      <form onSubmit={onSubmit} noValidate aria-label="Rename a chamber" className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Chamber to rename" id="c-from">
            <select id="c-from" name="from" className="field" defaultValue={chambers[0].name}>
              {chambers.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="New name" id="c-to">
            <input id="c-to" name="to" maxLength={SEAT_LIMITS.chamber} autoComplete="off" className="field" />
          </Field>
        </div>
        {problems.length > 0 && (
          <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-oppose">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <button className="btn" disabled={saving}>
          Rename the chamber
        </button>
      </form>
    </Section>
  )
}

function Seats({ body }: { body: Body }) {
  const { tracker } = useTracker()
  const { q } = Route.useSearch()
  const navigate = Route.useNavigate()
  const seats = tracker.seats
    .filter((s) => s.body_id === body.id)
    .sort((a, b) => (a.chamber ?? '').localeCompare(b.chamber ?? '') || a.label.localeCompare(b.label, undefined, { numeric: true }))
  const needle = q?.toLowerCase()
  const matching = needle ? seats.filter((s) => [s.label, s.region, s.chamber, holderNames(s, tracker)].join(' ').toLowerCase().includes(needle)) : seats

  return (
    <Section id="seats" title="Seats" hint="Who holds each seat is set on the seat's own page, or from the person's.">
      {seats.length === 0 ? (
        <p className="text-sm">No seats yet. A body with no seats has nobody to put a question to.</p>
      ) : (
        <>
          {(seats.length > SHOWN || q) && (
            <div>
              <label className="label" htmlFor="seat-search">
                Find a seat
              </label>
              <input
                id="seat-search"
                type="search"
                className="field"
                value={q ?? ''}
                autoComplete="off"
                onChange={(e) => navigate({ search: (prev) => ({ ...prev, q: e.target.value || undefined }), replace: true })}
              />
            </div>
          )}
          <p className="text-sm text-muted tabular-nums">
            {matching.length > SHOWN ? `The first ${SHOWN} of ${matching.length}` : `${matching.length} ${matching.length === 1 ? 'seat' : 'seats'}`}
          </p>
          <ul className="divide-y divide-line border-y border-line">
            {matching.slice(0, SHOWN).map((s) => {
              const held = holderNames(s, tracker)
              return (
                <li key={s.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{s.label}</span>
                    {s.chamber && <span className="text-muted"> · {s.chamber}</span>}
                    {s.region && <span className="text-muted"> · {s.region}</span>}
                    {!s.is_voting && <span className="text-muted"> · non-voting</span>}
                    <span className="block text-xs text-muted">{held ? `Held by ${held}` : 'Vacant'}</span>
                  </span>
                  <Link to="/seats/$seatId" params={{ seatId: s.id }} className="link shrink-0">
                    Edit <span className="sr-only">{s.label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      )}
      <Link to="/bodies/$slug/seats/new" params={{ slug: body.slug }} className="btn btn-sm">
        Add seats
      </Link>
    </Section>
  )
}

function Questions({ body }: { body: Body }) {
  const { tracker } = useTracker()
  const questions = tracker.questionsIn(body.id)
  return (
    <Section id="questions" title="Questions" hint="The questions listed under this body or put to it. A question is put to a body when it is added or edited.">
      {questions.length === 0 ? (
        <p className="text-sm">None yet.</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {questions.map((q) => (
            <li key={q.id} className="flex items-start justify-between gap-3 py-2 text-sm">
              <Link to="/q/$slug" params={{ slug: q.slug }} search={{ body: body.slug }} className="link">
                {q.title}
              </Link>
              <Link to="/q/$slug/edit" params={{ slug: q.slug }} className="link shrink-0">
                Edit <span className="sr-only">{q.short_title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/questions/new" search={{ in: body.slug }} className="btn btn-sm">
        Add a question
      </Link>
    </Section>
  )
}

// A body can be removed only when nothing hangs from it, as for one entered by mistake.
function DeleteBody({ body }: { body: Body }) {
  const { tracker } = useTracker()
  const navigate = Route.useNavigate()
  const [error, setError] = useState<string | null>(null)
  const dependents = bodyDependents(body, tracker)

  function remove() {
    if (!window.confirm(`Remove ${body.name}? It is gone from every page.`)) return
    setError(null)
    // Not optimistic: the body stays on this page until the server has deleted it.
    db.bodies.delete(body.id, { optimistic: false }).isPersisted.promise.then(
      () => navigate({ to: '/bodies' }),
      (err: unknown) => setError(notSaved(err)),
    )
  }

  return (
    <Section id="delete-body" title="Removing">
      {dependents.length > 0 ? (
        <p className="text-sm">This body cannot be removed while it has {dependents.join(', ')}.</p>
      ) : (
        <>
          <p className="text-sm text-muted">Nothing hangs from this body, so it can be removed.</p>
          <button type="button" className="btn" onClick={remove}>
            Remove this body
          </button>
        </>
      )}
      {error && <p className="text-sm text-oppose">{error}</p>}
    </Section>
  )
}
