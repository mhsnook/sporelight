import { describe, expect, it } from 'vitest'
import { EDITORS_ID, NEWS_READER_ID, type Review } from '../../shared/schema.ts'
import type { TieredReview } from './build-tracker.ts'
import { act, decider, question, review, track } from './fixtures.ts'
import { newReview, reviewToConfirm } from './own-review.ts'

const at = (r: Review, updated_at: string): Review => ({ ...r, updated_at })
const tiered = (tier: TieredReview['tier'], r: Review): TieredReview => ({ tier, review: r })

describe('reviewToConfirm', () => {
  it('copies the newest review in the tier the reading comes from that agrees with the reading', () => {
    const older = tiered('person', at(review('a', 'q', 'support', 'clear', 'cy'), '2026-11-01'))
    const newer = tiered('person', at(review('a', 'q', 'support', 'concrete', 'di'), '2026-11-02'))
    const agent = tiered('agent', at(review('a', 'q', 'oppose', 'clear', NEWS_READER_ID), '2026-11-03'))
    expect(reviewToConfirm([older, newer, agent], 'me')?.id).toBe(newer.review.id)
  })

  it('copies the newest in the tier when none of its reviews says what their average does', () => {
    const mixed = tiered('person', at(review('a', 'q', 'mixed', 'clear', 'cy'), '2026-11-01'))
    const against = tiered('person', at(review('a', 'q', 'oppose', 'clear', 'di'), '2026-11-02'))
    expect(reviewToConfirm([mixed, against], 'me')?.id).toBe(against.review.id)
  })

  it('offers nothing when the reviewer’s own review is the only one, or the tier says the act says nothing', () => {
    expect(reviewToConfirm([tiered('person', review('a', 'q', 'support', 'clear', 'me'))], 'me')).toBeNull()
    const nothing = tiered('editor', { ...review('a', 'q', 'support'), position: null, weight: null })
    expect(reviewToConfirm([nothing, tiered('agent', review('a', 'q', 'support', 'clear', NEWS_READER_ID))], 'me')).toBeNull()
  })
})

describe('newReview', () => {
  it('points a confirmed review at the one it copied, and a review of one’s own at nothing', () => {
    const theirs = review('a', 'q', 'support', 'clear', NEWS_READER_ID)
    expect(newReview('me', 'a', 'q', { position: 'support', weight: 'clear' }, 'now', 'r1', theirs)).toMatchObject({ reviewer_id: 'me', based_on: theirs.id, created_at: 'now', updated_at: 'now' })
    expect(newReview('me', 'a', 'q', { position: null, weight: null }, 'now', 'r2')).toMatchObject({ position: null, weight: null, based_on: null })
  })
})

describe('reviewsOn', () => {
  it('gives the reviews that count for an act as shown, each in its reviewer’s tier', () => {
    const t = track({
      deciders: [decider('ann')],
      questions: [question('q')],
      acts: [act('a', 'ann'), act('b', 'ann')],
      people: [{ id: NEWS_READER_ID, kind: 'agent', role: 'member' }, { id: 'cy', kind: 'person', role: 'member' }],
      reviews: [review('a', 'q', 'support', 'clear', NEWS_READER_ID), review('b', 'q', 'mixed', 'clear', 'cy')],
      sameActs: [{ act_id: 'a', same_as_id: 'b', marked_by: 'cy', marked_at: 't' }],
    })
    expect(t.reviewsOn('b', 'q').map((r) => [r.review.reviewer_id, r.tier]).sort()).toEqual([
      ['cy', 'person'],
      [NEWS_READER_ID, 'agent'],
    ])
    expect(t.reviewsOn('a', 'q')).toEqual([])
  })
})

describe('saidNothingOn', () => {
  const policy = question('policy')
  const bill = question('bill', { parent_id: 'policy', kind: 'formal_act', implies_on_parent: 'support' })
  const people = [{ id: NEWS_READER_ID, kind: 'agent' as const, role: 'member' as const }, { id: 'cy', kind: 'person' as const, role: 'member' as const }, { id: EDITORS_ID, kind: 'person' as const, role: 'editor' as const }]
  const nothing = (actId: string, questionId: string, reviewerId: string) => ({ ...review(actId, questionId, 'support', 'clear', reviewerId), position: null, weight: null })
  const t = track({
    deciders: [decider('ann')],
    questions: [policy, bill],
    acts: [act('off', 'ann'), act('settled', 'ann'), act('on-bill', 'ann'), act('read', 'ann')],
    people,
    reviews: [
      review('off', 'policy', 'support', 'clear', NEWS_READER_ID),
      nothing('off', 'policy', 'cy'),
      nothing('settled', 'policy', 'cy'),
      nothing('settled', 'policy', EDITORS_ID),
      review('on-bill', 'bill', 'mixed', 'clear', NEWS_READER_ID),
      nothing('on-bill', 'bill', 'cy'),
      review('read', 'bill', 'mixed', 'clear', NEWS_READER_ID),
    ],
  })

  it('lists an act a member said says nothing, on the question or a step under it, and not one the editors said so of, or one still read there', () => {
    expect(t.saidNothingOn(policy, 'ann').map((s) => [s.act.id, s.question.id])).toEqual([
      ['off', 'policy'],
      ['on-bill', 'bill'],
    ])
  })
})
