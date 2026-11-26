import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { NewsRun, NewsStep, ReadOutcome } from '../../shared/news-run.ts'
import { runStatus, traceOf, traceTotals, type TraceRow } from '../lib/news-trace.ts'
import { ProgressBar } from './bits.tsx'

const POLL_MS = 1500

// Fetches an editor endpoint, and again every `pollMs` for as long as `stillChanging` says the answer may change.
// A 404 counts as not there yet.
export function useEditorJson<T>(path: string | null, pollMs: number, stillChanging: (data: T | undefined) => boolean) {
  const [data, setData] = useState<T>()
  const [failure, setFailure] = useState<string | null>(null)
  const changing = useRef(stillChanging)
  changing.current = stillChanging
  useEffect(() => {
    setData(undefined)
    setFailure(null)
    if (!path) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let latest: T | undefined
    const load = async () => {
      try {
        const res = await fetch(path)
        if (res.ok) latest = (await res.json()) as T
        else if (res.status !== 404) throw new Error(`${path} answered ${res.status}.`)
        if (stopped) return
        setData(latest)
        setFailure(null)
      } catch (err) {
        if (!stopped) setFailure(err instanceof Error ? err.message : String(err))
      }
      if (!stopped && changing.current(latest)) timer = setTimeout(load, pollMs)
    }
    void load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [path, pollMs])
  return { data, failure }
}

type RunWithSteps = { run: NewsRun; steps: NewsStep[] }

export function useNewsRun(runId: string | null) {
  return useEditorJson<RunWithSteps>(runId && `/api/editor/news-runs/${runId}`, POLL_MS, (d) => !runStatus(d?.run ?? null, new Date()).finished)
}

// The button that starts a run, beside `children`, and the run it started below, on a row of its own.
export function NewsSearch({ children }: { children: ReactNode }) {
  const [runId, setRunId] = useState<string | null>(null)
  const [startFailure, setStartFailure] = useState<string | null>(null)
  const { data, failure } = useNewsRun(runId)
  const status = runStatus(data?.run ?? null, new Date())
  const running = runId !== null && !status.finished && !startFailure

  async function start() {
    const id = crypto.randomUUID()
    setStartFailure(null)
    setRunId(id)
    const res = await fetch('/api/editor/news-search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run_id: id }) }).catch(
      (err: unknown) => err,
    )
    // The run records its own outcome. Only a request that never reached it needs saying here.
    if (!(res instanceof Response)) setStartFailure(`The news search could not be started: ${String(res)}`)
    else if (!res.ok && res.status !== 500) setStartFailure(`The news search could not be started (${res.status}).`)
  }

  return (
    <>
      <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
        <button type="button" className="btn btn-sm" onClick={start} disabled={running} title="Searches the news for questions marked as in the news">
          {running ? 'Searching…' : 'Search the news now'}
        </button>
        <Link to="/news/runs" className="link text-sm font-semibold">
          Past runs
        </Link>
        {children}
      </div>
      {runId && (
        <div className="basis-full">
          <NewsRunView
            run={data?.run ?? null}
            steps={data?.steps ?? []}
            failure={startFailure ?? failure}
            actions={
              <>
                <Link to="/news/runs" search={{ run: runId }} className="link">
                  Every run
                </Link>
                {(status.finished || startFailure) && (
                  <button type="button" className="link cursor-pointer" onClick={() => setRunId(null)}>
                    Close
                  </button>
                )}
              </>
            }
          />
        </div>
      )}
    </>
  )
}

const MARK: Record<'search' | 'stopped_reading' | 'stopped' | 'reading' | ReadOutcome, { glyph: string; className: string }> = {
  search: { glyph: '⌕', className: 'border-ink bg-surface' },
  reading: { glyph: '', className: 'border-ink border-t-transparent bg-surface animate-spin' },
  queued: { glyph: '✓', className: 'border-ink bg-support text-white' },
  lead: { glyph: '~', className: 'border-ink border-dashed bg-surface' },
  nothing: { glyph: '–', className: 'border-line bg-surface text-faint' },
  failed: { glyph: '✕', className: 'border-ink bg-oppose text-white' },
  stopped_reading: { glyph: '!', className: 'border-ink bg-mixed' },
  stopped: { glyph: '!', className: 'border-ink bg-oppose text-white' },
}

const rowMark = (row: TraceRow) => MARK[row.kind === 'article' ? row.state : row.kind]
const questionOf = (row: TraceRow | undefined) => (row && (row.kind === 'search' || row.kind === 'article') ? row.question : null)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function rowText(row: TraceRow) {
  if (row.kind === 'stopped' || row.kind === 'stopped_reading') {
    return row.kind === 'stopped' ? { lead: 'Stopped', rest: row.reason } : { lead: 'Stopped reading articles', rest: `${row.reason} Articles found after this are queued as leads.` }
  }
  if (row.kind === 'search') return { lead: `Searched for ${row.query}`, rest: `${plural(row.hits, 'result', 'results')}, ${row.named} naming someone on the roster` }
  const rest = {
    reading: 'Reading…',
    queued: `Queued ${plural(row.queued, 'entry', 'entries')}`,
    lead: `Not read, queued as a lead: ${row.detail ?? ''}`,
    nothing: row.detail ? `Nothing queued: ${row.detail}` : 'Nothing on the question',
    failed: `Not queued: ${row.detail ?? ''} The next run tries it again.`,
  }[row.state]
  return { lead: row.title ?? row.url, rest }
}

// One run: a bar for how many of its searches are done, its totals, and its steps, newest last.
export function NewsRunView({ run, steps, failure, actions }: { run: NewsRun | null; steps: NewsStep[]; failure?: string | null; actions?: ReactNode }) {
  const list = useRef<HTMLOListElement>(null)
  const trace = traceOf(steps)
  const totals = traceTotals(trace)
  const status = runStatus(run, new Date())
  const endedEarly = status.finished && (run?.outcome !== 'searched' || totals.searchesDone < trace.searchesTotal)
  const deferred = status.report?.deferred ?? 0
  useEffect(() => {
    if (!status.finished) list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [trace.rows.length, status.finished])

  return (
    <section aria-label="News search" className="card mt-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-black">{status.heading}</h2>
        {actions && <span className="flex gap-4 text-sm font-semibold">{actions}</span>}
      </div>
      <ProgressBar
        label="Searches done"
        done={totals.searchesDone}
        total={trace.searchesTotal}
        className="mt-3 h-3"
        fillClassName={endedEarly ? 'bg-oppose' : 'bg-support'}
      />
      <p className="mt-2 text-sm text-muted tabular-nums">
        {totals.searchesDone} of {trace.searchesTotal} searches · {plural(totals.reads, 'article', 'articles')} read, at most {trace.maxReads} a run · {totals.queued} queued
        {totals.failed ? ` · ${totals.failed} not queued` : ''}
        {deferred ? ` · ${deferred} left for the next run` : ''}
      </p>
      {(failure || (status.note && !status.report?.error)) && <p className="mt-2 font-bold">{failure ?? status.note}</p>}
      {trace.rows.length > 0 && (
        <ol ref={list} aria-label="Steps" className="mt-3 flex max-h-96 flex-col gap-1.5 overflow-y-auto border-l-2 border-line pr-1 pl-3">
          {trace.rows.map((row, i) => {
            const mark = rowMark(row)
            const { lead, rest } = rowText(row)
            const question = questionOf(row)
            return (
              <li key={i} className="text-sm">
                {question !== null && question !== questionOf(trace.rows[i - 1]) && <p className="tag mt-1.5 mb-1 text-faint">{question}</p>}
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
