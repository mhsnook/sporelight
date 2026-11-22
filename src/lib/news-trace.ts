import type { NewsReport, NewsStep, ReadOutcome } from '../../shared/news-run.ts'

export type TraceRow =
  | { key: string; kind: 'search'; question: string; query: string; hits: number; named: number }
  | { key: string; kind: 'article'; question: string; url: string; title: string | null; state: 'reading' | ReadOutcome; queued: number; detail: string | null }
  | { key: string; kind: 'stop'; reason: string }

// A news search run as the editor who started it sees it: the steps so far and the totals they add up to.
export type NewsTrace = {
  searchesTotal: number
  searchesDone: number
  maxReads: number
  reads: number
  queued: number
  failed: number
  rows: TraceRow[]
  report: NewsReport | null
  // Why the run ended without a report: it crashed, or the connection to it was lost.
  broken: string | null
}

export const emptyTrace: NewsTrace = { searchesTotal: 0, searchesDone: 0, maxReads: 0, reads: 0, queued: 0, failed: 0, rows: [], report: null, broken: null }

export const traceFinished = (trace: NewsTrace) => trace.report !== null || trace.broken !== null

export function applyStep(trace: NewsTrace, step: NewsStep): NewsTrace {
  const key = `${trace.rows.length}`
  switch (step.kind) {
    case 'plan':
      return { ...trace, searchesTotal: step.questions.length * step.queriesPerQuestion, maxReads: step.maxReads }
    case 'searched':
      return { ...trace, searchesDone: trace.searchesDone + 1, rows: [...trace.rows, { key, kind: 'search', question: step.question, query: step.query, hits: step.hits, named: step.named }] }
    case 'reading':
      return {
        ...trace,
        reads: trace.reads + 1,
        rows: [...trace.rows, { key, kind: 'article', question: step.question, url: step.url, title: step.title, state: 'reading', queued: 0, detail: null }],
      }
    case 'read': {
      // The row the matching 'reading' step opened. Reads run one at a time, so it is the last open one.
      const at = trace.rows.findLastIndex((r) => r.kind === 'article' && r.state === 'reading' && r.url === step.url)
      const done: TraceRow = { key: at === -1 ? key : trace.rows[at].key, kind: 'article', question: step.question, url: step.url, title: step.title, state: step.outcome, queued: step.queued, detail: step.detail }
      return {
        ...trace,
        queued: trace.queued + step.queued,
        failed: trace.failed + Number(step.outcome === 'failed'),
        rows: at === -1 ? [...trace.rows, done] : trace.rows.with(at, done),
      }
    }
    case 'stopped':
      return { ...trace, rows: [...trace.rows, { key, kind: 'stop', reason: step.reason }] }
    case 'done':
      return 'skipped' in step.report ? { ...trace, broken: step.report.skipped } : { ...trace, report: step.report }
    case 'crashed':
      return { ...trace, broken: step.error }
  }
}

// Reads a response of one JSON step a line, handing each to `onStep` as it arrives.
export async function readSteps(body: ReadableStream<Uint8Array>, onStep: (step: NewsStep) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  for (;;) {
    const { value, done } = await reader.read()
    buffered += decoder.decode(value, { stream: !done })
    const lines = buffered.split('\n')
    buffered = done ? '' : lines.pop()!
    for (const line of lines) if (line.trim()) onStep(JSON.parse(line) as NewsStep)
    if (done) return
  }
}
