import { useEffect, useRef, useState } from 'react'
import { editorFetch } from '../lib/editor.ts'
import type { ReadOutcome } from '../../shared/news-run.ts'
import { applyStep, emptyTrace, readSteps, traceFinished, type NewsTrace, type TraceRow } from '../lib/news-trace.ts'

// Starts a news search run and follows its steps as the worker streams them.
export function useNewsSearch() {
  const [trace, setTrace] = useState<NewsTrace | null>(null)
  const running = trace !== null && !traceFinished(trace)

  async function start() {
    setTrace(emptyTrace)
    try {
      const res = await editorFetch('/api/editor/news-search', { method: 'POST' })
      if (!res.ok || !res.body) throw new Error(`The news search answered ${res.status}.`)
      await readSteps(res.body, (step) => setTrace((t) => applyStep(t ?? emptyTrace, step)))
      // A stream that ends without a report was cut off.
      setTrace((t) => (t && !traceFinished(t) ? { ...t, broken: 'The connection to the run was lost. It may still be running; the queue fills in as it does.' } : t))
    } catch (err) {
      setTrace((t) => ({ ...(t ?? emptyTrace), broken: err instanceof Error ? err.message : String(err) }))
    }
  }

  return { trace, running, start, dismiss: () => setTrace(null) }
}

export function NewsSearchButton({ running, onStart }: { running: boolean; onStart: () => void }) {
  return (
    <button type="button" className="btn btn-sm" onClick={onStart} disabled={running} title="Searches the news for questions marked as in the news">
      {running ? 'Searching…' : 'Search the news now'}
    </button>
  )
}

const MARK: Record<'search' | 'stop' | 'reading' | ReadOutcome, { glyph: string; className: string }> = {
  search: { glyph: '⌕', className: 'border-ink bg-surface' },
  reading: { glyph: '', className: 'border-ink border-t-transparent bg-surface animate-spin' },
  queued: { glyph: '✓', className: 'border-ink bg-support text-white' },
  lead: { glyph: '~', className: 'border-ink border-dashed bg-surface' },
  nothing: { glyph: '–', className: 'border-line bg-surface text-faint' },
  failed: { glyph: '✕', className: 'border-ink bg-oppose text-white' },
  stop: { glyph: '!', className: 'border-ink bg-mixed' },
}

const rowMark = (row: TraceRow) => MARK[row.kind === 'article' ? row.state : row.kind]
const questionOf = (row: TraceRow | undefined) => (row && row.kind !== 'stop' ? row.question : null)

function rowText(row: TraceRow) {
  if (row.kind === 'stop') return { lead: 'Stopped', rest: row.reason }
  if (row.kind === 'search') {
    return { lead: `Searched for ${row.query}`, rest: `${row.hits} ${row.hits === 1 ? 'result' : 'results'}, ${row.named} naming someone on the roster` }
  }
  const name = row.title ?? row.url
  const rest = {
    reading: 'Reading…',
    queued: `Queued ${row.queued} ${row.queued === 1 ? 'entry' : 'entries'}`,
    lead: `Not read, queued as a lead: ${row.detail ?? ''}`,
    nothing: row.detail ? `Nothing queued: ${row.detail}` : 'Nothing on the question',
    failed: `Not queued: ${row.detail ?? ''} The next run tries it again.`,
  }[row.state]
  return { lead: name, rest }
}

// The run's steps, newest last, with a bar for how many of its searches are done.
export function NewsTraceView({ trace, onDismiss }: { trace: NewsTrace; onDismiss: () => void }) {
  const list = useRef<HTMLOListElement>(null)
  const finished = traceFinished(trace)
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [trace.rows.length])

  const share = finished ? 1 : trace.searchesTotal ? trace.searchesDone / trace.searchesTotal : 0
  const heading = !finished ? 'Searching the news' : trace.broken ? 'The news search did not finish' : trace.report?.error ? 'The news search stopped early' : 'The news search finished'
  const deferred = trace.report?.deferred ?? 0

  return (
    <section aria-label="News search" className="card mt-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-black">{heading}</h2>
        {finished && (
          <button type="button" className="link cursor-pointer text-sm font-semibold" onClick={onDismiss}>
            Close
          </button>
        )}
      </div>
      <div
        className="mt-3 h-3 overflow-hidden rounded-full border-2 border-ink bg-paper"
        role="progressbar"
        aria-label="Searches done"
        aria-valuemin={0}
        aria-valuemax={trace.searchesTotal}
        aria-valuenow={finished ? trace.searchesTotal : trace.searchesDone}
      >
        <div className={`h-full transition-[width] duration-300 ${trace.broken ? 'bg-oppose' : 'bg-support'}`} style={{ width: `${share * 100}%` }} />
      </div>
      <p className="mt-2 text-sm text-muted tabular-nums">
        {trace.searchesDone} of {trace.searchesTotal} searches · {trace.reads} {trace.reads === 1 ? 'article' : 'articles'} read, at most {trace.maxReads} a run · {trace.queued} queued
        {trace.failed ? ` · ${trace.failed} not queued` : ''}
        {deferred ? ` · ${deferred} left for the next run` : ''}
      </p>
      {trace.broken && <p className="mt-2 font-bold">{trace.broken}</p>}
      {trace.rows.length > 0 && (
        <ol ref={list} aria-label="Steps" className="mt-3 flex max-h-80 flex-col gap-1.5 overflow-y-auto border-l-2 border-line pr-1 pl-3">
          {trace.rows.map((row, i) => {
            const mark = rowMark(row)
            const { lead, rest } = rowText(row)
            const question = questionOf(row)
            const newQuestion = question !== null && question !== questionOf(trace.rows[i - 1])
            return (
              <li key={row.key} className="text-sm">
                {newQuestion && <p className="tag mt-1.5 mb-1 text-faint">{question}</p>}
                <div className="flex items-start gap-2.5">
                  <span aria-hidden className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 text-[11px] leading-none font-black ${mark.className}`}>
                    {mark.glyph}
                  </span>
                  <span className="min-w-0">
                    <span className="font-bold break-words">
                      {row.kind === 'article' ? (
                        <a href={row.url} target="_blank" rel="noreferrer" className="link">
                          {lead}
                        </a>
                      ) : (
                        lead
                      )}
                    </span>
                    <span className="block text-muted">{rest}</span>
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
