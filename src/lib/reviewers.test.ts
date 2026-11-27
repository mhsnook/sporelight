import { describe, expect, it } from 'vitest'
import { EDITORS_ID, NEWS_READER_ID, type Review } from '../../shared/schema.ts'
import type { Reviewer } from './build-tracker.ts'
import { act, decider, question, review, track } from './fixtures.ts'
import { confirmsLine, notCountedLine, readingFromLine, reviewedByLine, reviewerOf, type ReviewerPerson } from './reviewers.ts'

const policy = question('policy')
const bill = question('bill', { parent_id: 'policy', kind: 'formal_act', implies_on_parent: 'support', sort: 1 })

const reviewers: Reviewer[] = [
  { id: EDITORS_ID, role: 'editor', kind: 'person' },
  { id: 'ed', role: 'editor', kind: 'person' },
  { id: 'ana', role: 'member', kind: 'person' },
  { id: 'ben', role: 'member', kind: 'person' },
  { id: 'unnamed', role: 'member', kind: 'person' },
  { id: NEWS_READER_ID, role: 'member', kind: 'agent' },
]
const names = new Map<string, ReviewerPerson>(
  [
    [EDITORS_ID, 'Editors'],
    ['ed', 'Edie Okafor'],
    ['ana', 'Ana Ruiz'],
    ['ben', 'Ben Ola'],
    ['unnamed', null],
    [NEWS_READER_ID, 'News reader'],
  ].map(([id, display_name]) => [id!, { id: id!, display_name }]),
)

// A review written at a moment, so the list's order by time can be checked.
const at = (r: Review, minute: number, over: Partial<Review> = {}): Review => {
  const stamp = `2026-11-20T10:${String(minute).padStart(2, '0')}:00.000Z`
  return { ...r, created_at: stamp, updated_at: stamp, ...over }
}

const reviewersOf = (reviews: Review[], actId = 'a', questionId = 'policy') =>
  track({ deciders: [decider('sato')], questions: [policy, bill], acts: [act('a', 'sato')], reviews, people: reviewers }).reviewersOf(actId, questionId)

describe('whose reviews a reading comes from', () => {
  it('lists the reviews of one group, all counting, and names the group by how many reviewed', () => {
    const of = reviewersOf([at(review('a', 'policy', 'support', 'clear', 'ana'), 1), at(review('a', 'policy', 'lean_support', 'clear', 'ben'), 2)])!
    expect(of.from).toBe('person')
    expect(of.rows.map((r) => [r.review.reviewer_id, r.notCounted])).toEqual([
      ['ana', null],
      ['ben', null],
    ])
    expect(reviewedByLine(of)).toBe('Reviewed by 2 members')
    expect(readingFromLine(of)).toBe('No editor has reviewed this yet, so the reading shown comes from the members’ reviews, averaged.')
  })

  it('lists the reviews of lower groups after the ones that count, each saying which group outranks it', () => {
    const of = reviewersOf([
      at(review('a', 'policy', 'support', 'clear', NEWS_READER_ID), 1),
      at(review('a', 'policy', 'oppose', 'clear', 'ana'), 2),
      at(review('a', 'policy', 'mixed', 'clear', 'ed'), 3),
    ])!
    expect(of.from).toBe('editor')
    expect(of.rows.map((r) => [r.review.reviewer_id, r.notCounted])).toEqual([
      ['ed', null],
      ['ana', { why: 'outranked', by: 'editor' }],
      [NEWS_READER_ID, { why: 'outranked', by: 'editor' }],
    ])
    expect(reviewedByLine(of)).toBe('Reviewed by an editor · 2 more not counted')
    expect(readingFromLine(of)).toBe('The reading shown comes from the editors’ review.')
    expect(notCountedLine(of.rows[1].notCounted!)).toBe('Does not count while editors have reviewed it.')
  })

  it("says a member's review is outranked by members when the news reader's is listed under it", () => {
    const of = reviewersOf([review('a', 'policy', 'support', 'clear', NEWS_READER_ID), review('a', 'policy', 'oppose', 'clear', 'ana')])!
    expect(notCountedLine(of.rows[1].notCounted!)).toBe('Does not count while members have reviewed it.')
  })

  it('names the editors and the news reader by who they are when they reviewed alone', () => {
    expect(reviewedByLine(reviewersOf([review('a', 'policy', 'support', 'clear', EDITORS_ID)])!)).toBe('Reviewed by the editors')
    const agentOnly = reviewersOf([review('a', 'policy', 'support', 'clear', NEWS_READER_ID)])!
    expect(reviewedByLine(agentOnly)).toBe('Reviewed by the news reader')
    expect(readingFromLine(agentOnly)).toBe('No editor or member has reviewed this yet, so the reading shown comes from the news reader’s review.')
  })

  it('points a review made by confirming another at the review it confirmed', () => {
    const readers = at(review('a', 'policy', 'support', 'clear', NEWS_READER_ID), 1)
    const confirmed = at(review('a', 'policy', 'support', 'clear', 'ana'), 2, { based_on: readers.id })
    const of = reviewersOf([readers, confirmed])!
    const ana = of.rows.find((r) => r.review.reviewer_id === 'ana')!
    expect(ana.confirms).toEqual({ id: readers.id, review: readers })
    expect(confirmsLine(ana.confirms!, names)).toBe('Made by confirming News reader’s review.')
    expect(of.rows.find((r) => r.review.reviewer_id === NEWS_READER_ID)!.confirms).toBeNull()
  })

  it('says so when the review a confirmation was made from has been removed', () => {
    const of = reviewersOf([{ ...review('a', 'policy', 'support', 'clear', 'ana'), based_on: 'gone' }])!
    expect(of.rows[0].confirms).toEqual({ id: 'gone', review: undefined })
    expect(confirmsLine(of.rows[0].confirms!, names)).toBe('Made by confirming a review that has since been removed.')
  })

  it('counts a reviewer with no row on file with the agents, and shows them as unknown', () => {
    const of = reviewersOf([review('a', 'policy', 'oppose', 'clear', 'nobody-on-file'), review('a', 'policy', 'support', 'clear', 'ana')])!
    const unknown = of.rows.find((r) => r.review.reviewer_id === 'nobody-on-file')!
    expect(unknown.tier).toBe('agent')
    expect(unknown.notCounted).toEqual({ why: 'outranked', by: 'person' })
    expect(reviewerOf(unknown, names)).toEqual({ name: 'Unknown reviewer', is: null })
  })

  it('shows a reviewer with no display name without one, and never anything but the display name', () => {
    const of = reviewersOf([review('a', 'policy', 'support', 'clear', 'unnamed'), review('a', 'policy', 'support', 'clear', 'ana')])!
    // Same moment, so they are listed by review id.
    expect(of.rows.map((r) => reviewerOf(r, names))).toEqual([
      { name: 'Ana Ruiz', is: 'member' },
      { name: null, is: 'member' },
    ])
    const confirming = reviewersOf([{ ...review('a', 'policy', 'support', 'clear', 'unnamed'), id: 'by-unnamed' }, { ...review('a', 'policy', 'support', 'clear', 'ana'), based_on: 'by-unnamed' }])!
    expect(confirmsLine(confirming.rows.find((r) => r.confirms)!.confirms!, names)).toBe('Made by confirming the review of someone with no name yet.')
  })

  it('lists a review given on a sub-question that counts on its parent, with what it counts as there', () => {
    const of = reviewersOf([review('a', 'bill', 'support', 'concrete', 'ed')])!
    expect(of.rows).toHaveLength(1)
    expect(of.rows[0]).toMatchObject({ via: bill, position: 'support', weight: 'concrete', notCounted: null })
    expect(reviewersOf([review('a', 'bill', 'support', 'concrete', 'ed')], 'a', 'bill')!.rows[0].via).toBeUndefined()
  })

  it('leaves out of the average a review in the counting group that says the act says nothing, and says why', () => {
    const of = reviewersOf([review('a', 'policy', 'support', 'clear', 'ana'), review('a', 'policy', null, null, 'ben')])!
    expect(of.rows.map((r) => [r.review.reviewer_id, r.notCounted])).toEqual([
      ['ana', null],
      ['ben', { why: 'said_nothing' }],
    ])
    expect(reviewedByLine(of)).toBe('Reviewed by a member · 1 more not counted')
  })

  it('has nothing to list when the reviews give the act no reading on the question', () => {
    expect(reviewersOf([review('a', 'policy', null, null, 'ed'), review('a', 'policy', 'support', 'clear', 'ana')])).toBeUndefined()
    expect(reviewersOf([])).toBeUndefined()
  })

  it('lists the reviews of an act shown as another under the act it is shown as', () => {
    const tracker = track({
      deciders: [decider('sato')],
      questions: [policy],
      acts: [act('a', 'sato'), act('a-again', 'sato')],
      reviews: [review('a-again', 'policy', 'support', 'clear', 'ana')],
      sameActs: [{ act_id: 'a-again', same_as_id: 'a', marked_by: 'ed', marked_at: '2026-11-20T00:00:00.000Z' }],
      people: reviewers,
    })
    expect(tracker.reviewersOf('a', 'policy')!.rows.map((r) => r.review.reviewer_id)).toEqual(['ana'])
  })
})
