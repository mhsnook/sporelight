import { Link, createFileRoute } from '@tanstack/react-router'
import { useTracker } from '../lib/tracker.tsx'
import { claimLabel } from '../lib/position.ts'
import { NotFound, Syncing } from '../components/bits.tsx'
import { PersonForm } from '../components/PersonForm.tsx'
import { Section } from '../components/form.tsx'

export const Route = createFileRoute('/_editor/people/$slug')({ component: EditPerson })

function EditPerson() {
  const { slug } = Route.useParams()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />
  const decider = tracker.deciderBySlug.get(slug)
  if (!decider) return <NotFound what="person" />

  const roles = [...(tracker.everyRoleByDecider.get(decider.id) ?? [])].sort((a, b) => (a.starts_on ?? '').localeCompare(b.starts_on ?? '') || a.id.localeCompare(b.id))
  const bodyIds = [...new Set(roles.flatMap((r) => tracker.seatById.get(r.seat_id)?.body_id ?? []))]
  // Their public page is under a question, so each body they sit in links to its first question.
  const pages = bodyIds.flatMap((id) => {
    const question = tracker.questionsIn(id)[0]
    const body = tracker.bodyById.get(id)
    return question && body ? [{ question, body }] : []
  })

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Link to="/people" className="link text-sm">
          ← People
        </Link>
        <h1 className="h-page">{decider.name}</h1>
        {pages.map(({ question, body }) => (
          <p key={question.id}>
            <Link to="/q/$slug/$decider" params={{ slug: question.slug, decider: decider.slug }} search={{ body: body.slug }} className="link">
              {question.short_title} · {body.name}
            </Link>
          </p>
        ))}
      </div>

      <PersonForm key={decider.id} editing={decider} />

      <Section id="roles" title="Seats" hint="Each claim on a seat, past, present or to come.">
        {roles.length === 0 && <p className="text-sm">No seat yet. Someone with no seat is not shown on any question.</p>}
        {roles.length > 0 && (
          <ul className="divide-y divide-line border-y border-line">
            {roles.map((r) => {
              const seat = tracker.seatById.get(r.seat_id)
              return (
                <li key={r.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{seat?.label ?? 'A seat that no longer exists'}</span>
                    {seat && <span className="text-muted"> · {tracker.bodyById.get(seat.body_id)?.name}</span>}
                    <span className="block text-xs text-muted first-letter:uppercase">
                      {claimLabel(r, tracker.asOf)}
                      {r.affiliation && ` · ${r.affiliation}`}
                    </span>
                  </span>
                  <Link to="/roles/$roleId" params={{ roleId: r.id }} className="link shrink-0">
                    Edit <span className="sr-only">the role on {seat?.label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
        <Link to="/roles/new" search={{ person: decider.slug }} className="btn btn-sm">
          Give them a role on a seat
        </Link>
      </Section>
    </div>
  )
}
