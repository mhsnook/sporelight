import { describe, expect, it } from 'vitest'
import {
  endHolding,
  holdingEdits,
  holdingInputOf,
  holdingLabel,
  holdingInserts,
  holdingProblems,
  newOffice,
  officeDependents,
  officeEdits,
  officeInputOf,
  officeProblems,
  readHoldingForm,
  readOfficeForm,
  sourceFor,
  type HoldingInput,
} from './office-form.ts'
import { TODAY, decider, holder, office, question, role, seat, source as sourceRow, track } from './fixtures.ts'

const form = (fields: [string, string][]) => {
  const f = new FormData()
  for (const [k, v] of fields) f.append(k, v)
  return f
}

const NOW = '2026-11-21T10:00:00.000Z'
const source = (id: string, url: string) => sourceRow(id, { url, title: null, created_at: NOW })

describe('offices', () => {
  it('reads the form, with an empty chamber and order as none', () => {
    expect(readOfficeForm(form([['label', ' Speaker '], ['chamber', ''], ['sort', '']]))).toEqual({ label: 'Speaker', chamber: null, sort: null })
    expect(readOfficeForm(form([['label', 'Chair'], ['chamber', 'Senate'], ['sort', '2']]))).toEqual({ label: 'Chair', chamber: 'Senate', sort: 2 })
  })

  it('refuses an office with no name, a chamber the body does not have, and an order that is not a whole number', () => {
    expect(officeProblems({ label: 'Speaker', chamber: 'House', sort: null }, ['House', 'Senate'])).toEqual([])
    expect(officeProblems({ label: '', chamber: 'Lords', sort: 0.5 }, ['House'])).toEqual([
      'The office needs a name.',
      'Choose one of the body’s chambers, or the whole body.',
      'The order must be a whole number, or left empty.',
    ])
  })

  it('gives a new office a random id and a place after the others of its body, and none of a chamber when held at large', () => {
    const offices = [office('a', { sort: 3 }), office('b', { body_id: 'other', sort: 9 }), office('c', { body_id: null, sort: 1 })]
    expect(newOffice({ label: 'Speaker', chamber: 'House', sort: null }, 'body', offices, () => 'id')).toEqual({ id: 'id', body_id: 'body', chamber: 'House', label: 'Speaker', sort: 4 })
    expect(newOffice({ label: 'Chair, Lakeview Tenants Union', chamber: 'House', sort: null }, null, offices)).toMatchObject({ body_id: null, chamber: null, sort: 2, id: expect.stringMatching(/^[0-9a-f]{8}-/) })
  })

  it('writes only what changed, and keeps the order when it is left empty', () => {
    const stored = office('o', { label: 'Chair', chamber: 'Senate', sort: 2 })
    expect(officeEdits(stored, { ...officeInputOf(stored), label: 'Chair, Finance', sort: null })).toEqual([{ on: 'offices', type: 'update', id: 'o', changes: { label: 'Chair, Finance' } }])
    expect(officeEdits(stored, officeInputOf(stored))).toEqual([])
  })

  it('counts its holders, ended ones included, and the asks put to it', () => {
    expect(officeDependents({ id: 'o' }, { officeHolders: [], questionOffices: [] })).toEqual([])
    expect(
      officeDependents({ id: 'o' }, { officeHolders: [holder('o', 'a', null, '2020-01-01'), holder('o', 'b'), holder('x', 'c')], questionOffices: [{ id: 'l', question_id: 'q', office_id: 'o' }] }),
    ).toEqual(['2 holders', '1 ask put to it'])
  })
})

describe('holdings', () => {
  const ok: HoldingInput = { starts_on: '2027-01-03', ends_on: null, certainty: 'likely', source_url: 'https://council.example/speaker' }

  it('reads the form, and an unknown certainty as certain', () => {
    expect(readHoldingForm(form([['starts_on', ''], ['ends_on', '2027-01-03'], ['certainty', 'possible'], ['source_url', ' https://a.example/x ']]))).toEqual({
      starts_on: null,
      ends_on: '2027-01-03',
      certainty: 'possible',
      source_url: 'https://a.example/x',
    })
    expect(readHoldingForm(form([['certainty', 'sure']])).certainty).toBe('certain')
  })

  it('refuses a source that is not a web address, and dates as a role does', () => {
    expect(holdingProblems(ok, true)).toEqual([])
    expect(holdingProblems({ ...ok, source_url: 'council minutes' }, true)).toEqual(['The source must be a web address starting with http:// or https://.'])
    expect(holdingProblems({ ...ok, ends_on: '2027-01-03' }, true)).toEqual(['The end date is not after the start date.'])
    // An edit can end a holding on the day it was to start, as when it never took effect.
    expect(holdingProblems({ ...ok, ends_on: '2027-01-03' }, false)).toEqual([])
  })

  it('reuses the source on file for an address, ignoring the part after #, and makes one otherwise', () => {
    const sources = [source('s', 'https://council.example/speaker')]
    expect(sourceFor('https://council.example/speaker#top', sources, NOW)).toEqual({ source: sources[0], isNew: false })
    expect(sourceFor('https://council.example/other', sources, NOW, () => 'new')).toEqual({ source: source('new', 'https://council.example/other'), isNew: true })
    expect(sourceFor(null, sources, NOW)).toBeNull()
  })

  it('writes a new person and a new source before the holding that points at them', () => {
    const person = decider('new-person')
    const made = sourceFor('https://council.example/other', [], NOW, () => 'src')
    const { holder: row, writes } = holdingInserts(ok, 'speaker', person, { person, source: made }, () => 'h')
    expect(row).toEqual({ id: 'h', office_id: 'speaker', decider_id: 'new-person', starts_on: '2027-01-03', ends_on: null, certainty: 'likely', source_id: 'src' })
    expect(writes.map((w) => w.on)).toEqual(['deciders', 'sources', 'office_holders'])
    expect(holdingInserts({ ...ok, source_url: null }, 'speaker', person, { source: null }).writes.map((w) => w.on)).toEqual(['office_holders'])
  })

  it('edits a holding and its source, and ends it on a day', () => {
    const sources = [source('s', 'https://council.example/speaker')]
    const stored = { ...holder('speaker', 'ann', '2025-01-01'), source_id: 's' }
    const start = holdingInputOf(stored, new Map(sources.map((s) => [s.id, s])))
    expect(start.source_url).toBe('https://council.example/speaker')
    expect(holdingEdits(stored, start, sourceFor(start.source_url, sources, NOW))).toEqual([])
    expect(holdingEdits(stored, { ...start, certainty: 'likely', source_url: null }, null)).toEqual([{ on: 'office_holders', type: 'update', id: stored.id, changes: { certainty: 'likely', source_id: null } }])
    expect(holdingEdits(stored, { ...start, source_url: 'https://b.example' }, sourceFor('https://b.example', sources, NOW, () => 'b')).map((w) => w.on)).toEqual(['sources', 'office_holders'])
    expect(endHolding(stored, '2026-11-21')).toEqual({ on: 'office_holders', type: 'update', id: stored.id, changes: { ends_on: '2026-11-21' } })
  })
})

describe('holdingLabel', () => {
  const day = (d: string) => d
  it('says where a holding stands on a day', () => {
    expect(holdingLabel(holder('o', 'a'), TODAY, day)).toBe('holds it')
    expect(holdingLabel(holder('o', 'a', null, '2027-01-03'), TODAY, day)).toBe('holds it until 2027-01-03')
    expect(holdingLabel(holder('o', 'a', null, TODAY), TODAY, day)).toBe(`held it until ${TODAY}`)
    expect(holdingLabel(holder('o', 'a', '2027-01-03', null, 'likely'), TODAY, day)).toBe('likely to take it up 2027-01-03')
    expect(holdingLabel(holder('o', 'a', '2027-01-03', '2027-01-03'), '2027-02-01', day)).toBe('never took it up; ended 2027-01-03')
    expect(holdingLabel(holder('o', 'a', null, null, 'possible'), TODAY, day)).toBe('may hold it')
  })
})

describe('an ask put to an office, after a change of holder made with these writes', () => {
  it('is put to whoever holds the office on the day viewed', () => {
    const ask = question('ask', { parent_id: 'main' })
    const before = holder('speaker', 'ann', '2025-01-01')
    const ended = { ...before, ends_on: TODAY }
    const { holder: next } = holdingInserts({ starts_on: TODAY, ends_on: null, certainty: 'certain', source_url: null }, 'speaker', decider('bob'), { source: null })
    const rows = (officeHolders: ReturnType<typeof holder>[]) =>
      track({
        deciders: [decider('ann'), decider('bob')],
        seats: [seat('s1'), seat('s2')],
        roles: [role('s1', 'ann'), role('s2', 'bob')],
        questions: [question('main'), ask],
        offices: [office('speaker', { label: 'Speaker' })],
        officeHolders,
        questionOffices: [{ id: 'l', question_id: 'ask', office_id: 'speaker' }],
      })
    expect(rows([before]).peopleOf(ask).map((k) => k.contender.decider.id)).toEqual(['ann'])
    expect(rows([ended, next]).peopleOf(ask).map((k) => [k.contender.decider.id, k.roleLabel])).toEqual([['bob', 'Speaker']])
  })
})
