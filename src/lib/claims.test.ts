import { describe, expect, it } from 'vitest'
import { EDITORS_ID, NEWS_READER_ID } from '../../shared/schema.ts'
import { claimOf } from './claims.ts'
import { act, decider, item, proposal, question, report, review, track } from './fixtures.ts'

describe('claimOf', () => {
  const policy = question('policy')
  const sent = proposal('p1', 'article', { origin: 'model', submitted_by: NEWS_READER_ID })
  const cameIn = item('i1', 'p1', 'ann', 'policy', { act_id: 'came-in' })
  const rows = {
    deciders: [decider('ann')],
    questions: [policy],
    acts: [act('came-in', 'ann', { body: 'I am for it.', occurred_on: null }), act('on-record', 'ann')],
    reports: [report('article', 'came-in', { passage: 'Ann said: I am for it.' })],
    reviews: [review('came-in', 'policy', 'support', 'clear', NEWS_READER_ID)],
  }

  it("gives the act's facts, its passage in the source and the sender's reading, waiting until the editors review it", () => {
    expect(claimOf(track(rows), sent, cameIn)).toMatchObject({ isLead: false, kind: 'says', occurred_on: null, quote: 'I am for it.', passage: 'Ann said: I am for it.', reading: 'support', weight: 'clear', verdict: 'waiting' })
  })

  it("reads the editors' review on the act it was found to be the same as, and one that says nothing on the act itself", () => {
    const marked = { act_id: 'came-in', same_as_id: 'on-record', marked_by: EDITORS_ID, marked_at: 't' }
    expect(claimOf(track({ ...rows, sameActs: [marked], reviews: [...rows.reviews, review('on-record', 'policy', 'oppose')] }), { ...sent, status: 'reviewed' }, cameIn).verdict).toBe('published')
    const nothing = { ...review('came-in', 'policy', 'support'), position: null, weight: null }
    expect(claimOf(track({ ...rows, reviews: [...rows.reviews, nothing] }), { ...sent, status: 'reviewed' }, cameIn).verdict).toBe('turned_down')
  })

  it('gives a lead no reading and its excerpt as words, turned down once its proposal is reviewed', () => {
    const lead = item('lead', 'p1', 'ann', 'policy', { act_id: null, excerpt: 'Ann was named.' })
    expect(claimOf(track(rows), sent, lead)).toMatchObject({ isLead: true, quote: 'Ann was named.', reading: null, verdict: 'waiting' })
    expect(claimOf(track(rows), { ...sent, status: 'reviewed' }, lead).verdict).toBe('turned_down')
  })
})
