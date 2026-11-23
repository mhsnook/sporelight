import { describe, expect, it } from 'vitest'
import { ageWhenFound, publishedLine } from './position.ts'

describe('publishedLine', () => {
  it('calls a date from the page or an editor a publish date', () => {
    expect(publishedLine({ published_on: '2018-07-19', published_on_from: 'page' })).toBe('Published Jul 19, 2018')
    expect(publishedLine({ published_on: '2018-07-19', published_on_from: 'editor' })).toBe('Published Jul 19, 2018')
  })

  it('does not call the search provider’s date a publish date', () => {
    expect(publishedLine({ published_on: '2018-07-19', published_on_from: 'search' })).toBe('Search result dated Jul 19, 2018')
  })

  it('says when the date is not known', () => {
    expect(publishedLine({ published_on: null, published_on_from: null })).toBe('Publish date not known')
    expect(publishedLine({ published_on: null, published_on_from: 'editor' })).toBe('Publish date not known')
  })
})

describe('ageWhenFound', () => {
  it('gives the Dingell release’s age when it was read', () => {
    expect(ageWhenFound('2018-07-19', '2026-11-23T14:17:00.000Z')).toBe('8 years')
  })

  it('counts in months under a year, and says nothing under 30 days', () => {
    expect(ageWhenFound('2026-10-24', '2026-11-23T00:00:00.000Z')).toBe('1 month')
    expect(ageWhenFound('2026-03-01', '2026-11-23T00:00:00.000Z')).toBe('8 months')
    expect(ageWhenFound('2026-10-25', '2026-11-23T00:00:00.000Z')).toBeNull()
    expect(ageWhenFound('2025-11-23', '2026-11-23T00:00:00.000Z')).toBe('1 year')
  })

  it('says nothing for an unknown date or one after it was found', () => {
    expect(ageWhenFound(null, '2026-11-23T00:00:00.000Z')).toBeNull()
    expect(ageWhenFound('2026-12-01', '2026-11-23T00:00:00.000Z')).toBeNull()
  })
})
