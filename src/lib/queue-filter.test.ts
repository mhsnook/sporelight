import { describe, expect, it } from 'vitest'
import type { ProposalItem } from '../../shared/schema.ts'
import { narrowQueue, tallyQueue } from './queue-filter.ts'
import { item, proposal, question, track } from './fixtures.ts'

const NOW = new Date('2026-11-17T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()

const policy = question('policy', { sort: 0 })
const bill = question('bill', { parent_id: 'policy', kind: 'formal_act', sort: 1 })
const markup = question('markup', { parent_id: 'policy', sort: 2 })
const ferry = question('ferry', { sort: 3 })
const harbor = question('harbor', { sort: 4 })
const tracker = track({ questions: [policy, bill, markup, ferry, harbor] })

const byProposal = (items: ProposalItem[]) => (id: string) => items.filter((i) => i.proposal_id === id)

describe('tallyQueue', () => {
  it('counts sub-question items under their top-level question, once per proposal', () => {
    const pending = [proposal('p1', 's'), proposal('p2', 's'), proposal('p3', 's')]
    const items = [
      item('a', 'p1', 'ann', 'policy'),
      item('b', 'p1', 'bob', 'bill'),
      item('c', 'p2', 'ann', 'markup'),
      item('d', 'p3', 'ann', 'ferry'),
    ]
    expect(tallyQueue(tracker, pending, byProposal(items), NOW).map((t) => [t.question.id, t.waiting])).toEqual([
      ['policy', 2],
      ['ferry', 1],
    ])
  })

  it('counts a proposal under each top-level question it has an item on', () => {
    const items = [item('a', 'p1', 'ann', 'bill'), item('b', 'p1', 'ann', 'ferry')]
    expect(tallyQueue(tracker, [proposal('p1', 's')], byProposal(items), NOW).map((t) => [t.question.id, t.waiting])).toEqual([
      ['policy', 1],
      ['ferry', 1],
    ])
  })

  it('counts what arrived in the last day, and breaks a tie in waiting by it', () => {
    const pending = [
      proposal('old-policy', 's', { created_at: hoursAgo(30) }),
      proposal('new-ferry', 's', { created_at: hoursAgo(2) }),
      proposal('edge-ferry', 's', { created_at: hoursAgo(24) }),
      proposal('old-ferry', 's', { created_at: hoursAgo(25) }),
      proposal('older-policy', 's', { created_at: hoursAgo(48) }),
      proposal('old-harbor', 's', { created_at: hoursAgo(26) }),
      proposal('older-harbor', 's', { created_at: hoursAgo(50) }),
    ]
    const items = [
      item('a', 'old-policy', 'ann', 'policy'),
      item('b', 'older-policy', 'ann', 'bill'),
      item('c', 'new-ferry', 'ann', 'ferry'),
      item('d', 'edge-ferry', 'ann', 'ferry'),
      item('e', 'old-ferry', 'ann', 'ferry'),
      item('f', 'old-harbor', 'ann', 'harbor'),
      item('g', 'older-harbor', 'ann', 'harbor'),
    ]
    expect(tallyQueue(tracker, pending, byProposal(items), NOW).map((t) => [t.question.id, t.waiting, t.lastDay])).toEqual([
      ['ferry', 3, 2],
      ['policy', 2, 0],
      ['harbor', 2, 0],
    ])
  })

  it('leaves out items on a question that is not on file', () => {
    expect(tallyQueue(tracker, [proposal('p1', 's')], byProposal([item('a', 'p1', 'ann', 'gone')]), NOW)).toEqual([])
  })
})

describe('narrowQueue', () => {
  const pending = [proposal('across', 's'), proposal('p-bill', 's'), proposal('p-ferry', 's'), proposal('p-markup', 's')]
  const items = [
    item('a', 'across', 'ann', 'policy'),
    item('b', 'p-bill', 'ann', 'bill'),
    item('c', 'p-ferry', 'ann', 'ferry'),
    item('d', 'p-markup', 'ann', 'markup'),
    item('e', 'p-markup', 'bob', 'ferry'),
  ]

  it('keeps proposals with an item on the question or anything under it, in the order given', () => {
    expect(narrowQueue(tracker, pending, byProposal(items), 'policy').map((p) => p.id)).toEqual(['across', 'p-bill', 'p-markup'])
  })

  it('on a sub-question, keeps only that sub-question', () => {
    expect(narrowQueue(tracker, pending, byProposal(items), 'bill').map((p) => p.id)).toEqual(['p-bill'])
  })

  it('keeps a proposal on two questions under either one', () => {
    expect(narrowQueue(tracker, pending, byProposal(items), 'ferry').map((p) => p.id)).toEqual(['p-ferry', 'p-markup'])
  })

  it('keeps nothing for a question with nothing waiting', () => {
    expect(narrowQueue(tracker, pending, byProposal(items), 'harbor')).toEqual([])
  })
})
