import { CERTAINTIES, isWebAddress, sourceUrl, type Certainty, type Decider, type Office, type OfficeHolder, type QuestionOffice, type Source } from '../../shared/schema.ts'
import type { Write } from './review-plan.ts'
import { changedFields, dateProblems, orNull, textField } from './form-input.ts'

// What the office form holds once read. The body is chosen when the office is made and not changed after.
export type OfficeInput = {
  label: string
  chamber: string | null
  // null leaves the order as it is, or puts a new office after the body's others.
  sort: number | null
}

export const OFFICE_LIMITS = { label: 80 } as const

export function readOfficeForm(f: FormData): OfficeInput {
  const sort = textField(f, 'sort')
  return { label: textField(f, 'label'), chamber: orNull(textField(f, 'chamber')), sort: sort === '' ? null : Number(sort) }
}

// `chambers` are the chambers of the office's body; an office held at large has none.
export function officeProblems(input: OfficeInput, chambers: readonly string[]): string[] {
  const problems: string[] = []
  if (!input.label) problems.push('The office needs a name.')
  else if (input.label.length > OFFICE_LIMITS.label) problems.push(`The name is longer than ${OFFICE_LIMITS.label} characters.`)
  if (input.chamber !== null && !chambers.includes(input.chamber)) problems.push('Choose one of the body’s chambers, or the whole body.')
  if (input.sort !== null && !Number.isInteger(input.sort)) problems.push('The order must be a whole number, or left empty.')
  return problems
}

export const officeInputOf = (office: Office | null): OfficeInput => ({ label: office?.label ?? '', chamber: office?.chamber ?? null, sort: office?.sort ?? null })

const nextSort = (offices: readonly Office[], bodyId: string | null) => Math.max(-1, ...offices.filter((o) => o.body_id === bodyId).map((o) => o.sort)) + 1

// A new office gets a random id, so re-running the seed, which writes its own ids, never replaces it.
export function newOffice(input: OfficeInput, bodyId: string | null, offices: readonly Office[], newId: () => string = () => crypto.randomUUID()): Office {
  return { id: newId(), body_id: bodyId, chamber: bodyId === null ? null : input.chamber, label: input.label, sort: input.sort ?? nextSort(offices, bodyId) }
}

export function officeEdits(office: Office, input: OfficeInput): Write[] {
  const changes = changedFields(office, { label: input.label, chamber: office.body_id === null ? null : input.chamber, sort: input.sort ?? office.sort }, ['label', 'chamber', 'sort'])
  return changes ? [{ on: 'offices', type: 'update', id: office.id, changes }] : []
}

// What hangs from an office. It can be removed only when nothing does.
export function officeDependents(office: Pick<Office, 'id'>, rows: { officeHolders: readonly OfficeHolder[]; questionOffices: readonly QuestionOffice[] }): string[] {
  const counts: [number, string, string][] = [
    [rows.officeHolders.filter((h) => h.office_id === office.id).length, 'holder', 'holders'],
    [rows.questionOffices.filter((l) => l.office_id === office.id).length, 'ask put to it', 'asks put to it'],
  ]
  return counts.filter(([n]) => n > 0).map(([n, one, many]) => (n === 1 ? `1 ${one}` : `${n} ${many}`))
}

// What the holding form holds once read. The office and the person are chosen when it is made and not changed after.
export type HoldingInput = {
  starts_on: string | null
  ends_on: string | null
  certainty: Certainty
  // The page that says they hold it.
  source_url: string | null
}

export function readHoldingForm(f: FormData): HoldingInput {
  const certainty = textField(f, 'certainty')
  return {
    starts_on: orNull(textField(f, 'starts_on')),
    ends_on: orNull(textField(f, 'ends_on')),
    certainty: (CERTAINTIES as readonly string[]).includes(certainty) ? (certainty as Certainty) : 'certain',
    source_url: orNull(textField(f, 'source_url')),
  }
}

export function holdingProblems(input: HoldingInput, isNew: boolean): string[] {
  return [
    ...dateProblems(input.starts_on, input.ends_on, isNew),
    ...(input.source_url !== null && !isWebAddress(input.source_url) ? ['The source must be a web address starting with http:// or https://.'] : []),
  ]
}

export const holdingInputOf = (holder: OfficeHolder | null, sourceById: ReadonlyMap<string, Source>): HoldingInput => ({
  starts_on: holder?.starts_on ?? null,
  ends_on: holder?.ends_on ?? null,
  certainty: holder?.certainty ?? 'certain',
  source_url: (holder?.source_id && sourceById.get(holder.source_id)?.url) || null,
})

// The source on file for an address, or a new one. A source is one row per address, so one on file is reused.
export function sourceFor(url: string | null, sources: readonly Source[], now: string, newId: () => string = () => crypto.randomUUID()): { source: Source; isNew: boolean } | null {
  if (url === null) return null
  const address = sourceUrl(url)
  const held = sources.find((s) => s.url === address)
  if (held) return { source: held, isNew: false }
  return {
    source: { id: newId(), url: address, title: null, publisher: null, published_on: null, published_on_from: null, kind: null, archive_url: null, stored_copy: null, created_at: now },
    isNew: true,
  }
}

// The person and the source go in before the holding that points at them. A new holding gets a random id.
export function holdingInserts(
  input: HoldingInput,
  officeId: string,
  decider: Decider,
  added: { person?: Decider; source: { source: Source; isNew: boolean } | null },
  newId: () => string = () => crypto.randomUUID(),
): { holder: OfficeHolder; writes: Write[] } {
  const holder: OfficeHolder = {
    id: newId(),
    office_id: officeId,
    decider_id: decider.id,
    starts_on: input.starts_on,
    ends_on: input.ends_on,
    certainty: input.certainty,
    source_id: added.source?.source.id ?? null,
  }
  return {
    holder,
    writes: [
      ...(added.person ? [{ on: 'deciders', type: 'insert', row: added.person } satisfies Write] : []),
      ...(added.source?.isNew ? [{ on: 'sources', type: 'insert', row: added.source.source } satisfies Write] : []),
      { on: 'office_holders', type: 'insert', row: holder },
    ],
  }
}

export function holdingEdits(holder: OfficeHolder, input: HoldingInput, source: { source: Source; isNew: boolean } | null): Write[] {
  const changes = changedFields(holder, { starts_on: input.starts_on, ends_on: input.ends_on, certainty: input.certainty, source_id: source?.source.id ?? null }, ['starts_on', 'ends_on', 'certainty', 'source_id'])
  return [...(source?.isNew ? [{ on: 'sources', type: 'insert', row: source.source } satisfies Write] : []), ...(changes ? [{ on: 'office_holders', type: 'update', id: holder.id, changes } satisfies Write] : [])]
}

export const endHolding = (holder: OfficeHolder, on: string): Write => ({ on: 'office_holders', type: 'update', id: holder.id, changes: { ends_on: on } })

// Where a holding stands on a day, in a few words.
export function holdingLabel(holder: Pick<OfficeHolder, 'starts_on' | 'ends_on' | 'certainty'>, day: string, formatDay: (day: string) => string): string {
  if (holder.ends_on !== null && holder.ends_on <= day) {
    return holder.starts_on !== null && holder.ends_on <= holder.starts_on ? `never took it up; ended ${formatDay(holder.ends_on)}` : `held it until ${formatDay(holder.ends_on)}`
  }
  if (holder.starts_on !== null && holder.starts_on > day) {
    const from = formatDay(holder.starts_on)
    return holder.certainty === 'certain' ? `takes it up ${from}` : holder.certainty === 'likely' ? `likely to take it up ${from}` : `may take it up ${from}`
  }
  if (holder.certainty === 'likely') return 'likely holds it'
  if (holder.certainty === 'possible') return 'may hold it'
  return holder.ends_on ? `holds it until ${formatDay(holder.ends_on)}` : 'holds it'
}
