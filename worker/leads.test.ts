import { describe, expect, it } from 'vitest'
import { alreadyProposed, leadFromHit, rosterMatcher } from './leads.ts'

const roster = [
  { id: 'jayapal', name: 'Pramila Jayapal', sort_name: 'Jayapal, Pramila' },
  { id: 'barragan', name: 'Nanette Diaz Barragán', sort_name: 'Barragán, Nanette' },
  { id: 'adams', name: 'Alma S. Adams', sort_name: 'Adams, Alma' },
  { id: 'smith-a', name: 'Adam Smith', sort_name: 'Smith, Adam' },
  { id: 'smith-j', name: 'Jason Smith', sort_name: 'Smith, Jason' },
]
const match = rosterMatcher(roster)

describe('rosterMatcher', () => {
  it('matches a full name, with or without a middle name or accents', () => {
    expect(match('Today Pramila Jayapal said the bill would pass')).toEqual(['jayapal'])
    expect(match('Nanette Diaz Barragan signs on')).toEqual(['barragan'])
    expect(match('Alma Adams and Alma S. Adams are one person')).toEqual(['adams'])
  })

  it('matches a titled last name only when the last name is unique', () => {
    expect(match('Rep. Jayapal reintroduces the bill')).toEqual(['jayapal'])
    expect(match('Rep. Smith reintroduces the bill')).toEqual([])
    expect(match('Jason Smith reintroduces the bill')).toEqual(['smith-j'])
  })

  it('does not match a name split across unrelated words', () => {
    expect(match('Alma mater of the late John Quincy Adams')).toEqual([])
  })
})

describe('leadFromHit', () => {
  const hit = { url: 'https://example.com/a', title: 'Rep. Jayapal on single payer', description: 'Pramila Jayapal said she would reintroduce it.', lastModifiedDate: '2026-11-02T10:00:00' }

  it('turns a hit into a proposal with no reading and the page date', () => {
    expect(leadFromHit(hit, 'q', 'query', match)).toMatchObject({
      source: { url: 'https://example.com/a' },
      items: [{ question_id: 'q', decider_id: 'jayapal', reading: null, occurred_on: '2026-11-02' }],
    })
  })

  it('claims no weight and gives no reason for being unread when the article was never fetched', () => {
    const lead = leadFromHit(hit, 'q', 'query', match)
    expect(lead?.unread).toBeUndefined()
    expect(lead?.items[0]).not.toHaveProperty('weight')
    expect(lead?.note).toBe('Search excerpt, not a verified quote. Found by searching: query')
  })

  it('carries why the article was not read, as a code and in the note', () => {
    const lead = leadFromHit(hit, 'q', 'query', match, { unread: 'refused', why: 'The article was not read: The site answered 403.' })
    expect(lead?.unread).toBe('refused')
    expect(lead?.note).toBe('Search excerpt, not a verified quote. Found by searching: query\nThe article was not read: The site answered 403.')
  })

  it('makes one proposal with an item for each person the hit names', () => {
    const lead = leadFromHit({ ...hit, description: 'Pramila Jayapal and Alma Adams both spoke.' }, 'q', 'query', match)
    expect(lead?.items.map((i) => i.decider_id)).toEqual(['jayapal', 'adams'])
  })

  it('drops hits that name nobody, or name a crowd', () => {
    expect(leadFromHit({ ...hit, title: 'Health policy news', description: 'Nothing about anyone in particular.' }, 'q', 'query', match)).toBeNull()
    const crowd = 'Pramila Jayapal, Alma Adams, Adam Smith and Jason Smith all spoke.'
    expect(leadFromHit({ ...hit, description: crowd }, 'q', 'query', match)).toBeNull()
  })
})

describe('alreadyProposed', () => {
  const item = { question_id: 'm4a', decider_id: 'jayapal', quote: 'I will vote for it.' }
  const earlier = (status: 'standing' | 'turned down', quote = 'A search excerpt about the bill.') => [{ ...item, turnedDown: status === 'turned down', quote }]

  it('turns away anything for the same person and question while an item has not been turned down', () => {
    expect(alreadyProposed(earlier('standing'), item, 'reader')).toBe(true)
    expect(alreadyProposed(earlier('standing'), { ...item, decider_id: 'adams' }, 'reader')).toBe(false)
    expect(alreadyProposed(earlier('standing'), { ...item, question_id: 'other' }, 'reader')).toBe(false)
  })

  it('lets a person bring a different quote after the editors turned one down, and not the same one', () => {
    expect(alreadyProposed(earlier('turned down'), item, 'reader')).toBe(false)
    expect(alreadyProposed(earlier('turned down', item.quote), item, 'reader')).toBe(true)
  })

  it('keeps a search hit the editors turned down turned down, however the next search excerpts it', () => {
    expect(alreadyProposed(earlier('turned down'), item, 'news_search')).toBe(true)
  })

  it('keeps an item the editors turned down turned down when a model reads the same article again', () => {
    expect(alreadyProposed(earlier('turned down'), item, 'model')).toBe(true)
  })
})
