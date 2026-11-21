import {
  DIRECTIONS,
  isWebAddress,
  slugOf,
  type Direction,
  type Question,
  type QuestionBody,
  type QuestionDecider,
  type QuestionOffice,
  type QuestionRelation,
} from '../../shared/schema.ts'
import type { Write } from './review-plan.ts'

// What the question form holds once read. Text is trimmed, and an empty
// optional field is null.
export type QuestionInput = {
  title: string
  short_title: string
  description: string | null
  kind: Question['kind']
  act_label: string | null
  threshold: number | null
  is_hot: boolean
  reference_url: string | null
  decides_on: string | null
  chamber: string | null
  implies_on_parent: Direction | null
  // The other bodies it is put to, beyond the one it is listed under.
  also_body_ids: string[]
  // Set only on an ask.
  deciders: { decider_id: string; role_label: string | null }[]
  office_ids: string[]
  // Only offered when a measure is made: the day it is known to close, as a bill dies when its Congress ends.
  closes_on: string | null
}

export type QuestionLinks = { bodies: QuestionBody[]; deciders: QuestionDecider[]; offices: QuestionOffice[] }

// What a question is called in labels: an ask is put to named people or offices, a measure is any other sub-question.
export const nounOf = (question: Pick<Question, 'parent_id'>, isAsk: boolean) => (isAsk ? 'ask' : question.parent_id ? 'measure' : 'question')

export type Placement =
  | { kind: 'question'; body_id: string }
  | { kind: 'measure' | 'ask'; parent: Question }
  | { kind: 'step'; to: Question; relation: QuestionRelation['kind'] }

export const LIMITS = { title: 200, short_title: 60, description: 1000, act_label: 40, role_label: 80 } as const

const textField = (f: FormData, name: string) => {
  const value = f.get(name)
  return typeof value === 'string' ? value.trim() : ''
}
const orNull = (value: string) => value || null
const allFields = (f: FormData, name: string) => f.getAll(name).map((v) => (typeof v === 'string' ? v.trim() : ''))

// Reads the form's named fields. People an ask is put to are rows of a
// `decider_id` select and a `role_label` field, paired by their order.
export function readQuestionForm(f: FormData): QuestionInput {
  const roleLabels = allFields(f, 'role_label')
  const implies = textField(f, 'implies_on_parent')
  const threshold = textField(f, 'threshold')
  return {
    title: textField(f, 'title'),
    short_title: textField(f, 'short_title'),
    description: orNull(textField(f, 'description')),
    kind: textField(f, 'kind') === 'formal_act' ? 'formal_act' : 'position',
    act_label: orNull(textField(f, 'act_label')),
    threshold: threshold === '' ? null : Number(threshold),
    is_hot: f.get('is_hot') !== null,
    reference_url: orNull(textField(f, 'reference_url')),
    decides_on: orNull(textField(f, 'decides_on')),
    chamber: orNull(textField(f, 'chamber')),
    implies_on_parent: (DIRECTIONS as readonly string[]).includes(implies) ? (implies as Direction) : null,
    also_body_ids: [...new Set(allFields(f, 'also_body_id').filter(Boolean))],
    deciders: allFields(f, 'decider_id').flatMap((decider_id, i) => (decider_id ? [{ decider_id, role_label: orNull(roleLabels[i] ?? '') }] : [])),
    office_ids: [...new Set(allFields(f, 'office_id').filter(Boolean))],
    closes_on: orNull(textField(f, 'closes_on')),
  }
}

const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))

export function questionProblems(input: QuestionInput, isAsk: boolean): string[] {
  const problems: string[] = []
  if (!input.title) problems.push('The question needs to be written out.')
  else if (input.title.length > LIMITS.title) problems.push(`The question is longer than ${LIMITS.title} characters.`)
  if (!slugOf(input.short_title)) problems.push('The short name needs at least one letter or number, since the page address is made from it.')
  else if (input.short_title.length > LIMITS.short_title) problems.push(`The short name is longer than ${LIMITS.short_title} characters.`)
  if (input.description && input.description.length > LIMITS.description) problems.push(`The description is longer than ${LIMITS.description} characters.`)
  if (input.act_label && input.act_label.length > LIMITS.act_label) problems.push(`The name for having done it is longer than ${LIMITS.act_label} characters.`)
  if (input.threshold !== null && !(Number.isInteger(input.threshold) && input.threshold > 0)) problems.push('The seats needed must be a whole number above zero, or left empty for a simple majority.')
  if (input.reference_url !== null && !isWebAddress(input.reference_url)) problems.push('The reference link must be a web address starting with http:// or https://.')
  if (input.decides_on !== null && !isDay(input.decides_on)) problems.push('The decision date is not a date.')
  if (input.closes_on !== null && !isDay(input.closes_on)) problems.push('The closing date is not a date.')
  if (isAsk && input.deciders.length === 0 && input.office_ids.length === 0) problems.push('An ask needs at least one person or office to be put to.')
  if (new Set(input.deciders.map((d) => d.decider_id)).size !== input.deciders.length) problems.push('The same person is listed twice.')
  if (input.deciders.some((d) => d.role_label && d.role_label.length > LIMITS.role_label)) problems.push(`A role is longer than ${LIMITS.role_label} characters.`)
  return problems
}

// A slug is the question's address, so it is chosen once, when the question is
// made, and is never one another question has.
export function chooseSlug(name: string, taken: ReadonlySet<string>, under?: Question): string {
  const own = slugOf(name) || 'question'
  const base = under ? `${under.slug}-${own}` : own
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}

export type QuestionRows = {
  question: Question
  bodies: QuestionBody[]
  deciders: QuestionDecider[]
  offices: QuestionOffice[]
  relation: QuestionRelation | null
}

export type Existing = { questions: Question[]; questionRelations: QuestionRelation[] }

export const bodyOf = (place: Placement) => (place.kind === 'question' ? place.body_id : place.kind === 'step' ? place.to.body_id : place.parent.body_id)

const nextSort = (sorts: number[]) => Math.max(-1, ...sorts) + 1

// The rows for a new question. Every row gets a new random id, so re-running
// the seed, which writes its own ids, never replaces one.
export function newQuestionRows(input: QuestionInput, place: Placement, existing: Existing, newId: () => string = () => crypto.randomUUID()): QuestionRows {
  const id = newId()
  const parent = place.kind === 'measure' || place.kind === 'ask' ? place.parent : null
  const body_id = bodyOf(place)
  const sort =
    place.kind === 'step'
      ? place.to.sort
      : nextSort(existing.questions.filter((q) => (parent ? q.parent_id === parent.id : q.parent_id === null && q.body_id === body_id)).map((q) => q.sort))
  const closes = place.kind === 'measure' && input.closes_on
  const question: Question = {
    id,
    slug: chooseSlug(input.short_title, new Set(existing.questions.map((q) => q.slug)), parent ?? undefined),
    body_id,
    parent_id: parent?.id ?? null,
    kind: input.kind,
    title: input.title,
    short_title: input.short_title,
    description: input.description,
    reference_url: input.reference_url,
    chamber: input.chamber,
    is_hot: input.is_hot,
    sort,
    threshold: input.threshold,
    act_label: input.kind === 'formal_act' ? input.act_label : null,
    status: closes ? 'lapsed' : 'open',
    closed_on: closes || null,
    closed_note: null,
    decides_on: input.decides_on,
    implies_on_parent: parent ? input.implies_on_parent : null,
  }
  const isAsk = place.kind === 'ask'
  return {
    question,
    bodies: input.also_body_ids.filter((b) => b !== body_id).map((body_id) => ({ id: newId(), question_id: id, body_id })),
    deciders: isAsk ? input.deciders.map((d) => ({ id: newId(), question_id: id, decider_id: d.decider_id, role_label: d.role_label })) : [],
    offices: isAsk ? input.office_ids.map((office_id) => ({ id: newId(), question_id: id, office_id })) : [],
    relation:
      place.kind === 'step'
        ? {
            id: newId(),
            question_id: place.to.id,
            related_id: id,
            kind: place.relation,
            sort: nextSort(existing.questionRelations.filter((r) => r.question_id === place.to.id).map((r) => r.sort)),
          }
        : null,
  }
}

// The question goes in before the rows that point at it.
export const questionInserts = (rows: QuestionRows): Write[] => [
  { on: 'questions', type: 'insert', row: rows.question },
  ...rows.bodies.map((row): Write => ({ on: 'question_bodies', type: 'insert', row })),
  ...rows.deciders.map((row): Write => ({ on: 'question_deciders', type: 'insert', row })),
  ...rows.offices.map((row): Write => ({ on: 'question_offices', type: 'insert', row })),
  ...(rows.relation ? [{ on: 'question_relations', type: 'insert', row: rows.relation } satisfies Write] : []),
]

export function inputOf(question: Question | null, links: QuestionLinks = { bodies: [], deciders: [], offices: [] }): QuestionInput {
  return {
    title: question?.title ?? '',
    short_title: question?.short_title ?? '',
    description: question?.description ?? null,
    kind: question?.kind ?? 'position',
    act_label: question?.act_label ?? null,
    threshold: question?.threshold ?? null,
    is_hot: question?.is_hot ?? false,
    reference_url: question?.reference_url ?? null,
    decides_on: question?.decides_on ?? null,
    chamber: question?.chamber ?? null,
    implies_on_parent: question?.implies_on_parent ?? null,
    also_body_ids: links.bodies.map((l) => l.body_id),
    deciders: links.deciders.map((l) => ({ decider_id: l.decider_id, role_label: l.role_label })),
    office_ids: links.offices.map((l) => l.office_id),
    closes_on: null,
  }
}

const EDITABLE = ['title', 'short_title', 'description', 'kind', 'act_label', 'threshold', 'is_hot', 'reference_url', 'decides_on', 'chamber', 'implies_on_parent'] as const

// The writes that turn a stored question and its links into what the form
// holds. The slug, body, parent, order and status are left as they are: the
// slug is in the page's address, and closing has its own control.
export function questionEdits(
  question: Question,
  input: QuestionInput,
  links: QuestionLinks,
  newId: () => string = () => crypto.randomUUID(),
): Write[] {
  const isAsk = links.deciders.length + links.offices.length > 0
  const wanted: Pick<Question, (typeof EDITABLE)[number]> = {
    ...input,
    act_label: input.kind === 'formal_act' ? input.act_label : null,
    implies_on_parent: question.parent_id ? input.implies_on_parent : null,
  }
  const changes = Object.fromEntries(EDITABLE.filter((k) => wanted[k] !== question[k]).map((k) => [k, wanted[k]])) as Partial<Question>
  const writes: Write[] = Object.keys(changes).length ? [{ on: 'questions', type: 'update', id: question.id, changes }] : []

  const bodies = new Set(input.also_body_ids.filter((b) => b !== question.body_id))
  // The form offers no box for the body a question is listed under, so a link to it is left alone.
  for (const l of links.bodies) if (l.body_id !== question.body_id && !bodies.has(l.body_id)) writes.push({ on: 'question_bodies', type: 'delete', id: l.id })
  for (const body_id of bodies) if (!links.bodies.some((l) => l.body_id === body_id)) writes.push({ on: 'question_bodies', type: 'insert', row: { id: newId(), question_id: question.id, body_id } })

  if (!isAsk) return writes
  for (const l of links.deciders) {
    const kept = input.deciders.find((d) => d.decider_id === l.decider_id)
    if (!kept) writes.push({ on: 'question_deciders', type: 'delete', id: l.id })
    else if (kept.role_label !== l.role_label) writes.push({ on: 'question_deciders', type: 'update', id: l.id, changes: { role_label: kept.role_label } })
  }
  for (const d of input.deciders) {
    if (!links.deciders.some((l) => l.decider_id === d.decider_id)) writes.push({ on: 'question_deciders', type: 'insert', row: { id: newId(), question_id: question.id, ...d } })
  }
  const offices = new Set(input.office_ids)
  for (const l of links.offices) if (!offices.has(l.office_id)) writes.push({ on: 'question_offices', type: 'delete', id: l.id })
  for (const office_id of offices) if (!links.offices.some((l) => l.office_id === office_id)) writes.push({ on: 'question_offices', type: 'insert', row: { id: newId(), question_id: question.id, office_id } })
  return writes
}

// The review card's short form: a new position question linked to `to`, as a
// smaller step toward it or a neighbouring question, put to the same bodies.
export function relatedQuestionRows(
  to: Question,
  alsoPutTo: QuestionBody[],
  existing: Existing,
  input: { short_title: string; title: string; kind: QuestionRelation['kind'] },
  newId: () => string = () => crypto.randomUUID(),
): QuestionRows {
  return newQuestionRows(
    {
      ...inputOf(null),
      title: input.title.trim(),
      short_title: input.short_title.trim(),
      chamber: to.chamber,
      also_body_ids: alsoPutTo.filter((l) => l.question_id === to.id).map((l) => l.body_id),
    },
    { kind: 'step', to, relation: input.kind },
    existing,
    newId,
  )
}
