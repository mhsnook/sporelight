import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo, type ReactNode } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import type { Question } from '../../shared/schema.ts'
import { db } from '../lib/db.ts'
import { atomHref, buildStories, buildWaiting, feedPage, mergeFeed, pageHolding, type FeedFilter, type FeedStory, type Story } from '../lib/feed.ts'
import { useTracker, type Tracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { StoryCard, WaitingStoryCard } from '../components/Story.tsx'

// `proposal` is a link to one waiting proposal: the feed opens on the page that holds it.
type FeedSearch = { question?: string; recordOnly?: true; before?: string; proposal?: string }

export const Route = createFileRoute('/news')({
  component: Latest,
  validateSearch: (s: Record<string, unknown>): FeedSearch => ({
    question: typeof s.question === 'string' && s.question ? s.question : undefined,
    recordOnly: s.recordOnly === true || undefined,
    before: typeof s.before === 'string' && s.before ? s.before : undefined,
    proposal: typeof s.proposal === 'string' && s.proposal ? s.proposal : undefined,
  }),
})

function Latest() {
  const search = Route.useSearch()
  const bodySlug = search.body
  const navigate = Route.useNavigate()
  const { tracker, isReady } = useTracker()
  const question = search.question ? tracker.questionBySlug.get(search.question) : undefined
  const body = bodySlug ? tracker.bodyBySlug.get(bodySlug) : undefined
  const filter: FeedFilter = { questionId: question?.id, bodyId: body?.id }
  const stories = useMemo(() => buildStories(tracker, filter), [tracker, filter.questionId, filter.bodyId])

  if (!isReady) return <Syncing />
  if ((search.question && !question) || (bodySlug && !body)) {
    return (
      <div className="pb-16 text-center">
        <NotFound what={search.question && !question ? 'question' : 'body'} />
        <Link to="/news" search={{ body: undefined }} className="link">
          See everything that is new
        </Link>
      </div>
    )
  }

  const set = (patch: Partial<typeof search>) => navigate({ search: (prev) => ({ ...prev, before: undefined, proposal: undefined, ...patch }), replace: true })
  const atom = atomHref({ question: question?.slug, body: body?.slug })

  return (
    <div className="space-y-6">
      <link rel="alternate" type="application/atom+xml" title="Sporelight: latest on the record" href={atom} />
      <header className="space-y-3">
        <h1 className="h-page">Latest</h1>
        <p className="max-w-2xl text-muted">
          What has been added to the record, newest first. Each story is one source an editor checked, with everyone in it: what they said or did, and what it shows on
          each question. Dashed lines are put forward and not checked yet.
        </p>
      </header>

      <div className="grid gap-3 sm:flex sm:flex-wrap sm:items-end">
        <div className="min-w-0 sm:max-w-sm sm:flex-1">
          <label className="label" htmlFor="feed-question">
            Question
          </label>
          <select id="feed-question" className="field" value={question?.slug ?? ''} onChange={(e) => set({ question: e.target.value || undefined })}>
            <option value="">Every question</option>
            <QuestionOptions tracker={tracker} />
          </select>
        </div>
        <div className="min-w-0 sm:max-w-56 sm:flex-1">
          <label className="label" htmlFor="feed-body">
            Body
          </label>
          <select id="feed-body" className="field" value={body?.slug ?? ''} onChange={(e) => set({ body: e.target.value || undefined })}>
            <option value="">Every body</option>
            {tracker.bodiesInOrder.map((b) => (
              <option key={b.id} value={b.slug}>
                {b.name}
                {b.is_demo ? ' (demo)' : ''}
              </option>
            ))}
          </select>
        </div>
        <button type="button" aria-pressed={!!search.recordOnly} className={`btn ${search.recordOnly ? 'btn-primary' : ''}`} onClick={() => set({ recordOnly: search.recordOnly ? undefined : true })}>
          Show only what is on the record
        </button>
      </div>
      <p className="text-sm">
        <a href={atom} className="link">
          Atom feed{question || body ? ' of this selection' : ''}
        </a>
        <span className="text-muted"> · published stories only</span>
      </p>

      <section aria-labelledby="latest-feed">
        <h2 id="latest-feed" className="sr-only">
          Stories
        </h2>
        {search.recordOnly && !search.proposal ? (
          <Feed feed={mergeFeed(stories, [])} before={search.before} />
        ) : (
          <WithWaiting stories={stories} filter={filter} before={search.before} linked={search.before ? undefined : search.proposal} />
        )}
      </section>
    </div>
  )
}

// `linked` is the proposal a link asked for. `linkedNote` says what became of it when it is not waiting.
function Feed({ feed, before, linked, linkedNote }: { feed: FeedStory[]; before: string | undefined; linked?: string; linkedNote?: string }) {
  const { page, older, isFirst } = (linked && pageHolding(feed, `proposal:${linked}`)) || feedPage(feed, before)
  return (
    <>
      {linkedNote && (
        <p role="status" className="mb-5 rounded-lg border-2 border-dashed border-line bg-paper px-4 py-3 text-sm font-semibold">
          {linkedNote}
        </p>
      )}
      {page.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">Nothing here yet.</p>
      ) : (
        <div className="space-y-5">
          {page.map((f) => (f.kind === 'published' ? <StoryCard key={f.story.key} story={f.story} /> : <WaitingStoryCard key={f.story.key} story={f.story} linked={f.story.proposal.id === linked} />))}
        </div>
      )}
      {(older || !isFirst) && (
        <nav className="mt-6 flex flex-wrap gap-3" aria-label="Pages">
          {!isFirst && (
            <Link to="." search={(prev) => ({ ...prev, before: undefined, proposal: undefined })} className="btn btn-sm">
              Back to the newest
            </Link>
          )}
          {older && (
            <Link to="." search={(prev) => ({ ...prev, before: older, proposal: undefined })} className="btn btn-sm">
              Older stories
            </Link>
          )}
        </nav>
      )}
    </>
  )
}

// These queries are what subscribe to proposals, so a reader showing only the
// record never mounts this and loads none.
function WithWaiting({ stories, filter, before, linked }: { stories: Story[]; filter: FeedFilter; before: string | undefined; linked?: string }) {
  const { tracker } = useTracker()
  const proposals = useLiveQuery((q) => q.from({ row: db.proposals }))
  const items = useLiveQuery((q) => q.from({ row: db.proposal_items }))
  const ready = proposals.isReady && items.isReady
  const waiting = useMemo(
    () => (ready ? buildWaiting(tracker, proposals.data, items.data, filter) : []),
    [ready, tracker, proposals.data, items.data, filter.questionId, filter.bodyId],
  )
  const isWaiting = waiting.some((w) => w.proposal.id === linked)
  const linkedNote =
    !linked || !ready || isWaiting
      ? undefined
      : proposals.data.some((p) => p.id === linked && p.status === 'reviewed')
        ? 'An editor has reviewed the report that link was for. What was published from it is on the record below.'
        : 'No report is waiting at that link.'
  return <Feed feed={mergeFeed(stories, waiting)} before={before} linked={isWaiting ? linked : undefined} linkedNote={linkedNote} />
}

function QuestionOptions({ tracker }: { tracker: Tracker }) {
  const seen = new Set<string>()
  const option = (q: Question, depth: number): ReactNode[] => {
    if (seen.has(q.id)) return []
    seen.add(q.id)
    return [
      <option key={q.id} value={q.slug}>
        {' '.repeat(depth)}
        {depth ? q.short_title : q.title}
      </option>,
      ...tracker.subQuestionsOf(q.id).flatMap((c) => option(c, depth + 1)),
    ]
  }
  return tracker.bodiesInOrder.map((b) => {
    const listed = tracker.questionsIn(b.id).filter((q) => q.body_id === b.id)
    return listed.length === 0 ? null : (
      <optgroup key={b.id} label={b.is_demo ? `${b.name} (demo)` : b.name}>
        {listed.flatMap((q) => option(q, 0))}
      </optgroup>
    )
  })
}
