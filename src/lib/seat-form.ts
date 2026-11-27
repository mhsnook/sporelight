import type { Office, Question, QuestionBody, Role, Seat } from '../../shared/schema.ts'
import type { Write } from './review-plan.ts'
import { changedFields, isDay, orNull, textField } from './form-input.ts'

// What the seat form holds once read. Text is trimmed, and an empty optional field is null.
export type SeatInput = {
  chamber: string | null
  region: string | null
  label: string
  is_voting: boolean
  next_election_on: string | null
}

// Several seats added at once share a chamber, a vote and an election day, and each has its own label and region.
export type SeatsInput = Omit<SeatInput, 'label' | 'region'> & { lines: { label: string; region: string | null }[] }

export const SEAT_LIMITS = { chamber: 60, region: 80, label: 80 } as const

// party-db refuses a write of more than 1,000 rows, and all the seats go in one write.
export const SEATS_AT_ONCE = 500

export function readSeatForm(f: FormData): SeatInput {
  return {
    chamber: orNull(textField(f, 'chamber')),
    region: orNull(textField(f, 'region')),
    label: textField(f, 'label'),
    is_voting: f.get('is_voting') !== null,
    next_election_on: orNull(textField(f, 'next_election_on')),
  }
}

// One seat per line: its label, then a tab or a comma and its region, if it has one.
// A tab is looked for first, so a pasted spreadsheet's commas stay in the label.
export function seatLines(text: string): SeatsInput['lines'] {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    const at = line.includes('\t') ? line.indexOf('\t') : line.indexOf(',')
    if (at === -1) return [{ label: line.trim(), region: null }]
    return [{ label: line.slice(0, at).trim(), region: orNull(line.slice(at + 1).trim()) }]
  })
}

export function readSeatsForm(f: FormData): SeatsInput {
  const { chamber, is_voting, next_election_on } = readSeatForm(f)
  return { chamber, is_voting, next_election_on, lines: seatLines(textField(f, 'lines')) }
}

function sharedProblems(input: Pick<SeatInput, 'chamber' | 'next_election_on'>): string[] {
  const problems: string[] = []
  if (input.chamber && input.chamber.length > SEAT_LIMITS.chamber) problems.push(`The chamber is longer than ${SEAT_LIMITS.chamber} characters.`)
  if (input.next_election_on !== null && !isDay(input.next_election_on)) problems.push('The day of the next election is not a date.')
  return problems
}

function lineProblems(line: { label: string; region: string | null }, where: string): string[] {
  const problems: string[] = []
  if (!line.label) problems.push(`${where} has a region but no label.`)
  else if (line.label.length > SEAT_LIMITS.label) problems.push(`${where}: the label is longer than ${SEAT_LIMITS.label} characters.`)
  if (line.region && line.region.length > SEAT_LIMITS.region) problems.push(`${where}: the region is longer than ${SEAT_LIMITS.region} characters.`)
  return problems
}

export function seatProblems(input: SeatInput): string[] {
  const label = input.label ? lineProblems(input, 'The seat') : ['The seat needs a label.']
  return [...label, ...sharedProblems(input)]
}

export function seatsProblems(input: SeatsInput): string[] {
  if (input.lines.length === 0) return ['Add at least one seat, one label per line.', ...sharedProblems(input)]
  if (input.lines.length > SEATS_AT_ONCE) return [`At most ${SEATS_AT_ONCE} seats can be added at once. Add the rest after these are saved.`]
  return [...input.lines.flatMap((line, i) => lineProblems(line, `Line ${i + 1}`)), ...sharedProblems(input)]
}

// New seats get random ids, so re-running the seed, which writes its own ids, never replaces them.
export function newSeats(input: SeatsInput, bodyId: string, newId: () => string = () => crypto.randomUUID()): Seat[] {
  return input.lines.map((line) => ({
    id: newId(),
    body_id: bodyId,
    chamber: input.chamber,
    region: line.region,
    label: line.label,
    is_voting: input.is_voting,
    next_election_on: input.next_election_on,
  }))
}

export const seatInserts = (seats: Seat[]): Write[] => seats.map((row) => ({ on: 'seats', type: 'insert', row }))

export const seatInputOf = (seat: Seat): SeatInput => ({
  chamber: seat.chamber,
  region: seat.region,
  label: seat.label,
  is_voting: seat.is_voting,
  next_election_on: seat.next_election_on,
})

const EDITABLE = ['chamber', 'region', 'label', 'is_voting', 'next_election_on'] as const

// The body is left as it is: the seat's holders and their records are in that body.
export function seatEdits(seat: Seat, input: SeatInput): Write[] {
  const changes = changedFields(seat, input, EDITABLE)
  return changes ? [{ on: 'seats', type: 'update', id: seat.id, changes }] : []
}

// Every claim on a seat, ended ones included, which the tracker's rolesBySeat leaves out.
export const seatClaims = (seat: Pick<Seat, 'id'>, roles: readonly Role[]) => roles.filter((r) => r.seat_id === seat.id)

type ChamberRows = { seats: readonly Seat[]; questions: readonly Question[]; offices: readonly Office[] }

// Each chamber a body names, with what names it. `fromElsewhere` counts the
// questions put to this body from another that narrow to a chamber of this name;
// a rename leaves them alone, since the name may be their own body's chamber.
// `sharedOut` counts this body's questions naming it that are also put to other
// bodies; a rename changes their chamber there too.
export type ChamberUse = { name: string; seats: number; questions: number; offices: number; fromElsewhere: number; sharedOut: number }

export function chamberUse(bodyId: string, rows: ChamberRows & { questionBodies: readonly QuestionBody[] }, putHere: readonly Question[]): ChamberUse[] {
  const alsoElsewhere = new Set(rows.questionBodies.filter((l) => l.body_id !== bodyId).map((l) => l.question_id))
  const names = new Set<string>()
  for (const s of rows.seats) if (s.body_id === bodyId && s.chamber) names.add(s.chamber)
  for (const q of rows.questions) if (q.body_id === bodyId && q.chamber) names.add(q.chamber)
  for (const o of rows.offices) if (o.body_id === bodyId && o.chamber) names.add(o.chamber)
  return [...names].sort().map((name) => ({
    name,
    seats: rows.seats.filter((s) => s.body_id === bodyId && s.chamber === name).length,
    questions: rows.questions.filter((q) => q.body_id === bodyId && q.chamber === name).length,
    offices: rows.offices.filter((o) => o.body_id === bodyId && o.chamber === name).length,
    fromElsewhere: putHere.filter((q) => q.body_id !== bodyId && q.chamber === name).length,
    sharedOut: rows.questions.filter((q) => q.body_id === bodyId && q.chamber === name && alsoElsewhere.has(q.id)).length,
  }))
}

export function renameProblems(from: string, to: string, chambers: readonly string[]): string[] {
  if (!chambers.includes(from)) return ['Choose the chamber to rename.']
  if (!to) return ['Give the chamber its new name.']
  if (to.length > SEAT_LIMITS.chamber) return [`The new name is longer than ${SEAT_LIMITS.chamber} characters.`]
  if (to === from) return ['The new name is the name it has now.']
  return []
}

// One write per row that names the chamber in this body: its seats, and the questions and offices of the body.
// Renaming onto a chamber the body already has puts the two together, and they cannot be told apart after.
export function renameChamber(bodyId: string, from: string, to: string, rows: ChamberRows): Write[] {
  return [
    ...rows.seats.filter((s) => s.body_id === bodyId && s.chamber === from).map((s): Write => ({ on: 'seats', type: 'update', id: s.id, changes: { chamber: to } })),
    ...rows.questions.filter((q) => q.body_id === bodyId && q.chamber === from).map((q): Write => ({ on: 'questions', type: 'update', id: q.id, changes: { chamber: to } })),
    ...rows.offices.filter((o) => o.body_id === bodyId && o.chamber === from).map((o): Write => ({ on: 'offices', type: 'update', id: o.id, changes: { chamber: to } })),
  ]
}
