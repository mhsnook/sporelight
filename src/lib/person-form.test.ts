import { describe, expect, it } from 'vitest'
import { newPerson, personEdits, personInputOf, personProblems, readPersonForm, sortNameOf } from './person-form.ts'
import { decider } from './fixtures.ts'

const form = (fields: [string, string][]) => {
  const f = new FormData()
  for (const [k, v] of fields) f.append(k, v)
  return f
}

describe('readPersonForm', () => {
  it('trims the fields and leaves empty ones null', () => {
    expect(readPersonForm(form([['name', '  Rosa Delgado '], ['sort_name', ' '], ['url', '']]))).toEqual({ name: 'Rosa Delgado', sort_name: null, url: null })
  })

  it('reads the fields under a prefix, so the role form can add someone beside the role', () => {
    expect(readPersonForm(form([['name', 'Not this'], ['new_name', 'Rosa Delgado'], ['new_url', 'https://example.org']]), 'new_')).toEqual({ name: 'Rosa Delgado', sort_name: null, url: 'https://example.org' })
  })
})

describe('personProblems', () => {
  it('needs a name, and a link that is a web address', () => {
    expect(personProblems({ name: 'Rosa Delgado', sort_name: null, url: 'https://example.org/rosa' })).toEqual([])
    expect(personProblems({ name: '', sort_name: null, url: 'javascript:alert(1)' })).toHaveLength(2)
  })
})

describe('sortNameOf', () => {
  it('files someone under the last word of their name', () => {
    expect(sortNameOf('Rosa María Delgado')).toBe('Delgado, Rosa María')
    expect(sortNameOf('Cher')).toBe('Cher')
  })
})

describe('newPerson', () => {
  it('gives a new id, and a slug from the name that no one else has', () => {
    const made = newPerson({ name: 'Rosa Delgado', sort_name: null, url: null }, [{ ...decider('a'), slug: 'rosa-delgado' }], () => 'new-1')
    expect(made).toEqual({ id: 'new-1', slug: 'rosa-delgado-2', name: 'Rosa Delgado', sort_name: 'Delgado, Rosa', external_id: null, url: null })
  })
})

describe('personEdits', () => {
  const rosa = { ...decider('seed-rosa'), slug: 'rosa-delgado', name: 'Rosa Delgado', sort_name: 'Delgado, Rosa', external_id: 'X1' }

  it('changes only what the form changed, never the slug or the external id', () => {
    expect(personEdits(rosa, personInputOf(rosa))).toEqual([])
    expect(personEdits(rosa, { name: 'Rosa M. Delgado', sort_name: 'Delgado, Rosa', url: 'https://example.org' })).toEqual([
      { on: 'deciders', type: 'update', id: 'seed-rosa', changes: { name: 'Rosa M. Delgado', url: 'https://example.org' } },
    ])
  })

  it('files them under their name again when the sort name is cleared', () => {
    expect(personEdits(rosa, { name: 'Rosa Ortiz', sort_name: null, url: null })).toEqual([{ on: 'deciders', type: 'update', id: 'seed-rosa', changes: { name: 'Rosa Ortiz', sort_name: 'Ortiz, Rosa' } }])
  })
})
