import { Link, createFileRoute } from '@tanstack/react-router'
import { useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { HoldingForm } from '../components/OfficeForm.tsx'

export const Route = createFileRoute('/_editor/offices/$officeId/holders/new')({ component: NewHolding })

function NewHolding() {
  const { officeId } = Route.useParams()
  const navigate = Route.useNavigate()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />
  const office = tracker.offices.find((o) => o.id === officeId)
  if (!office) return <NotFound what="office" />

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Link to="/offices/$officeId" params={{ officeId: office.id }} className="link text-sm">
          ← {office.label}
        </Link>
        <h1 className="h-page">A holder for {office.label}</h1>
      </div>
      <HoldingForm office={office} onSaved={() => navigate({ to: '/offices/$officeId', params: { officeId: office.id }, hash: 'holders' })} />
    </div>
  )
}
