import { EDITORS_ID, NEWS_READER_ID, type Person, type Review } from '../../shared/schema.ts'
import type { ReviewerTier } from '../../shared/standing.ts'
import type { NotCounted, ReviewerRow, Reviewers } from './build-tracker.ts'
import { DIRECTION_LABEL, WEIGHT_LABEL } from './position.ts'

export type ReviewerPerson = Pick<Person, 'id' | 'display_name'>

// What a review says, as the review forms word it.
export const answersLabel = (r: Pick<Review, 'position' | 'weight'>) => (r.position && r.weight ? `${DIRECTION_LABEL[r.position]} · ${WEIGHT_LABEL[r.weight]}` : 'says nothing on this question')

// One reviewer, then several, in each tier.
const NOUN: Record<ReviewerTier, [string, string]> = {
  editor: ['an editor', 'editors'],
  person: ['a member', 'members'],
  agent: ['an agent', 'agents'],
}

// What a reviewer is, beside their name. Agents include anyone with no row on file, who counts in the lowest tier.
export const TIER_LABEL: Record<ReviewerTier, string> = { editor: 'editor', person: 'member', agent: 'agent' }

const counting = (reviewers: Reviewers) => reviewers.rows.filter((r) => r.notCounted === null)
// One reviewer's support on two sub-questions can both count on the parent, so rows are not reviewers.
const reviewerIds = (rows: ReviewerRow[]) => [...new Set(rows.map((r) => r.review.reviewer_id))]
const onlyReviewer = (reviewers: Reviewers) => {
  const ids = reviewerIds(counting(reviewers))
  return ids.length === 1 ? ids[0] : null
}

// The group the reading comes from, as a reader would name it: "the editors", "2 members", "the news reader".
function groupName(reviewers: Reviewers): string {
  const only = onlyReviewer(reviewers)
  if (only === EDITORS_ID) return 'the editors'
  if (only === NEWS_READER_ID) return 'the news reader'
  const [one, many] = NOUN[reviewers.from]
  return only ? one : `${reviewerIds(counting(reviewers)).length} ${many}`
}

// The short line on an act: whose reviews its reading comes from, and how many more reviews there are that do not count.
export function reviewedByLine(reviewers: Reviewers): string {
  const others = reviewers.rows.length - counting(reviewers).length
  return `Reviewed by ${groupName(reviewers)}${others > 0 ? ` · ${others} more not counted` : ''}`
}

// Whose reviews, for one reviewer and for several.
const OWNER: Record<ReviewerTier, [string, string]> = { editor: ['an editor’s', 'the editors’'], person: ['a member’s', 'the members’'], agent: ['an agent’s', 'the agents’'] }

// Opens the list: which group the reading comes from, and why that one.
export function readingFromLine(reviewers: Reviewers): string {
  const only = onlyReviewer(reviewers)
  const whose = only === NEWS_READER_ID ? 'the news reader’s' : only === EDITORS_ID ? 'the editors’' : OWNER[reviewers.from][only ? 0 : 1]
  const what = counting(reviewers).length === 1 ? `${whose} review` : `${whose} reviews, averaged`
  if (reviewers.from === 'editor') return `The reading shown comes from ${what}.`
  if (reviewers.from === 'person') return `No editor has reviewed this yet, so the reading shown comes from ${what}.`
  return `No editor or member has reviewed this yet, so the reading shown comes from ${what}.`
}

export const ORDER_NOTE = 'Editors’ reviews count first, then those of signed-in members, then those of the news reader and other agents. Within the group that counts, each reviewer counts once.'

export function notCountedLine(notCounted: NotCounted): string {
  if (notCounted.why === 'said_nothing') return 'Says the act says nothing on this question. Others in the same group gave a reading, so this review is left out of their average.'
  return `Does not count while ${notCounted.by === 'editor' ? 'editors' : 'members'} have reviewed it.`
}

// A reviewer as the list shows them. `name` is null for someone who has not chosen one; `is` is null for a reviewer with no row on file.
export function reviewerOf(row: Pick<ReviewerRow, 'review' | 'tier'>, people: ReadonlyMap<string, ReviewerPerson>): { name: string | null; is: string | null } {
  const person = people.get(row.review.reviewer_id)
  if (!person) return { name: 'Unknown reviewer', is: null }
  return { name: person.display_name, is: row.review.reviewer_id === EDITORS_ID ? 'the editors’ shared account, from before each signed in by name' : TIER_LABEL[row.tier] }
}

// Points a review made by confirming another at the review it confirmed.
export function confirmsLine(confirms: NonNullable<ReviewerRow['confirms']>, people: ReadonlyMap<string, ReviewerPerson>): string {
  if (!confirms.review) return 'Made by confirming a review that has since been removed.'
  const person = people.get(confirms.review.reviewer_id)
  if (!person) return 'Made by confirming the review of an unknown reviewer.'
  if (!person.display_name) return 'Made by confirming the review of someone with no name yet.'
  return `Made by confirming ${person.display_name}’s review.`
}
