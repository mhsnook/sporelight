import { describe, expect, it } from 'vitest'
import type { NewsRun, NewsStep, ReadOutcome } from '../../shared/news-run.ts'
import { runStatus, traceOf, traceTotals } from './news-trace.ts'

const reading = (url: string): NewsStep => ({ kind: 'reading', question: 'Ferry', url, title: url })
const read = (url: string, outcome: ReadOutcome, queued = 0, detail: string | null = null): NewsStep => ({ kind: 'read', question: 'Ferry', url, title: url, outcome, queued, detail })

const NOW = new Date('2026-11-20T12:00:00Z')
const run = (over: Partial<NewsRun>): NewsRun => ({ id: 'r', started_at: '2026-11-20T11:55:00Z', started_by: 'editor', outcome: 'running', finished_at: null, detail: null, ...over })

describe('traceOf', () => {
  it('counts searches against the plan, and articles as they are read', () => {
    const trace = traceOf([
      { kind: 'plan', questions: ['Ferry', 'Berth'], queriesPerQuestion: 4, maxReads: 15 },
      { kind: 'searched', question: 'Ferry', query: 'ferry news', hits: 10, named: 2 },
      reading('a'),
      read('a', 'queued', 2),
      reading('b'),
      read('b', 'failed', 0, 'The room was asleep.'),
      reading('c'),
    ])
    expect(trace).toMatchObject({ searchesTotal: 8, maxReads: 15 })
    expect(traceTotals(trace)).toEqual({ searchesDone: 1, reads: 3, queued: 2, failed: 1 })
  })

  it('turns the open row for an article into its outcome, in place', () => {
    const trace = traceOf([reading('a'), read('a', 'nothing'), reading('b'), read('b', 'lead', 1, 'The site answered 403.')])
    expect(trace.rows.map((r) => (r.kind === 'article' ? [r.url, r.state, r.detail] : r.kind))).toEqual([
      ['a', 'nothing', null],
      ['b', 'lead', 'The site answered 403.'],
    ])
  })

  it('keeps a stop among the steps, in order', () => {
    const trace = traceOf([
      reading('a'),
      { kind: 'stopped_reading', reason: 'The model call failed.' },
      read('a', 'lead', 1),
      { kind: 'searched', question: 'Ferry', query: 'q', hits: 1, named: 0 },
      { kind: 'stopped', reason: 'The review queue is full.' },
    ])
    expect(trace.rows.map((r) => (r.kind === 'article' ? r.state : r.kind))).toEqual(['lead', 'stopped_reading', 'search', 'stopped'])
  })
})

describe('runStatus', () => {
  it('is not finished while the run is starting or running', () => {
    expect(runStatus(null, NOW).finished).toBe(false)
    expect(runStatus(run({}), NOW)).toMatchObject({ finished: false, heading: 'Searching the news' })
  })

  it('gives up on a run still marked running an hour after it started', () => {
    expect(runStatus(run({ started_at: '2026-11-20T10:30:00Z' }), NOW)).toMatchObject({ finished: true, heading: 'The news search did not finish' })
  })

  it('reads the report of a finished run, and says when it stopped early', () => {
    const report = { questions: [{ question: 'Ferry', hits: 3, read: 1, queued: 1, failed: 0 }], deferred: 0 }
    expect(runStatus(run({ outcome: 'searched', detail: JSON.stringify(report) }), NOW)).toEqual({ finished: true, heading: 'The news search finished', report, note: null })
    const stopped = { ...report, error: 'Web search failed (502)' }
    expect(runStatus(run({ outcome: 'stopped', detail: JSON.stringify(stopped) }), NOW)).toMatchObject({ heading: 'The news search stopped early', note: 'Web search failed (502)' })
  })

  it('gives the reason for a skipped run and the error of a failed one', () => {
    expect(runStatus(run({ outcome: 'skipped', detail: '3 automated proposals are waiting.' }), NOW)).toMatchObject({ finished: true, note: '3 automated proposals are waiting.' })
    expect(runStatus(run({ outcome: 'failed', detail: 'Error: D1 is down' }), NOW)).toMatchObject({ finished: true, heading: 'The news search did not finish', note: 'Error: D1 is down' })
  })
})
