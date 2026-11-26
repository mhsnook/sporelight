import type { Act, Decider, Office, OfficeHolder, Position, Proposal, ProposalItem, Question, QuestionDecider, QuestionRelation, Report, Review, Role, Seat, SetPosition, Source } from '../../shared/schema.ts'
import { EDITORS_ID, NEWS_READER_ID, pairId } from '../../shared/schema.ts'
import { buildTracker, type TrackerData } from './build-tracker.ts'
import { claimOf, type Claim } from './claims.ts'

// Row builders for tests: each takes the fields a test cares about and fills in the rest.

export const question = (id: string, over: Partial<Question> = {}): Question => ({
  id,
  slug: id,
  body_id: 'body',
  parent_id: null,
  kind: 'position',
  title: `${id}?`,
  short_title: id,
  description: null,
  reference_url: null,
  chamber: null,
  is_hot: false,
  sort: 0,
  threshold: null,
  act_label: null,
  status: 'open',
  closed_on: null,
  closed_note: null,
  archived_at: null,
  decides_on: null,
  implies_on_parent: null,
  ...over,
})

export const decider = (id: string): Decider => ({ id, slug: id, name: id, sort_name: id, external_id: null, url: null })
export const seat = (id: string, over: Partial<Seat> = {}): Seat => ({ id, body_id: 'body', chamber: null, region: null, label: id, is_voting: true, next_election_on: null, ...over })
export const role = (seatId: string, deciderId: string, over: Partial<Role> = {}): Role => ({ id: `${seatId}:${deciderId}`, seat_id: seatId, decider_id: deciderId, contest: null, affiliation: null, starts_on: null, ends_on: null, certainty: 'certain', ...over })
export const office = (id: string, over: Partial<Office> = {}): Office => ({ id, body_id: 'body', chamber: null, label: id, sort: 0, ...over })
export const holder = (officeId: string, deciderId: string, starts_on: string | null = null, ends_on: string | null = null, certainty: OfficeHolder['certainty'] = 'certain'): OfficeHolder => ({
  id: `${officeId}:${deciderId}`,
  office_id: officeId,
  decider_id: deciderId,
  starts_on,
  ends_on,
  source_id: null,
  certainty,
})
export const link = (questionId: string, deciderId: string, role_label: string | null = null): QuestionDecider => ({ id: `${questionId}:${deciderId}`, question_id: questionId, decider_id: deciderId, role_label })
export const setPosition = (questionId: string, deciderId: string, position: Position, reason = 'Set in a test.'): SetPosition => ({ id: pairId(questionId, deciderId), question_id: questionId, decider_id: deciderId, position, reason, set_at: '2026-01-01T00:00:00.000Z' })
export const relation = (questionId: string, relatedId: string, kind: QuestionRelation['kind'] = 'smaller_step', sort = 0): QuestionRelation => ({ id: `${questionId}>${relatedId}`, question_id: questionId, related_id: relatedId, kind, sort })
export const source = (id: string, over: Partial<Source> = {}): Source => ({ id, url: `https://example.com/${id}`, title: id, publisher: null, published_on: null, published_on_from: null, kind: null, archive_url: null, stored_copy: null, created_at: '2026-01-01T00:00:00.000Z', ...over })
export const act = (id: string, deciderId: string, over: Partial<Act> = {}): Act => ({ id, decider_id: deciderId, kind: 'says', occurred_on: '2026-01-01', body: id, primary_source_id: null, withdrawn_on: null, created_at: '2026-01-01T00:00:00.000Z', ...over })
export const report = (sourceId: string, actId: string, over: Partial<Report> = {}): Report => ({ id: `${sourceId}>${actId}`, source_id: sourceId, act_id: actId, excerpt: null, passage: null, created_at: '2026-01-01T00:00:00.000Z', ...over })
export const review = (actId: string, questionId: string, position: Review['position'], weight: Review['weight'] = 'clear', reviewerId = EDITORS_ID): Review => ({ id: `${reviewerId}:${actId}@${questionId}`, reviewer_id: reviewerId, act_id: actId, question_id: questionId, position, weight, based_on: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' })
export const proposal = (id: string, sourceId: string, over: Partial<Proposal> = {}): Proposal => ({ id, source_id: sourceId, origin: 'reader', submitted_by: null, status: 'pending', unread: null, created_at: '2026-01-01T00:00:00.000Z', reviewed_at: null, reviewed_by: null, ...over })
export const item = (id: string, proposalId: string, deciderId: string, questionId: string, over: Partial<ProposalItem> = {}): ProposalItem => ({
  id,
  proposal_id: proposalId,
  sort: 0,
  decider_id: deciderId,
  question_id: questionId,
  act_id: `act-of-${id}`,
  excerpt: null,
  ...over,
})

export const data = (over: Partial<TrackerData>): TrackerData => ({
  bodies: [{ id: 'body', slug: 'body', name: 'Body', jurisdiction: null, description: null, is_demo: false, sort: 0, next_term_on: null, next_term_label: null }],
  deciders: [],
  seats: [],
  roles: [],
  questions: [],
  questionBodies: [],
  questionDeciders: [],
  offices: [],
  officeHolders: [],
  questionOffices: [],
  questionRelations: [],
  setPositions: [],
  sources: [],
  acts: [],
  reports: [],
  reviews: [],
  sameActs: [],
  people: [{ id: EDITORS_ID, role: 'editor', kind: 'person' }],
  ...over,
})

export const TODAY = '2026-11-17'
export const track = (over: Partial<TrackerData>, asOf = TODAY) => buildTracker(data(over), asOf)

// What one proposal item brings in, as rows on file: its act, its report in
// the proposal's source and the sender's review (when `reading` is given).
// `verdict` adds the editors' review: their reading, or saying nothing.
export type Incoming = Pick<TrackerData, 'acts' | 'reports' | 'reviews'>
type Sent = Partial<Omit<Claim, 'item'>>
export const incoming = (row: ProposalItem, from: Pick<Proposal, 'source_id' | 'submitted_by' | 'created_at'>, { kind = 'says', occurred_on = null, quote, passage = null, reading = null, weight = null, verdict = 'waiting' }: Sent = {}): Incoming => {
  if (!row.act_id) return { acts: [], reports: [], reviews: [] }
  const actId = row.act_id
  const editors = verdict === 'published' ? [review(actId, row.question_id, reading ?? 'support', weight ?? 'clear')] : verdict === 'turned_down' ? [{ ...review(actId, row.question_id, 'support'), position: null, weight: null }] : []
  return {
    acts: [act(actId, row.decider_id, { kind, occurred_on, body: quote ?? `words of ${row.id}`, created_at: from.created_at })],
    reports: [report(from.source_id, actId, { passage, created_at: from.created_at })],
    reviews: [...(reading && from.submitted_by ? [review(actId, row.question_id, reading, weight ?? 'clear', from.submitted_by)] : []), ...editors],
  }
}

// Several items' rows together. Items that share an act share its first act and report row.
export const onFile = (...brought: Incoming[]): Incoming => {
  const once = <T extends { id: string }>(rows: T[]) => rows.filter((r, i) => rows.findIndex((x) => x.id === r.id) === i)
  return { acts: once(brought.flatMap((b) => b.acts)), reports: once(brought.flatMap((b) => b.reports)), reviews: once(brought.flatMap((b) => b.reviews)) }
}

// A claim as the review form gets it, from the rows `incoming` writes for the
// fields a test cares about. A lead is an item with no act.
export const claimed = (
  id: string,
  proposalId: string,
  deciderId: string,
  questionId: string,
  { act_id, sort, excerpt, ...sent }: Partial<Pick<ProposalItem, 'act_id' | 'sort' | 'excerpt'>> & Sent = {},
): Claim => {
  const row = item(id, proposalId, deciderId, questionId, { ...(act_id !== undefined && { act_id }), ...(sort !== undefined && { sort }), ...(excerpt !== undefined && { excerpt }) })
  const from = proposal(proposalId, 'article', { submitted_by: NEWS_READER_ID, status: sent.verdict && sent.verdict !== 'waiting' ? 'reviewed' : 'pending' })
  return claimOf(track({ ...incoming(row, from, sent), people: [{ id: EDITORS_ID, role: 'editor', kind: 'person' }, { id: NEWS_READER_ID, role: 'member', kind: 'agent' }] }), from, row)
}
