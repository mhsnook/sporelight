import {
  EARLIEST_PUBLISHED,
  EDITORS_ID,
  isPublishDay,
  pairId,
  type Act,
  type ActKind,
  type Decider,
  type Direction,
  type Position,
  type Proposal,
  type ProposalItem,
  type ProposalNote,
  type Question,
  type QuestionBody,
  type QuestionDecider,
  type QuestionOffice,
  type QuestionRelation,
  type Report,
  type Review,
  type Role,
  type SameAct,
  type SetPosition,
  type Source,
  type Weight,
} from '../../shared/schema.ts'
import { indexBy } from './build-tracker.ts'
import { cameInOf } from './claims.ts'

type Rows = {
  deciders: Decider
  roles: Role
  questions: Question
  question_bodies: QuestionBody
  question_deciders: QuestionDecider
  question_offices: QuestionOffice
  question_relations: QuestionRelation
  sources: Source
  acts: Act
  reports: Report
  reviews: Review
  same_acts: SameAct
  set_positions: SetPosition
  proposals: Proposal
  proposal_items: ProposalItem
  proposal_notes: ProposalNote
}

export type Write = {
  [K in keyof Rows]:
    | { on: K; type: 'insert'; row: Rows[K] }
    | { on: K; type: 'update'; id: string; changes: Partial<Rows[K]> }
    | { on: K; type: 'delete'; id: string }
}[keyof Rows]

// The rows a plan reads to decide between inserting and updating.
export type Published = {
  questions: Question[]
  acts: Act[]
  reports: Report[]
  reviews: Review[]
  sameActs: SameAct[]
  setPositions: SetPosition[]
}

// What an editor decided about the position set by hand for one person on one
// question, alongside publishing an act. `keep` may reword the reason. A note
// on lifting is for editors only.
export type PositionDecision =
  | { question_id: string; action: 'set'; position: Position; reason: string }
  | { question_id: string; action: 'keep'; reason: string | null }
  | { question_id: string; action: 'lift'; note: string | null }

// One act by one person as the editor left it: published with a reading on
// each question listed, or dismissed. `items` are the proposal's rows for the
// act. A reading with no item was added in the review form, as is a whole
// entry with none.
export type EntryVerdict = { decider_id: string; items: ProposalItem[]; note: string | null } & (
  | { publish: false }
  | {
      publish: true
      // An act on file, or the id the new act takes.
      act_id: string
      kind: ActKind
      occurred_on: string
      quote: string
      passage: string | null
      weight: Weight
      readings: { question_id: string; reading: Direction; item: ProposalItem | null }[]
      decision: PositionDecision | null
    }
)

export type Verdict = {
  review_note: string | null
  entries: EntryVerdict[]
  // The source's publish date as the editor set it on the card. Left out when
  // they did not touch it; null when they said it is not known.
  published_on?: string | null
}

// The store sends a transaction as one batch per table, in the order each table
// first appears, and every batch may only point at rows an earlier one wrote.
// Plans list their writes in an order that respects that.
const APPROVAL_ORDER: (keyof Rows)[] = ['sources', 'acts', 'same_acts', 'reports', 'reviews', 'set_positions', 'proposal_items', 'proposal_notes', 'proposals']

// Everything publishing one reviewed proposal changes, as a list of writes for
// a single transaction. What the proposal put forward is already on file: an
// act, its report in the source and the sender's review. Publishing is the
// editors' review of each act on each question it is read on, with any
// correction to the act's facts or its passage. A question the editor took
// off an act, and every question of a dismissed entry, gets the editors'
// review that the act says nothing there. An entry the editor says is an act
// already on the record marks the act that came in as the same as that one.
// A lead, or an entry the editor added, writes its act and report here.
export function planReview(
  published: Published,
  proposal: Proposal,
  source: Source,
  verdict: Verdict,
  now: string,
  newId: () => string = () => crypto.randomUUID(),
): Write[] {
  const writes: Write[] = []
  const questionById = new Map(published.questions.map((q) => [q.id, q]))
  const actById = indexBy(published.acts, (a) => a.id)
  const reportIn = indexBy(published.reports, (r) => `${r.source_id} ${r.act_id}`)
  const editorsReview = new Map(published.reviews.filter((r) => r.reviewer_id === EDITORS_ID).map((r) => [`${r.act_id} ${r.question_id}`, r]))
  const setPositionIds = new Set(published.setPositions.map((s) => s.id))
  const markedAs = new Map(published.sameActs.map((s) => [s.act_id, s.same_as_id]))
  let nextSort = Math.max(-1, ...verdict.entries.flatMap((e) => e.items.map((i) => i.sort))) + 1

  const review = (actId: string, questionId: string, position: Direction | null, weight: Weight | null) => {
    const key = `${actId} ${questionId}`
    const existing = editorsReview.get(key)
    if (existing && existing.position === position && existing.weight === weight) return
    const row: Review = existing ? { ...existing, position, weight, updated_at: now } : { id: newId(), reviewer_id: EDITORS_ID, act_id: actId, question_id: questionId, position, weight, based_on: null, created_at: now, updated_at: now }
    editorsReview.set(key, row)
    writes.push(existing ? { on: 'reviews', type: 'update', id: row.id, changes: { position, weight, updated_at: now } } : { on: 'reviews', type: 'insert', row })
  }
  const saysNothing = (items: ProposalItem[]) => {
    for (const item of items) if (item.act_id) review(item.act_id, item.question_id, null, null)
  }

  const note = (body: string, itemId: string | null) =>
    writes.push({ on: 'proposal_notes', type: 'insert', row: { id: newId(), proposal_id: proposal.id, proposal_item_id: itemId, kind: 'review', body, created_at: now } })

  for (const entry of verdict.entries) {
    if (!entry.publish) {
      saysNothing(entry.items)
      if (entry.note && entry.items[0]) note(entry.note, entry.items[0].id)
      continue
    }
    if (entry.readings.length === 0) throw new Error('An entry needs a reading on at least one question to be published.')

    const cameIn = cameInOf(entry.items)
    const onFile = actById.get(entry.act_id)
    if (cameIn && cameIn !== entry.act_id) {
      // The editor found the act that came in to be one already on the record.
      if (!onFile) throw new Error('The act chosen as the same one is not on file.')
      // It may have been marked already, from the person's page, while the card waited.
      const marked = markedAs.get(cameIn)
      if (marked === undefined) writes.push({ on: 'same_acts', type: 'insert', row: { act_id: cameIn, same_as_id: entry.act_id, marked_by: EDITORS_ID, marked_at: now } })
      else if (marked !== entry.act_id) writes.push({ on: 'same_acts', type: 'update', id: cameIn, changes: { same_as_id: entry.act_id, marked_by: EDITORS_ID, marked_at: now } })
    } else if (onFile && cameIn) {
      const facts = { kind: entry.kind, occurred_on: entry.occurred_on || null, body: entry.quote }
      if (onFile.kind !== facts.kind || onFile.occurred_on !== facts.occurred_on || onFile.body !== facts.body) writes.push({ on: 'acts', type: 'update', id: onFile.id, changes: facts })
      const report = reportIn.get(`${source.id} ${onFile.id}`)
      if (report && report.passage !== entry.passage) writes.push({ on: 'reports', type: 'update', id: report.id, changes: { passage: entry.passage } })
    } else if (!onFile) {
      writes.push({
        on: 'acts',
        type: 'insert',
        row: { id: entry.act_id, decider_id: entry.decider_id, kind: entry.kind, occurred_on: entry.occurred_on || null, body: entry.quote, primary_source_id: null, withdrawn_on: null, created_at: now },
      })
    }
    if (!cameIn && !reportIn.has(`${source.id} ${entry.act_id}`)) {
      const row: Report = { id: newId(), source_id: source.id, act_id: entry.act_id, excerpt: onFile ? entry.quote : null, passage: entry.passage, created_at: now }
      reportIn.set(`${source.id} ${entry.act_id}`, row)
      // For an act already on file the entry's words are this source's wording of it.
      writes.push({ on: 'reports', type: 'insert', row })
    }

    const readOn = new Set<string>()
    let firstItemId: string | null = null
    for (const r of entry.readings) {
      const question = questionById.get(r.question_id)
      if (!question) throw new Error(`Unknown question ${r.question_id}`)
      readOn.add(question.id)
      review(entry.act_id, question.id, r.reading, entry.weight)
      if (r.item) {
        firstItemId ??= r.item.id
        if (r.item.act_id === null) writes.push({ on: 'proposal_items', type: 'update', id: r.item.id, changes: { act_id: entry.act_id, excerpt: null } })
      } else {
        const id = newId()
        firstItemId ??= id
        writes.push({ on: 'proposal_items', type: 'insert', row: { id, proposal_id: proposal.id, sort: nextSort++, decider_id: entry.decider_id, question_id: question.id, act_id: entry.act_id, excerpt: null } })
      }
    }
    // A question the editor took off the act.
    saysNothing(entry.items.filter((i) => !readOn.has(i.question_id)))
    if (entry.note) note(entry.note, firstItemId)

    const decision = entry.decision
    if (decision) {
      const id = pairId(decision.question_id, entry.decider_id)
      const isSet = setPositionIds.has(id)
      if (decision.action === 'set') {
        const row: SetPosition = { id, question_id: decision.question_id, decider_id: entry.decider_id, position: decision.position, reason: decision.reason, set_at: now }
        writes.push(isSet ? { on: 'set_positions', type: 'update', id, changes: { position: row.position, reason: row.reason, set_at: now } } : { on: 'set_positions', type: 'insert', row })
        setPositionIds.add(id)
      } else if (decision.action === 'keep') {
        if (isSet && decision.reason) writes.push({ on: 'set_positions', type: 'update', id, changes: { reason: decision.reason } })
      } else if (isSet) {
        writes.push({ on: 'set_positions', type: 'delete', id })
        setPositionIds.delete(id)
        note(`Lifted the position set by editors.${decision.note ? ` ${decision.note}` : ''}`, firstItemId)
      }
    }
  }

  if (verdict.published_on && !isPublishDay(verdict.published_on, now.slice(0, 10))) {
    throw new Error(`The publish date has to be a day from ${EARLIEST_PUBLISHED} to today.`)
  }
  if (verdict.published_on !== undefined && (verdict.published_on !== source.published_on || source.published_on_from !== 'editor')) {
    writes.push({ on: 'sources', type: 'update', id: source.id, changes: { published_on: verdict.published_on, published_on_from: 'editor' } })
  }
  if (verdict.review_note) note(verdict.review_note, null)
  writes.push({ on: 'proposals', type: 'update', id: proposal.id, changes: { status: 'reviewed', reviewed_at: now } })

  return writes.sort((a, b) => APPROVAL_ORDER.indexOf(a.on) - APPROVAL_ORDER.indexOf(b.on))
}
