import { Link, createFileRoute } from '@tanstack/react-router'
import { plural } from '../lib/position.ts'
import { chambersIn } from '../lib/role-form.ts'
import { useTracker } from '../lib/tracker.tsx'
import { Syncing } from '../components/bits.tsx'

export const Route = createFileRoute('/_editor/bodies/')({ component: Bodies })

function Bodies() {
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h-page">Bodies</h1>
        <Link to="/bodies/new" className="btn">
          Add a body
        </Link>
      </div>
      <p className="text-muted">The legislatures, councils and boards questions are put to, each with its seats and the day its next term starts.</p>
      <ul className="divide-y divide-line border-y border-line">
        {tracker.bodiesInOrder.map((b) => {
          const chambers = chambersIn(tracker.seats, b.id)
          return (
            <li key={b.id} className="flex items-start justify-between gap-3 py-2 text-sm">
              <span>
                <span className="font-medium">{b.name}</span>
                {b.is_demo && <span className="text-faint"> (demo)</span>}
                <span className="block text-xs text-muted">
                  {plural(tracker.seatsByBody.get(b.id)?.length ?? 0, 'seat', 'seats')}
                  {chambers.length > 0 && ` · ${chambers.join(', ')}`}
                </span>
              </span>
              <Link to="/bodies/$slug" params={{ slug: b.slug }} className="link shrink-0">
                Edit <span className="sr-only">{b.name}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
