import { describe, expect, it } from 'vitest'
import type { Body } from '../../shared/schema.ts'
import { bodyDependents, bodyEdits, bodyInputOf, bodyProblems, newBody, readBodyForm, type BodyInput } from './body-form.ts'
import { office, question, seat } from './fixtures.ts'

const form = (fields: [string, string][]) => {
  const f = new FormData()
  for (const [k, v] of fields) f.append(k, v)
  return f
}

const body = (id: string, over: Partial<Body> = {}): Body => ({
  id,
  slug: id,
  name: id,
  jurisdiction: null,
  description: null,
  is_demo: false,
  sort: 0,
  next_term_on: null,
  next_term_label: null,
  ...over,
})

const ok: BodyInput = { name: 'Lakeview Council', jurisdiction: 'Lakeview', description: null, sort: null, next_term_on: '2027-11-01', next_term_label: 'Council of 2027' }

describe('readBodyForm', () => {
  it('trims the fields, leaves empty ones null, and reads an empty order as none', () => {
    expect(readBodyForm(form([['name', ' Lakeview Council '], ['jurisdiction', ''], ['description', ' A city council. '], ['sort', ''], ['next_term_on', '2027-11-01'], ['next_term_label', '']]))).toEqual({
      name: 'Lakeview Council',
      jurisdiction: null,
      description: 'A city council.',
      sort: null,
      next_term_on: '2027-11-01',
      next_term_label: null,
    })
    expect(readBodyForm(form([['sort', '4']])).sort).toBe(4)
  })
})

describe('bodyProblems', () => {
  it('has nothing to say about a named body with a next term', () => {
    expect(bodyProblems(ok)).toEqual([])
  })

  it('refuses a body with no name, an order that is not a whole number, and a start day that is not a date', () => {
    expect(bodyProblems({ ...ok, name: '', sort: 1.5, next_term_on: 'next year' })).toEqual([
      'The body needs a name.',
      'The order in the list must be a whole number, or left empty.',
      'The day the next term starts is not a date.',
    ])
  })

  it('refuses a name for the next term with no day it starts', () => {
    expect(bodyProblems({ ...ok, next_term_on: null })).toEqual(['The next term has a name but no day it starts.'])
    expect(bodyProblems({ ...ok, next_term_on: null, next_term_label: null })).toEqual([])
  })

  it('refuses text past its limit', () => {
    expect(bodyProblems({ ...ok, name: 'x'.repeat(121), description: 'x'.repeat(1001) })).toHaveLength(2)
  })
})

describe('newBody', () => {
  const bodies = [body('a', { slug: 'lakeview-council', sort: 2 }), body('b', { is_demo: true, sort: 5 })]

  it('gets a random id, a slug of its own, and a place after every body on file', () => {
    const made = newBody(ok, bodies, () => 'new-id')
    expect(made).toEqual({ id: 'new-id', slug: 'lakeview-council-2', name: 'Lakeview Council', jurisdiction: 'Lakeview', description: null, is_demo: false, sort: 6, next_term_on: '2027-11-01', next_term_label: 'Council of 2027' })
    expect(newBody({ ...ok, sort: 1 }, bodies).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    expect(newBody({ ...ok, sort: 1 }, bodies).sort).toBe(1)
  })

  it('never takes the address of the page that adds a body', () => {
    expect(newBody({ ...ok, name: 'New' }, []).slug).toBe('new-2')
    expect(newBody({ ...ok, name: '???' }, []).slug).toBe('body')
  })
})

describe('bodyEdits', () => {
  const stored = body('a', { slug: 'lakeview', name: 'Lakeview', sort: 3, is_demo: true })

  it('writes only what changed, and keeps the slug, the order when it is left empty, and the demo mark', () => {
    expect(bodyEdits(stored, { ...bodyInputOf(stored), name: 'Lakeview City Council', sort: null, next_term_on: '2027-11-01' })).toEqual([
      { on: 'bodies', type: 'update', id: 'a', changes: { name: 'Lakeview City Council', next_term_on: '2027-11-01' } },
    ])
  })

  it('writes nothing when nothing changed', () => {
    expect(bodyEdits(stored, bodyInputOf(stored))).toEqual([])
  })

  it('clears the next term', () => {
    const withTerm = { ...stored, next_term_on: '2027-11-01', next_term_label: 'Next council' }
    expect(bodyEdits(withTerm, { ...bodyInputOf(withTerm), next_term_on: null, next_term_label: null })).toEqual([
      { on: 'bodies', type: 'update', id: 'a', changes: { next_term_on: null, next_term_label: null } },
    ])
  })
})

describe('bodyDependents', () => {
  const empty = { seats: [], questions: [], questionBodies: [], offices: [] }

  it('finds nothing hanging from a new body', () => {
    expect(bodyDependents({ id: 'body' }, { ...empty, seats: [seat('s', { body_id: 'other' })] })).toEqual([])
  })

  it('counts its seats, the questions listed under it or put to it, and its offices', () => {
    expect(
      bodyDependents(
        { id: 'body' },
        {
          seats: [seat('s1'), seat('s2')],
          questions: [question('q'), question('elsewhere', { body_id: 'other' })],
          questionBodies: [{ id: 'l', question_id: 'elsewhere', body_id: 'body' }],
          offices: [office('chair'), office('at-large', { body_id: null })],
        },
      ),
    ).toEqual(['2 seats', '1 question listed under it', '1 question put to it from another body', '1 office'])
  })
})
