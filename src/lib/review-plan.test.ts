import { describe, expect, it } from 'vitest'
import { EDITORS_ID, type Act, type ProposalItem, type Report, type Review, type SetPosition } from '../../shared/schema.ts'
import { planReview, type EntryVerdict, type PositionDecision, type Published, type Verdict, type Write } from './review-plan.ts'
import { act, item, proposal, question, report, review, setPosition, source } from './fixtures.ts'

const NOW = '2026-11-17T12:00:00.000Z'
const ids = () => {
  let n = 0
  return () => `new-${++n}`
}

const policy = question('policy')
const bill = question('bill', { parent_id: 'policy', kind: 'formal_act', implies_on_parent: 'support' })
const markup = question('markup', { parent_id: 'policy' })
const article = source('article', { title: 'As submitted' })
const pending = proposal('p1', 'article')

const published = (over: Partial<Published> = {}): Published => ({ questions: [policy, bill, markup], acts: [], reports: [], reviews: [], setPositions: [], ...over })

type Publish = Extract<EntryVerdict, { publish: true }>

// One act published as its items describe it: read on each item's question, as support unless the item says otherwise.
const publish = (items: ProposalItem[], over: Partial<Publish> = {}): EntryVerdict => ({
  decider_id: items[0].decider_id,
  items,
  note: null,
  publish: true,
  act_id: items[0].act_id,
  kind: 'says',
  occurred_on: '2026-11-10',
  quote: items[0].quote,
  passage: null,
  weight: 'clear',
  readings: items.map((i) => ({ question_id: i.question_id, reading: i.reading ?? 'support', item: i })),
  decision: null,
  ...over,
})
const dismiss = (items: ProposalItem[], note: string | null = null): EntryVerdict => ({ decider_id: items[0].decider_id, items, note, publish: false })
const verdict = (entries: EntryVerdict[], review_note: string | null = null): Verdict => ({ review_note, entries })
const plan = (v: Verdict, onFile: Published = published()) => planReview(onFile, pending, article, v, EDITORS_ID, NOW, ids())

const rowsOf = <T>(writes: Write[], on: Write['on']) => writes.filter((w) => w.on === on && w.type === 'insert').map((w) => (w as unknown as { row: T }).row)
const updatesOf = (writes: Write[], on: Write['on']) => writes.filter((w) => w.on === on && w.type === 'update').map((w) => w as { id: string; changes: Record<string, unknown> })
const notesOf = (writes: Write[]) => rowsOf<{ proposal_item_id: string | null; body: string }>(writes, 'proposal_notes').map((n) => [n.proposal_item_id, n.body])
const writesOn = (writes: Write[], table: Write['on']) => writes.filter((w) => w.on === table)

describe('planReview', () => {
  it('publishes several entries from one article in a single plan, recording who reviewed it', () => {
    const ann = item('i1', 'p1', 'ann', 'policy')
    const bob = item('i2', 'p1', 'bob', 'policy', { sort: 1, reading: 'oppose' })
    const cy = item('i3', 'p1', 'cy', 'policy', { sort: 2 })
    const writes = plan(verdict([publish([ann]), publish([bob]), dismiss([cy], 'Not in the article.')], 'Read in full.'))

    expect(rowsOf<Act>(writes, 'acts').map((a) => [a.id, a.decider_id, a.kind, a.occurred_on, a.body, a.created_at])).toEqual([
      ['act-of-i1', 'ann', 'says', '2026-11-10', 'words of i1', NOW],
      ['act-of-i2', 'bob', 'says', '2026-11-10', 'words of i2', NOW],
    ])
    expect(rowsOf<Report>(writes, 'reports').map((r) => [r.source_id, r.act_id, r.excerpt, r.created_at])).toEqual([
      ['article', 'act-of-i1', null, NOW],
      ['article', 'act-of-i2', null, NOW],
    ])
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.act_id, r.question_id, r.position, r.weight])).toEqual([
      ['act-of-i1', 'policy', 'support', 'clear'],
      ['act-of-i2', 'policy', 'oppose', 'clear'],
    ])
    expect(updatesOf(writes, 'proposal_items').map((u) => [u.id, u.changes.status])).toEqual([
      ['i1', 'accepted'],
      ['i2', 'accepted'],
      ['i3', 'rejected'],
    ])
    expect(updatesOf(writes, 'proposals')).toEqual([{ on: 'proposals', type: 'update', id: 'p1', changes: { status: 'reviewed', reviewed_at: NOW, reviewed_by: EDITORS_ID } }])
    expect(notesOf(writes)).toEqual([
      ['i3', 'Not in the article.'],
      [null, 'Read in full.'],
    ])
  })

  it('writes no position for anyone and leaves the source as it is', () => {
    const writes = plan(verdict([publish([item('i1', 'p1', 'ann', 'policy')])]))
    expect(writesOn(writes, 'set_positions')).toEqual([])
    expect(writesOn(writes, 'sources')).toEqual([])
  })

  it('writes every table after the ones its rows point at', () => {
    const entry = publish([item('i1', 'p1', 'ann', 'bill')], { decision: { question_id: 'bill', action: 'set', position: 'support', reason: 'Said so on the floor.' } })
    const order = [...new Set(plan(verdict([entry], 'x')).map((w) => w.on))]
    expect(order).toEqual(['acts', 'reports', 'reviews', 'set_positions', 'proposal_items', 'proposal_notes', 'proposals'])
  })

  it('writes one act, one report with its passage and two readings for an entry read on two questions', () => {
    const onMarkup = item('i1', 'p1', 'ann', 'markup', { act_id: 'shared' })
    const onPolicy = item('i2', 'p1', 'ann', 'policy', { act_id: 'shared', sort: 1, reading: 'oppose' })
    const writes = plan(verdict([publish([onMarkup, onPolicy], { passage: 'The paragraph the words sit in.' })]))
    expect(rowsOf<Act>(writes, 'acts').map((a) => a.id)).toEqual(['shared'])
    expect(rowsOf<Report>(writes, 'reports').map((r) => [r.source_id, r.act_id, r.passage])).toEqual([['article', 'shared', 'The paragraph the words sit in.']])
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.act_id, r.question_id, r.position])).toEqual([
      ['shared', 'markup', 'support'],
      ['shared', 'policy', 'oppose'],
    ])
    expect(updatesOf(writes, 'proposal_items').map((u) => [u.id, u.changes.status, u.changes.question_id, u.changes.reading])).toEqual([
      ['i1', 'accepted', 'markup', 'support'],
      ['i2', 'accepted', 'policy', 'oppose'],
    ])
  })

  it('writes onto each accepted item what the editor left in the form', () => {
    const lead = item('i1', 'p1', 'ann', 'policy')
    const entry = publish([lead], {
      act_id: 'chosen',
      kind: 'does',
      occurred_on: '2026-11-03',
      quote: 'Voted for it.',
      passage: 'On Tuesday she voted for it.',
      weight: 'concrete',
      readings: [{ question_id: 'markup', reading: 'lean_support', item: lead }],
    })
    expect(updatesOf(plan(verdict([entry])), 'proposal_items')).toEqual([
      {
        on: 'proposal_items',
        type: 'update',
        id: 'i1',
        changes: { act_id: 'chosen', kind: 'does', occurred_on: '2026-11-03', quote: 'Voted for it.', passage: 'On Tuesday she voted for it.', weight: 'concrete', status: 'accepted', question_id: 'markup', reading: 'lean_support' },
      },
    ])
  })

  it('inserts an accepted item for a reading added in the form', () => {
    const lead = item('i1', 'p1', 'ann', 'policy', { sort: 4 })
    const entry = publish([lead], {
      passage: 'The paragraph.',
      readings: [
        { question_id: 'policy', reading: 'support', item: lead },
        { question_id: 'markup', reading: 'lean_support', item: null },
      ],
    })
    const writes = plan(verdict([entry]))
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.question_id, r.position])).toEqual([
      ['policy', 'support'],
      ['markup', 'lean_support'],
    ])
    expect(rowsOf<ProposalItem>(writes, 'proposal_items')).toEqual([
      {
        id: expect.stringMatching(/^new-/),
        proposal_id: 'p1',
        sort: 5,
        decider_id: 'ann',
        question_id: 'markup',
        act_id: 'act-of-i1',
        kind: 'says',
        occurred_on: '2026-11-10',
        quote: 'words of i1',
        passage: 'The paragraph.',
        reading: 'lean_support',
        weight: 'clear',
        status: 'accepted',
      },
    ])
  })

  it('publishes an entry the editor added, which has no item, and numbers its items after the proposal’s', () => {
    const lead = item('i1', 'p1', 'ann', 'policy', { sort: 2 })
    const added: EntryVerdict = {
      decider_id: 'bob',
      items: [],
      note: 'Named in the third paragraph.',
      publish: true,
      act_id: 'bob-act',
      kind: 'says',
      occurred_on: '2026-11-10',
      quote: 'Bob said no.',
      passage: null,
      weight: 'clear',
      readings: [
        { question_id: 'policy', reading: 'oppose', item: null },
        { question_id: 'markup', reading: 'oppose', item: null },
      ],
      decision: null,
    }
    const writes = plan(verdict([publish([lead]), added]))
    expect(rowsOf<Act>(writes, 'acts').map((a) => [a.id, a.decider_id, a.body])).toEqual([
      ['act-of-i1', 'ann', 'words of i1'],
      ['bob-act', 'bob', 'Bob said no.'],
    ])
    const inserted = rowsOf<ProposalItem>(writes, 'proposal_items')
    expect(inserted.map((i) => [i.decider_id, i.question_id, i.act_id, i.sort, i.status])).toEqual([
      ['bob', 'policy', 'bob-act', 3, 'accepted'],
      ['bob', 'markup', 'bob-act', 4, 'accepted'],
    ])
    expect(notesOf(writes)).toEqual([[inserted[0].id, 'Named in the third paragraph.']])
  })

  it('rejects an item whose reading the editor took off the entry', () => {
    const onPolicy = item('i1', 'p1', 'ann', 'policy', { act_id: 'shared' })
    const onMarkup = item('i2', 'p1', 'ann', 'markup', { act_id: 'shared', sort: 1 })
    const writes = plan(verdict([publish([onPolicy, onMarkup], { readings: [{ question_id: 'policy', reading: 'support', item: onPolicy }] })]))
    expect(rowsOf<Review>(writes, 'reviews').map((r) => r.question_id)).toEqual(['policy'])
    expect(updatesOf(writes, 'proposal_items').map((u) => [u.id, u.changes.status])).toEqual([
      ['i1', 'accepted'],
      ['i2', 'rejected'],
    ])
  })

  it('puts the note on a published entry on its first item', () => {
    const first = item('i1', 'p1', 'ann', 'policy', { act_id: 'shared' })
    const second = item('i2', 'p1', 'ann', 'markup', { act_id: 'shared', sort: 1 })
    expect(notesOf(plan(verdict([publish([first, second], { note: 'Checked against the video.' })])))).toEqual([['i1', 'Checked against the video.']])
  })

  it('refuses to publish an entry with no reading, or one read on a question that is not on file', () => {
    const lead = item('i1', 'p1', 'ann', 'policy')
    expect(() => plan(verdict([publish([lead], { readings: [] })]))).toThrow(/at least one question/)
    expect(() => plan(verdict([publish([lead], { readings: [{ question_id: 'gone', reading: 'support', item: lead }] })]))).toThrow(/Unknown question gone/)
  })

  it("publishes each reading as the editors' review, starting from nobody else's", () => {
    const writes = plan(verdict([publish([item('i1', 'p1', 'ann', 'policy')])]))
    expect(rowsOf<Review>(writes, 'reviews')).toEqual([
      { id: expect.any(String), reviewer_id: EDITORS_ID, act_id: 'act-of-i1', question_id: 'policy', position: 'support', weight: 'clear', based_on: null, created_at: NOW, updated_at: NOW },
    ])
  })

  it('writes nothing on the parent, which works out what a sub-question implies from the review there', () => {
    const writes = plan(verdict([publish([item('i1', 'p1', 'ann', 'bill')], { kind: 'commits', weight: 'concrete' })]))
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.question_id, r.position, r.weight])).toEqual([['bill', 'support', 'concrete']])
    expect(rowsOf<ProposalItem>(writes, 'proposal_items')).toEqual([])
  })

  it("adds the editors' review beside a review by someone else, and leaves theirs as it is", () => {
    const onFile = published({ acts: [act('feb-11', 'ann')], reviews: [review('feb-11', 'policy', 'oppose', 'clear', 'a-reader')] })
    const writes = plan(verdict([publish([item('i1', 'p1', 'ann', 'policy')], { act_id: 'feb-11' })]), onFile)
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.reviewer_id, r.position])).toEqual([[EDITORS_ID, 'support']])
    expect(updatesOf(writes, 'reviews')).toEqual([])
  })

  it('adds a report to an act already on file instead of a second act', () => {
    const onFile = published({
      acts: [act('feb-11', 'ann')],
      reports: [report('release', 'feb-11')],
      reviews: [review('feb-11', 'policy', 'lean_support')],
    })
    const entry = publish([item('i1', 'p1', 'ann', 'policy')], { act_id: 'feb-11', quote: 'As the paper words it.', passage: 'The paragraph in the paper.' })
    const writes = plan(verdict([entry]), onFile)
    expect(rowsOf<Act>(writes, 'acts')).toEqual([])
    expect(rowsOf<Report>(writes, 'reports').map((r) => [r.source_id, r.act_id, r.excerpt, r.passage])).toEqual([['article', 'feb-11', 'As the paper words it.', 'The paragraph in the paper.']])
    expect(rowsOf<Review>(writes, 'reviews')).toEqual([])
    expect(updatesOf(writes, 'reviews')).toEqual([{ on: 'reviews', type: 'update', id: 'editors:feb-11@policy', changes: { position: 'support', weight: 'clear', updated_at: NOW } }])
    expect(updatesOf(writes, 'proposal_items')[0].changes.act_id).toBe('feb-11')
    expect(onFile.reviews[0].position).toBe('lean_support')
  })

  it('writes no second report from the same source, and leaves a reading that has not changed', () => {
    const onFile = published({ acts: [act('feb-11', 'ann')], reports: [report('article', 'feb-11')], reviews: [review('feb-11', 'policy', 'support')] })
    const writes = plan(verdict([publish([item('i1', 'p1', 'ann', 'policy')], { act_id: 'feb-11' })]), onFile)
    expect(writesOn(writes, 'reports')).toEqual([])
    expect(writesOn(writes, 'reviews')).toEqual([])
  })

  it('changes the weight of a reading on file when the editor reads the act again', () => {
    const onFile = published({ acts: [act('feb-11', 'ann')], reviews: [review('feb-11', 'policy', 'support', 'passing')] })
    const writes = plan(verdict([publish([item('i1', 'p1', 'ann', 'policy')], { act_id: 'feb-11' })]), onFile)
    expect(updatesOf(writes, 'reviews')).toEqual([{ on: 'reviews', type: 'update', id: 'editors:feb-11@policy', changes: { position: 'support', weight: 'clear', updated_at: NOW } }])
  })

  it('rejects a whole proposal without publishing anything', () => {
    const writes = plan(verdict([dismiss([item('i1', 'p1', 'ann', 'policy')])], 'Spam.'))
    expect(writes.map((w) => `${w.type} ${w.on}`)).toEqual(['update proposal_items', 'insert proposal_notes', 'update proposals'])
  })

  it('rejects every item of a dismissed entry and puts its note on the first', () => {
    const first = item('i1', 'p1', 'ann', 'policy', { act_id: 'shared' })
    const second = item('i2', 'p1', 'ann', 'markup', { act_id: 'shared', sort: 1 })
    const writes = plan(verdict([dismiss([first, second], 'A paraphrase.')]))
    expect(updatesOf(writes, 'proposal_items').map((u) => [u.id, u.changes])).toEqual([
      ['i1', { status: 'rejected' }],
      ['i2', { status: 'rejected' }],
    ])
    expect(notesOf(writes)).toEqual([['i1', 'A paraphrase.']])
  })
})

describe('planReview and the source’s publish date', () => {
  const ann = () => item('i1', 'p1', 'ann', 'policy')

  it('writes the date an editor set on the card, first, as an editor’s', () => {
    const writes = plan({ ...verdict([publish([ann()])]), published_on: '2018-07-19' })
    expect(writes[0]).toEqual({ on: 'sources', type: 'update', id: 'article', changes: { published_on: '2018-07-19', published_on_from: 'editor' } })
  })

  it('writes an editor’s word that the date is not known, so no automated date replaces it', () => {
    const dated = source('article', { published_on: '2018-07-19', published_on_from: 'page' })
    const writes = planReview(published(), pending, dated, { ...verdict([dismiss([ann()])]), published_on: null }, EDITORS_ID, NOW, ids())
    expect(updatesOf(writes, 'sources')).toEqual([{ on: 'sources', type: 'update', id: 'article', changes: { published_on: null, published_on_from: 'editor' } }])
  })

  it('refuses a date ahead of today or before the web, and writes nothing', () => {
    expect(() => plan({ ...verdict([publish([ann()])]), published_on: '2062-07-19' })).toThrow('The publish date has to be a day from 1991-01-01 to today.')
    expect(() => plan({ ...verdict([publish([ann()])]), published_on: '0201-07-19' })).toThrow()
    expect(() => plan({ ...verdict([publish([ann()])]), published_on: '2018-02-30' })).toThrow()
  })

  it('confirms a page date the editor kept as their own, and writes nothing for a date they did not touch', () => {
    const dated = source('article', { published_on: '2018-07-19', published_on_from: 'page' })
    expect(updatesOf(planReview(published(), pending, dated, { ...verdict([publish([ann()])]), published_on: '2018-07-19' }, EDITORS_ID, NOW, ids()), 'sources')).toHaveLength(1)
    expect(writesOn(planReview(published(), pending, dated, verdict([publish([ann()])]), EDITORS_ID, NOW, ids()), 'sources')).toEqual([])
    const theirs = source('article', { published_on: '2018-07-19', published_on_from: 'editor' })
    expect(writesOn(planReview(published(), pending, theirs, { ...verdict([publish([ann()])]), published_on: '2018-07-19' }, EDITORS_ID, NOW, ids()), 'sources')).toEqual([])
  })
})

describe('planReview with a decision about a set position', () => {
  const lead = item('i1', 'p1', 'ann', 'policy', { reading: 'oppose' })
  const held = setPosition('policy', 'ann', 'support', 'Promised it at the convention.')
  const decide = (decision: PositionDecision, setPositions: SetPosition[] = [held]) => plan(verdict([publish([lead], { decision })]), published({ setPositions }))

  it('sets a position where there was none, with its reason and the time', () => {
    const writes = decide({ question_id: 'policy', action: 'set', position: 'lean_oppose', reason: 'Told the caucus she will vote no.' }, [])
    expect(writesOn(writes, 'set_positions')).toEqual([
      {
        on: 'set_positions',
        type: 'insert',
        row: { id: 'policy:ann', question_id: 'policy', decider_id: 'ann', position: 'lean_oppose', reason: 'Told the caucus she will vote no.', set_at: NOW },
      },
    ])
    expect(notesOf(writes)).toEqual([])
  })

  it('changes a position already set instead of adding a second one', () => {
    const writes = decide({ question_id: 'policy', action: 'set', position: 'lean_oppose', reason: 'Told the caucus she will vote no.' })
    expect(writesOn(writes, 'set_positions')).toEqual([
      { on: 'set_positions', type: 'update', id: 'policy:ann', changes: { position: 'lean_oppose', reason: 'Told the caucus she will vote no.', set_at: NOW } },
    ])
  })

  it('sets it for the person the entry is about, on the question the decision names', () => {
    const entry = publish([lead], { decision: { question_id: 'markup', action: 'set', position: 'mixed', reason: 'Both ways in one week.' } })
    expect(rowsOf<SetPosition>(plan(verdict([entry])), 'set_positions').map((s) => [s.id, s.question_id, s.decider_id])).toEqual([['markup:ann', 'markup', 'ann']])
  })

  it('writes nothing to keep a set position as it is', () => {
    expect(writesOn(decide({ question_id: 'policy', action: 'keep', reason: null }), 'set_positions')).toEqual([])
  })

  it('rewords the reason of a kept position and leaves the position alone', () => {
    const writes = decide({ question_id: 'policy', action: 'keep', reason: 'Promised it again after the vote.' })
    expect(writesOn(writes, 'set_positions')).toEqual([{ on: 'set_positions', type: 'update', id: 'policy:ann', changes: { reason: 'Promised it again after the vote.' } }])
  })

  it('writes nothing to keep or lift a position that is not set', () => {
    const decisions: PositionDecision[] = [
      { question_id: 'policy', action: 'keep', reason: 'A reason with nothing to go on.' },
      { question_id: 'policy', action: 'lift', note: 'Nothing to lift.' },
    ]
    for (const decision of decisions) {
      const writes = decide(decision, [])
      expect(writesOn(writes, 'set_positions')).toEqual([])
      expect(notesOf(writes)).toEqual([])
    }
  })

  it('deletes a lifted position and says so in a note only editors read', () => {
    const writes = decide({ question_id: 'policy', action: 'lift', note: 'The vote settles it.' })
    expect(writesOn(writes, 'set_positions')).toEqual([{ on: 'set_positions', type: 'delete', id: 'policy:ann' }])
    expect(rowsOf<{ proposal_id: string; proposal_item_id: string | null; kind: string; body: string }>(writes, 'proposal_notes')).toMatchObject([
      { proposal_id: 'p1', proposal_item_id: 'i1', kind: 'review', body: 'Lifted the position set by editors. The vote settles it.' },
    ])
  })

  it('notes a lift that was given no reason', () => {
    expect(notesOf(decide({ question_id: 'policy', action: 'lift', note: null }))).toEqual([['i1', 'Lifted the position set by editors.']])
  })

  it('publishes the entry whatever was decided', () => {
    const decisions: PositionDecision[] = [
      { question_id: 'policy', action: 'set', position: 'oppose', reason: 'Said so twice.' },
      { question_id: 'policy', action: 'keep', reason: null },
      { question_id: 'policy', action: 'lift', note: null },
    ]
    for (const decision of decisions) {
      expect(rowsOf<Review>(decide(decision), 'reviews').map((r) => [r.question_id, r.position])).toEqual([['policy', 'oppose']])
    }
  })
})
