import { Link, createFileRoute } from '@tanstack/react-router'
import { useTracker } from '../lib/tracker.tsx'
import { Syncing } from '../components/bits.tsx'
import { PersonForm } from '../components/PersonForm.tsx'

export const Route = createFileRoute('/editor/people/new')({ component: NewPerson })

function NewPerson() {
  const { isReady } = useTracker()
  const navigate = Route.useNavigate()
  if (!isReady) return <Syncing />
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Link to="/editor/people" className="link text-sm">
          ← People
        </Link>
        <h1 className="h-page">A new person</h1>
        <p className="text-muted">Once they are added, give them a role on a seat so they appear on the questions put to its body.</p>
      </div>
      <PersonForm onSaved={(made) => navigate({ to: '/editor/people/$slug', params: { slug: made.slug } })} />
    </div>
  )
}
