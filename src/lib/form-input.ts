import { slugOf } from '../../shared/schema.ts'

// Reading an editor's form: text is trimmed, and an empty optional field is null.
export const textField = (f: FormData, name: string) => {
  const value = f.get(name)
  return typeof value === 'string' ? value.trim() : ''
}
export const orNull = (value: string) => value || null
export const allFields = (f: FormData, name: string) => f.getAll(name).map((v) => (typeof v === 'string' ? v.trim() : ''))

export const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))

// The dates of a claim on a seat or an office. On an edit, an end before the
// start is how a claim ends before it takes effect, as when a candidate withdraws.
export function dateProblems(starts_on: string | null, ends_on: string | null, isNew: boolean): string[] {
  const problems: string[] = []
  if (starts_on !== null && !isDay(starts_on)) problems.push('The start date is not a date.')
  if (ends_on !== null && !isDay(ends_on)) problems.push('The end date is not a date.')
  if (isNew && starts_on && ends_on && isDay(starts_on) && isDay(ends_on) && ends_on <= starts_on) problems.push('The end date is not after the start date.')
  return problems
}

// The fields of `wanted` that differ from the stored row, or null when none do.
export function changedFields<T extends object, K extends keyof T>(row: T, wanted: Pick<T, K>, keys: readonly K[]): Partial<T> | null {
  const changes: Partial<T> = {}
  for (const k of keys) if (wanted[k] !== row[k]) changes[k] = wanted[k]
  return Object.keys(changes).length ? changes : null
}

// A slug is a page address, so it is chosen once, when the row is made, and is
// never one another row of the same table has.
export function chooseSlug(name: string, taken: ReadonlySet<string>, under?: { slug: string }, fallback = 'question'): string {
  const own = slugOf(name) || fallback
  const base = under ? `${under.slug}-${own}` : own
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}
