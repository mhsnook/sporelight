import type { Act, ActKind, Direction, Position, ProposalContext, ProposalItem, PublishedOnFrom, Question, Source, Weight } from '../../shared/schema.ts'
import { cameInOf, type Claim } from './claims.ts'
import type { Listing, RelatedQuestion, Tracker } from './build-tracker.ts'
import type { Standing } from './position.ts'
import type { EntryVerdict, PositionDecision, Verdict } from './review-plan.ts'

// One act by one person as the review form holds it while an editor works.
// Nothing here is written anywhere until the card is published.
export type EntryDraft = {
  key: string
  // null on an entry the editor added, until they choose who it is about.
  decider_id: string | null
  // `newActId`, or another act on file chosen as the one this entry reports.
  act_id: string
  // The act the entry reports unless another is chosen: the act that came in
  // with the proposal, or for a lead or an added entry, the id a new act takes.
  newActId: string
  // The proposal's rows for this act. Empty on an entry the editor added.
  items: ProposalItem[]
  // The question the entry is read on first. Readings on others are in `related`.
  question_id: string
  kind: ActKind
  // Empty until a date is known.
  occurred_on: string
  quote: string
  passage: string | null
  // The passage the entry came with and the paragraphs either side of it, in
  // the article's order, when the article was read. Only editors are sent it.
  wider: string[] | null
  reading: Direction | null
  // The act says nothing on the entry's own question, only on the related ones it is read on.
  mainSkipped: boolean
  weight: Weight | null
  // Readings on other questions, by question id. null is "none".
  related: Record<string, Direction | null>
  dismissed: boolean
  note: string
  // Whose answers an added entry started from.
  copiedFrom: string | null
  // "Set our position", asked for on a routine entry.
  setPosition: { position: Position; reason: string } | null
  // What to do about a position editors set, when this entry sits across from it.
  decision: { action: PositionDecision['action']; position: Position | null; reason: string }
}

const newDecision = (): EntryDraft['decision'] => ({ action: 'keep', position: null, reason: '' })

// The proposal's claims as entries: claims about one act are one entry, read
// on the first claim's question and on the others' beside it. A lead is an
// entry of its own, with no words: the editor types them.
export function draftEntries(claims: Claim[], contexts: ProposalContext[] = []): EntryDraft[] {
  const drafts: EntryDraft[] = []
  const contextOf = new Map(contexts.map((c) => [c.proposal_item_id, c]))
  // A claim that was turned down goes after the others, so an act is read first on a question it was published on.
  for (const claim of [...claims].sort((a, b) => Number(a.verdict === 'turned_down') - Number(b.verdict === 'turned_down') || a.item.sort - b.item.sort)) {
    const { item } = claim
    const actId = item.act_id ?? item.id
    const key = `${item.decider_id} ${actId}`
    const turnedDown = claim.verdict === 'turned_down'
    const entry = drafts.find((d) => d.key === key)
    if (entry) {
      entry.items.push(item)
      if (!turnedDown) entry.related[item.question_id] = claim.reading
      entry.dismissed &&= turnedDown
      continue
    }
    drafts.push({
      key,
      decider_id: item.decider_id,
      act_id: actId,
      newActId: actId,
      items: [item],
      question_id: item.question_id,
      kind: claim.kind,
      occurred_on: claim.occurred_on ?? '',
      quote: claim.quote,
      passage: claim.passage,
      wider: wider(claim.passage, contextOf.get(item.id)),
      reading: claim.reading,
      mainSkipped: false,
      weight: claim.weight,
      related: {},
      dismissed: turnedDown,
      note: '',
      copiedFrom: null,
      setPosition: null,
      decision: newDecision(),
    })
  }
  const firstSort = (d: EntryDraft) => Math.min(...d.items.map((i) => i.sort))
  return drafts.sort((a, b) => firstSort(a) - firstSort(b))
}

const wider = (passage: string | null, context: ProposalContext | undefined) =>
  context && passage !== null ? [...context.before.split('\n'), passage, ...context.after.split('\n')].filter((p) => p.trim()) : null

// "Add another person" starts from the first entry's answers and its passage,
// with no words marked.
export function addedEntry(first: EntryDraft, copiedFrom: string | null, newId: () => string = () => crypto.randomUUID()): EntryDraft {
  const actId = newId()
  return {
    ...first,
    key: newId(),
    decider_id: null,
    act_id: actId,
    newActId: actId,
    items: [],
    quote: '',
    mainSkipped: false,
    related: { ...first.related },
    dismissed: false,
    note: '',
    copiedFrom,
    setPosition: null,
    decision: newDecision(),
  }
}

// The entry as a report of an act already on file, which keeps its own kind
// and date, or of a new act when `act` is null.
export const reportingAct = (entry: EntryDraft, act: Act | null): EntryDraft =>
  act ? { ...entry, act_id: act.id, kind: act.kind, occurred_on: act.occurred_on ?? '' } : { ...entry, act_id: entry.newActId }

// An entry for someone the source only describes: what it says of them, to be
// counted as presumed, with no answer filled in.
export function presumedEntry(first: EntryDraft, deciderId: string, words: string, newId: () => string = () => crypto.randomUUID()): EntryDraft {
  return { ...addedEntry(first, null, newId), decider_id: deciderId, kind: 'says', quote: words, passage: null, wider: null, reading: null, weight: 'presumed', related: {} }
}

// A concrete reading is a commitment or a use of office, so words become an act.
export const withWeight = (entry: EntryDraft, weight: Weight): EntryDraft => ({ ...entry, weight, kind: weight === 'concrete' && entry.kind === 'says' ? 'does' : entry.kind })

// What still stands between an entry and publishing it, or null.
export function missingFrom(entry: EntryDraft): string | null {
  if (!entry.decider_id) return 'the person'
  if (!entry.quote.trim()) return 'the words'
  const isRead = entry.mainSkipped ? Object.values(entry.related).some((r) => r !== null) : entry.reading !== null
  if (!isRead || !entry.weight) return 'both answers'
  return null
}

// The act an entry reports: the one on file, or the one publishing it would make.
const actOf = (tracker: Pick<Tracker, 'actById'>, entry: EntryDraft): Act =>
  tracker.actById.get(entry.act_id) ?? { id: entry.act_id, decider_id: entry.decider_id ?? '', kind: entry.kind, occurred_on: entry.occurred_on || null, body: entry.quote, primary_source_id: null, withdrawn_on: null, created_at: '' }

export type Outlook = {
  // Where the person is listed today, and where publishing the entry would leave them.
  now: Listing
  then: Listing | null
  // The position editors set, when the entry's reading sits across from it.
  across: Listing['set']
}

// Where publishing this entry's reading on a question would leave the person.
// `then` is null until both answers are in.
export function outlook(tracker: Pick<Tracker, 'actById' | 'listingFor' | 'entryOf' | 'acrossFor'>, entry: EntryDraft, question: Question, given: Direction | null): Outlook {
  const reading = entry.mainSkipped && question.id === entry.question_id ? null : given
  const deciderId = entry.decider_id ?? ''
  // Where they stand without the act that came in, which is what is being reviewed.
  const cameIn = cameInOf(entry.items)
  const without = cameIn ? [cameIn] : []
  const now = tracker.listingFor(question, deciderId, [], without)
  if (!reading || !entry.weight || !entry.decider_id) return { now, then: null, across: undefined }
  const read = { id: '', act_id: entry.act_id, question_id: question.id, position: reading, weight: entry.weight, via_question_id: null }
  const then = tracker.listingFor(question, deciderId, [tracker.entryOf(actOf(tracker, entry), read)], without)
  return { now, then, across: tracker.acrossFor(question, deciderId, reading) }
}

export type RelatedChoice = RelatedQuestion | { question: Question; kind: 'main_question' | 'measure' | 'ask' }

// The other questions an entry may be read on: the rest of its question's
// family that is put to this person, then the questions linked to it.
export function relatedChoices(tracker: Pick<Tracker, 'questionById' | 'rootOf' | 'roleIn' | 'seatById' | 'measuresOf' | 'asksFor' | 'relatedTo' | 'isOpen' | 'appliesTo'>, entry: EntryDraft): RelatedChoice[] {
  const question = tracker.questionById.get(entry.question_id)
  if (!question || !entry.decider_id) return []
  const deciderId = entry.decider_id
  const root = tracker.rootOf(question)
  const role = tracker.roleIn(root, deciderId)
  const chamber = role && tracker.seatById.get(role.seat_id)?.chamber
  const family: RelatedChoice[] = [
    ...(root.id === question.id ? [] : [{ question: root, kind: 'main_question' as const }]),
    ...(tracker.measuresOf.get(root.id) ?? []).filter((m) => !m.chamber || m.chamber === chamber).map((m) => ({ question: m, kind: 'measure' as const })),
    ...tracker.asksFor(root, deciderId).map((k) => ({ question: k.ask, kind: 'ask' as const })),
  ]
  const linked = [...tracker.relatedTo(root), ...(root.id === question.id ? [] : tracker.relatedTo(question))]
  const seen = new Set([question.id])
  return [...family, ...linked].filter((c) => {
    if (seen.has(c.question.id) || !tracker.isOpen(c.question) || !tracker.appliesTo(c.question, deciderId)) return false
    seen.add(c.question.id)
    return true
  })
}

// The editor's decisions as the plan takes them. `decide` gives the decision
// on a position editors set, for an entry that sits across from one. Throws if
// an entry that is not dismissed is missing something.
export function verdictOf(drafts: EntryDraft[], reviewNote: string, decide: (entry: EntryDraft) => PositionDecision | null = () => null, dismissAll = false): Verdict {
  const entries: EntryVerdict[] = []
  for (const d of drafts) {
    const note = d.note.trim() || null
    if (dismissAll || d.dismissed) {
      if (d.items.length) entries.push({ decider_id: d.decider_id ?? d.items[0].decider_id, items: d.items, note, publish: false })
      continue
    }
    const missing = missingFrom(d)
    if (missing) throw new Error(`An entry still needs ${missing}.`)
    const itemOn = (questionId: string) => d.items.find((i) => i.question_id === questionId) ?? null
    const decision: PositionDecision | null =
      decide(d) ?? (d.setPosition ? { question_id: d.question_id, action: 'set', position: d.setPosition.position, reason: d.setPosition.reason.trim() } : null)
    if (decision?.action === 'set' && !decision.reason) throw new Error('A position set by hand needs its reason, which is shown on the page.')
    entries.push({
      decider_id: d.decider_id!,
      items: d.items,
      note,
      publish: true,
      act_id: d.act_id,
      kind: d.kind,
      occurred_on: d.occurred_on,
      quote: d.quote.trim(),
      passage: d.passage,
      weight: d.weight!,
      readings: [
        ...(d.mainSkipped ? [] : [{ question_id: d.question_id, reading: d.reading!, item: itemOn(d.question_id) }]),
        ...Object.entries(d.related).flatMap(([question_id, reading]) => (reading ? [{ question_id, reading, item: itemOn(question_id) }] : [])),
      ],
      decision,
    })
  }
  return { review_note: reviewNote.trim() || null, entries }
}

// The position a new one starts from: what the entry itself shows.
const newPosition = (entry: EntryDraft): Position => entry.decision.position ?? entry.reading ?? 'mixed'

// Where each answer to "what should the page show" leaves the person.
export const decisionStandings = (entry: EntryDraft, view: Outlook): Record<PositionDecision['action'], Standing> => ({
  keep: view.across?.position ?? 'unknown',
  lift: view.then?.calculated ?? 'unknown',
  set: newPosition(entry),
})

// Whether anything a waiting proposal claims sits across from a position editors set, as its card would find.
export const proposalIsAcross = (tracker: Pick<Tracker, 'questionById' | 'acrossFor'>, claims: Claim[]) =>
  draftEntries(claims).some((d) => {
    const question = tracker.questionById.get(d.question_id)
    return !d.dismissed && question !== undefined && d.reading !== null && d.decider_id !== null && tracker.acrossFor(question, d.decider_id, d.reading) !== undefined
  })

// The decision on a position editors set, for an entry that sits across from it.
export function decisionOf(entry: EntryDraft): PositionDecision {
  const text = entry.decision.reason.trim()
  if (entry.decision.action === 'set') return { question_id: entry.question_id, action: 'set', position: newPosition(entry), reason: text }
  if (entry.decision.action === 'lift') return { question_id: entry.question_id, action: 'lift', note: text || null }
  return { question_id: entry.question_id, action: 'keep', reason: text || null }
}

// A date to offer for an act that came with none: the source's own, when it is
// known. It is only ever offered, never filled in. The day the proposal was put
// forward is not offered: an old article can be found years after the act.
export const dateOffer = (source: Pick<Source, 'published_on' | 'published_on_from'>): { date: string; from: PublishedOnFrom } | null =>
  source.published_on && source.published_on_from ? { date: source.published_on, from: source.published_on_from } : null
