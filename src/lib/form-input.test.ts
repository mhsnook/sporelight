import { describe, expect, it } from 'vitest'
import { chooseSlug, isDay } from './form-input.ts'
import { question } from './fixtures.ts'

describe('chooseSlug', () => {
  it('makes the address from the short name and steps past ones in use', () => {
    expect(chooseSlug('Medicare at 55', new Set())).toBe('medicare-at-55')
    expect(chooseSlug('Medicare at 55', new Set(['medicare-at-55', 'medicare-at-55-2']))).toBe('medicare-at-55-3')
  })

  it('puts a sub-question’s address under its parent’s', () => {
    expect(chooseSlug('H.R. 1', new Set(), question('m4a', { slug: 'medicare-for-all' }))).toBe('medicare-for-all-h-r-1')
  })

  it('falls back to the word given when the name has no letters or numbers', () => {
    expect(chooseSlug('—', new Set(['person']), undefined, 'person')).toBe('person-2')
  })
})

describe('isDay', () => {
  it('takes a calendar day and nothing else', () => {
    expect(isDay('2027-01-03')).toBe(true)
    expect(isDay('2027-1-3')).toBe(false)
    expect(isDay('2027-13-40')).toBe(false)
  })
})
