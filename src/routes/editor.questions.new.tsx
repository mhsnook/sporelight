import { Link, createFileRoute } from '@tanstack/react-router'
import type { Placement } from '../lib/question-form.ts'
import { useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { QuestionForm } from '../components/QuestionForm.tsx'

// With no search, a new question in a body. `parent` and `sub` make a measure
// or an ask under a question, and `linkTo` a question linked to another as a
// smaller step or a related issue. Each names the other question by its slug.
type NewSearch = { parent?: string; sub?: 'measure' | 'ask'; linkTo?: string }

export const Route = createFileRoute('/editor/questions/new')({
  component: NewQuestion,
  validateSearch: (s: Record<string, unknown>): NewSearch => ({
    parent: typeof s.parent === 'string' && s.parent ? s.parent : undefined,
    sub: s.sub === 'measure' || s.sub === 'ask' ? s.sub : undefined,
    linkTo: typeof s.linkTo === 'string' && s.linkTo ? s.linkTo : undefined,
  }),
})

const HEADING = { question: 'A new question', measure: 'A new measure', ask: 'A new ask', step: 'A new linked question' } as const

function NewQuestion() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />

  const parent = search.parent ? tracker.questionBySlug.get(search.parent) : undefined
  const linkTo = search.linkTo ? tracker.questionBySlug.get(search.linkTo) : undefined
  let place: Placement
  if (search.parent) {
    if (!parent || parent.parent_id) return <NotFound what="question to put this under" />
    place = { kind: search.sub ?? 'measure', parent }
  } else if (search.linkTo) {
    if (!linkTo) return <NotFound what="question to link this to" />
    place = { kind: 'step', to: linkTo, relation: 'smaller_step' }
  } else {
    const first = tracker.bodiesInOrder[0]
    if (!first) return <NotFound what="body to add a question to" />
    place = { kind: 'question', body_id: first.id }
  }
  const from = parent ?? linkTo

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        {from && (
          <Link to="/editor/questions/$slug/edit" params={{ slug: from.slug }} className="link text-sm">
            ← {from.title}
          </Link>
        )}
        <h1 className="h-page">{HEADING[place.kind]}</h1>
      </div>
      <QuestionForm
        place={place}
        onSaved={(made) => navigate({ to: '/editor/questions/$slug/edit', params: { slug: made.parent_id && parent ? parent.slug : made.slug } })}
      />
    </div>
  )
}
