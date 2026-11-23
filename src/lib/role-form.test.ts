import { describe, expect, it } from 'vitest'
import {
  chambersIn,
  endRole,
  holderProblems,
  newRole,
  nextTermStart,
  personChoices,
  readRoleForm,
  readRoleHolder,
  regionsIn,
  roleDependents,
  roleEdits,
  roleInputOf,
  roleInserts,
  roleProblems,
  runningFor,
  seatsIn,
  threadsFor,
} from './role-form.ts'
import { act, decider, holder, item, link, office, question, reading, role, seat, setPosition, track } from './fixtures.ts'
import type { Comment, ProposalMention } from '../../shared/schema.ts'

const form = (fields: [string, string][]) => {
  const f = new FormData()
  for (const [k, v] of fields) f.append(k, v)
  return f
}

const TODAY = '2026-11-21'
const body = { id: 'body', next_term_on: '2027-01-03' }

describe('readRoleForm', () => {
  it('trims the fields, leaves empty ones null, and reads an unknown certainty as certain', () => {
    expect(readRoleForm(form([['affiliation', ' Green '], ['starts_on', '2027-01-03'], ['ends_on', ''], ['certainty', 'possible'], ['contest', 'general']]))).toEqual({
      affiliation: 'Green',
      starts_on: '2027-01-03',
      ends_on: null,
      certainty: 'possible',
      contest: 'general',
    })
    expect(readRoleForm(form([['certainty', 'sure'], ['contest', 'coin toss']]))).toMatchObject({ certainty: 'certain', contest: null })
  })
})

describe('choosing who holds a role', () => {
  const people = [{ ...decider('a'), name: 'Sam Lee', sort_name: 'Lee, Sam', slug: 'sam-lee' }, { ...decider('b'), name: 'Sam Lee', sort_name: 'Lee, Sam', slug: 'sam-lee-2' }, { ...decider('c'), name: 'Ana Bo', sort_name: 'Bo, Ana' }]
  const choices = personChoices(people)

  it('picks each person by a text no one else has, in order of sort name', () => {
    expect(choices.map((c) => c.text)).toEqual(['Ana Bo', 'Sam Lee (sam-lee)', 'Sam Lee (sam-lee-2)'])
  })

  it('finds the person picked by name, or reads the new person’s fields', () => {
    expect(readRoleHolder(form([['holder', 'existing'], ['person', ' Sam Lee (sam-lee-2) ']]), choices)).toEqual({ kind: 'existing', decider: people[1] })
    expect(readRoleHolder(form([['holder', 'new'], ['person', 'Ana Bo'], ['new_name', 'Kit Moss']]), choices)).toEqual({ kind: 'new', person: { name: 'Kit Moss', sort_name: null, url: null } })
  })

  it('says so when the name typed is no one on file, and when nothing was chosen', () => {
    const typed = readRoleHolder(form([['holder', 'existing'], ['person', 'Sam Lee']]), choices)
    expect(holderProblems(typed)).toEqual([expect.stringContaining('Nobody on file is called “Sam Lee”')])
    expect(holderProblems(readRoleHolder(form([]), choices))).toEqual([expect.stringContaining('Choose who holds the role')])
    expect(holderProblems({ kind: 'new', person: { name: '', sort_name: null, url: null } })).toEqual(['The person needs a name.'])
  })
})

describe('roleProblems', () => {
  const ok = { affiliation: null, starts_on: '2027-01-03', ends_on: null, certainty: 'possible' as const, contest: 'general' as const }

  it('has nothing to say about a challenger with a start date and a contest', () => {
    expect(roleProblems(ok, true)).toEqual([])
  })

  it('refuses a contest on a certain claim, and dates that are not dates', () => {
    expect(roleProblems({ ...ok, certainty: 'certain' }, true)).toEqual([expect.stringContaining('A certain claim')])
    expect(roleProblems({ ...ok, starts_on: 'soon', ends_on: '2027-02-30x' }, true)).toHaveLength(2)
  })

  it('refuses a new role that ends before it starts, and lets an edit end a claim before it took effect', () => {
    const withdrawn = { ...ok, ends_on: '2026-11-21' }
    expect(roleProblems(withdrawn, true)).toEqual(['The end date is not after the start date.'])
    expect(roleProblems(withdrawn, false)).toEqual([])
  })
})

describe('someone running for a seat', () => {
  it('starts on the seat’s next election, else the body’s next term, if either is still to come', () => {
    expect(nextTermStart({ next_election_on: '2027-05-04' }, body, TODAY)).toBe('2027-05-04')
    expect(nextTermStart({ next_election_on: null }, body, TODAY)).toBe('2027-01-03')
    expect(nextTermStart({ next_election_on: '2026-05-04' }, { next_term_on: '2025-01-03' }, TODAY)).toBeNull()
    expect(nextTermStart({ next_election_on: null }, undefined, TODAY)).toBeNull()
  })

  it('is a possible holder from then, with the contest left to choose', () => {
    expect(runningFor(seat('s'), body as never, TODAY)).toEqual({ affiliation: null, starts_on: '2027-01-03', ends_on: null, certainty: 'possible', contest: null })
  })
})

describe('the rows for a role', () => {
  const input = { affiliation: 'Green', starts_on: '2027-01-03', ends_on: null, certainty: 'possible' as const, contest: 'general' as const }

  it('makes a role under a new id, after the new person it is for', () => {
    const made = newRole(input, 'seat-1', 'kit', () => 'new-1')
    expect(made).toEqual({ id: 'new-1', seat_id: 'seat-1', decider_id: 'kit', ...input })
    expect(roleInserts(made, decider('kit')).map((w) => [w.on, w.type])).toEqual([['deciders', 'insert'], ['roles', 'insert']])
    expect(roleInserts(made).map((w) => w.on)).toEqual(['roles'])
  })

  it('changes only what the form changed, and nothing when nothing changed', () => {
    const r = newRole(input, 'seat-1', 'kit', () => 'r1')
    expect(roleEdits(r, roleInputOf(r))).toEqual([])
    expect(roleEdits(r, { ...input, certainty: 'certain', contest: null })).toEqual([{ on: 'roles', type: 'update', id: 'r1', changes: { certainty: 'certain', contest: null } }])
  })

  it('ends a role by setting the day it ends', () => {
    expect(endRole(role('s', 'kit'), '2026-11-21')).toEqual({ on: 'roles', type: 'update', id: 's:kit', changes: { ends_on: '2026-11-21' } })
  })
})

describe('narrowing the seats to choose from', () => {
  const seats = [
    seat('ca-12', { body_id: 'congress', chamber: 'House', region: 'CA', label: 'CA-12' }),
    seat('ca-2', { body_id: 'congress', chamber: 'House', region: 'CA', label: 'CA-2' }),
    seat('ny-1', { body_id: 'congress', chamber: 'House', region: 'NY', label: 'NY-1' }),
    seat('ca-sen', { body_id: 'congress', chamber: 'Senate', region: 'CA', label: 'CA Senate' }),
    seat('ward-1', { body_id: 'council', label: 'Ward 1' }),
  ]

  it('offers the chambers and regions of the body chosen', () => {
    expect(chambersIn(seats, 'congress')).toEqual(['House', 'Senate'])
    expect(regionsIn(seats, 'congress', 'House')).toEqual(['CA', 'NY'])
    expect([chambersIn(seats, 'council'), regionsIn(seats, 'council', null)]).toEqual([[], []])
  })

  it('lists the seats that match, in the order of their labels', () => {
    expect(seatsIn(seats, { body_id: 'congress', chamber: 'House', region: 'CA' }).map((s) => s.id)).toEqual(['ca-2', 'ca-12'])
    expect(seatsIn(seats, { body_id: 'council', chamber: null, region: null }).map((s) => s.id)).toEqual(['ward-1'])
  })
})

describe('roleDependents', () => {
  const policy = question('policy')
  const elsewhere = question('elsewhere', { body_id: 'other' })
  const base = {
    deciders: [decider('kit'), decider('sitting')],
    seats: [seat('ward-1'), seat('ward-2'), seat('far', { body_id: 'other' })],
    questions: [policy, elsewhere],
  }
  const running = role('ward-1', 'kit', { starts_on: '2027-05-04', certainty: 'possible', contest: 'general' })
  const none = { proposalItems: [], proposalMentions: [], comments: [] }

  it('is nothing for someone with nothing on file in the body', () => {
    const t = track({ ...base, roles: [running], acts: [act('far-act', 'kit')], readings: [reading('far-act', 'elsewhere', 'support')] })
    expect(roleDependents(running, t, none)).toEqual([])
  })

  it('counts what a page in the body shows of them', () => {
    const t = track({
      ...base,
      roles: [running],
      acts: [act('a1', 'kit'), act('a2', 'kit')],
      readings: [reading('a1', 'policy', 'support'), reading('a2', 'policy', 'oppose')],
      setPositions: [setPosition('policy', 'kit', 'support')],
      questionDeciders: [link('policy', 'kit')],
      offices: [office('chair')],
      officeHolders: [holder('chair', 'kit')],
    })
    const proposalMentions: ProposalMention[] = [{ id: 'm1', proposal_id: 'p1', decider_id: 'kit', words: 'Kit' }]
    const comments = [{ id: 'c1', thread_id: 'policy:kit' }] as Comment[]
    expect(roleDependents(running, t, { proposalItems: [item('i1', 'p1', 'kit', 'policy')], proposalMentions, comments })).toEqual([
      '2 readings on the record',
      '1 proposal item',
      '1 mention in a proposal',
      '1 position set by hand',
      '1 ask put to them by name',
      '1 office held in this body',
      '1 comment',
    ])
  })

  it('is nothing when another seat of theirs in the body keeps the record in place', () => {
    const t = track({ ...base, roles: [running, role('ward-2', 'kit')], acts: [act('a1', 'kit')], readings: [reading('a1', 'policy', 'support')] })
    expect(roleDependents(running, t, none)).toEqual([])
  })

  it('loads the threads of every question put to the role’s body', () => {
    expect(threadsFor(running, track({ ...base, roles: [running] }))).toEqual(['policy:kit'])
  })
})
