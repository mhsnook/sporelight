import type { Proposal, ProposalItem, Question } from '../../shared/schema.ts'
import type { Tracker } from './build-tracker.ts'
import { questionFamily } from './feed.ts'

const DAY_MS = 24 * 60 * 60 * 1000

// How many waiting proposals have an item on a top-level question or anything under it.
export type QuestionTally = { question: Question; waiting: number; lastDay: number }

// The top-level question a question sits under, at any depth.
export function topQuestionOf(tracker: Pick<Tracker, 'questionById'>, question: Question): Question {
  const seen = new Set<string>()
  let top = question
  while (top.parent_id && !seen.has(top.id)) {
    seen.add(top.id)
    const parent = tracker.questionById.get(top.parent_id)
    if (!parent) break
    top = parent
  }
  return top
}

// The questions with something waiting, busiest first. A proposal counts once
// per top-level question, however many of its items fall under it.
export function tallyQueue(tracker: Pick<Tracker, 'questionById'>, pending: Proposal[], itemsOf: (proposalId: string) => ProposalItem[], now: Date): QuestionTally[] {
  const since = now.getTime() - DAY_MS
  const tallies = new Map<string, QuestionTally>()
  for (const proposal of pending) {
    const tops = new Set<Question>()
    for (const item of itemsOf(proposal.id)) {
      const question = tracker.questionById.get(item.question_id)
      if (question) tops.add(topQuestionOf(tracker, question))
    }
    const recent = Date.parse(proposal.created_at) >= since
    for (const question of tops) {
      const tally = tallies.get(question.id) ?? { question, waiting: 0, lastDay: 0 }
      tally.waiting++
      if (recent) tally.lastDay++
      tallies.set(question.id, tally)
    }
  }
  return [...tallies.values()].sort(
    (a, b) => b.waiting - a.waiting || b.lastDay - a.lastDay || a.question.sort - b.question.sort || a.question.short_title.localeCompare(b.question.short_title),
  )
}

// The proposals with an item on the question or one under it, in the order they came in.
export function narrowQueue<P extends Proposal>(tracker: Pick<Tracker, 'subQuestionsOf'>, proposals: P[], itemsOf: (proposalId: string) => ProposalItem[], questionId: string): P[] {
  const family = questionFamily(tracker, questionId)
  return proposals.filter((p) => itemsOf(p.id).some((i) => family.has(i.question_id)))
}
