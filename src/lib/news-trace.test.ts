import { describe, expect, it } from 'vitest'
import type { NewsStep } from '../../shared/news-run.ts'
import { applyStep, emptyTrace, readSteps, traceFinished } from './news-trace.ts'

const run = (steps: NewsStep[]) => steps.reduce(applyStep, emptyTrace)
const reading = (url: string): NewsStep => ({ kind: 'reading', question: 'Ferry', url, title: url })
const read = (url: string, outcome: Extract<NewsStep, { kind: 'read' }>['outcome'], queued = 0, detail: string | null = null): NewsStep => ({ kind: 'read', question: 'Ferry', url, title: url, outcome, queued, detail })

describe('applyStep', () => {
  it('counts searches against the plan and articles as they are read', () => {
    const trace = run([
      { kind: 'plan', questions: ['Ferry', 'Berth'], queriesPerQuestion: 4, maxReads: 15 },
      { kind: 'searched', question: 'Ferry', query: 'ferry news', hits: 10, named: 2 },
      reading('a'),
      read('a', 'queued', 2),
      reading('b'),
      read('b', 'failed', 0, 'The room was asleep.'),
      reading('c'),
    ])
    expect(trace).toMatchObject({ searchesTotal: 8, searchesDone: 1, maxReads: 15, reads: 3, queued: 2, failed: 1 })
    expect(traceFinished(trace)).toBe(false)
  })

  it('turns the open row for an article into its outcome, in place', () => {
    const trace = run([reading('a'), read('a', 'nothing'), reading('b'), read('b', 'lead', 1, 'The site answered 403.')])
    expect(trace.rows.map((r) => (r.kind === 'article' ? [r.url, r.state, r.detail] : r.kind))).toEqual([
      ['a', 'nothing', null],
      ['b', 'lead', 'The site answered 403.'],
    ])
    expect(new Set(trace.rows.map((r) => r.key)).size).toBe(2)
  })

  it('keeps going after a stop, and finishes on the report', () => {
    const report = { error: 'Stopped reading articles: limit', questions: [], deferred: 3 }
    const trace = run([{ kind: 'stopped', reason: report.error }, { kind: 'searched', question: 'Ferry', query: 'q', hits: 1, named: 0 }, { kind: 'done', report }])
    expect(trace.rows.map((r) => r.kind)).toEqual(['stop', 'search'])
    expect(trace.report).toEqual(report)
    expect(traceFinished(trace)).toBe(true)
  })

  it('finishes without a report when the run crashes or is skipped', () => {
    expect(run([{ kind: 'crashed', error: 'Error: boom' }]).broken).toBe('Error: boom')
    expect(run([{ kind: 'done', report: { skipped: 'The queue is unattended.' } }]).broken).toBe('The queue is unattended.')
  })
})

describe('readSteps', () => {
  it('hands over each line as it completes, across chunk boundaries and split characters', async () => {
    const text = `${JSON.stringify(reading('“é”'))}\n${JSON.stringify(read('“é”', 'queued', 1))}\n`
    const bytes = new TextEncoder().encode(text)
    // Split inside the first line and inside a multi-byte character.
    const cuts = [5, text.indexOf('é') + 2, bytes.length]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let from = 0
        for (const to of cuts) {
          controller.enqueue(bytes.slice(from, to))
          from = to
        }
        controller.close()
      },
    })
    const seen: NewsStep[] = []
    await readSteps(body, (step) => seen.push(step))
    expect(seen.map((s) => s.kind)).toEqual(['reading', 'read'])
    expect(seen[0]).toMatchObject({ url: '“é”' })
  })
})
