import type { Act, Decider, Office, OfficeHolder, Position, Proposal, ProposalItem, Question, QuestionDecider, QuestionRelation, Reading, Report, Role, Seat, SetPosition, Source } from '../../shared/schema.ts'
import { pairId } from '../../shared/schema.ts'
import { buildTracker, type TrackerData } from './build-tracker.ts'

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
export const reading = (actId: string, questionId: string, position: Reading['position'], via: string | null = null, weight: Reading['weight'] = 'clear'): Reading => ({ id: `${actId}@${questionId}`, act_id: actId, question_id: questionId, position, weight, via_question_id: via, created_at: '2026-01-01T00:00:00.000Z' })
export const proposal = (id: string, sourceId: string, over: Partial<Proposal> = {}): Proposal => ({ id, source_id: sourceId, origin: 'reader', submitted_by: null, status: 'pending', unread: null, created_at: '2026-01-01T00:00:00.000Z', reviewed_at: null, ...over })
export const item = (id: string, proposalId: string, deciderId: string, questionId: string, over: Partial<ProposalItem> = {}): ProposalItem => ({
  id,
  proposal_id: proposalId,
  sort: 0,
  decider_id: deciderId,
  question_id: questionId,
  act_id: `act-of-${id}`,
  kind: 'says',
  occurred_on: null,
  quote: `words of ${id}`,
  passage: null,
  reading: null,
  weight: null,
  status: 'pending',
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
  readings: [],
  ...over,
})

export const TODAY = '2026-11-17'
export const track = (over: Partial<TrackerData>, asOf = TODAY) => buildTracker(data(over), asOf)
