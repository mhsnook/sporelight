import { describe, expect, it } from 'vitest'
import { claimLabel, claimTag } from './position.ts'
import { EDITORS_ID, type SameAct } from '../../shared/schema.ts'
import { asShown, readingsFrom, reviewerTiers, type RecordEntry } from './build-tracker.ts'
import { act, decider, holder, link, office, question, review, relation, report, role, seat, setPosition, source, track } from './fixtures.ts'

const policy = question('policy')
const bill = question('bill', { parent_id: 'policy', kind: 'formal_act', implies_on_parent: 'support', sort: 1 })

describe("a decider's record on a question", () => {
  const tracker = track({
      deciders: [decider('ann'), decider('bob')],
      questions: [policy, bill],
      sources: [source('release'), source('paper'), source('wire')],
      acts: [
        act('speech', 'ann', { occurred_on: '2026-02-11', primary_source_id: 'release' }),
        act('signed', 'ann', { kind: 'commits', occurred_on: '2026-01-05' }),
        act('hedge', 'ann', { occurred_on: '2026-03-01' }),
        act('bob-speech', 'bob', { occurred_on: '2026-02-12' }),
      ],
      reports: [
        report('paper', 'speech', { created_at: '2026-02-12T00:00:00.000Z' }),
        report('wire', 'speech', { created_at: '2026-02-13T00:00:00.000Z' }),
        report('release', 'speech', { created_at: '2026-02-14T00:00:00.000Z' }),
        report('paper', 'signed'),
        report('paper', 'hedge'),
        report('wire', 'bob-speech'),
      ],
      reviews: [
        review('speech', 'policy', 'support'),
        review('signed', 'bill', 'support'),
        review('hedge', 'bill', 'mixed'),
        review('bob-speech', 'policy', 'oppose'),
      ],
    })

  it('is the readings on that question for that decider, newest act first', () => {
    expect(tracker.recordFor(policy, 'ann').map((e) => e.act.id)).toEqual(['speech', 'signed'])
    expect(tracker.recordFor(policy, 'bob').map((e) => [e.act.id, e.reading.position])).toEqual([['bob-speech', 'oppose']])
  })

  it('lists one act once however many sources report it, the record of the act itself first', () => {
    const [speech] = tracker.recordFor(policy, 'ann')
    expect(speech.reports.map((r) => r.source.id)).toEqual(['release', 'paper', 'wire'])
  })

  it('shows a reading on a sub-question on the parent only when it was written there too', () => {
    expect(tracker.recordFor(bill, 'ann').map((e) => e.act.id)).toEqual(['hedge', 'signed'])
    const signed = tracker.recordFor(policy, 'ann').find((e) => e.act.id === 'signed')
    expect(signed?.via?.id).toBe('bill')
    expect(tracker.recordFor(policy, 'ann').some((e) => e.act.id === 'hedge')).toBe(false)
  })

  it('lets one act read differently on two questions', () => {
    const both = track({
        deciders: [decider('ann')],
        questions: [policy, question('markup', { parent_id: 'policy' })],
        acts: [act('advance', 'ann')],
        reviews: [review('advance', 'markup', 'support'), review('advance', 'policy', 'oppose')],
      })
    expect(both.recordFor(both.questionById.get('markup')!, 'ann')[0].reading.position).toBe('support')
    expect(both.recordFor(policy, 'ann')[0].reading.position).toBe('oppose')
  })

  it('takes footing from the acts on the record', () => {
    const tracked = track({
        deciders: [decider('ann')],
        seats: [seat('s1')],
        roles: [role('s1', 'ann')],
        questions: [policy, bill],
        acts: [act('signed', 'ann', { kind: 'commits' })],
        reviews: [review('signed', 'bill', 'support', 'concrete')],
      })
    const [row] = tracked.board(bill)
    expect(row.incumbent).toMatchObject({ standing: 'support', footing: 'on_record' })
    expect(tracked.board(policy)[0].incumbent).toMatchObject({ standing: 'support', footing: 'on_record' })
  })
})

describe('asks', () => {
  const markup = question('markup', { parent_id: 'policy', sort: 5 })
  const hearing = question('hearing', { parent_id: 'policy', sort: 4, status: 'lapsed', closed_on: '2026-03-01' })
  const tracker = track({
      deciders: [decider('ann'), decider('bob'), decider('cy')],
      seats: [seat('s1'), seat('s2'), seat('s3')],
      roles: [role('s1', 'ann'), role('s2', 'bob'), role('s3', 'cy', { starts_on: '2027-05-04', certainty: 'possible', contest: 'general' })],
      questions: [policy, bill, markup, hearing],
      questionDeciders: [link('markup', 'bob', 'Chair'), link('hearing', 'ann', 'Vice chair')],
      acts: [act('bob-on-markup', 'bob')],
      reviews: [review('bob-on-markup', 'markup', 'lean_support')],
    })

  it('keeps asks apart from the measures put to everyone', () => {
    expect(tracker.measuresOf.get('policy')?.map((q) => q.id)).toEqual(['bill'])
    expect(tracker.asksOf.get('policy')?.map((q) => q.id)).toEqual(['markup', 'hearing'])
  })

  it('names the people each ask is put to, open asks first', () => {
    expect(tracker.keyPeople(policy).map((k) => [k.ask.id, k.contender.decider.id, k.roleLabel, k.contender.standing])).toEqual([
      ['markup', 'bob', 'Chair', 'lean_support'],
      ['hearing', 'ann', 'Vice chair', 'unknown'],
    ])
    expect(tracker.asksFor(policy, 'ann').map((k) => k.ask.id)).toEqual(['hearing'])
  })

  it('puts only the named people on the board of an ask', () => {
    expect(tracker.board(markup).map((r) => r.incumbent?.decider.id)).toEqual(['bob'])
    expect(tracker.board(policy)).toHaveLength(3)
    expect(tracker.appliesTo(markup, 'ann')).toBe(false)
  })
})

describe('viewing a body on a day', () => {
  const policy = question('policy')
  const markup = question('markup', { parent_id: 'policy', title: 'Will they commit to a markup?' })
  const TERM = '2027-01-03'
  const rows = {
    deciders: [decider('crapo'), decider('wyden'), decider('old'), decider('new')],
    seats: [seat('id'), seat('or'), seat('tx')],
    roles: [role('id', 'crapo'), role('or', 'wyden'), role('tx', 'old', { ends_on: TERM }), role('tx', 'new', { starts_on: TERM })],
    questions: [policy, markup],
    offices: [office('chair', { label: 'Chair, Finance' })],
    officeHolders: [holder('chair', 'crapo', null, TERM), holder('chair', 'wyden', TERM)],
    questionOffices: [{ id: 'markup:chair', question_id: 'markup', office_id: 'chair' }],
    acts: [act('crapo-refuses', 'crapo'), act('old-backs', 'old'), act('new-hedges', 'new')],
    reviews: [review('crapo-refuses', 'markup', 'oppose'), review('old-backs', 'policy', 'support'), review('new-hedges', 'policy', 'lean_support')],
  }
  const now = track(rows)
  const next = track(rows, '2027-01-31')

  it('fills each seat with whoever holds it that day', () => {
    const holderOf = (t: typeof now, seatId: string) => t.board(policy).find((r) => r.seat.id === seatId)?.incumbent?.decider.id
    expect(holderOf(now, 'tx')).toBe('old')
    expect(holderOf(next, 'tx')).toBe('new')
    expect(now.board(policy).map((r) => r.incumbent?.standing)).toEqual(['unknown', 'unknown', 'support'])
    expect(next.board(policy).map((r) => r.incumbent?.standing)).toEqual(['unknown', 'unknown', 'lean_support'])
  })

  it('hands the seat over on the day itself, with nobody holding it twice', () => {
    const onTheDay = track(rows, TERM)
    expect(onTheDay.rolesBySeat.get('tx')?.map((r) => r.decider_id)).toEqual(['new'])
    expect(track(rows, '2027-01-02').rolesBySeat.get('tx')?.map((r) => r.decider_id)).toEqual(['old'])
  })

  it('puts an ask of an office to whoever sits in it that day, under the title of the office', () => {
    expect(now.keyPeople(policy).map((k) => [k.contender.decider.id, k.roleLabel, k.contender.standing])).toEqual([['crapo', 'Chair, Finance', 'oppose']])
    expect(next.keyPeople(policy).map((k) => [k.contender.decider.id, k.roleLabel, k.contender.standing])).toEqual([['wyden', 'Chair, Finance', 'unknown']])
    expect(now.isAsk(markup)).toBe(true)
    expect([now.appliesTo(markup, 'wyden'), next.appliesTo(markup, 'wyden'), next.appliesTo(markup, 'crapo')]).toEqual([false, true, false])
    expect(next.board(markup).map((r) => r.incumbent?.decider.id)).toEqual(['wyden'])
  })

  it('gives each ask its own entry when two are put to one office', () => {
    const hearing = question('hearing', { parent_id: 'policy', sort: 1 })
    const both = track({ ...rows, questions: [...rows.questions, hearing], questionOffices: [...rows.questionOffices, { id: 'hearing:chair', question_id: 'hearing', office_id: 'chair' }] })
    const people = both.keyPeople(policy)
    expect(people.map((k) => [k.ask.id, k.contender.decider.id])).toEqual([['markup', 'crapo'], ['hearing', 'crapo']])
    expect(new Set(people.map((k) => k.key)).size).toBe(2)
  })

  it('keeps each holder their own position on the ask, and knows when they hold the office', () => {
    expect(next.standingFor(markup, 'crapo')).toBe('oppose')
    expect(now.tenuresOn(markup, 'wyden').map((t) => [t.office.label, t.holder.starts_on])).toEqual([['Chair, Finance', TERM]])
    expect(now.tenuresHeldBy('crapo', 'body').map((t) => t.office.id)).toEqual(['chair'])
    expect(next.tenuresHeldBy('crapo', 'body')).toEqual([])
  })

  it('still finds the seat of someone who has left or not yet arrived', () => {
    expect(next.roleIn(policy, 'old')?.seat_id).toBe('tx')
    expect(now.roleIn(policy, 'new')?.seat_id).toBe('tx')
  })
})

describe('a question put to more than one body', () => {
  const pledge = question('pledge', { body_id: 'council' })
  const rows = {
    bodies: [
      { id: 'council', slug: 'council', name: 'Council', jurisdiction: null, description: null, is_demo: false, sort: 0, next_term_on: null, next_term_label: null },
      { id: 'board', slug: 'board', name: 'Board', jurisdiction: null, description: null, is_demo: false, sort: 1, next_term_on: null, next_term_label: null },
      { id: 'elsewhere', slug: 'elsewhere', name: 'Elsewhere', jurisdiction: null, description: null, is_demo: false, sort: 2, next_term_on: null, next_term_label: null },
    ],
    deciders: [decider('ann'), decider('bob'), decider('cy')],
    seats: [seat('c1', { body_id: 'council' }), seat('c2', { body_id: 'council' }), seat('b1', { body_id: 'board' }), seat('b2', { body_id: 'board' }), seat('e1', { body_id: 'elsewhere' })],
    roles: [role('c1', 'ann'), role('c2', 'bob'), role('b1', 'ann'), role('b2', 'cy'), role('e1', 'cy')],
    questions: [pledge, question('council-only', { body_id: 'council' }), question('bill', { body_id: 'council', parent_id: 'pledge', kind: 'formal_act' as const })],
    questionBodies: [{ id: 'pledge:board', question_id: 'pledge', body_id: 'board' }],
    acts: [act('ann-pledges', 'ann')],
    reviews: [review('ann-pledges', 'pledge', 'support')],
    offices: [office('fundraiser', { body_id: null, label: 'Fundraiser' }), office('speaker', { body_id: 'council', label: 'Speaker' })],
    officeHolders: [holder('fundraiser', 'ann'), holder('speaker', 'ann')],
  }
  const tracker = track(rows)

  it('lists it under each body it is put to, and only those', () => {
    expect(tracker.bodiesOf(pledge).map((b) => b.id)).toEqual(['council', 'board'])
    expect(tracker.questionsIn('council').map((q) => q.id)).toEqual(['pledge', 'council-only'])
    expect(tracker.questionsIn('board').map((q) => q.id)).toEqual(['pledge'])
    expect(tracker.questionsIn('elsewhere')).toEqual([])
  })

  it("draws each body's own seats, with one answer for someone who sits in both", () => {
    expect(tracker.board(pledge).map((r) => [r.incumbent?.decider.id, r.incumbent?.standing])).toEqual([
      ['ann', 'support'],
      ['bob', 'unknown'],
    ])
    expect(tracker.board(pledge, 'board').map((r) => [r.incumbent?.decider.id, r.incumbent?.standing])).toEqual([
      ['ann', 'support'],
      ['cy', 'unknown'],
    ])
  })

  it('finds a person in the body asked for, else in another the question is put to, never one it is not', () => {
    expect(tracker.roleIn(pledge, 'ann', 'board')?.seat_id).toBe('b1')
    expect(tracker.roleIn(pledge, 'ann')?.seat_id).toBe('c1')
    expect(tracker.roleIn(pledge, 'bob', 'board')?.seat_id).toBe('c2')
    expect(tracker.roleIn(pledge, 'cy')?.seat_id).toBe('b2')
  })

  it('keeps a measure in the bodies it is put to', () => {
    expect(tracker.measuresIn(pledge, 'council').map((q) => q.id)).toEqual(['bill'])
    expect(tracker.measuresIn(pledge, 'board')).toEqual([])
  })

  it('shows a role held at large in every body, and an office of one body only there', () => {
    expect(tracker.tenuresHeldBy('ann', 'council').map((t) => t.office.label)).toEqual(['Fundraiser', 'Speaker'])
    expect(tracker.tenuresHeldBy('ann', 'board').map((t) => t.office.label)).toEqual(['Fundraiser'])
  })

  it('puts an ask of a role at large to its holder wherever they sit', () => {
    const ask = question('ask', { body_id: 'council', parent_id: 'pledge' })
    const asked = track({ ...rows, questions: [...rows.questions, ask], questionBodies: [...rows.questionBodies, { id: 'ask:board', question_id: 'ask', body_id: 'board' }], questionOffices: [{ id: 'ask:fundraiser', question_id: 'ask', office_id: 'fundraiser' }] })
    expect(asked.keyPeople(pledge, 'council').map((k) => [k.contender.decider.id, k.roleLabel, k.seat.id])).toEqual([['ann', 'Fundraiser', 'c1']])
    expect(asked.keyPeople(pledge, 'board').map((k) => [k.contender.decider.id, k.roleLabel, k.seat.id])).toEqual([['ann', 'Fundraiser', 'b1']])
  })
})

describe('how much an act counts', () => {
  const policy = question('policy')
  const bill = question('bill', { parent_id: 'policy', kind: 'formal_act', implies_on_parent: 'support', status: 'lapsed', closed_on: '2027-01-03' })
  const base = { deciders: [decider('ann')], seats: [seat('s1')], roles: [role('s1', 'ann')], questions: [policy, bill] }
  const on = (rows: Parameters<typeof track>[0], q: typeof policy, asOf?: string) => {
    const person = track({ ...base, ...rows }, asOf).board(q)[0].incumbent!
    return [person.standing, person.footing]
  }
  const cosponsored = { acts: [act('signed', 'ann', { kind: 'commits', occurred_on: '2025-04-29' })], reviews: [review('signed', 'bill', 'support', 'concrete')] }

  it('puts a use of office and a commitment in force on the record when they are read as concrete, and words not', () => {
    expect(on({ acts: [act('a', 'ann', { kind: 'does' })], reviews: [review('a', 'policy', 'support', 'concrete')] }, policy)[1]).toBe('on_record')
    expect(on({ acts: [act('a', 'ann', { kind: 'commits' })], reviews: [review('a', 'policy', 'support', 'concrete')] }, policy)[1]).toBe('on_record')
    expect(on({ acts: [act('a', 'ann', { kind: 'says', occurred_on: '2026-11-01' })], reviews: [review('a', 'policy', 'support')] }, policy)[1]).toBe('sparse')
    expect(on({ acts: [act('a', 'ann', { kind: 'says', occurred_on: '2026-11-01' })], reviews: [review('a', 'policy', 'support', 'concrete')] }, policy)[1]).toBe('sparse')
  })

  it('counts a vote on something else as a signal here, not as being on the record', () => {
    const rows = { acts: [act('gift', 'ann', { kind: 'does', occurred_on: '2026-07-14' })], reviews: [review('gift', 'policy', 'oppose', 'passing')] }
    expect(on(rows, policy)).toEqual(['lean_oppose', 'sparse'])
    expect(track({ ...base, ...rows }).recordFor(policy, 'ann')[0].onRecord).toBe(false)
  })

  it('reads where someone stands on a formal-act question off the acts, whatever position is set', () => {
    expect(on(cosponsored, bill)).toEqual(['support', 'on_record'])
    const talk = { acts: [act('talk', 'ann')], reviews: [review('talk', 'bill', 'support')], setPositions: [setPosition('bill', 'ann', 'support')] }
    expect(track({ ...base, ...talk }).listingFor(bill, 'ann')).toEqual({ standing: 'unknown', calculated: 'unknown', set: undefined })
    expect(on({ setPositions: [setPosition('bill', 'ann', 'oppose')], ...cosponsored }, bill)[0]).toBe('support')
    const both = {
      acts: [act('yes', 'ann', { kind: 'does' }), act('no', 'ann', { kind: 'does', occurred_on: '2026-02-01' })],
      reviews: [review('yes', 'bill', 'support', 'concrete'), review('no', 'bill', 'oppose', 'concrete')],
    }
    expect(on(both, bill)[0]).toBe('mixed')
  })

  it('stops counting a commitment from the day it is withdrawn', () => {
    const withdrawn = { ...cosponsored, acts: [act('signed', 'ann', { kind: 'commits', occurred_on: '2025-04-29', withdrawn_on: '2026-10-05' })] }
    expect(on(withdrawn, bill, '2026-10-04')).toEqual(['support', 'on_record'])
    expect(on(withdrawn, bill, '2026-10-05')[0]).toBe('unknown')
    expect(track({ ...base, ...withdrawn }).recordFor(bill, 'ann')[0].lapse).toBe('withdrawn')
    expect(on(withdrawn, policy)[1]).not.toBe('on_record')
  })

  it('works out the parent from the acts read there, so taking a commitment back takes it back', () => {
    const withdrawn = { ...cosponsored, acts: [act('signed', 'ann', { kind: 'commits', occurred_on: '2025-04-29', withdrawn_on: '2026-10-05' })] }
    const standing = (rows: Parameters<typeof track>[0], asOf?: string) => track({ ...base, ...rows }, asOf).board(policy)[0].incumbent!.standing
    expect(standing(cosponsored)).toBe('support')
    expect([standing(withdrawn, '2026-10-04'), standing(withdrawn)]).toEqual(['support', 'unknown'])
    // The measure closing does not take the commitment back.
    expect(standing(cosponsored, '2027-01-31')).toBe('support')
  })

  it('falls back on what is left of the record once a commitment is withdrawn', () => {
    const rows = {
      acts: [act('signed', 'ann', { kind: 'commits', occurred_on: '2025-04-29', withdrawn_on: '2026-10-05' }), act('speech', 'ann', { occurred_on: '2026-10-20' })],
      reviews: [...cosponsored.reviews, review('speech', 'policy', 'lean_support')],
    }
    expect(on(rows, policy)[0]).toBe('lean_support')
  })

  it('lets a commitment lapse on the parent when its measure closes, and keeps the measure as it stood', () => {
    expect(on(cosponsored, policy)[1]).toBe('on_record')
    expect(on(cosponsored, policy, '2027-01-31')[1]).toBe('sparse')
    expect(track({ ...base, ...cosponsored }, '2027-01-31').recordFor(policy, 'ann')[0].lapse).toBe('closed')
    expect(on(cosponsored, bill, '2027-01-31')).toEqual(['support', 'on_record'])
  })

  it('treats a question with a closing date ahead as open until the day', () => {
    expect([track(base).isOpen(bill), track(base, '2027-01-03').isOpen(bill)]).toEqual([true, false])
  })
})

describe('a position set by editors', () => {
  const policy = question('policy')
  const base = { deciders: [decider('ann'), decider('bob')], seats: [seat('s1')], roles: [role('s1', 'ann')], questions: [policy] }
  const voted = { acts: [act('vote', 'ann', { kind: 'does', occurred_on: '2026-03-01' })], reviews: [review('vote', 'policy', 'support', 'concrete')] }
  const set = setPosition('policy', 'ann', 'lean_oppose', 'Told the caucus she will vote no.')

  it('is shown instead of the calculated one, which still reports the record', () => {
    const tracker = track({ ...base, ...voted, setPositions: [set] })
    expect(tracker.listingFor(policy, 'ann')).toEqual({ standing: 'lean_oppose', calculated: 'support', set })
    expect(tracker.standingFor(policy, 'ann')).toBe('lean_oppose')
    expect(tracker.board(policy)[0].incumbent).toMatchObject({ standing: 'lean_oppose', calculated: 'support', set, footing: 'on_record' })
  })

  it('is shown for someone with no record', () => {
    expect(track({ ...base, setPositions: [set] }).listingFor(policy, 'ann')).toEqual({ standing: 'lean_oppose', calculated: 'unknown', set })
  })

  it('leaves the calculated position showing when there is none, and for everyone else', () => {
    expect(track({ ...base, ...voted }).listingFor(policy, 'ann')).toEqual({ standing: 'support', calculated: 'support', set: undefined })
    expect(track({ ...base, ...voted, setPositions: [set] }).listingFor(policy, 'bob')).toEqual({ standing: 'unknown', calculated: 'unknown', set: undefined })
  })
})

describe('where an entry not on file yet would leave someone', () => {
  const policy = question('policy')
  const bill = question('bill', { parent_id: 'policy', kind: 'formal_act' })
  const tracker = track({
    deciders: [decider('ann')],
    questions: [policy, bill],
    acts: [act('speech', 'ann', { occurred_on: '2026-02-01' })],
    reviews: [review('speech', 'policy', 'support')],
    setPositions: [setPosition('policy', 'ann', 'mixed')],
  })
  const extra = (questionId: string, position: Parameters<typeof review>[2], weight: Parameters<typeof review>[3] & string, over: Parameters<typeof act>[2] = {}): RecordEntry => {
    const added = act('added', 'ann', { occurred_on: '2026-06-01', ...over })
    return { act: added, reading: { id: `added ${questionId}`, act_id: 'added', question_id: questionId, position, weight, via_question_id: null }, via: undefined, reports: [], lapse: null, onRecord: weight === 'concrete' && added.kind !== 'says' }
  }

  it('counts the entry with the record in what is calculated', () => {
    expect(tracker.listingFor(policy, 'ann').calculated).toBe('support')
    expect(tracker.listingFor(policy, 'ann', [extra('policy', 'oppose', 'clear')]).calculated).toBe('oppose')
    expect(tracker.listingFor(policy, 'ann', [extra('policy', 'oppose', 'passing')]).calculated).toBe('support')
    expect(tracker.listingFor(policy, 'ann', [extra('policy', 'oppose', 'concrete', { kind: 'does', occurred_on: '2026-01-01' })]).calculated).toBe('lean_oppose')
  })

  it('still shows the set position', () => {
    expect(tracker.listingFor(policy, 'ann', [extra('policy', 'oppose', 'clear')])).toMatchObject({ standing: 'mixed', calculated: 'oppose' })
  })

  it('reads a formal-act question off the entry when it binds them', () => {
    expect(tracker.listingFor(bill, 'ann', [extra('bill', 'support', 'concrete', { kind: 'commits' })]).standing).toBe('support')
    expect(tracker.listingFor(bill, 'ann', [extra('bill', 'support', 'clear')]).standing).toBe('unknown')
  })

  it('does not put the entry on the record', () => {
    tracker.listingFor(policy, 'ann', [extra('policy', 'oppose', 'clear')])
    expect(tracker.recordFor(policy, 'ann').map((e) => e.act.id)).toEqual(['speech'])
  })
})

describe('related questions', () => {
  const full = question('full')
  const step = question('step')
  const laterStep = question('later-step')
  const near = question('near')
  const tracker = track({
    questions: [full, step, laterStep, near],
    questionRelations: [relation('full', 'near', 'related'), relation('full', 'later-step', 'smaller_step', 2), relation('full', 'step', 'smaller_step', 1), relation('full', 'gone', 'smaller_step'), relation('near', 'step', 'related')],
  })
  const related = (q: typeof full) => tracker.relatedTo(q).map((r) => [r.question.id, r.kind])

  it('lists the smaller steps of a fuller proposal in their order, then its neighbours', () => {
    expect(related(full)).toEqual([
      ['step', 'smaller_step'],
      ['later-step', 'smaller_step'],
      ['near', 'related'],
    ])
  })

  it('names the fuller proposal from the side of the smaller step', () => {
    expect(related(laterStep)).toEqual([['full', 'fuller_proposal']])
    expect(related(step)).toEqual([
      ['full', 'fuller_proposal'],
      ['near', 'related'],
    ])
  })

  it('reads a related link the same way from either side', () => {
    expect(related(near)).toEqual([
      ['step', 'related'],
      ['full', 'related'],
    ])
  })

  it('is empty for a question with no links', () => {
    expect(tracker.relatedTo(question('alone'))).toEqual([])
  })
})

describe('a seat or office whose holder is not settled', () => {
  const policy = question('policy')
  const ask = question('ask', { parent_id: 'policy' })
  const TERM = '2027-01-03'
  const rows = {
    deciders: [decider('holder'), decider('leader'), decider('a'), decider('b'), decider('chair')],
    seats: [seat('recount'), seat('runoff'), seat('safe')],
    roles: [
      role('recount', 'holder', { ends_on: TERM }),
      role('recount', 'holder', { id: 'again', starts_on: TERM, certainty: 'possible' }),
      role('recount', 'leader', { starts_on: TERM, certainty: 'likely' }),
      role('runoff', 'a', { starts_on: TERM, certainty: 'possible' }),
      role('runoff', 'b', { starts_on: TERM, certainty: 'possible' }),
      role('safe', 'chair'),
    ],
    questions: [policy, ask],
    offices: [office('gavel', { label: 'Chair' })],
    officeHolders: [holder('gavel', 'chair', TERM, null, 'likely')],
    questionOffices: [{ id: 'ask:gavel', question_id: 'ask', office_id: 'gavel' }],
  }
  const seatOf = (t: ReturnType<typeof track>, id: string) => t.board(policy).find((r) => r.seat.id === id)!
  const now = track(rows)
  const next = track(rows, '2027-01-31')

  it('is certain today', () => {
    expect([seatOf(now, 'recount').incumbent?.decider.id, seatOf(now, 'recount').incumbent?.role.certainty, seatOf(now, 'recount').alternates.length]).toEqual(['holder', 'certain', 0])
  })

  it('shows whoever is likely as the holder, with the others who may hold it beside them', () => {
    const seat = seatOf(next, 'recount')
    expect([seat.incumbent?.decider.id, seat.incumbent?.role.certainty]).toEqual(['leader', 'likely'])
    expect(seat.alternates.map((a) => a.decider.id)).toEqual(['holder'])
  })

  it('shows nobody as the holder when everyone is only possible', () => {
    const seat = seatOf(next, 'runoff')
    expect(seat.incumbent).toBeUndefined()
    expect(seat.alternates.map((a) => a.decider.id)).toEqual(['a', 'b'])
  })

  it('carries how sure an office holder is onto the ask put to them', () => {
    expect(next.keyPeople(policy).map((k) => [k.contender.decider.id, k.certainty])).toEqual([['chair', 'likely']])
  })

  it("finds someone's surest seat first", () => {
    expect(next.roleIn(policy, 'holder')?.certainty).toBe('possible')
    expect(now.roleIn(policy, 'holder')?.certainty).toBe('certain')
  })
})

describe('one kind of claim on a seat', () => {
  const policy = question('policy')
  const ELECTION = '2027-05-04'
  const rows = {
    deciders: [decider('sitting'), decider('running'), decider('elect')],
    seats: [seat('open'), seat('won')],
    roles: [
      role('open', 'sitting'),
      role('open', 'running', { starts_on: ELECTION, certainty: 'possible', contest: 'general' }),
      role('won', 'sitting', { id: 'won:sitting', ends_on: '2027-01-03' }),
      role('won', 'elect', { starts_on: '2027-01-03' }),
    ],
    questions: [policy],
    acts: [act('running-says', 'running')],
    reviews: [review('running-says', 'policy', 'support')],
  }
  const seatOf = (t: ReturnType<typeof track>, id: string) => t.board(policy).find((r) => r.seat.id === id)!
  const now = track(rows)

  it('lists a challenger and a member-elect the same way: as claims that start later', () => {
    expect(seatOf(now, 'open').upcoming.map((c) => [c.decider.id, c.role.certainty, c.standing])).toEqual([['running', 'possible', 'support']])
    expect(seatOf(now, 'won').upcoming.map((c) => [c.decider.id, c.role.certainty])).toEqual([['elect', 'certain']])
    expect(seatOf(now, 'open').incumbent?.decider.id).toBe('sitting')
  })

  it('turns a claim into the holding, or a possible one, once its day comes', () => {
    const later = track(rows, '2027-06-01')
    expect([seatOf(later, 'won').incumbent?.decider.id, seatOf(later, 'won').upcoming.length]).toEqual(['elect', 0])
    expect(seatOf(later, 'open').incumbent?.decider.id).toBe('sitting')
    expect(seatOf(later, 'open').alternates.map((c) => c.decider.id)).toEqual(['running'])
  })

  it('says where each claim stands in the same words whoever holds it', () => {
    const say = (r: Parameters<typeof claimLabel>[0], day = '2026-11-19') => [claimLabel(r, day), claimTag(r, day)]
    const claim = (over: object) => ({ starts_on: null, ends_on: null, certainty: 'certain' as const, contest: null, ...over })
    expect(say(claim({}))).toEqual(['holds the seat', 'now'])
    expect(say(claim({ ends_on: '2027-01-03' }))[0]).toBe('holds the seat until Jan 3, 2027')
    expect(say(claim({ starts_on: '2027-01-03' }))).toEqual(['takes the seat Jan 3, 2027', 'from Jan 3, 2027'])
    expect(say(claim({ starts_on: '2027-01-03', certainty: 'likely', contest: 'recount' }))).toEqual(['likely to take the seat Jan 3, 2027, recount pending', 'likely from Jan 3, 2027'])
    expect(say(claim({ starts_on: '2027-01-03', certainty: 'possible', contest: 'runoff' }))).toEqual(['may take the seat Jan 3, 2027, runoff pending', 'runoff'])
    expect(say(claim({ starts_on: '2027-05-04', certainty: 'possible', contest: 'general' }))).toEqual(['running in the general election', 'general election'])
    expect(say(claim({ ends_on: '2027-01-03' }), '2027-02-01')[0]).toBe('held the seat until Jan 3, 2027')
    expect(say(claim({ starts_on: '2027-05-04', ends_on: '2026-11-10', certainty: 'possible', contest: 'general' }))[0]).toBe('no longer in line for the seat since Nov 10, 2026')
  })

  it('lists a claim ended before its start only until the day it ended, and never as a holding', () => {
    const withdrawn = { ...rows, roles: rows.roles.map((r) => (r.decider_id === 'running' ? { ...r, ends_on: '2026-11-10' } : r)) }
    expect(seatOf(track(withdrawn, '2026-11-01'), 'open').upcoming.map((c) => c.decider.id)).toEqual(['running'])
    expect(seatOf(track(withdrawn), 'open').upcoming).toEqual([])
    expect(seatOf(track(withdrawn, '2027-06-01'), 'open').alternates).toEqual([])
  })
})

describe('readingsFrom', () => {
  const policy = question('policy')
  const bill = question('bill', { parent_id: 'policy', kind: 'formal_act', implies_on_parent: 'support' })
  const letter = question('letter', { parent_id: 'policy', kind: 'formal_act', implies_on_parent: 'oppose' })
  const questions = new Map([policy, bill, letter].map((q) => [q.id, q]))
  const tiers = reviewerTiers([
    { id: EDITORS_ID, role: 'editor', kind: 'person' },
    ...['a-reader', 'one', 'two', 'former-editor'].map((id) => ({ id, role: 'member' as const, kind: 'person' as const })),
    { id: 'news-reader', role: 'member', kind: 'agent' },
  ])
  const shown = (reviews: Parameters<typeof readingsFrom>[0]) => readingsFrom(reviews, questions, tiers).map((r) => [r.act_id, r.question_id, r.position, r.weight, r.via_question_id])

  it("counts a review in its author's tier now: an editor's role, then a person over an agent, and a reviewer with no row with the agents", () => {
    expect(shown([review('a', 'policy', 'support', 'clear', 'news-reader'), review('a', 'policy', 'oppose', 'clear', 'one')])).toEqual([['a', 'policy', 'oppose', 'clear', null]])
    expect(shown([review('a', 'policy', 'support', 'clear', 'nobody-on-file'), review('a', 'policy', 'oppose', 'clear', 'one')])).toEqual([['a', 'policy', 'oppose', 'clear', null]])
    expect(shown([review('a', 'policy', 'support', 'clear', 'nobody-on-file'), review('a', 'policy', 'oppose', 'clear', 'news-reader')])).toEqual([['a', 'policy', 'mixed', 'clear', null]])
    // A former editor is a member now, so their review counts as a person's.
    expect(shown([review('a', 'policy', 'support', 'clear', 'former-editor'), review('a', 'policy', 'oppose', 'clear', 'one')])).toEqual([['a', 'policy', 'mixed', 'clear', null]])
  })

  it("takes the editors' review over a reader's", () => {
    expect(shown([review('a', 'policy', 'support', 'clear', 'a-reader'), review('a', 'policy', 'oppose', 'passing')])).toEqual([['a', 'policy', 'oppose', 'passing', null]])
  })

  it('averages the reviews of people when no editor has reviewed the act', () => {
    expect(shown([review('a', 'policy', 'mixed', 'clear', 'one'), review('a', 'policy', 'oppose', 'clear', 'two')])).toEqual([['a', 'policy', 'lean_oppose', 'clear', null]])
  })

  it('implies on the parent what support on the sub-question means there, at the same weight', () => {
    expect(shown([review('a', 'bill', 'support', 'concrete')])).toEqual([
      ['a', 'bill', 'support', 'concrete', null],
      ['a', 'policy', 'support', 'concrete', 'bill'],
    ])
    expect(shown([review('a', 'letter', 'support', 'concrete')])).toContainEqual(['a', 'policy', 'oppose', 'concrete', 'letter'])
  })

  it('implies nothing for a passing review, or for anything but support', () => {
    expect(shown([review('a', 'bill', 'support', 'passing')])).toEqual([['a', 'bill', 'support', 'passing', null]])
    expect(shown([review('a', 'bill', 'mixed', 'concrete')])).toEqual([['a', 'bill', 'mixed', 'concrete', null]])
  })

  it('keeps a review made on the parent directly over what the sub-question implies, whichever comes first', () => {
    const onBill = review('a', 'bill', 'support', 'concrete')
    const onPolicy = review('a', 'policy', 'mixed', 'clear')
    for (const reviews of [[onBill, onPolicy], [onPolicy, onBill]]) {
      expect(shown(reviews)).toContainEqual(['a', 'policy', 'mixed', 'clear', null])
      expect(shown(reviews)).toHaveLength(2)
    }
  })

  it('leaves the parent mixed when two sub-questions imply opposite things there, in whatever order the reviews come', () => {
    const onBill = review('a', 'bill', 'support', 'concrete')
    const onLetter = review('a', 'letter', 'support', 'concrete')
    for (const reviews of [[onBill, onLetter], [onLetter, onBill]]) {
      expect(readingsFrom(reviews, questions, tiers).find((r) => r.question_id === 'policy')).toMatchObject({ position: 'mixed', via_question_id: 'bill' })
    }
  })

  it("implies on the parent from each reviewer's own review, so only a review of support says anything there", () => {
    const reviews = [review('a', 'bill', 'support', 'concrete', 'one'), review('a', 'bill', 'oppose', 'concrete', 'two')]
    expect(shown(reviews)).toEqual([
      ['a', 'bill', 'mixed', 'concrete', null],
      ['a', 'policy', 'support', 'concrete', 'bill'],
    ])
  })

  it("puts the editors' implied reading on the parent ahead of a person's review there", () => {
    expect(shown([review('a', 'bill', 'support', 'concrete'), review('a', 'policy', 'oppose', 'clear', 'a-reader')])).toContainEqual(['a', 'policy', 'support', 'concrete', 'bill'])
  })
})

describe('acts an editor found to be the same', () => {
  const policy = question('policy')
  const markup = question('markup', { parent_id: 'policy' })
  const same = (actId: string, sameAsId: string): SameAct => ({ act_id: actId, same_as_id: sameAsId, marked_by: EDITORS_ID, marked_at: '2026-11-25T00:00:00.000Z' })
  const rows = {
    deciders: [decider('ann'), decider('bob')],
    questions: [policy, markup],
    sources: [source('paper'), source('wire'), source('release')],
    acts: [act('feb-11', 'ann', { occurred_on: '2026-02-11' }), act('feb-11-again', 'ann', { occurred_on: '2026-02-12', primary_source_id: 'release' }), act('other', 'bob')],
    reports: [report('paper', 'feb-11'), report('paper', 'feb-11-again', { excerpt: 'As the paper put it.' }), report('wire', 'feb-11-again'), report('release', 'feb-11-again')],
    reviews: [review('feb-11', 'policy', 'support'), { ...review('feb-11-again', 'policy', 'lean_support'), updated_at: '2026-03-01T00:00:00.000Z' }, review('feb-11-again', 'markup', 'oppose')],
  }
  const marked = track({ ...rows, sameActs: [same('feb-11-again', 'feb-11')] })

  it('shows one entry with every source, the record of the act first', () => {
    const record = marked.recordFor(policy, 'ann')
    expect(record.map((e) => e.act.id)).toEqual(['feb-11'])
    expect(record[0].act.primary_source_id).toBe('release')
    expect(record[0].reports.map((r) => r.source.id)).toEqual(['release', 'paper', 'wire'])
  })

  it('keeps the words each source printed, and one report per source', () => {
    const words = marked.shownReports.filter((r) => r.act_id === 'feb-11').map((r) => [r.source_id, r.excerpt])
    expect(words.sort()).toEqual([
      ['paper', null],
      ['release', 'feb-11-again'],
      ['wire', 'feb-11-again'],
    ])
  })

  it("counts each reviewer's latest review of either act, and reads the other act's questions there too", () => {
    expect(marked.readings.filter((r) => r.act_id === 'feb-11').map((r) => [r.question_id, r.position]).sort()).toEqual([
      ['markup', 'oppose'],
      ['policy', 'lean_support'],
    ])
    expect(marked.readings.some((r) => r.act_id === 'feb-11-again')).toBe(false)
  })

  it('changes no row, and shows both acts again once the mark is taken away', () => {
    expect(marked.acts).toEqual(rows.acts)
    expect(marked.reviews).toEqual(rows.reviews)
    const apart = track(rows)
    expect(apart.recordFor(policy, 'ann').map((e) => e.act.id)).toEqual(['feb-11-again', 'feb-11'])
  })

  it('still finds the act shown as another, for a proposal that names it', () => {
    expect(marked.actById.get('feb-11-again')?.id).toBe('feb-11-again')
    expect(marked.shownAs('feb-11-again')).toBe('feb-11')
    expect(marked.actsByDecider.get('ann')?.map((a) => a.id)).toEqual(['feb-11'])
  })

  it('follows one act marked as another that is itself marked, and leaves a loop as it is', () => {
    const chain = asShown({ ...rows, acts: [...rows.acts, act('feb-11-third', 'ann')], sameActs: [same('feb-11-third', 'feb-11-again'), same('feb-11-again', 'feb-11')] })
    expect(chain.shownAs('feb-11-third')).toBe('feb-11')
    const loop = asShown({ ...rows, sameActs: [same('feb-11', 'feb-11-again'), same('feb-11-again', 'feb-11')] })
    expect([loop.shownAs('feb-11'), loop.shownAs('feb-11-again')]).toEqual(['feb-11', 'feb-11-again'])
  })
})
