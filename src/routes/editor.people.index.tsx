import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useTracker } from '../lib/tracker.tsx'
import { Syncing } from '../components/bits.tsx'

// Enough to find someone by name; the search narrows the rest.
const SHOWN = 50

export const Route = createFileRoute('/editor/people/')({
  component: People,
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({ q: typeof s.q === 'string' && s.q ? s.q : undefined }),
})

function People() {
  const { tracker, isReady } = useTracker()
  const { q } = Route.useSearch()
  const navigate = Route.useNavigate()
  const everyone = useMemo(() => [...tracker.deciders].sort((a, b) => a.sort_name.localeCompare(b.sort_name)), [tracker.deciders])
  if (!isReady) return <Syncing />

  const needle = q?.toLowerCase()
  const matching = needle ? everyone.filter((d) => d.name.toLowerCase().includes(needle) || d.sort_name.toLowerCase().includes(needle)) : everyone
  const seatsOf = (deciderId: string) =>
    [...new Set((tracker.everyRoleByDecider.get(deciderId) ?? []).flatMap((r) => tracker.seatById.get(r.seat_id)?.label ?? []))].join(', ')

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h-page">People</h1>
        <Link to="/editor/people/new" className="btn">
          Add a person
        </Link>
      </div>
      <p className="text-muted">Everyone who holds, held or is running for a seat. Someone new is added here, or from a seat on a question’s page.</p>
      <div>
        <label className="label" htmlFor="people-search">
          Find someone
        </label>
        <input
          id="people-search"
          type="search"
          name="q"
          className="field"
          value={q ?? ''}
          autoComplete="off"
          onChange={(e) => navigate({ search: { q: e.target.value || undefined }, replace: true })}
        />
      </div>
      <p className="text-sm text-muted tabular-nums">
        {matching.length > SHOWN ? `The first ${SHOWN} of ${matching.length}` : `${matching.length} ${matching.length === 1 ? 'person' : 'people'}`}
      </p>
      <ul className="divide-y divide-line border-y border-line">
        {matching.slice(0, SHOWN).map((d) => (
          <li key={d.id} className="flex items-start justify-between gap-3 py-2 text-sm">
            <span>
              <span className="font-medium">{d.name}</span>
              <span className="block text-xs text-muted">{seatsOf(d.id) || 'No seat'}</span>
            </span>
            <Link to="/editor/people/$slug" params={{ slug: d.slug }} className="link shrink-0">
              Edit <span className="sr-only">{d.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
