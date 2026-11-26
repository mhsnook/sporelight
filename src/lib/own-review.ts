import type { Direction, Review, Weight } from '../../shared/schema.ts'
import { summarize } from '../../shared/standing.ts'
import type { TieredReview } from './build-tracker.ts'

// The answers a reviewer gives: a direction and a weight, or null for both when
// the act says nothing on the question.
export type Answers = { position: Direction; weight: Weight } | { position: null; weight: null }

// The review Confirm copies, from the tier the shown reading comes from: the
// newest that agrees with that reading, or the newest in the tier if none
// does. None while every review there says nothing, or when the reviewer's
// own review is the only one.
export function reviewToConfirm(reviews: TieredReview[], reviewerId: string): Review | null {
  const others = reviews.filter((r) => r.review.reviewer_id !== reviewerId)
  const summary = summarize(others.map(({ review, tier }) => ({ tier, position: review.position, weight: review.weight })))
  if (!summary) return null
  const tier = others
    .filter((r) => r.tier === summary.tier && r.review.position !== null)
    .map((r) => r.review)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
  return tier.find((r) => r.position === summary.position) ?? tier[0]
}

// A new review of an act on a question, or `started` from someone else's with its answers.
export function newReview(reviewerId: string, actId: string, questionId: string, answers: Answers, now: string, id: string, started: Review | null = null): Review {
  return { id, reviewer_id: reviewerId, act_id: actId, question_id: questionId, ...answers, based_on: started?.id ?? null, created_at: now, updated_at: now }
}
