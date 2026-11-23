import { Link, createFileRoute } from '@tanstack/react-router'
import type { NewsReport, NewsRun } from '../../shared/news-run.ts'
import { NewsRunView, useEditorJson, useNewsRun } from '../components/NewsSearch.tsx'
import { Syncing } from '../components/bits.tsx'
import { runStatus } from '../lib/news-trace.ts'

type RunsSearch = { run?: string }

export const Route = createFileRoute('/_editor/news/runs')({
  component: NewsRuns,
  validateSearch: (s: Record<string, unknown>): RunsSearch => ({ run: typeof s.run === 'string' && s.run ? s.run : undefined }),
})

const LIST_POLL_MS = 5000

const when = (iso: string) => new Date(iso).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })

// What a run added up to, in a few words, for the list.
function runSummary(run: NewsRun): string {
  const status = runStatus(run, new Date())
  if (!status.report) return status.heading.replace(/^The news search /, '').replace(/^Searching the news$/, 'running')
  const sum = (field: keyof NewsReport['questions'][number]) => status.report!.questions.reduce((n, q) => n + Number(q[field]), 0)
  const failed = sum('failed')
  return `${sum('read')} read · ${sum('queued')} queued${failed ? ` · ${failed} not queued` : ''}${status.report.error ? ' · stopped early' : ''}`
}

function NewsRuns() {
  const search = Route.useSearch()
  const runs = useEditorJson<{ runs: NewsRun[] }>('/api/editor/news-runs', LIST_POLL_MS, (d) => !d || d.runs.some((r) => !runStatus(r, new Date()).finished))
  const list = runs.data?.runs ?? []
  const chosenId = search.run ?? list[0]?.id ?? null
  const chosen = useNewsRun(chosenId)

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm">
          <Link to="/news/review" className="link font-semibold">
            Review queue
          </Link>
        </p>
        <h1 className="h-page">News search runs</h1>
        <p className="max-w-2xl text-muted">Every run of the news search, scheduled or started by an editor, newest first, with each search it made and what became of each article it read.</p>
      </header>
      {runs.failure && <p className="font-bold">{runs.failure}</p>}
      {!runs.data ? (
        <Syncing />
      ) : list.length === 0 ? (
        <p className="card bg-mint p-6 text-center font-bold">No run has been recorded yet.</p>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <ol aria-label="Runs" className="flex flex-col gap-2">
            {list.map((run) => (
              <li key={run.id}>
                <Link
                  to="/news/runs"
                  search={{ run: run.id }}
                  className={`block rounded-[14px] border-2 border-ink px-3.5 py-2.5 hover:shadow-hard-md ${run.id === chosenId ? 'bg-mint shadow-hard-md' : 'bg-surface'}`}
                >
                  <span className="flex items-baseline justify-between gap-2 font-bold">
                    {when(run.started_at)}
                    <span className="tag shrink-0 text-faint">{run.started_by === 'cron' ? 'scheduled' : 'editor'}</span>
                  </span>
                  <span className="block text-sm text-muted">{runSummary(run)}</span>
                </Link>
              </li>
            ))}
          </ol>
          <div className="lg:-mt-5">
            {chosen.data ? <NewsRunView run={chosen.data.run} steps={chosen.data.steps} failure={chosen.failure} /> : chosen.failure ? <p className="font-bold">{chosen.failure}</p> : <Syncing />}
          </div>
        </div>
      )}
    </div>
  )
}
