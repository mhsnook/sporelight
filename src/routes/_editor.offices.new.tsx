import { Link, createFileRoute } from '@tanstack/react-router'
import { useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { OfficeForm } from '../components/OfficeForm.tsx'

// `in` is the slug of the body the office belongs to. Without it, the office is held at large.
// It is not `body`, which the root route carries along every link as the body a question is viewed through.
export const Route = createFileRoute('/_editor/offices/new')({
  component: NewOffice,
  validateSearch: (s: Record<string, unknown>): { in?: string } => ({ in: typeof s.in === 'string' && s.in ? s.in : undefined }),
})

function NewOffice() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />
  const body = search.in ? tracker.bodyBySlug.get(search.in) : undefined
  if (search.in && !body) return <NotFound what="body" />

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        {body ? (
          <Link to="/bodies/$slug" params={{ slug: body.slug }} hash="offices" className="link text-sm">
            ← {body.name}
          </Link>
        ) : (
          <Link to="/bodies" hash="at-large" className="link text-sm">
            ← Bodies
          </Link>
        )}
        <h1 className="h-page">{body ? `A new office in ${body.name}` : 'A new office held at large'}</h1>
        <p className="text-muted">Once it is added, give it a holder.</p>
      </div>
      <OfficeForm body={body} onSaved={(made) => navigate({ to: '/offices/$officeId', params: { officeId: made.id } })} />
    </div>
  )
}
