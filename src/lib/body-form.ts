import type { Body, Office, Question, QuestionBody, Seat } from '../../shared/schema.ts'
import type { Write } from './review-plan.ts'
import { changedFields, chooseSlug, isDay, orNull, textField } from './form-input.ts'
import { countPhrases } from './position.ts'

// What the body form holds once read. Text is trimmed, and an empty optional field is null.
export type BodyInput = {
  name: string
  jurisdiction: string | null
  description: string | null
  // null leaves the order as it is, or puts a new body after the others.
  sort: number | null
  next_term_on: string | null
  next_term_label: string | null
}

export const BODY_LIMITS = { name: 120, jurisdiction: 80, description: 1000, next_term_label: 60 } as const

// Addresses under /bodies that are pages of their own, not a body.
const RESERVED_SLUGS = ['new']

export function readBodyForm(f: FormData): BodyInput {
  const sort = textField(f, 'sort')
  return {
    name: textField(f, 'name'),
    jurisdiction: orNull(textField(f, 'jurisdiction')),
    description: orNull(textField(f, 'description')),
    sort: sort === '' ? null : Number(sort),
    next_term_on: orNull(textField(f, 'next_term_on')),
    next_term_label: orNull(textField(f, 'next_term_label')),
  }
}

export function bodyProblems(input: BodyInput): string[] {
  const problems: string[] = []
  if (!input.name) problems.push('The body needs a name.')
  else if (input.name.length > BODY_LIMITS.name) problems.push(`The name is longer than ${BODY_LIMITS.name} characters.`)
  if (input.jurisdiction && input.jurisdiction.length > BODY_LIMITS.jurisdiction) problems.push(`The jurisdiction is longer than ${BODY_LIMITS.jurisdiction} characters.`)
  if (input.description && input.description.length > BODY_LIMITS.description) problems.push(`The description is longer than ${BODY_LIMITS.description} characters.`)
  if (input.sort !== null && !Number.isInteger(input.sort)) problems.push('The order in the list must be a whole number, or left empty.')
  if (input.next_term_on !== null && !isDay(input.next_term_on)) problems.push('The day the next term starts is not a date.')
  if (input.next_term_label && input.next_term_label.length > BODY_LIMITS.next_term_label) problems.push(`The name of the next term is longer than ${BODY_LIMITS.next_term_label} characters.`)
  if (input.next_term_label && !input.next_term_on) problems.push('The next term has a name but no day it starts.')
  return problems
}

export const bodyInputOf = (body: Body | null): BodyInput => ({
  name: body?.name ?? '',
  jurisdiction: body?.jurisdiction ?? null,
  description: body?.description ?? null,
  sort: body?.sort ?? null,
  next_term_on: body?.next_term_on ?? null,
  next_term_label: body?.next_term_label ?? null,
})

// After every body on file, demo ones included, so a new body is listed after them.
export const nextBodySort = (bodies: readonly Body[]) => Math.max(-1, ...bodies.map((b) => b.sort)) + 1

// A new body gets a random id, so re-running the seed, which writes its own
// ids, never replaces it. Its slug is in page addresses and never changes.
export function newBody(input: BodyInput, bodies: readonly Body[], newId: () => string = () => crypto.randomUUID()): Body {
  return {
    id: newId(),
    slug: chooseSlug(input.name, new Set([...bodies.map((b) => b.slug), ...RESERVED_SLUGS]), undefined, 'body'),
    name: input.name,
    jurisdiction: input.jurisdiction,
    description: input.description,
    is_demo: false,
    sort: input.sort ?? nextBodySort(bodies),
    next_term_on: input.next_term_on,
    next_term_label: input.next_term_label,
  }
}

const EDITABLE = ['name', 'jurisdiction', 'description', 'sort', 'next_term_on', 'next_term_label'] as const

// The slug and whether it is demo data are left as they are.
export function bodyEdits(body: Body, input: BodyInput): Write[] {
  const changes = changedFields(body, { ...input, sort: input.sort ?? body.sort }, EDITABLE)
  return changes ? [{ on: 'bodies', type: 'update', id: body.id, changes }] : []
}

type BodyRows = { seats: readonly Seat[]; questions: readonly Question[]; questionBodies: readonly QuestionBody[]; offices: readonly Office[] }

// What hangs from a body. It can be removed only when nothing does.
export function bodyDependents(body: Pick<Body, 'id'>, rows: BodyRows): string[] {
  const counts: [number, string, string][] = [
    [rows.seats.filter((s) => s.body_id === body.id).length, 'seat', 'seats'],
    [rows.questions.filter((q) => q.body_id === body.id).length, 'question listed under it', 'questions listed under it'],
    [rows.questionBodies.filter((l) => l.body_id === body.id).length, 'question put to it from another body', 'questions put to it from other bodies'],
    [rows.offices.filter((o) => o.body_id === body.id).length, 'office', 'offices'],
  ]
  return countPhrases(counts)
}
