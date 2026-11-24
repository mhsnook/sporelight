import { describe, expect, it } from 'vitest'
import { planMerge, type Write } from './review-plan.ts'
import { act, decider, item, question, review, report, source, track } from './fixtures.ts'

// Applies a plan to plain arrays the way the store would, so a test can look at
// what a reader ends up seeing.
function apply<T extends { id: string }>(rows: T[], writes: Write[], on: Write['on']): T[] {
  let out = rows.map((r) => ({ ...r }))
  for (const w of writes) {
    if (w.on !== on) continue
    if (w.type === 'delete') out = out.filter((r) => r.id !== w.id)
    else if (w.type === 'update') Object.assign(out.find((r) => r.id === w.id)!, w.changes)
    else out.push(w.row as unknown as T)
  }
  return out
}

describe('planMerge', () => {
  const before = {
    acts: [act('feb-11', 'ann', { occurred_on: '2026-02-11' }), act('feb-11-again', 'ann', { occurred_on: '2026-02-12', primary_source_id: 'release' }), act('other', 'bob')],
    reports: [report('paper', 'feb-11'), report('paper', 'feb-11-again', { excerpt: 'As the paper put it.' }), report('wire', 'feb-11-again'), report('release', 'feb-11-again')],
    reviews: [review('feb-11', 'policy', 'support'), review('feb-11-again', 'policy', 'lean_support'), review('feb-11-again', 'markup', 'oppose')],
    proposalItems: [item('i1', 'p1', 'ann', 'policy', { act_id: 'feb-11-again', status: 'accepted' }), item('i2', 'p2', 'ann', 'policy', { act_id: 'feb-11' })],
  }
  const writes = planMerge(before, 'feb-11', 'feb-11-again')
  const after = {
    acts: apply(before.acts, writes, 'acts'),
    reports: apply(before.reports, writes, 'reports'),
    reviews: apply(before.reviews, writes, 'reviews'),
    proposalItems: apply(before.proposalItems, writes, 'proposal_items'),
  }

  it('leaves one act, carrying the primary source the survivor lacked', () => {
    expect(after.acts.map((a) => [a.id, a.primary_source_id])).toEqual([
      ['feb-11', 'release'],
      ['other', null],
    ])
  })

  it('moves reports to the survivor, keeping one per source and the words each source printed', () => {
    expect(after.reports.map((r) => [r.source_id, r.act_id, r.excerpt]).sort()).toEqual([
      ['paper', 'feb-11', 'As the paper put it.'],
      ['release', 'feb-11', 'feb-11-again'],
      ['wire', 'feb-11', 'feb-11-again'],
    ])
  })

  it("moves reviews to the survivor, and keeps the survivor's where one reviewer read both on the same question", () => {
    expect(after.reviews.map((r) => [r.act_id, r.question_id, r.position]).sort()).toEqual([
      ['feb-11', 'markup', 'oppose'],
      ['feb-11', 'policy', 'support'],
    ])
  })

  it("keeps another reviewer's review of the dropped act beside the survivor's own", () => {
    const theirs = review('feb-11-again', 'policy', 'oppose', 'clear', 'a-reader')
    const moved = planMerge({ ...before, reviews: [...before.reviews, theirs] }, 'feb-11', 'feb-11-again')
    expect(moved).toContainEqual({ on: 'reviews', type: 'update', id: theirs.id, changes: { act_id: 'feb-11' } })
  })

  it('repoints proposal items, so the queue still knows the act is on file', () => {
    expect(after.proposalItems.map((i) => i.act_id)).toEqual(['feb-11', 'feb-11'])
  })

  it('deletes the dropped act only after everything that pointed at it has moved', () => {
    const last = writes.at(-1)
    expect(last).toEqual({ on: 'acts', type: 'delete', id: 'feb-11-again' })
    expect([...new Set(writes.map((w) => w.on))]).toEqual(['reports', 'reviews', 'proposal_items', 'acts'])
  })

  it('shows a reader one entry with every source', () => {
    const policy = question('policy')
    const tracker = track({ deciders: [decider('ann'), decider('bob')], questions: [policy, question('markup', { parent_id: 'policy' })], sources: [source('paper'), source('wire'), source('release')], ...after })
    const record = tracker.recordFor(policy, 'ann')
    expect(record).toHaveLength(1)
    expect(record[0].reports.map((r) => r.source.id)).toEqual(['release', 'paper', 'wire'])
  })

  it('refuses acts by different people, a missing act, and an act with itself', () => {
    expect(() => planMerge(before, 'feb-11', 'other')).toThrow(/different people/)
    expect(() => planMerge(before, 'feb-11', 'gone')).toThrow(/on file/)
    expect(() => planMerge(before, 'feb-11', 'feb-11')).toThrow(/itself/)
  })
})
