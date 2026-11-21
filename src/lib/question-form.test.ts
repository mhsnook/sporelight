import { describe, expect, it } from 'vitest'
import { chooseSlug, inputOf, newQuestionRows, questionEdits, questionInserts, questionProblems, readQuestionForm, relatedQuestionRows, type QuestionInput } from './question-form.ts'
import { link, question, relation } from './fixtures.ts'

const ids = () => {
  let n = 0
  return () => `new-${++n}`
}

const form = (fields: [string, string][]) => {
  const f = new FormData()
  for (const [k, v] of fields) f.append(k, v)
  return f
}

const filled = (over: Partial<QuestionInput> = {}): QuestionInput => ({ ...inputOf(null), title: 'Should the pier reopen?', short_title: 'Pier', ...over })

describe('readQuestionForm', () => {
  it('trims text, leaves empty optional fields null and pairs each person with their role', () => {
    const input = readQuestionForm(
      form([
        ['title', '  Will they hold a hearing? '],
        ['short_title', ' Hearing '],
        ['description', '  '],
        ['kind', 'formal_act'],
        ['threshold', '38'],
        ['is_hot', 'on'],
        ['reference_url', ''],
        ['implies_on_parent', 'support'],
        ['also_body_id', 'board'],
        ['also_body_id', 'board'],
        ['decider_id', 'ann'],
        ['role_label', ' Chair '],
        ['decider_id', ''],
        ['role_label', 'ignored'],
        ['decider_id', 'bob'],
        ['role_label', ''],
        ['office_id', 'speaker'],
      ]),
    )
    expect(input).toMatchObject({
      title: 'Will they hold a hearing?',
      short_title: 'Hearing',
      description: null,
      kind: 'formal_act',
      threshold: 38,
      is_hot: true,
      reference_url: null,
      implies_on_parent: 'support',
      also_body_ids: ['board'],
      deciders: [
        { decider_id: 'ann', role_label: 'Chair' },
        { decider_id: 'bob', role_label: null },
      ],
      office_ids: ['speaker'],
    })
  })

  it('reads an unchecked box as false and an unknown direction as none', () => {
    expect(readQuestionForm(form([['implies_on_parent', 'sideways']]))).toMatchObject({ is_hot: false, implies_on_parent: null, kind: 'position', threshold: null })
  })
})

describe('questionProblems', () => {
  it('has nothing to say about a question with its title and short name', () => {
    expect(questionProblems(filled(), false)).toEqual([])
  })

  it('needs a short name an address can be made from', () => {
    expect(questionProblems(filled({ short_title: '—' }), false)).toEqual([expect.stringContaining('short name')])
  })

  it('refuses a threshold that is not a whole number of seats, and a link that is not a web address', () => {
    expect(questionProblems(filled({ threshold: 2.5, reference_url: 'javascript:alert(1)' }), false)).toHaveLength(2)
    expect(questionProblems(filled({ threshold: 0 }), false)).toHaveLength(1)
  })

  it('needs an ask to be put to someone, and to name each person once', () => {
    expect(questionProblems(filled(), true)).toEqual([expect.stringContaining('person or office')])
    expect(questionProblems(filled({ office_ids: ['chair'] }), true)).toEqual([])
    const twice = [{ decider_id: 'ann', role_label: null }, { decider_id: 'ann', role_label: 'Chair' }]
    expect(questionProblems(filled({ deciders: twice }), true)).toEqual([expect.stringContaining('twice')])
  })
})

describe('chooseSlug', () => {
  it('makes the address from the short name and steps past ones in use', () => {
    expect(chooseSlug('Medicare at 55', new Set())).toBe('medicare-at-55')
    expect(chooseSlug('Medicare at 55', new Set(['medicare-at-55', 'medicare-at-55-2']))).toBe('medicare-at-55-3')
  })

  it('puts a sub-question’s address under its parent’s', () => {
    expect(chooseSlug('H.R. 1', new Set(), question('m4a', { slug: 'medicare-for-all' }))).toBe('medicare-for-all-h-r-1')
  })
})

describe('newQuestionRows', () => {
  const main = question('m4a', { body_id: 'congress', sort: 3 })
  const existing = {
    questions: [main, question('other', { body_id: 'congress', sort: 7 }), question('elsewhere', { body_id: 'states', sort: 40 }), question('bill', { parent_id: 'm4a', sort: 2 })],
    questionRelations: [],
  }

  it('puts a new question last in its body, open, with its other bodies', () => {
    const rows = newQuestionRows(filled({ also_body_ids: ['states', 'congress'] }), { kind: 'question', body_id: 'congress' }, existing, ids())
    expect(rows.question).toMatchObject({ id: 'new-1', slug: 'pier', body_id: 'congress', parent_id: null, sort: 8, status: 'open', implies_on_parent: null })
    expect(rows.bodies).toEqual([{ id: 'new-2', question_id: 'new-1', body_id: 'states' }])
    expect(rows.relation).toBeNull()
  })

  it('makes a measure under its parent, closing on the day given', () => {
    const rows = newQuestionRows(filled({ kind: 'formal_act', act_label: 'Cosponsored', implies_on_parent: 'support', chamber: 'House', closes_on: '2027-01-03' }), { kind: 'measure', parent: main }, existing, ids())
    expect(rows.question).toMatchObject({ slug: 'm4a-pier', body_id: 'congress', parent_id: 'm4a', sort: 3, kind: 'formal_act', act_label: 'Cosponsored', implies_on_parent: 'support', chamber: 'House', status: 'lapsed', closed_on: '2027-01-03' })
    expect(rows.deciders).toEqual([])
  })

  it('puts an ask to the people and offices named, and to no one on a measure', () => {
    const input = filled({ deciders: [{ decider_id: 'ann', role_label: 'Chair' }], office_ids: ['speaker'], closes_on: '2027-01-03' })
    const ask = newQuestionRows(input, { kind: 'ask', parent: main }, existing, ids())
    expect(ask.deciders).toEqual([{ id: 'new-2', question_id: 'new-1', decider_id: 'ann', role_label: 'Chair' }])
    expect(ask.offices).toEqual([{ id: 'new-3', question_id: 'new-1', office_id: 'speaker' }])
    expect(ask.question.status).toBe('open')
    const measure = newQuestionRows(input, { kind: 'measure', parent: main }, existing, ids())
    expect([measure.deciders, measure.offices]).toEqual([[], []])
  })

  it('keeps a name for having done it only on a question about doing something', () => {
    expect(newQuestionRows(filled({ act_label: 'Signed' }), { kind: 'question', body_id: 'congress' }, existing, ids()).question.act_label).toBeNull()
  })

  it('inserts the question before the rows that point at it', () => {
    const rows = newQuestionRows(filled({ also_body_ids: ['states'], office_ids: ['speaker'] }), { kind: 'ask', parent: main }, existing, ids())
    expect(questionInserts(rows).map((w) => w.on)).toEqual(['questions', 'question_bodies', 'question_offices'])
  })
})

describe('relatedQuestionRows', () => {
  const main = question('m4a', { body_id: 'congress', short_title: 'Medicare for All', sort: 3, chamber: 'House' })
  const add = (taken: string[] = [], linked = [relation('m4a', 'kids', 'smaller_step', 4)]) =>
    relatedQuestionRows(
      main,
      [{ id: 'l1', question_id: 'm4a', body_id: 'senate' }, { id: 'l2', question_id: 'other', body_id: 'board' }],
      { questions: taken.map((slug) => question(slug)), questionRelations: linked },
      { short_title: ' Medicare at 55 ', title: 'Do they support lowering the age to 55? ', kind: 'smaller_step' },
      ids(),
    )

  it('makes an open position question of its own in the same body, put to the same other bodies', () => {
    const { question: made, bodies } = add()
    expect(made).toMatchObject({ id: 'new-1', slug: 'medicare-at-55', body_id: 'congress', parent_id: null, kind: 'position', short_title: 'Medicare at 55', title: 'Do they support lowering the age to 55?', status: 'open', sort: 3, chamber: 'House' })
    expect(bodies).toEqual([{ id: 'new-2', question_id: 'new-1', body_id: 'senate' }])
  })

  it('links it after the questions already linked', () => {
    expect(add().relation).toEqual({ id: 'new-3', question_id: 'm4a', related_id: 'new-1', kind: 'smaller_step', sort: 5 })
    expect(add([], []).relation?.sort).toBe(0)
  })

  it('gives it an address no other question has', () => {
    expect(add(['medicare-at-55', 'medicare-at-55-2']).question.slug).toBe('medicare-at-55-3')
  })
})

describe('questionEdits', () => {
  const ask = question('hearing', { parent_id: 'm4a', title: 'Will they hold a hearing?', short_title: 'Hearing', slug: 'm4a-hearing' })
  const links = { bodies: [{ id: 'b1', question_id: 'hearing', body_id: 'states' }], deciders: [link('hearing', 'ann', 'Chair'), link('hearing', 'bob')], offices: [] }

  it('changes only what the form changed, never the address, and nothing when nothing changed', () => {
    expect(questionEdits(ask, inputOf(ask, links), links, ids())).toEqual([])
    const writes = questionEdits(ask, { ...inputOf(ask, links), short_title: 'A hearing', threshold: 5 }, links, ids())
    expect(writes).toEqual([{ on: 'questions', type: 'update', id: 'hearing', changes: { short_title: 'A hearing', threshold: 5 } }])
  })

  it('adds and removes the other bodies, people and offices, and rewords a role in place', () => {
    const input = { ...inputOf(ask, links), also_body_ids: ['board'], deciders: [{ decider_id: 'ann', role_label: 'Ranking member' }, { decider_id: 'cy', role_label: null }], office_ids: ['speaker'] }
    expect(questionEdits(ask, input, links, ids())).toEqual([
      { on: 'question_bodies', type: 'delete', id: 'b1' },
      { on: 'question_bodies', type: 'insert', row: { id: 'new-1', question_id: 'hearing', body_id: 'board' } },
      { on: 'question_deciders', type: 'update', id: 'hearing:ann', changes: { role_label: 'Ranking member' } },
      { on: 'question_deciders', type: 'delete', id: 'hearing:bob' },
      { on: 'question_deciders', type: 'insert', row: { id: 'new-2', question_id: 'hearing', decider_id: 'cy', role_label: null } },
      { on: 'question_offices', type: 'insert', row: { id: 'new-3', question_id: 'hearing', office_id: 'speaker' } },
    ])
  })

  it('leaves alone a link to the body the question is listed under, which the form has no box for', () => {
    const own = { bodies: [{ id: 'own', question_id: 'hearing', body_id: ask.body_id }], deciders: links.deciders, offices: [] }
    expect(questionEdits(ask, { ...inputOf(ask, links), also_body_ids: [] }, own, ids())).toEqual([])
  })

  it('does not put a measure to anyone, and keeps what doing it implies off a top-level question', () => {
    const top = question('pier')
    const input = { ...inputOf(top), implies_on_parent: 'support' as const, deciders: [{ decider_id: 'ann', role_label: null }] }
    expect(questionEdits(top, input, { bodies: [], deciders: [], offices: [] }, ids())).toEqual([])
  })
})
