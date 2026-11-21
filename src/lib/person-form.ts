import { isWebAddress, type Decider } from '../../shared/schema.ts'
import type { Write } from './review-plan.ts'
import { chooseSlug, orNull, textField } from './form-input.ts'

export type PersonInput = { name: string; sort_name: string | null; url: string | null }

export const PERSON_LIMITS = { name: 120, sort_name: 120 } as const

// `prefix` tells apart the person fields of the role form, which can add someone new beside the role.
export function readPersonForm(f: FormData, prefix = ''): PersonInput {
  return {
    name: textField(f, `${prefix}name`),
    sort_name: orNull(textField(f, `${prefix}sort_name`)),
    url: orNull(textField(f, `${prefix}url`)),
  }
}

export function personProblems(input: PersonInput): string[] {
  const problems: string[] = []
  if (!input.name) problems.push('The person needs a name.')
  else if (input.name.length > PERSON_LIMITS.name) problems.push(`The name is longer than ${PERSON_LIMITS.name} characters.`)
  if (input.sort_name && input.sort_name.length > PERSON_LIMITS.sort_name) problems.push(`The sort name is longer than ${PERSON_LIMITS.sort_name} characters.`)
  if (input.url !== null && !isWebAddress(input.url)) problems.push('The link must be a web address starting with http:// or https://.')
  return problems
}

// What a list sorted by family name files someone under when no sort name is
// given: the last word of the name first, as the seed does.
export function sortNameOf(name: string): string {
  const words = name.trim().split(/\s+/)
  return words.length < 2 ? name.trim() : `${words.at(-1)}, ${words.slice(0, -1).join(' ')}`
}

// A new person gets a random id, so re-running the seed, which writes its own
// ids, never replaces them. Their slug is their page address and never changes.
export function newPerson(input: PersonInput, deciders: readonly Decider[], newId: () => string = () => crypto.randomUUID()): Decider {
  return {
    id: newId(),
    slug: chooseSlug(input.name, new Set(deciders.map((d) => d.slug)), undefined, 'person'),
    name: input.name,
    sort_name: input.sort_name ?? sortNameOf(input.name),
    external_id: null,
    url: input.url,
  }
}

export const personInputOf = (decider: Decider | null): PersonInput => ({ name: decider?.name ?? '', sort_name: decider?.sort_name ?? null, url: decider?.url ?? null })

// The slug and the external id are left as they are: one is in page addresses,
// the other is the seed's link to the outside roster.
export function personEdits(decider: Decider, input: PersonInput): Write[] {
  const wanted = { name: input.name, sort_name: input.sort_name ?? sortNameOf(input.name), url: input.url }
  const changes = Object.fromEntries((Object.keys(wanted) as (keyof typeof wanted)[]).filter((k) => wanted[k] !== decider[k]).map((k) => [k, wanted[k]])) as Partial<Decider>
  return Object.keys(changes).length ? [{ on: 'deciders', type: 'update', id: decider.id, changes }] : []
}
