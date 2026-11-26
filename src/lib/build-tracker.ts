import type { Act, Body, Decider, Office, OfficeHolder, Position, Question, QuestionBody, QuestionDecider, QuestionOffice, QuestionRelation, Person, Reading, Report, Review, Role, SameAct, Seat, SetPosition, Source } from '../../shared/schema.ts'
import { EDITORS_ID, carriesUp, inEffect, isOpenOn, pairId, stillAhead, type Certainty } from '../../shared/schema.ts'
import { calculatePosition, footingOf, isAcross, summarize, type Footing, type ReviewerTier } from '../../shared/standing.ts'
import type { Standing } from './position.ts'

export function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

export const indexBy = <T, K>(items: readonly T[], key: (item: T) => K) => new Map(items.map((i) => [key(i), i] as const))

// One act as it bears on one question: what it signals there, and every source
// that reports it.
export type RecordEntry = {
  act: Act
  reading: Reading
  // The sub-question this reading was written from, when support there counts here.
  via: Question | undefined
  reports: { report: Report; source: Source }[]
  // Why a commitment no longer holds on the day viewed, if it does not: it was
  // taken back, or the measure it was made on has closed.
  lapse: 'withdrawn' | 'closed' | null
  // The act binds them on this very question and still holds. See `Signal`.
  onRecord: boolean
}

// Where someone is listed on a question. `calculated` is what their record
// works out to; `set` is the position editors set by hand, which is shown
// instead for as long as it exists.
export type Listing = { standing: Standing; calculated: Standing; set: SetPosition | undefined }

// Another question an act on this one may also be read on.
export type RelatedQuestion = { question: Question; kind: 'smaller_step' | 'fuller_proposal' | 'related' }

export type Contender = Listing & {
  decider: Decider
  role: Role
  record: RecordEntry[]
  footing: Footing
}

export type SeatRow = {
  seat: Seat
  // Whoever certainly or likely holds the seat on the day viewed.
  incumbent: Contender | undefined
  // Others who may hold it on the day viewed: the other side of a recount, or
  // the candidates in a runoff. Never drawn as the holder.
  alternates: Contender[]
  // Those with a claim that starts after the day viewed, soonest and surest
  // first: a member-elect, the leader in a recount, someone running for it.
  upcoming: Contender[]
}

export type HeldSeat = SeatRow & { incumbent: Contender }
export const isHeld = (row: SeatRow): row is HeldSeat => row.incumbent !== undefined

// An ask and one of the people it is put to, with the title they are asked under.
export type KeyPerson = { ask: Question; key: string; roleLabel: string | null; certainty: Certainty; contender: Contender; seat: Seat }

// A stretch of time someone holds an office.
export type Tenure = { office: Office; holder: OfficeHolder }

export type TrackerData = {
  bodies: Body[]
  deciders: Decider[]
  seats: Seat[]
  roles: Role[]
  questions: Question[]
  questionBodies: QuestionBody[]
  questionDeciders: QuestionDecider[]
  offices: Office[]
  officeHolders: OfficeHolder[]
  questionOffices: QuestionOffice[]
  questionRelations: QuestionRelation[]
  setPositions: SetPosition[]
  sources: Source[]
  acts: Act[]
  reports: Report[]
  reviews: Review[]
  sameActs: SameAct[]
  people: Pick<Person, 'id' | 'kind'>[]
}

// Which tier of reviewer someone is, for the summary: the editors' identity,
// an agent, or a person. Someone not loaded yet counts as a person.
export function tierOfPeople(people: TrackerData['people']): (reviewerId: string) => ReviewerTier {
  const agents = new Set(people.filter((p) => p.kind === 'agent').map((p) => p.id))
  return (reviewerId) => (reviewerId === EDITORS_ID ? 'editor' : agents.has(reviewerId) ? 'agent' : 'person')
}

// The record as readers see it: an act an editor found to be the same as
// another is shown as that one. Its reports go there, keeping the words their
// source printed, and its reviews count there, each reviewer once. A loop of
// acts each marked as the next leaves every act as itself.
export function asShown(c: Pick<TrackerData, 'acts' | 'reports' | 'reviews' | 'sameActs'>) {
  const sameAs = new Map(c.sameActs.map((s) => [s.act_id, s.same_as_id]))
  const shownAs = (actId: string): string => {
    const seen = new Set<string>()
    let at = actId
    while (sameAs.has(at) && !seen.has(at)) {
      seen.add(at)
      at = sameAs.get(at)!
    }
    return seen.has(at) ? actId : at
  }
  const rawById = indexBy(c.acts, (a) => a.id)
  const alsoRecordedAs = groupBy(
    c.acts.filter((a) => shownAs(a.id) !== a.id),
    (a) => shownAs(a.id),
  )
  const acts = c.acts
    .filter((a) => shownAs(a.id) === a.id)
    .map((a) => (a.primary_source_id ? a : { ...a, primary_source_id: alsoRecordedAs.get(a.id)?.find((d) => d.primary_source_id)?.primary_source_id ?? null }))

  const reports = new Map<string, Report>()
  // The shown act's own report from a source comes first, so it is the one kept.
  for (const report of [...c.reports].sort((a, b) => Number(shownAs(a.act_id) !== a.act_id) - Number(shownAs(b.act_id) !== b.act_id))) {
    const actId = shownAs(report.act_id)
    const key = `${report.source_id} ${actId}`
    if (reports.has(key)) continue
    const own = rawById.get(report.act_id)
    const words = actId === report.act_id || report.excerpt !== null || own?.body === rawById.get(actId)?.body ? report.excerpt : (own?.body ?? null)
    reports.set(key, { ...report, act_id: actId, excerpt: words })
  }

  // A reviewer's review of the shown act itself stands over their review of an act shown as it; otherwise the latest stands.
  const reviews = new Map<string, Review>()
  const isOwn = new Map<string, boolean>()
  for (const review of c.reviews) {
    const actId = shownAs(review.act_id)
    const own = actId === review.act_id
    const key = `${review.reviewer_id} ${actId} ${review.question_id}`
    const kept = reviews.get(key)
    if (!kept || (own && !isOwn.get(key)) || (own === isOwn.get(key) && review.updated_at > kept.updated_at)) {
      reviews.set(key, own ? review : { ...review, act_id: actId })
      isOwn.set(key, own)
    }
  }
  return { acts, reports: [...reports.values()], reviews: [...reviews.values()], shownAs, alsoRecordedAs }
}

// What the reviews come to for each act on each question. A review of support
// on a sub-question that implies something on its parent also counts there, by
// the same reviewer, unless they reviewed the act on the parent directly; too
// loose a review does not carry upward.
export function readingsFrom(reviews: Review[], questionById: ReadonlyMap<string, Question>, tierOf: (reviewerId: string) => ReviewerTier): Reading[] {
  const readDirectly = new Set(reviews.map((r) => `${r.reviewer_id} ${r.act_id} ${r.question_id}`))
  const counted = reviews.flatMap((r) => {
    const own = { act_id: r.act_id, question_id: r.question_id, via: null as Question | null, tier: tierOf(r.reviewer_id), position: r.position, weight: r.weight }
    const q = questionById.get(r.question_id)
    const implies = q?.parent_id && q.implies_on_parent && r.position === 'support' && r.weight && carriesUp(r.weight) && !readDirectly.has(`${r.reviewer_id} ${r.act_id} ${q.parent_id}`)
    return implies ? [own, { ...own, question_id: q.parent_id!, via: q, position: q.implies_on_parent! }] : [own]
  })
  return [...groupBy(counted, (c) => `${c.act_id} ${c.question_id}`)].flatMap(([id, group]): Reading[] => {
    const summary = summarize(group)
    if (!summary) return []
    // Implied when everything the summary went by was implied; named by the first such sub-question in question order.
    const used = group.filter((c) => c.tier === summary.tier && c.position !== null)
    const via = used.every((c) => c.via) ? used.map((c) => c.via!).sort((x, y) => x.sort - y.sort || x.id.localeCompare(y.id))[0].id : null
    return [{ id, act_id: group[0].act_id, question_id: group[0].question_id, position: summary.position, weight: summary.weight, by: summary.tier, via_question_id: via }]
  })
}

// `asOf` is the day the bodies are viewed on. Seats and offices are filled by
// whoever holds them that day, so a day after a body's next term starts shows
// its incoming members and the asks put to its incoming office holders.
export function buildTracker(c: TrackerData, asOf: string) {
  const deciderById = indexBy(c.deciders, (d) => d.id)
  const deciderBySlug = indexBy(c.deciders, (d) => d.slug)
  const questionById = indexBy(c.questions, (q) => q.id)
  const questionBySlug = indexBy(c.questions, (q) => q.slug)
  const seatById = indexBy(c.seats, (s) => s.id)
  const setPositionById = indexBy(c.setPositions, (s) => s.id)
  const sourceById = indexBy(c.sources, (s) => s.id)
  const shown = asShown(c)
  // Every act on file, so a proposal or a plan can find one shown as another; a shown act as it is shown.
  const actById = indexBy([...c.acts, ...shown.acts], (a) => a.id)
  const readings = readingsFrom(shown.reviews, questionById, tierOfPeople(c.people))
  const seatsByBody = groupBy(c.seats, (s) => s.body_id)
  const SURENESS: Record<Certainty, number> = { certain: 0, likely: 1, possible: 2 }
  // Surest first, so anything that takes the first holder takes the surest.
  const rolesInEffect = c.roles.filter((r) => inEffect(r, asOf)).sort((a, b) => SURENESS[a.certainty] - SURENESS[b.certainty])
  const rolesBySeat = groupBy(rolesInEffect, (r) => r.seat_id)
  const upcomingBySeat = groupBy(
    c.roles.filter((r) => stillAhead(r, asOf)).sort((a, b) => a.starts_on!.localeCompare(b.starts_on!) || SURENESS[a.certainty] - SURENESS[b.certainty]),
    (r) => r.seat_id,
  )
  const rolesByDecider = groupBy(rolesInEffect, (r) => r.decider_id)
  const everyRoleByDecider = groupBy(c.roles, (r) => r.decider_id)
  const officeById = indexBy(c.offices, (o) => o.id)
  const tenures: Tenure[] = c.officeHolders.flatMap((holder) => {
    const office = officeById.get(holder.office_id)
    return office ? [{ office, holder }] : []
  })
  const sittingByOffice = groupBy(
    tenures.filter((t) => inEffect(t.holder, asOf)),
    (t) => t.office.id,
  )
  const officesOf = groupBy(c.questionOffices, (l) => l.question_id)
  // Newest first, and an act with no date yet after every dated one.
  const newestFirst = (a: Act, b: Act) => (b.occurred_on ?? '').localeCompare(a.occurred_on ?? '') || a.id.localeCompare(b.id)
  const actsByDecider = groupBy([...shown.acts].sort(newestFirst), (a) => a.decider_id)
  const reportsByAct = groupBy(shown.reports, (r) => r.act_id)
  const sameActsOf = groupBy(c.sameActs, (s) => s.same_as_id)
  // The rows as stored, for what a proposal put forward.
  const storedReport = new Map(c.reports.map((r) => [`${r.source_id} ${r.act_id}`, r]))
  const storedReview = new Map(c.reviews.map((r) => [`${r.reviewer_id} ${r.act_id} ${r.question_id}`, r]))
  const reportIn = (sourceId: string, actId: string) => storedReport.get(`${sourceId} ${actId}`)
  const reviewBy = (reviewerId: string, actId: string, questionId: string) => storedReview.get(`${reviewerId} ${actId} ${questionId}`)
  const namedIn = groupBy(c.questionDeciders, (l) => l.question_id)

  const bodyById = indexBy(c.bodies, (b) => b.id)
  const bodyBySlug = indexBy(c.bodies, (b) => b.slug)
  const bodiesInOrder = [...c.bodies].sort((a, b) => Number(a.is_demo) - Number(b.is_demo) || a.sort - b.sort)
  const alsoPutTo = groupBy(c.questionBodies, (l) => l.question_id)
  // Every body a question is put to, the one it is listed under first.
  const bodyIdsOf = (question: Question): string[] => [question.body_id, ...(alsoPutTo.get(question.id) ?? []).map((l) => l.body_id).filter((id) => id !== question.body_id)]
  const bodiesOf = (question: Question): Body[] => bodyIdsOf(question).flatMap((id) => bodyById.get(id) ?? [])
  const appliesIn = (question: Question, bodyId: string) => bodyIdsOf(question).includes(bodyId)
  const questionsIn = (bodyId: string): Question[] => c.questions.filter((q) => !q.parent_id && appliesIn(q, bodyId)).sort((a, b) => a.sort - b.sort)

  const isAsk = (question: Question) => namedIn.has(question.id) || officesOf.has(question.id)
  const isOpen = (question: Question) => isOpenOn(question, asOf)
  const byOpenThenSort = (a: Question, b: Question) => Number(!isOpen(a)) - Number(!isOpen(b)) || a.sort - b.sort
  const children = c.questions.filter((q) => q.parent_id)
  // Sub-questions put to the whole body or chamber, and those put to named people.
  const measuresOf = groupBy(
    children.filter((q) => !isAsk(q)).sort((a, b) => a.sort - b.sort),
    (q) => q.parent_id!,
  )
  const asksOf = groupBy(
    children.filter(isAsk).sort(byOpenThenSort),
    (q) => q.parent_id!,
  )

  // Every source that reports an act, the record of the act itself first.
  const reportsOf = (act: Act): { report: Report; source: Source }[] =>
    (reportsByAct.get(act.id) ?? [])
      .map((report) => ({ report, source: sourceById.get(report.source_id) }))
      .filter((r): r is { report: Report; source: Source } => r.source !== undefined)
      .sort((a, b) => Number(b.source.id === act.primary_source_id) - Number(a.source.id === act.primary_source_id) || a.report.created_at.localeCompare(b.report.created_at))

  // Measures and asks alike: every question directly under this one.
  const subQuestionsOf = (questionId: string): Question[] => [...(measuresOf.get(questionId) ?? []), ...(asksOf.get(questionId) ?? [])]

  // One act as it bears on one question, by the rules for what lapses and what binds.
  const entryOf = (act: Act, reading: Reading): RecordEntry => {
    const question = questionById.get(reading.question_id)
    const via = reading.via_question_id ? questionById.get(reading.via_question_id) : undefined
    // A closed question is read as it stood when it closed, so its page keeps
    // showing who had signed on. An open one is read on the day viewed.
    const day = question && !isOpen(question) && question.closed_on ? question.closed_on : asOf
    const lapse =
      act.kind !== 'commits' ? null : act.withdrawn_on && act.withdrawn_on <= day ? ('withdrawn' as const) : via && !isOpenOn(via, day) ? ('closed' as const) : null
    // An act with no date yet binds them on nothing until it is dated.
    const onRecord = act.occurred_on !== null && reading.weight === 'concrete' && (act.kind === 'does' || (act.kind === 'commits' && lapse === null))
    return { act, reading, via, reports: reportsOf(act), lapse, onRecord }
  }

  const entriesByPair = new Map<string, RecordEntry[]>()
  for (const reading of readings) {
    const act = actById.get(reading.act_id)
    if (!act) continue
    const entry = entryOf(act, reading)
    const key = pairId(reading.question_id, act.decider_id)
    const list = entriesByPair.get(key)
    if (list) list.push(entry)
    else entriesByPair.set(key, [entry])
  }
  for (const list of entriesByPair.values()) list.sort((a, b) => newestFirst(a.act, b.act))

  // A decider's record on a question is the readings on that question alone. A
  // reading on a sub-question appears here only if it was also written here.
  const recordFor = (question: Question, deciderId: string): RecordEntry[] => entriesByPair.get(pairId(question.id, deciderId)) ?? []

  const agreed = (entries: RecordEntry[]): Standing => {
    const positions = new Set(entries.map((e) => e.reading.position))
    return positions.size === 0 ? 'unknown' : positions.size === 1 ? [...positions][0] : 'mixed'
  }

  // An act with no date yet is shown on the record and counts toward nothing until it is dated.
  const dated = (record: RecordEntry[]) => record.filter((e): e is RecordEntry & { act: Act & { occurred_on: string } } => e.act.occurred_on !== null)

  // What a record works out to on a position question.
  const calculate = (record: RecordEntry[]): Standing =>
    calculatePosition(dated(record).map((e) => ({ position: e.reading.position, weight: e.reading.weight, occurred_on: e.act.occurred_on, inForce: e.lapse !== 'withdrawn' }))) ?? 'unknown'

  // Where someone is listed. On a formal-act question that is read off the
  // acts that bind them there and still hold, so a withdrawn cosponsorship is
  // "has not" from the day it is withdrawn, and nobody sets it by hand.
  // Anywhere else it is what their record works out to, unless editors have
  // set a position, which is shown instead. `extra` is a record entry not on
  // file yet, to see where publishing it would leave them.
  function listingFor(question: Question, deciderId: string, extra: RecordEntry[] = [], without: readonly string[] = []): Listing {
    // An extra entry for an act already on the record takes its place there. Acts in `without` are left out.
    const replaced = new Set([...extra.map((e) => e.act.id), ...without])
    const record = [...recordFor(question, deciderId).filter((e) => !replaced.has(e.act.id)), ...extra]
    if (question.kind === 'formal_act') {
      const standing = agreed(record.filter((e) => e.onRecord))
      return { standing, calculated: standing, set: undefined }
    }
    const calculated = calculate(record)
    const set = setPositionById.get(pairId(question.id, deciderId))
    return { standing: set?.position ?? calculated, calculated, set }
  }
  const standingFor = (question: Question, deciderId: string): Standing => listingFor(question, deciderId).standing

  // The position editors set for someone, when a reading sits across from it.
  const acrossFor = (question: Question, deciderId: string, reading: Position): SetPosition | undefined => {
    const set = listingFor(question, deciderId).set
    return set && isAcross(set.position, reading) ? set : undefined
  }

  // The question a sub-question sits under, or the question itself.
  const rootOf = (question: Question): Question => (question.parent_id && questionById.get(question.parent_id)) || question

  // Everyone with a claim, past or to come, on a seat the question is put to.
  function rosterOf(question: Question): Decider[] {
    const bodies = new Set(bodyIdsOf(question))
    const seated = new Map<string, Decider>()
    for (const role of c.roles) {
      const seat = seatById.get(role.seat_id)
      const decider = deciderById.get(role.decider_id)
      if (decider && seat && bodies.has(seat.body_id) && (!question.chamber || seat.chamber === question.chamber)) seated.set(decider.id, decider)
    }
    return [...seated.values()].sort((a, b) => a.sort_name.localeCompare(b.sort_name))
  }

  // The questions an act on this one may also be read on: its smaller steps,
  // the fuller proposal it is a step of, and its neighbours.
  const relationsFrom = groupBy(c.questionRelations, (r) => r.question_id)
  const relationsTo = groupBy(c.questionRelations, (r) => r.related_id)
  function relatedTo(question: Question): RelatedQuestion[] {
    const out: (RelatedQuestion & { sort: number })[] = []
    for (const r of relationsFrom.get(question.id) ?? []) {
      const other = questionById.get(r.related_id)
      if (other) out.push({ question: other, kind: r.kind, sort: r.sort })
    }
    for (const r of relationsTo.get(question.id) ?? []) {
      const other = questionById.get(r.question_id)
      if (other) out.push({ question: other, kind: r.kind === 'smaller_step' ? 'fuller_proposal' : 'related', sort: r.sort })
    }
    const ORDER = { smaller_step: 0, fuller_proposal: 1, related: 2 }
    return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.sort - b.sort).map(({ sort: _, ...r }) => r)
  }

  function contender(question: Question, role: Role): Contender | undefined {
    const decider = deciderById.get(role.decider_id)
    if (!decider) return undefined
    const record = recordFor(question, decider.id)
    const footing = footingOf(
      dated(record).map((e) => ({ occurred_on: e.act.occurred_on, onRecord: e.onRecord })),
      new Date(asOf),
    )
    return { decider, role, ...listingFor(question, decider.id), record, footing }
  }

  // The offices an ask is put to, each with whoever sits in it on the day viewed.
  const sittingFor = (ask: Question): Tenure[] =>
    (officesOf.get(ask.id) ?? [])
      .flatMap((l) => sittingByOffice.get(l.office_id) ?? [])
      .sort((a, b) => a.office.sort - b.office.sort || SURENESS[a.holder.certainty] - SURENESS[b.holder.certainty])

  const appliesTo = (question: Question, deciderId: string) =>
    !isAsk(question) || (namedIn.get(question.id) ?? []).some((l) => l.decider_id === deciderId) || sittingFor(question).some((t) => t.holder.decider_id === deciderId)

  // Every stretch, past or to come, in which this person holds an office the
  // ask is put to. Their record on the ask stays theirs outside those dates.
  const tenuresOn = (ask: Question, deciderId: string): Tenure[] => {
    const asked = new Set((officesOf.get(ask.id) ?? []).map((l) => l.office_id))
    return tenures.filter((t) => t.holder.decider_id === deciderId && asked.has(t.office.id))
  }

  // The roles someone holds on the day viewed that count in this body: its own
  // offices, and any role they hold at large.
  const tenuresHeldBy = (deciderId: string, bodyId: string): Tenure[] =>
    tenures.filter((t) => t.holder.decider_id === deciderId && inEffect(t.holder, asOf) && (t.office.body_id === null || t.office.body_id === bodyId))

  const measuresIn = (question: Question, bodyId: string): Question[] => (measuresOf.get(question.id) ?? []).filter((m) => appliesIn(m, bodyId))

  // A question put to several bodies has one board per body. Left out, the
  // body is the one the question is listed under.
  function board(question: Question, bodyId: string = question.body_id): SeatRow[] {
    const seats = (seatsByBody.get(bodyId) ?? []).filter((s) => !question.chamber || s.chamber === question.chamber)
    return seats
      .map((seat) => {
        const present = (roles: Role[] | undefined) =>
          (roles ?? [])
            .filter((r) => appliesTo(question, r.decider_id))
            .map((r) => contender(question, r))
            .filter((x) => x !== undefined)
        const holders = present(rolesBySeat.get(seat.id))
        const incumbent = holders.find((x) => x.role.certainty !== 'possible')
        return { seat, incumbent, alternates: holders.filter((x) => x !== incumbent), upcoming: present(upcomingBySeat.get(seat.id)) }
      })
      .filter((row) => !isAsk(question) || row.incumbent || row.alternates.length > 0 || row.upcoming.length > 0)
  }

  // The seat someone holds, on the day viewed, in a body the question is put
  // to: the body named if they sit there, else another. Someone who has left,
  // or has not arrived, still resolves to their seat so their page and record
  // stay reachable.
  function roleIn(question: Question, deciderId: string, bodyId?: string): Role | undefined {
    const order = bodyIdsOf(question)
    if (bodyId) order.sort((a, b) => Number(b === bodyId) - Number(a === bodyId))
    const pick = (roles: Role[]) => order.map((id) => roles.find((r) => seatById.get(r.seat_id)?.body_id === id)).find((r) => r !== undefined)
    return pick(rolesByDecider.get(deciderId) ?? []) ?? pick(everyRoleByDecider.get(deciderId) ?? [])
  }

  // Someone an ask is put to appears in a body only if they have a seat in it.
  function keyPerson(ask: Question, bodyId: string, deciderId: string, key: string, roleLabel: string | null, certainty: Certainty = 'certain'): KeyPerson[] {
    const role = roleIn(ask, deciderId, bodyId)
    const seat = role && seatById.get(role.seat_id)
    const person = role && contender(ask, role)
    return person && seat?.body_id === bodyId ? [{ ask, key, roleLabel, certainty, contender: person, seat }] : []
  }

  // The people an ask is put to on the day viewed: office holders, then anyone named.
  function peopleOf(ask: Question, bodyId: string = ask.body_id): KeyPerson[] {
    return [
      ...sittingFor(ask).flatMap((t) => keyPerson(ask, bodyId, t.holder.decider_id, `${ask.id}:${t.holder.id}`, t.office.label, t.holder.certainty)),
      ...(namedIn.get(ask.id) ?? []).flatMap((l) => keyPerson(ask, bodyId, l.decider_id, l.id, l.role_label)),
    ]
  }

  // Everyone with an ask under this question, open asks first.
  const keyPeople = (question: Question, bodyId: string = question.body_id): KeyPerson[] =>
    (asksOf.get(question.id) ?? []).filter((a) => appliesIn(a, bodyId)).flatMap((a) => peopleOf(a, bodyId))

  const asksFor = (question: Question, deciderId: string, bodyId: string = question.body_id): KeyPerson[] =>
    keyPeople(question, bodyId).filter((k) => k.contender.decider.id === deciderId)

  return {
    ...c,
    readings,
    shownReports: shown.reports,
    shownAs: shown.shownAs,
    sameActsOf,
    reportIn,
    reviewBy,
    deciderById,
    deciderBySlug,
    questionById,
    questionBySlug,
    seatById,
    setPositionById,
    sourceById,
    actById,
    actsByDecider,
    rolesBySeat,
    rolesByDecider,
    measuresOf,
    asksOf,
    isAsk,
    appliesTo,
    tenuresOn,
    tenuresHeldBy,
    bodyById,
    bodyBySlug,
    bodiesInOrder,
    bodiesOf,
    subQuestionsOf,
    appliesIn,
    questionsIn,
    measuresIn,
    asOf,
    upcomingBySeat,
    everyRoleByDecider,
    recordFor,
    standingFor,
    listingFor,
    acrossFor,
    entryOf,
    rootOf,
    rosterOf,
    relatedTo,
    isOpen,
    contender,
    board,
    roleIn,
    peopleOf,
    keyPeople,
    asksFor,
  }
}

export type Tracker = ReturnType<typeof buildTracker>
