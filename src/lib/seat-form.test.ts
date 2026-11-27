import { describe, expect, it } from 'vitest'
import {
  SEATS_AT_ONCE,
  chamberUse,
  newSeats,
  readSeatForm,
  readSeatsForm,
  renameChamber,
  renameProblems,
  seatClaims,
  seatEdits,
  seatInputOf,
  seatLines,
  seatProblems,
  seatsProblems,
  type SeatInput,
  type SeatsInput,
} from './seat-form.ts'
import { office, question, role, seat } from './fixtures.ts'

const form = (fields: [string, string][]) => {
  const f = new FormData()
  for (const [k, v] of fields) f.append(k, v)
  return f
}

describe('reading seats', () => {
  it('reads one seat, its vote from the checkbox being there', () => {
    expect(readSeatForm(form([['label', ' Ward 4 '], ['region', ''], ['chamber', 'Council'], ['next_election_on', '2027-05-04']]))).toEqual({
      chamber: 'Council',
      region: null,
      label: 'Ward 4',
      is_voting: false,
      next_election_on: '2027-05-04',
    })
    expect(readSeatForm(form([['label', 'Ward 4'], ['is_voting', 'on']])).is_voting).toBe(true)
  })

  it('reads one seat per line, with a region after a tab or a comma, and skips blank lines', () => {
    expect(seatLines('Ward 1\n\n  Ward 2, North \r\nDistrict 5, Dartmouth, East\nAt large\tCity, whole\n')).toEqual([
      { label: 'Ward 1', region: null },
      { label: 'Ward 2', region: 'North' },
      { label: 'District 5', region: 'Dartmouth, East' },
      { label: 'At large', region: 'City, whole' },
    ])
    expect(seatLines('Ward 3,')).toEqual([{ label: 'Ward 3', region: null }])
  })

  it('reads the shared fields with the lines', () => {
    expect(readSeatsForm(form([['chamber', ''], ['is_voting', 'on'], ['lines', 'A\nB, West']]))).toEqual({
      chamber: null,
      is_voting: true,
      next_election_on: null,
      lines: [
        { label: 'A', region: null },
        { label: 'B', region: 'West' },
      ],
    })
  })
})

describe('seat problems', () => {
  const one: SeatInput = { chamber: null, region: null, label: 'Ward 1', is_voting: true, next_election_on: null }
  const many: SeatsInput = { chamber: 'Senate', is_voting: true, next_election_on: null, lines: [{ label: 'S1', region: null }] }

  it('has nothing to say about a seat with a label in a body with no chambers', () => {
    expect(seatProblems(one, [seat('other')])).toEqual([])
    expect(seatsProblems(many, [seat('other', { chamber: 'House' })])).toEqual([])
  })

  it('refuses a seat with no label, and dates that are not dates', () => {
    expect(seatProblems({ ...one, label: '', next_election_on: 'May' }, [])).toEqual(['The seat needs a label.', 'The day of the next election is not a date.'])
  })

  it('refuses a seat with no chamber in a body whose other seats have one, which no chart would draw', () => {
    expect(seatProblems(one, [seat('h', { chamber: 'House' })])).toEqual([expect.stringContaining('The other seats in this body are each in a chamber')])
    expect(seatsProblems({ ...many, chamber: null }, [seat('h', { chamber: 'House' })])).toEqual([expect.stringContaining('The other seats in this body are each in a chamber')])
    expect(seatsProblems(many, [seat('w1'), seat('w2')])).toEqual([expect.stringContaining("The body's other seats have no chamber")])
    expect(seatsProblems(many, [])).toEqual([])
    // The first seat put in a chamber starts the change from none, one seat at a time.
    expect(seatProblems({ ...one, chamber: 'House' }, [seat('other')])).toEqual([])
  })

  it('names the line a problem is on', () => {
    expect(seatsProblems({ ...many, lines: [{ label: 'S1', region: null }, { label: '', region: 'North' }, { label: 'x'.repeat(81), region: null }] }, [])).toEqual([
      'Line 2 has a region but no label.',
      'Line 3: the label is longer than 80 characters.',
    ])
  })

  it('refuses an empty list, and more seats than one write can carry', () => {
    expect(seatsProblems({ ...many, lines: [] }, [])).toEqual(['Add at least one seat, one label per line.'])
    const lines = Array.from({ length: SEATS_AT_ONCE + 1 }, (_, i) => ({ label: `S${i}`, region: null }))
    expect(seatsProblems({ ...many, lines }, [])).toEqual([expect.stringContaining(`At most ${SEATS_AT_ONCE} seats`)])
  })
})

describe('making and editing seats', () => {
  it('gives each new seat a random id and the shared fields', () => {
    const made = newSeats({ chamber: 'House', is_voting: false, next_election_on: '2027-11-02', lines: [{ label: 'H1', region: 'North' }, { label: 'H2', region: null }] }, 'body')
    expect(made).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-/), body_id: 'body', chamber: 'House', region: 'North', label: 'H1', is_voting: false, next_election_on: '2027-11-02' },
      { id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-/), body_id: 'body', chamber: 'House', region: null, label: 'H2', is_voting: false, next_election_on: '2027-11-02' },
    ])
    expect(made[0].id).not.toBe(made[1].id)
  })

  it('writes only what changed on a seat, and nothing when nothing did', () => {
    const stored = seat('s', { chamber: 'House', label: 'H1' })
    expect(seatEdits(stored, { ...seatInputOf(stored), label: 'H-1', is_voting: false })).toEqual([{ on: 'seats', type: 'update', id: 's', changes: { label: 'H-1', is_voting: false } }])
    expect(seatEdits(stored, seatInputOf(stored))).toEqual([])
  })

  it('counts every claim on a seat, ended ones included', () => {
    expect(seatClaims(seat('s'), [role('s', 'a', { ends_on: '2020-01-01' }), role('s', 'b'), role('t', 'c')]).map((r) => r.decider_id)).toEqual(['a', 'b'])
  })
})

describe('chambers', () => {
  const rows = {
    seats: [seat('h1', { chamber: 'House' }), seat('h2', { chamber: 'House' }), seat('s1', { chamber: 'Senate' }), seat('x', { body_id: 'other', chamber: 'House' })],
    questions: [question('q', { chamber: 'House' }), question('whole'), question('away', { body_id: 'other', chamber: 'House' })],
    offices: [office('speaker', { chamber: 'House' }), office('away-chair', { body_id: 'other', chamber: 'House' }), office('at-large', { body_id: null, chamber: null })],
    questionBodies: [{ id: 'l', question_id: 'q', body_id: 'other' }],
  }

  it('lists each chamber in the body with what names it, the questions from elsewhere a rename leaves alone, and its own questions put elsewhere too', () => {
    expect(chamberUse('body', rows, [rows.questions[0], rows.questions[1], rows.questions[2]])).toEqual([
      { name: 'House', seats: 2, questions: 1, offices: 1, fromElsewhere: 1, sharedOut: 1 },
      { name: 'Senate', seats: 1, questions: 0, offices: 0, fromElsewhere: 0, sharedOut: 0 },
    ])
  })

  it("renames a chamber on the body's seats, questions and offices, and nowhere else", () => {
    expect(renameChamber('body', 'House', 'Assembly', rows)).toEqual([
      { on: 'seats', type: 'update', id: 'h1', changes: { chamber: 'Assembly' } },
      { on: 'seats', type: 'update', id: 'h2', changes: { chamber: 'Assembly' } },
      { on: 'questions', type: 'update', id: 'q', changes: { chamber: 'Assembly' } },
      { on: 'offices', type: 'update', id: 'speaker', changes: { chamber: 'Assembly' } },
    ])
  })

  it('refuses a rename to nothing, or to the same name', () => {
    const names = ['House', 'Senate']
    expect(renameProblems('House', 'Assembly', names)).toEqual([])
    expect(renameProblems('Lords', 'Assembly', names)).toEqual(['Choose the chamber to rename.'])
    expect(renameProblems('House', '', names)).toEqual(['Give the chamber its new name.'])
    expect(renameProblems('House', 'House', names)).toEqual(['The new name is the name it has now.'])
  })

  it('puts two chambers together when one is renamed to the other', () => {
    expect(renameProblems('House', 'Senate', ['House', 'Senate'])).toEqual([])
    expect(renameChamber('body', 'Senate', 'House', rows)).toEqual([{ on: 'seats', type: 'update', id: 's1', changes: { chamber: 'House' } }])
  })
})
