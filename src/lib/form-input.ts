import { slugOf } from '../../shared/schema.ts'

// Reading an editor's form: text is trimmed, and an empty optional field is null.
export const textField = (f: FormData, name: string) => {
  const value = f.get(name)
  return typeof value === 'string' ? value.trim() : ''
}
export const orNull = (value: string) => value || null
export const allFields = (f: FormData, name: string) => f.getAll(name).map((v) => (typeof v === 'string' ? v.trim() : ''))

export const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))

// A slug is a page address, so it is chosen once, when the row is made, and is
// never one another row of the same table has.
export function chooseSlug(name: string, taken: ReadonlySet<string>, under?: { slug: string }, fallback = 'question'): string {
  const own = slugOf(name) || fallback
  const base = under ? `${under.slug}-${own}` : own
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}
