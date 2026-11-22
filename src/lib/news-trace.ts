import type { NewsReport, NewsRun, NewsStep, ReadOutcome } from '../../shared/news-run.ts'

export type TraceRow =
  | { kind: 'search'; question: string; query: string; hits: number; named: number }
  | { kind: 'article'; question: string; url: string; title: string | null; state: 'reading' | ReadOutcome; queued: number; detail: string | null }
  | { kind: 'stopped_reading'; reason: string }
  | { kind: 'stopped'; reason: string }

// A run's steps folded into what its page shows.
export type NewsTrace = { searchesTotal: number; maxReads: number; rows: TraceRow[] }

export const emptyTrace: NewsTrace = { searchesTotal: 0, maxReads: 0, rows: [] }

export function applyStep(trace: NewsTrace, step: NewsStep): NewsTrace {
  switch (step.kind) {
    case 'plan':
      return { ...trace, searchesTotal: step.questions.length * step.queriesPerQuestion, maxReads: step.maxReads }
    case 'searched':
      return { ...trace, rows: [...trace.rows, { kind: 'search', question: step.question, query: step.query, hits: step.hits, named: step.named }] }
    case 'reading':
      return { ...trace, rows: [...trace.rows, { kind: 'article', question: step.question, url: step.url, title: step.title, state: 'reading', queued: 0, detail: null }] }
    case 'read': {
      // Reads run one at a time, so the article this ends is the last one begun.
      const at = trace.rows.findLastIndex((r) => r.kind === 'article')
      const open = trace.rows[at]
      if (open?.kind !== 'article') return trace
      return { ...trace, rows: trace.rows.with(at, { ...open, state: step.outcome, queued: step.queued, detail: step.detail }) }
    }
    case 'stopped_reading':
    case 'stopped':
      return { ...trace, rows: [...trace.rows, step] }
  }
}

export const traceOf = (steps: NewsStep[]) => steps.reduce(applyStep, emptyTrace)

export function traceTotals(trace: NewsTrace) {
  const articles = trace.rows.filter((r) => r.kind === 'article')
  return {
    searchesDone: trace.rows.filter((r) => r.kind === 'search').length,
    reads: articles.length,
    queued: articles.reduce((n, r) => n + r.queued, 0),
    failed: articles.filter((r) => r.state === 'failed').length,
  }
}

// A run still `running` after this long was stopped by the platform before it could record how it ended.
const GIVEN_UP_MS = 60 * 60 * 1000

export type RunStatus = { finished: boolean; heading: string; report: NewsReport | null; note: string | null }

// How a run ended, or that it has not, from its row.
export function runStatus(run: NewsRun | null, now: Date): RunStatus {
  if (!run) return { finished: false, heading: 'Starting the news search', report: null, note: null }
  switch (run.outcome) {
    case 'running':
      return now.getTime() - Date.parse(run.started_at) > GIVEN_UP_MS
        ? { finished: true, heading: 'The news search did not finish', report: null, note: 'The run stopped before it could record how it ended.' }
        : { finished: false, heading: 'Searching the news', report: null, note: null }
    case 'skipped':
      return { finished: true, heading: 'The news search was skipped', report: null, note: run.detail }
    case 'failed':
      return { finished: true, heading: 'The news search did not finish', report: null, note: run.detail }
    case 'stopped':
    case 'searched': {
      const report = JSON.parse(run.detail ?? '{}') as NewsReport
      return { finished: true, heading: report.error ? 'The news search stopped early' : 'The news search finished', report, note: report.error ?? null }
    }
  }
}
