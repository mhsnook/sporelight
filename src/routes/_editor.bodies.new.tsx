import { Link, createFileRoute } from '@tanstack/react-router'
import { useTracker } from '../lib/tracker.tsx'
import { Syncing } from '../components/bits.tsx'
import { BodyForm } from '../components/BodyForm.tsx'

export const Route = createFileRoute('/_editor/bodies/new')({ component: NewBody })

function NewBody() {
  const { isReady } = useTracker()
  const navigate = Route.useNavigate()
  if (!isReady) return <Syncing />
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Link to="/bodies" className="link text-sm">
          ← Bodies
        </Link>
        <h1 className="h-page">A new body</h1>
        <p className="text-muted">Once it is added, give it seats, then put people in them and questions to it.</p>
      </div>
      <BodyForm onSaved={(made) => navigate({ to: '/bodies/$slug', params: { slug: made.slug } })} />
    </div>
  )
}
