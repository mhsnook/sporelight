import { Link, createFileRoute } from '@tanstack/react-router'
import { useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { SeatsForm } from '../components/SeatForm.tsx'

export const Route = createFileRoute('/_editor/bodies/$slug/seats/new')({ component: NewSeats })

function NewSeats() {
  const { slug } = Route.useParams()
  const navigate = Route.useNavigate()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />
  const body = tracker.bodyBySlug.get(slug)
  if (!body) return <NotFound what="body" />

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Link to="/bodies/$slug" params={{ slug: body.slug }} className="link text-sm">
          ← {body.name}
        </Link>
        <h1 className="h-page">Seats for {body.name}</h1>
        <p className="text-muted">Once they are added, put someone in each seat from its page.</p>
      </div>
      <SeatsForm body={body} onSaved={() => navigate({ to: '/bodies/$slug', params: { slug: body.slug }, hash: 'seats' })} />
    </div>
  )
}
