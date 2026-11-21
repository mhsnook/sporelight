import { Link, createFileRoute } from '@tanstack/react-router'
import type { Body, Seat } from '../../shared/schema.ts'
import { nextTermStart, roleInputOf, runningFor } from '../lib/role-form.ts'
import { formatDate } from '../lib/position.ts'
import { today, useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { RoleForm } from '../components/RoleForm.tsx'

// `seat` is a seat id and `person` a person's slug, either known in advance.
// `running` starts the form as someone running for the seat. `question` is the
// question page the editor came from, which they go back to once it is saved.
type NewRoleSearch = { seat?: string; person?: string; running?: boolean; question?: string }

export const Route = createFileRoute('/editor/roles/new')({
  component: NewRole,
  validateSearch: (s: Record<string, unknown>): NewRoleSearch => ({
    seat: typeof s.seat === 'string' && s.seat ? s.seat : undefined,
    person: typeof s.person === 'string' && s.person ? s.person : undefined,
    running: s.running === true || undefined,
    question: typeof s.question === 'string' && s.question ? s.question : undefined,
  }),
})

// Where a challenger's start date came from, or why there is none.
function runningHint(seat: Seat, body: Body | undefined): string {
  const day = nextTermStart(seat, body, today())
  if (day && day === seat.next_election_on) return `The seat’s next election, ${formatDate(day)}.`
  if (day) return `${body?.next_term_label ?? 'The next term'} starts on ${formatDate(day)}.`
  return 'Neither the seat nor its body names a day for its next term. With no start date, they are listed as someone who may hold the seat today.'
}

function NewRole() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />

  const seat = search.seat ? tracker.seatById.get(search.seat) : undefined
  const person = search.person ? tracker.deciderBySlug.get(search.person) : undefined
  if (search.seat && !seat) return <NotFound what="seat" />
  if (search.person && !person) return <NotFound what="person" />
  const body = seat && tracker.bodyById.get(seat.body_id)
  const running = search.running && seat
  const from = search.question ? tracker.questionBySlug.get(search.question) : undefined

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        {from && (
          <Link to="/q/$slug" params={{ slug: from.slug }} className="link text-sm">
            ← {from.title}
          </Link>
        )}
        {person && !from && (
          <Link to="/editor/people/$slug" params={{ slug: person.slug }} className="link text-sm">
            ← {person.name}
          </Link>
        )}
        <h1 className="h-page">{running ? `Someone running for ${seat.label}` : person ? `A seat for ${person.name}` : 'A new role on a seat'}</h1>
      </div>
      <RoleForm
        seat={seat}
        person={person}
        start={running ? runningFor(seat, body, today()) : roleInputOf(null)}
        startHint={running ? runningHint(seat, body) : undefined}
        onSaved={(role, holder) => {
          const at = tracker.seatById.get(role.seat_id)
          if (from && at) navigate({ to: '/q/$slug', params: { slug: from.slug }, search: (prev) => ({ ...prev, q: at.label }) })
          else navigate({ to: '/editor/people/$slug', params: { slug: holder.slug } })
        }}
      />
    </div>
  )
}
