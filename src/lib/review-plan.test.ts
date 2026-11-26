import { describe, expect, it } from 'vitest'
import { EDITORS_ID, NEWS_READER_ID, type Act, type Direction, type ProposalItem, type Report, type Review, type SetPosition } from '../../shared/schema.ts'
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

// One act published on each of its items' questions, with the same reading on each.
const publish = (items: ProposalItem[], over: Partial<Publish> = {}, reading: Direction = 'support'): EntryVerdict => ({
  decider_id: items[0].decider_id,
  items,
  note: null,
  publish: true,
  act_id: items[0].act_id ?? `act-of-${items[0].id}`,
  kind: 'says',
  occurred_on: '2026-11-10',
  quote: `words of ${items[0].id}`,
  passage: null,
  weight: 'clear',
  readings: items.map((i) => ({ question_id: i.question_id, reading, item: i })),
  decision: null,
  ...over,
})

// What a proposal brings in: for each item, its act, its report in the article and the sender's review.
const cameIn = (items: ProposalItem[], over: Partial<Published> = {}): Published => {
  const acts = [...new Set(items.flatMap((i) => (i.act_id ? [i.act_id] : [])))].map((id) => act(id, items.find((i) => i.act_id === id)!.decider_id, { body: `words of ${items.find((i) => i.act_id === id)!.id}`, occurred_on: '2026-11-10' }))
  return published({
    acts,
    reports: acts.map((a) => report('article', a.id)),
    reviews: items.flatMap((i) => (i.act_id ? [review(i.act_id, i.question_id, 'support', 'clear', NEWS_READER_ID)] : [])),
    ...over,
  })
}
const dismiss = (items: ProposalItem[], note: string | null = null): EntryVerdict => ({ decider_id: items[0].decider_id, items, note, publish: false })
const verdict = (entries: EntryVerdict[], review_note: string | null = null): Verdict => ({ review_note, entries })
const plan = (v: Verdict, onFile: Published = published()) => planReview(onFile, pending, article, v, NOW, ids())

const rowsOf = <T>(writes: Write[], on: Write['on']) => writes.filter((w) => w.on === on && w.type === 'insert').map((w) => (w as unknown as { row: T }).row)
const updatesOf = (writes: Write[], on: Write['on']) => writes.filter((w) => w.on === on && w.type === 'update').map((w) => w as { id: string; changes: Record<string, unknown> })
const notesOf = (writes: Write[]) => rowsOf<{ proposal_item_id: string | null; body: string }>(writes, 'proposal_notes').map((n) => [n.proposal_item_id, n.body])
const writesOn = (writes: Write[], table: Write['on']) => writes.filter((w) => w.on === table)

describe('planReview', () => {
  const ann = item('i1', 'p1', 'ann', 'policy')
  const bob = item('i2', 'p1', 'bob', 'policy', { sort: 1 })

  it("publishes what came in as the editors' review of each act, and writes no act or report again", () => {
    const writes = plan(verdict([publish([ann]), publish([bob], {}, 'oppose')], 'Read in full.'), cameIn([ann, bob]))
    expect(writesOn(writes, 'acts')).toEqual([])
    expect(writesOn(writes, 'reports')).toEqual([])
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.reviewer_id, r.act_id, r.question_id, r.position, r.weight, r.created_at])).toEqual([
      [EDITORS_ID, 'act-of-i1', 'policy', 'support', 'clear', NOW],
      [EDITORS_ID, 'act-of-i2', 'policy', 'oppose', 'clear', NOW],
    ])
    expect(notesOf(writes)).toEqual([[null, 'Read in full.']])
    expect(writes.at(-1)).toEqual({ on: 'proposals', type: 'update', id: 'p1', changes: { status: 'reviewed', reviewed_at: NOW } })
  })

  it("leaves the sender's review as it is", () => {
    const writes = plan(verdict([publish([ann], {}, 'oppose')]), cameIn([ann]))
    expect(writesOn(writes, 'reviews')).toEqual([{ on: 'reviews', type: 'insert', row: expect.objectContaining({ reviewer_id: EDITORS_ID, position: 'oppose' }) }])
  })

  it("corrects the act's kind, date and words, and the passage, where the editor changed them, and writes nothing where they did not", () => {
    const onFile = cameIn([ann])
    expect(writesOn(plan(verdict([publish([ann])]), onFile), 'acts')).toEqual([])
    const corrected = plan(verdict([publish([ann], { kind: 'does', occurred_on: '2026-11-03', quote: 'Voted for it.', passage: 'In the vote, Ann voted for it.' })]), onFile)
    expect(updatesOf(corrected, 'acts')).toEqual([{ on: 'acts', type: 'update', id: 'act-of-i1', changes: { kind: 'does', occurred_on: '2026-11-03', body: 'Voted for it.' } }])
    expect(updatesOf(corrected, 'reports')).toEqual([{ on: 'reports', type: 'update', id: 'article>act-of-i1', changes: { passage: 'In the vote, Ann voted for it.' } }])
  })

  it('keeps an act undated when the editor leaves the date empty', () => {
    const onFile = cameIn([ann], { acts: [act('act-of-i1', 'ann', { body: 'words of i1', occurred_on: null })] })
    expect(writesOn(plan(verdict([publish([ann], { occurred_on: '' })]), onFile), 'acts')).toEqual([])
  })

  it("says the act says nothing on a question the editor took off it, in the editors' review", () => {
    const onMarkup = item('i3', 'p1', 'ann', 'markup', { act_id: 'act-of-i1', sort: 1 })
    const writes = plan(verdict([publish([ann, onMarkup], { readings: [{ question_id: 'policy', reading: 'support', item: ann }] })]), cameIn([ann, onMarkup]))
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.question_id, r.position, r.weight])).toEqual([
      ['policy', 'support', 'clear'],
      ['markup', null, null],
    ])
  })

  it("dismisses an entry with the editors' review that its act says nothing on each of its questions, and puts its note on the first item", () => {
    const writes = plan(verdict([dismiss([ann], 'Not in the article.')]), cameIn([ann]))
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.reviewer_id, r.act_id, r.question_id, r.position])).toEqual([[EDITORS_ID, 'act-of-i1', 'policy', null]])
    expect(notesOf(writes)).toEqual([['i1', 'Not in the article.']])
  })

  it('writes nothing for a dismissed lead but the proposal, since a lead put no act forward', () => {
    const lead = item('lead', 'p1', 'ann', 'policy', { act_id: null, excerpt: 'Ann was named.' })
    expect(plan(verdict([dismiss([lead])])).map((w) => w.on)).toEqual(['proposals'])
  })

  it("links a reading added in the form to the proposal, with the editors' review", () => {
    const writes = plan(verdict([publish([ann], { readings: [{ question_id: 'policy', reading: 'support', item: ann }, { question_id: 'markup', reading: 'mixed', item: null }] })]), cameIn([ann]))
    expect(rowsOf<ProposalItem>(writes, 'proposal_items')).toEqual([{ id: expect.any(String), proposal_id: 'p1', sort: 1, decider_id: 'ann', question_id: 'markup', act_id: 'act-of-i1', excerpt: null }])
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.question_id, r.position])).toEqual([
      ['policy', 'support'],
      ['markup', 'mixed'],
    ])
  })

  it('writes the act and report of a lead the editor publishes, and points its item at the act', () => {
    const lead = item('lead', 'p1', 'ann', 'policy', { act_id: null, excerpt: 'Ann was named.' })
    const writes = plan(verdict([publish([lead], { act_id: 'typed', quote: 'I am for it.', occurred_on: '' })]))
    expect(rowsOf<Act>(writes, 'acts').map((a) => [a.id, a.body, a.occurred_on])).toEqual([['typed', 'I am for it.', null]])
    expect(rowsOf<Report>(writes, 'reports').map((r) => [r.source_id, r.act_id, r.excerpt])).toEqual([['article', 'typed', null]])
    expect(updatesOf(writes, 'proposal_items')).toEqual([{ on: 'proposal_items', type: 'update', id: 'lead', changes: { act_id: 'typed', excerpt: null } }])
  })

  it('publishes an entry the editor added, which has no item, and numbers its item after the proposal’s', () => {
    const added: EntryVerdict = { ...(publish([ann]) as Publish), decider_id: 'cy', items: [], act_id: 'added', readings: [{ question_id: 'policy', reading: 'oppose', item: null }] }
    const writes = plan(verdict([publish([ann]), added]), cameIn([ann]))
    expect(rowsOf<Act>(writes, 'acts').map((a) => [a.id, a.decider_id])).toEqual([['added', 'cy']])
    expect(rowsOf<ProposalItem>(writes, 'proposal_items').map((i) => [i.decider_id, i.act_id, i.sort])).toEqual([['cy', 'added', 1]])
  })

  it('marks the act that came in as the same as an act already on the record, and reviews that one', () => {
    const onFile = cameIn([ann], { acts: [...cameIn([ann]).acts, act('feb-11', 'ann')], reports: [...cameIn([ann]).reports, report('release', 'feb-11')] })
    const writes = plan(verdict([publish([ann], { act_id: 'feb-11' })]), onFile)
    expect(writesOn(writes, 'same_acts')).toEqual([{ on: 'same_acts', type: 'insert', row: { act_id: 'act-of-i1', same_as_id: 'feb-11', marked_by: EDITORS_ID, marked_at: NOW } }])
    expect(writesOn(writes, 'acts')).toEqual([])
    expect(writesOn(writes, 'reports')).toEqual([])
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.act_id, r.question_id])).toEqual([['feb-11', 'policy']])
  })

  it('says nothing on a question left off, on the act that came in, when it is marked as an act already on the record', () => {
    const onMarkup = item('i3', 'p1', 'ann', 'markup', { act_id: 'act-of-i1', sort: 1 })
    const onFile = cameIn([ann, onMarkup], { acts: [...cameIn([ann]).acts, act('feb-11', 'ann')] })
    const writes = plan(verdict([publish([ann, onMarkup], { act_id: 'feb-11', readings: [{ question_id: 'policy', reading: 'support', item: ann }] })]), onFile)
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.act_id, r.question_id, r.position])).toEqual([
      ['feb-11', 'policy', 'support'],
      ['act-of-i1', 'markup', null],
    ])
  })

  it('adds a report to an act already on file for a lead the editor finds on the record, in this source’s words', () => {
    const lead = item('lead', 'p1', 'ann', 'policy', { act_id: null })
    const writes = plan(verdict([publish([lead], { act_id: 'feb-11', quote: 'As the paper words it.' })]), published({ acts: [act('feb-11', 'ann')] }))
    expect(writesOn(writes, 'acts')).toEqual([])
    expect(rowsOf<Report>(writes, 'reports').map((r) => [r.act_id, r.excerpt])).toEqual([['feb-11', 'As the paper words it.']])
  })

  it("adds the editors' review beside a review by someone else, and changes only the editors' own after", () => {
    const first = plan(verdict([publish([ann])]), cameIn([ann]))
    expect(rowsOf<Review>(first, 'reviews').map((r) => r.reviewer_id)).toEqual([EDITORS_ID])
    const again = plan(verdict([publish([ann], { weight: 'passing' })]), cameIn([ann], { reviews: [review('act-of-i1', 'policy', 'support', 'clear', NEWS_READER_ID), review('act-of-i1', 'policy', 'support', 'clear')] }))
    expect(updatesOf(again, 'reviews')).toEqual([{ on: 'reviews', type: 'update', id: 'editors:act-of-i1@policy', changes: { position: 'support', weight: 'passing', updated_at: NOW } }])
    expect(writesOn(plan(verdict([publish([ann])]), cameIn([ann], { reviews: [review('act-of-i1', 'policy', 'support', 'clear')] })), 'reviews')).toEqual([])
  })

  it('writes nothing on the parent, which works out what a sub-question implies from the review there', () => {
    const onBill = item('i1', 'p1', 'ann', 'bill')
    const writes = plan(verdict([publish([onBill], { kind: 'commits', weight: 'concrete' })]), cameIn([onBill]))
    expect(rowsOf<Review>(writes, 'reviews').map((r) => [r.question_id, r.position, r.weight])).toEqual([['bill', 'support', 'concrete']])
  })

  it('writes every table after the ones its rows point at', () => {
    const entry = publish([item('i1', 'p1', 'ann', 'bill', { act_id: null })], { act_id: 'new', decision: { question_id: 'bill', action: 'set', position: 'support', reason: 'Said so on the floor.' } })
    const order = [...new Set(plan(verdict([entry], 'x')).map((w) => w.on))]
    expect(order).toEqual(['acts', 'reports', 'reviews', 'set_positions', 'proposal_items', 'proposal_notes', 'proposals'])
  })

  it('refuses to publish an entry with no reading, or one read on a question that is not on file', () => {
    expect(() => plan(verdict([publish([ann], { readings: [] })]), cameIn([ann]))).toThrow(/at least one question/)
    expect(() => plan(verdict([publish([ann], { readings: [{ question_id: 'gone', reading: 'support', item: ann }] })]), cameIn([ann]))).toThrow(/Unknown question gone/)
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
    const writes = planReview(published(), pending, dated, { ...verdict([dismiss([ann()])]), published_on: null }, NOW, ids())
    expect(updatesOf(writes, 'sources')).toEqual([{ on: 'sources', type: 'update', id: 'article', changes: { published_on: null, published_on_from: 'editor' } }])
  })

  it('refuses a date ahead of today or before the web, and writes nothing', () => {
    expect(() => plan({ ...verdict([publish([ann()])]), published_on: '2062-07-19' })).toThrow('The publish date has to be a day from 1991-01-01 to today.')
    expect(() => plan({ ...verdict([publish([ann()])]), published_on: '0201-07-19' })).toThrow()
    expect(() => plan({ ...verdict([publish([ann()])]), published_on: '2018-02-30' })).toThrow()
  })

  it('confirms a page date the editor kept as their own, and writes nothing for a date they did not touch', () => {
    const dated = source('article', { published_on: '2018-07-19', published_on_from: 'page' })
    expect(updatesOf(planReview(published(), pending, dated, { ...verdict([publish([ann()])]), published_on: '2018-07-19' }, NOW, ids()), 'sources')).toHaveLength(1)
    expect(writesOn(planReview(published(), pending, dated, verdict([publish([ann()])]), NOW, ids()), 'sources')).toEqual([])
    const theirs = source('article', { published_on: '2018-07-19', published_on_from: 'editor' })
    expect(writesOn(planReview(published(), pending, theirs, { ...verdict([publish([ann()])]), published_on: '2018-07-19' }, NOW, ids()), 'sources')).toEqual([])
  })
})

describe('planReview with a decision about a set position', () => {
  const lead = item('i1', 'p1', 'ann', 'policy')
  const held = setPosition('policy', 'ann', 'support', 'Promised it at the convention.')
  const decide = (decision: PositionDecision, setPositions: SetPosition[] = [held]) => plan(verdict([publish([lead], { decision }, 'oppose')]), cameIn([lead], { setPositions }))

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
    expect(rowsOf<SetPosition>(plan(verdict([entry]), cameIn([lead])), 'set_positions').map((s) => [s.id, s.question_id, s.decider_id])).toEqual([['markup:ann', 'markup', 'ann']])
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
