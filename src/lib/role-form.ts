import { CERTAINTIES, CONTESTS, pairId, type Body, type Certainty, type Comment, type Decider, type ProposalItem, type ProposalMention, type Role, type Seat } from '../../shared/schema.ts'
import type { Tracker } from './build-tracker.ts'
import type { Write } from './review-plan.ts'
import { changedFields, isDay, orNull, textField } from './form-input.ts'
import { personProblems, readPersonForm, type PersonInput } from './person-form.ts'
import { countPhrases } from './position.ts'

export type Contest = (typeof CONTESTS)[number]

// What the role form holds once read. The seat is chosen when the role is made and not changed after.
export type RoleInput = {
  affiliation: string | null
  starts_on: string | null
  ends_on: string | null
  certainty: Certainty
  contest: Contest | null
}

// Who a new role is for: someone on file, or a person added with it.
export type RoleHolder = { kind: 'existing'; decider: Decider } | { kind: 'new'; person: PersonInput } | { kind: 'unknown'; typed: string }

export const ROLE_LIMITS = { affiliation: 80 } as const

export function readRoleForm(f: FormData): RoleInput {
  const certainty = textField(f, 'certainty')
  const contest = textField(f, 'contest')
  return {
    affiliation: orNull(textField(f, 'affiliation')),
    starts_on: orNull(textField(f, 'starts_on')),
    ends_on: orNull(textField(f, 'ends_on')),
    certainty: (CERTAINTIES as readonly string[]).includes(certainty) ? (certainty as Certainty) : 'certain',
    contest: (CONTESTS as readonly string[]).includes(contest) ? (contest as Contest) : null,
  }
}

// The text each person is picked by in the role form's list of names. A name
// two people share gets the person's slug after it, so each text is one person.
export function personChoices(deciders: readonly Decider[]): { text: string; decider: Decider }[] {
  const count = new Map<string, number>()
  for (const d of deciders) count.set(d.name, (count.get(d.name) ?? 0) + 1)
  return [...deciders]
    .sort((a, b) => a.sort_name.localeCompare(b.sort_name))
    .map((decider) => ({ text: count.get(decider.name)! > 1 ? `${decider.name} (${decider.slug})` : decider.name, decider }))
}

// `holder` says whether the form picked someone on file by name (`person`) or
// added someone (`new_name` and the other `new_` fields).
export function readRoleHolder(f: FormData, choices: readonly { text: string; decider: Decider }[]): RoleHolder {
  if (textField(f, 'holder') === 'new') return { kind: 'new', person: readPersonForm(f, 'new_') }
  const typed = textField(f, 'person')
  const decider = choices.find((c) => c.text === typed)?.decider
  return decider ? { kind: 'existing', decider } : { kind: 'unknown', typed }
}

export function roleProblems(input: RoleInput, isNew: boolean): string[] {
  const problems: string[] = []
  if (input.affiliation && input.affiliation.length > ROLE_LIMITS.affiliation) problems.push(`The affiliation is longer than ${ROLE_LIMITS.affiliation} characters.`)
  if (input.starts_on !== null && !isDay(input.starts_on)) problems.push('The start date is not a date.')
  if (input.ends_on !== null && !isDay(input.ends_on)) problems.push('The end date is not a date.')
  // On an edit, an end before the start is how a claim ends before it takes effect, as when a candidate withdraws.
  if (isNew && input.starts_on && input.ends_on && isDay(input.starts_on) && isDay(input.ends_on) && input.ends_on <= input.starts_on) problems.push('The end date is not after the start date.')
  if (input.certainty === 'certain' && input.contest) problems.push('A certain claim does not depend on a contest. Leave the contest empty, or make the claim likely or possible.')
  return problems
}

export function holderProblems(holder: RoleHolder): string[] {
  if (holder.kind === 'new') return personProblems(holder.person)
  if (holder.kind === 'unknown') return [holder.typed ? `Nobody on file is called “${holder.typed}”. Choose a name from the list, or add a new person.` : 'Choose who holds the role, or add a new person.']
  return []
}

// The first day of the seat's next term, if the seat or its body names one still to come.
export function nextTermStart(seat: Pick<Seat, 'next_election_on'>, body: Pick<Body, 'next_term_on'> | undefined, today: string): string | null {
  return [seat.next_election_on, body?.next_term_on ?? null].find((day) => day !== null && day > today) ?? null
}

// Someone running for a seat: a possible holder from the next term.
export const runningFor = (seat: Seat, body: Body | undefined, today: string): RoleInput => ({
  affiliation: null,
  starts_on: nextTermStart(seat, body, today),
  ends_on: null,
  certainty: 'possible',
  contest: null,
})

export const roleInputOf = (role: Role | null): RoleInput => ({
  affiliation: role?.affiliation ?? null,
  starts_on: role?.starts_on ?? null,
  ends_on: role?.ends_on ?? null,
  certainty: role?.certainty ?? 'certain',
  contest: role?.contest ?? null,
})

// A new role gets a random id, so re-running the seed never replaces it.
export const newRole = (input: RoleInput, seatId: string, deciderId: string, newId: () => string = () => crypto.randomUUID()): Role => ({
  id: newId(),
  seat_id: seatId,
  decider_id: deciderId,
  ...input,
})

// The person goes in before the role that points at them.
export function roleInserts(role: Role, person?: Decider): Write[] {
  return [...(person ? [{ on: 'deciders', type: 'insert', row: person } satisfies Write] : []), { on: 'roles', type: 'insert', row: role }]
}

const EDITABLE = ['affiliation', 'starts_on', 'ends_on', 'certainty', 'contest'] as const

export function roleEdits(role: Role, input: RoleInput): Write[] {
  const changes = changedFields(role, input, EDITABLE)
  return changes ? [{ on: 'roles', type: 'update', id: role.id, changes }] : []
}

export const endRole = (role: Role, on: string): Write => ({ on: 'roles', type: 'update', id: role.id, changes: { ends_on: on } })

// The seats an editor chooses among once they have narrowed by body, chamber and region.
export type SeatFilter = { body_id: string; chamber: string | null; region: string | null }

// Who certainly or likely holds a seat on the day viewed, by name.
export const holderNames = (seat: Pick<Seat, 'id'>, tracker: Pick<Tracker, 'rolesBySeat' | 'deciderById'>) =>
  (tracker.rolesBySeat.get(seat.id) ?? [])
    .filter((r) => r.certainty !== 'possible')
    .flatMap((r) => tracker.deciderById.get(r.decider_id)?.name ?? [])
    .join(', ')

export const chambersIn = (seats: readonly Seat[], bodyId: string) => [...new Set(seats.filter((s) => s.body_id === bodyId && s.chamber).map((s) => s.chamber!))].sort()
export const regionsIn = (seats: readonly Seat[], bodyId: string, chamber: string | null) =>
  [...new Set(seats.filter((s) => s.body_id === bodyId && (chamber === null || s.chamber === chamber) && s.region).map((s) => s.region!))].sort()
// Seat labels in reading order, so "Ward 10" follows "Ward 9". One collator, since localeCompare with options builds one per call.
export const byLabel = new Intl.Collator(undefined, { numeric: true }).compare

export const seatsIn = (seats: readonly Seat[], filter: SeatFilter) =>
  seats
    .filter((s) => s.body_id === filter.body_id && (filter.chamber === null || s.chamber === filter.chamber) && (filter.region === null || s.region === filter.region))
    .sort((a, b) => byLabel(a.label, b.label))

type BodyQuestions = Pick<Tracker, 'seatById' | 'questions' | 'appliesIn'>

// The questions put to the body a role's seat is in.
const questionsHere = (role: Role, tracker: BodyQuestions) => {
  const bodyId = tracker.seatById.get(role.seat_id)?.body_id
  return bodyId === undefined ? [] : tracker.questions.filter((q) => tracker.appliesIn(q, bodyId))
}

// The comment threads a role's dependents are counted over, so the page can load just those.
export const threadsFor = (role: Role, tracker: BodyQuestions): string[] => questionsHere(role, tracker).map((q) => pairId(q.id, role.decider_id))

// The rows a role keeps reachable. Rows point at a person, not a role, but a
// person's page under a question is found through their seat in the body the
// question is put to. A role is safe to delete only when its person keeps
// another seat in that body, or has nothing there for a page to show.
export function roleDependents(
  role: Role,
  tracker: BodyQuestions & Pick<Tracker, 'everyRoleByDecider' | 'actsByDecider' | 'readings' | 'setPositions' | 'questionDeciders' | 'officeHolders' | 'offices'>,
  loaded: { proposalItems: readonly ProposalItem[]; proposalMentions: readonly ProposalMention[]; comments: readonly Comment[] },
): string[] {
  const who = role.decider_id
  const bodyId = tracker.seatById.get(role.seat_id)?.body_id
  const seatedElsewhere = (tracker.everyRoleByDecider.get(who) ?? []).some((r) => r.id !== role.id && tracker.seatById.get(r.seat_id)?.body_id === bodyId)
  if (bodyId === undefined || seatedElsewhere) return []
  const here = new Set(questionsHere(role, tracker).map((q) => q.id))
  const acts = new Set((tracker.actsByDecider.get(who) ?? []).map((a) => a.id))
  const items = loaded.proposalItems.filter((i) => i.decider_id === who && here.has(i.question_id))
  const proposalsHere = new Set(loaded.proposalItems.filter((i) => here.has(i.question_id)).map((i) => i.proposal_id))
  const officesHere = new Set(tracker.offices.filter((o) => o.body_id === bodyId).map((o) => o.id))
  const threads = new Set(threadsFor(role, tracker))
  const counts: [number, string, string][] = [
    [tracker.readings.filter((r) => acts.has(r.act_id) && here.has(r.question_id)).length, 'reading on the record', 'readings on the record'],
    [items.length, 'proposal item', 'proposal items'],
    [loaded.proposalMentions.filter((m) => m.decider_id === who && proposalsHere.has(m.proposal_id)).length, 'mention in a proposal', 'mentions in proposals'],
    [tracker.setPositions.filter((s) => s.decider_id === who && here.has(s.question_id)).length, 'position set by hand', 'positions set by hand'],
    [tracker.questionDeciders.filter((l) => l.decider_id === who && here.has(l.question_id)).length, 'ask put to them by name', 'asks put to them by name'],
    [tracker.officeHolders.filter((h) => h.decider_id === who && officesHere.has(h.office_id)).length, 'office held in this body', 'offices held in this body'],
    [loaded.comments.filter((c) => threads.has(c.thread_id)).length, 'comment', 'comments'],
  ]
  return countPhrases(counts)
}
