import {
  carriesUp,
  pairId,
  type Act,
  type ActKind,
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
  type Reading,
  type Report,
  type SetPosition,
  type Source,
  type Weight,
} from '../../shared/schema.ts'

type Rows = {
  questions: Question
  question_bodies: QuestionBody
  question_deciders: QuestionDecider
  question_offices: QuestionOffice
  question_relations: QuestionRelation
  sources: Source
  acts: Act
  reports: Report
  readings: Reading
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
  readings: Reading[]
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
}

// The store sends a transaction as one batch per table, in the order each table
// first appears, and every batch may only point at rows an earlier one wrote.
// Plans list their writes in an order that respects that.
const APPROVAL_ORDER: (keyof Rows)[] = ['sources', 'acts', 'reports', 'readings', 'set_positions', 'proposal_items', 'proposal_notes', 'proposals']

// Everything publishing one reviewed proposal changes, as a list of writes for
// a single transaction. Every row it writes is stamped with the same `now`:
// the feed groups reports of one source with one timestamp into one story.
// Each published entry writes its act (unless it is on file), a report of it
// in the proposal's source, and a reading on each question it is read on.
// Dismissed entries only change the status of their items.
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
  const actIds = new Set(published.acts.map((a) => a.id))
  const reported = new Set(published.reports.map((r) => `${r.source_id} ${r.act_id}`))
  const readingByPair = new Map(published.readings.map((r) => [`${r.act_id} ${r.question_id}`, r]))
  const newReadings = new Map<string, Reading>()
  const setPositionIds = new Set(published.setPositions.map((s) => s.id))
  let nextSort = Math.max(-1, ...verdict.entries.flatMap((e) => e.items.map((i) => i.sort))) + 1

  const read = (actId: string, questionId: string, position: Direction, weight: Weight, via: string | null) => {
    const key = `${actId} ${questionId}`
    const mine = newReadings.get(key)
    const existing = mine ?? readingByPair.get(key)
    if (!existing) {
      const row: Reading = { id: newId(), act_id: actId, question_id: questionId, position, weight, via_question_id: via, created_at: now }
      newReadings.set(key, row)
      writes.push({ on: 'readings', type: 'insert', row })
    } else if (via) {
      // A reading implied by a sub-question never replaces one already there.
    } else if (mine) {
      Object.assign(mine, { position, weight, via_question_id: null })
    } else if (existing.position !== position || existing.weight !== weight || existing.via_question_id) {
      // Read directly, it stops being a reading the sub-question implied.
      writes.push({ on: 'readings', type: 'update', id: existing.id, changes: { position, weight, via_question_id: null } })
    }
  }

  const note = (body: string, itemId: string | null) =>
    writes.push({ on: 'proposal_notes', type: 'insert', row: { id: newId(), proposal_id: proposal.id, proposal_item_id: itemId, kind: 'review', body, created_at: now } })

  for (const entry of verdict.entries) {
    if (!entry.publish) {
      for (const item of entry.items) writes.push({ on: 'proposal_items', type: 'update', id: item.id, changes: { status: 'rejected' } })
      if (entry.note && entry.items[0]) note(entry.note, entry.items[0].id)
      continue
    }
    if (entry.readings.length === 0) throw new Error('An entry needs a reading on at least one question to be published.')

    const isNewAct = !actIds.has(entry.act_id)
    if (isNewAct) {
      actIds.add(entry.act_id)
      writes.push({
        on: 'acts',
        type: 'insert',
        row: { id: entry.act_id, decider_id: entry.decider_id, kind: entry.kind, occurred_on: entry.occurred_on, body: entry.quote, primary_source_id: null, withdrawn_on: null, created_at: now },
      })
    }
    if (!reported.has(`${source.id} ${entry.act_id}`)) {
      reported.add(`${source.id} ${entry.act_id}`)
      // For an act already on file the entry's words are this source's wording of it.
      writes.push({
        on: 'reports',
        type: 'insert',
        row: { id: newId(), source_id: source.id, act_id: entry.act_id, excerpt: isNewAct ? null : entry.quote, passage: entry.passage, created_at: now },
      })
    }

    const facts = { act_id: entry.act_id, kind: entry.kind, occurred_on: entry.occurred_on, quote: entry.quote, passage: entry.passage, weight: entry.weight }
    const kept = new Set<string>()
    let firstItemId: string | null = null
    for (const r of entry.readings) {
      const question = questionById.get(r.question_id)
      if (!question) throw new Error(`Unknown question ${r.question_id}`)
      read(entry.act_id, question.id, r.reading, entry.weight, null)
      // Doing the thing a sub-question asks about says something on its parent
      // too, if the sub-question says what. A passing or presumed reading is too loose
      // to carry upward.
      if (question.implies_on_parent && question.parent_id && r.reading === 'support' && carriesUp(entry.weight)) {
        read(entry.act_id, question.parent_id, question.implies_on_parent, entry.weight, question.id)
      }
      if (r.item) {
        kept.add(r.item.id)
        firstItemId ??= r.item.id
        writes.push({ on: 'proposal_items', type: 'update', id: r.item.id, changes: { ...facts, status: 'accepted', question_id: r.question_id, reading: r.reading } })
      } else {
        const id = newId()
        firstItemId ??= id
        writes.push({
          on: 'proposal_items',
          type: 'insert',
          row: { ...facts, id, proposal_id: proposal.id, sort: nextSort++, decider_id: entry.decider_id, question_id: r.question_id, reading: r.reading, status: 'accepted' },
        })
      }
    }
    // A reading the editor took off the act.
    for (const item of entry.items) if (!kept.has(item.id)) writes.push({ on: 'proposal_items', type: 'update', id: item.id, changes: { status: 'rejected' } })
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

  if (verdict.review_note) note(verdict.review_note, null)
  writes.push({ on: 'proposals', type: 'update', id: proposal.id, changes: { status: 'reviewed', reviewed_at: now } })

  return writes.sort((a, b) => APPROVAL_ORDER.indexOf(a.on) - APPROVAL_ORDER.indexOf(b.on))
}

// Folds one act into another when both turn out to be the same real-world
// thing. Reports and readings move to the survivor; where the survivor already
// has a report from that source or a reading on that question, its own stands
// and the duplicate is deleted. The dropped act goes last, once nothing points
// at it.
export function planMerge(published: Pick<Published, 'acts' | 'reports' | 'readings'> & { proposalItems: ProposalItem[] }, keepId: string, dropId: string): Write[] {
  const keep = published.acts.find((a) => a.id === keepId)
  const drop = published.acts.find((a) => a.id === dropId)
  if (!keep || !drop) throw new Error('Both acts have to be on file.')
  if (keep.id === drop.id) throw new Error('An act cannot be merged into itself.')
  if (keep.decider_id !== drop.decider_id) throw new Error('Acts by different people cannot be the same act.')

  const writes: Write[] = []
  const keptReports = new Map(published.reports.filter((r) => r.act_id === keepId).map((r) => [r.source_id, r]))
  for (const report of published.reports.filter((r) => r.act_id === dropId)) {
    const kept = keptReports.get(report.source_id)
    if (!kept) {
      // Keeps the words this source printed, which may not be the survivor's.
      const excerpt = report.excerpt ?? (drop.body !== keep.body ? drop.body : null)
      writes.push({ on: 'reports', type: 'update', id: report.id, changes: excerpt === report.excerpt ? { act_id: keepId } : { act_id: keepId, excerpt } })
      continue
    }
    writes.push({ on: 'reports', type: 'delete', id: report.id })
    if (!kept.excerpt && report.excerpt) writes.push({ on: 'reports', type: 'update', id: kept.id, changes: { excerpt: report.excerpt } })
  }

  const keptQuestions = new Set(published.readings.filter((r) => r.act_id === keepId).map((r) => r.question_id))
  for (const reading of published.readings.filter((r) => r.act_id === dropId)) {
    writes.push(keptQuestions.has(reading.question_id) ? { on: 'readings', type: 'delete', id: reading.id } : { on: 'readings', type: 'update', id: reading.id, changes: { act_id: keepId } })
  }

  for (const item of published.proposalItems.filter((i) => i.act_id === dropId)) {
    writes.push({ on: 'proposal_items', type: 'update', id: item.id, changes: { act_id: keepId } })
  }

  if (!keep.primary_source_id && drop.primary_source_id) writes.push({ on: 'acts', type: 'update', id: keepId, changes: { primary_source_id: drop.primary_source_id } })
  writes.push({ on: 'acts', type: 'delete', id: dropId })
  return writes
}
