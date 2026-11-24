import { describe, expect, it } from 'vitest'
import { buildStories, buildWaiting, feedPage, mergeFeed, pageHolding, questionFamily } from './feed.ts'
import { act, data, decider, item, proposal, question, reading, report, role, seat, setPosition, source, track } from './fixtures.ts'

const at = (day: string, time = '12:00') => `${day}T${time}:00.000Z`

const policy = question('policy')
const bill = question('bill', { parent_id: 'policy', kind: 'formal_act', implies_on_parent: 'support', sort: 1 })
const markup = question('markup', { parent_id: 'bill', sort: 2 })
const other = question('other', { sort: 3 })
const elsewhere = question('elsewhere', { body_id: 'council' })

const bodies = [
  ...data({}).bodies,
  { id: 'council', slug: 'council', name: 'Council', jurisdiction: null, description: null, is_demo: true, sort: 1, next_term_on: null, next_term_label: null },
]

// One act and its first report share the moment an editor published them, as planReview writes them.
const published = (id: string, deciderId: string, sourceId: string, when: string, over: Parameters<typeof act>[2] = {}) => ({
  act: act(id, deciderId, { created_at: when, ...over }),
  report: report(sourceId, id, { created_at: when }),
})

const article = [
  published('ann-says', 'ann', 'paper', at('2026-11-12')),
  published('bob-says', 'bob', 'paper', at('2026-11-12'), { occurred_on: '2026-11-10' }),
]
const cosponsor = published('cosponsor', 'ann', 'record', at('2026-11-10'), { kind: 'commits', occurred_on: '2026-03-01' })
const councilVote = published('council-vote', 'cy', 'minutes', at('2026-11-15'), { kind: 'does' })
const aside = published('aside', 'ann', 'blog', at('2026-11-14'))
// A later article reporting an act already on file, with its own excerpt.
const followUp = report('wire', 'bob-says', { created_at: at('2026-11-16'), excerpt: 'Bob said it again.', passage: 'Asked on Monday, Bob said it again. He did not say more.' })

const tracker = track({
  bodies,
  deciders: [decider('ann'), decider('bob'), decider('cy')],
  seats: [seat('s1'), seat('s2'), seat('c1', { body_id: 'council' })],
  roles: [role('s1', 'ann'), role('s2', 'bob'), role('c1', 'cy')],
  questions: [policy, bill, markup, other, elsewhere],
  sources: ['paper', 'record', 'minutes', 'blog', 'wire', 'unread'].map((id) => source(id)),
  acts: [...article.map((p) => p.act), cosponsor.act, councilVote.act, aside.act, act('unread', 'ann', { created_at: at('2026-11-17') })],
  reports: [...article.map((p) => p.report), cosponsor.report, councilVote.report, aside.report, followUp, report('unread', 'unread', { created_at: at('2026-11-17') })],
  readings: [
    reading('ann-says', 'policy', 'support'),
    reading('bob-says', 'policy', 'oppose'),
    reading('bob-says', 'markup', 'oppose'),
    reading('cosponsor', 'bill', 'support', null, 'concrete'),
    reading('cosponsor', 'policy', 'support', 'bill', 'concrete'),
    reading('aside', 'other', 'mixed'),
    reading('council-vote', 'elsewhere', 'support'),
  ],
})

const keys = (stories: { source: { id: string } }[]) => stories.map((s) => s.source.id)
const people = (story: { items: { decider: { id: string } }[] }) => story.items.map((i) => i.decider.id)

describe('stories', () => {
  const stories = buildStories(tracker)

  it('are one per source and publishing moment, newest first', () => {
    expect(keys(stories)).toEqual(['wire', 'minutes', 'blog', 'paper', 'record'])
  })

  it('gather everyone a source reports in one story', () => {
    expect(people(stories.find((s) => s.source.id === 'paper')!)).toEqual(['ann', 'bob'])
  })

  it('leave out an act with no reading, which says nothing on any question', () => {
    expect(keys(stories)).not.toContain('unread')
  })

  it('say every question an act is read on, the direct reading before the implied one', () => {
    const [item] = stories.find((s) => s.source.id === 'record')!.items
    expect(item.readings.map((r) => [r.question.id, r.reading.position, r.via?.id])).toEqual([
      ['bill', 'support', undefined],
      ['policy', 'support', 'bill'],
    ])
  })

  it('mark a later report of an act already on file, with that source’s own words', () => {
    const [item] = stories.find((s) => s.source.id === 'wire')!.items
    expect(item.isNew).toBe(false)
    expect(item.words).toBe('Bob said it again.')
    const [first] = stories.find((s) => s.source.id === 'paper')!.items
    expect(first.isNew).toBe(true)
    expect(first.words).toBe('ann-says')
  })

  it('carry the passage a report kept, and none where it kept none', () => {
    expect(stories.find((s) => s.source.id === 'wire')!.items[0].passage).toBe('Asked on Monday, Bob said it again. He did not say more.')
    expect(stories.find((s) => s.source.id === 'paper')!.items.map((i) => i.passage)).toEqual([null, null])
  })

  it('are marked as demo data when read on a question in a demo body', () => {
    expect(stories.filter((s) => s.isDemo).map((s) => s.source.id)).toEqual(['minutes'])
  })
})

describe('filters', () => {
  it('take a question and everything under it, at any depth', () => {
    expect([...questionFamily(tracker, 'policy')].sort()).toEqual(['bill', 'markup', 'policy'])
    expect(keys(buildStories(tracker, { questionId: 'policy' }))).toEqual(['wire', 'paper', 'record'])
    expect(keys(buildStories(tracker, { questionId: 'markup' }))).toEqual(['wire', 'paper'])
  })

  it('keep only the people in a story the filter keeps, and put their matching readings first', () => {
    const paper = buildStories(tracker, { questionId: 'markup' }).find((s) => s.source.id === 'paper')!
    expect(people(paper)).toEqual(['bob'])
    expect(paper.items[0].readings.map((r) => r.question.id)).toEqual(['markup', 'policy'])
  })

  it('take a body: people seated in it, on questions put to it', () => {
    expect(keys(buildStories(tracker, { bodyId: 'council' }))).toEqual(['minutes'])
    expect(keys(buildStories(tracker, { questionId: 'policy', bodyId: 'council' }))).toEqual([])
  })

  it('survive two questions that name each other as parent', () => {
    const loop = track({ questions: [question('a', { parent_id: 'b' }), question('b', { parent_id: 'a' })] })
    expect([...questionFamily(loop, 'a')].sort()).toEqual(['a', 'b'])
  })
})

describe('paging', () => {
  const feed = mergeFeed(buildStories(tracker), [])
  const ids = (page: typeof feed) => page.map((f) => (f.kind === 'published' ? f.story.source.id : f.story.proposal.id))

  it('starts at the newest and gives a cursor while more remain', () => {
    const first = feedPage(feed, undefined, 2)
    expect(ids(first.page)).toEqual(['wire', 'minutes'])
    expect(first.isFirst).toBe(true)
    const second = feedPage(feed, first.older, 2)
    expect(ids(second.page)).toEqual(['blog', 'paper'])
    const last = feedPage(feed, second.older, 2)
    expect(ids(last.page)).toEqual(['record'])
    expect(last.older).toBeUndefined()
  })

  it('finds the page that holds one story, with the same way on to older ones, and nothing for a story not in the feed', () => {
    const second = feedPage(feed, feedPage(feed, undefined, 2).older, 2)
    expect(pageHolding(feed, second.page[1].story.key, 2)).toEqual(second)
    expect(pageHolding(feed, feed[0].story.key, 2)?.isFirst).toBe(true)
    expect(pageHolding(feed, 'proposal:not-in-the-feed', 2)).toBeNull()
  })

  it('goes back to the newest when the cursor is not one', () => {
    expect(feedPage(feed, 'not-a-cursor', 2).isFirst).toBe(true)
  })

  it('carries on from the same place after the story the cursor came from is gone', () => {
    const { older } = feedPage(feed, undefined, 2)
    const withoutMinutes = feed.filter((f) => f.kind !== 'published' || f.story.source.id !== 'minutes')
    expect(ids(feedPage(withoutMinutes, older, 2).page)).toEqual(['blog', 'paper'])
  })
})

describe('what is waiting for review', () => {
  const proposals = [
    proposal('from-reader', 'paper', { created_at: at('2026-11-17') }),
    proposal('from-model', 'record', { origin: 'model', created_at: at('2026-11-18') }),
    proposal('lead', 'minutes', { origin: 'news_search', created_at: at('2026-11-18') }),
    proposal('done', 'paper', { status: 'reviewed', created_at: at('2026-11-01') }),
  ]
  const items = [
    item('claim', 'from-reader', 'ann', 'policy', { reading: 'support' }),
    item('turned-down', 'from-reader', 'bob', 'policy', { reading: 'oppose', status: 'rejected' }),
    item('on-bill', 'from-model', 'bob', 'bill', { reading: 'support', act_id: 'one-act', sort: 0 }),
    item('on-policy', 'from-model', 'bob', 'policy', { reading: 'support', act_id: 'one-act', sort: 1 }),
    item('second-act', 'from-model', 'ann', 'other', { reading: 'mixed', act_id: 'two' }),
    item('bare-lead', 'lead', 'cy', 'elsewhere'),
    item('published', 'done', 'ann', 'policy', { reading: 'support', status: 'accepted' }),
    item('unknown-person', 'from-reader', 'nobody', 'policy', { reading: 'support' }),
  ]
  const waiting = buildWaiting(tracker, proposals, items)
  const claimed = (stories: typeof waiting) => stories.map((s) => [s.proposal.id, s.items.map((i) => i.claims.map((c) => c.item.id))])

  it('is one story per proposal with pending items that claim a reading, newest first', () => {
    expect(claimed(waiting)).toEqual([
      ['from-model', [['on-bill', 'on-policy'], ['second-act']]],
      ['from-reader', [['claim']]],
    ])
  })

  it('never shows a rejected item, a bare search lead or anything already reviewed', () => {
    const shown = waiting.flatMap((s) => s.items.flatMap((i) => i.claims.map((c) => c.item.id)))
    for (const id of ['turned-down', 'bare-lead', 'published', 'unknown-person']) expect(shown).not.toContain(id)
  })

  it('takes the same filters as the record', () => {
    expect(claimed(buildWaiting(tracker, proposals, items, { questionId: 'bill' }))).toEqual([['from-model', [['on-bill']]]])
    expect(claimed(buildWaiting(tracker, proposals, items, { bodyId: 'council' }))).toEqual([])
  })

  it('sits in the feed beside the record, by when it was put forward', () => {
    const merged = mergeFeed(buildStories(tracker), waiting)
    expect(merged.map((f) => (f.kind === 'published' ? f.story.source.id : `waiting:${f.story.proposal.id}`))).toEqual([
      'waiting:from-model',
      'waiting:from-reader',
      'wire',
      'minutes',
      'blog',
      'paper',
      'record',
    ])
  })

  it('says where each person stood on the question before the claim', () => {
    const bob = waiting[0].items[0]
    expect(bob.claims.map((c) => [c.question.id, c.before])).toEqual([
      ['bill', 'unknown'],
      ['policy', 'oppose'],
    ])
    const signed = buildWaiting(tracker, proposals, [item('again', 'from-reader', 'ann', 'bill', { reading: 'support' })])
    expect(signed[0].items[0].claims[0].before).toBe('support')
  })

  it('names the position editors set when a claim sits across from it, and not otherwise', () => {
    const set = setPosition('policy', 'ann', 'lean_oppose')
    const withSet = track({ deciders: [decider('ann'), decider('bob')], questions: [policy, other], setPositions: [set, setPosition('other', 'ann', 'mixed')] })
    const claims = [
      item('across', 'from-reader', 'ann', 'policy', { reading: 'lean_support', sort: 0 }),
      item('same-side', 'from-reader', 'ann', 'policy', { reading: 'oppose', act_id: 'second', sort: 1 }),
      item('against-mixed', 'from-reader', 'ann', 'other', { reading: 'oppose', act_id: 'third', sort: 2 }),
      item('nothing-set', 'from-reader', 'bob', 'policy', { reading: 'support', act_id: 'fourth', sort: 3 }),
    ]
    const [story] = buildWaiting(withSet, proposals, claims)
    expect(story.items.flatMap((i) => i.claims.map((c) => [c.item.id, c.before, c.across]))).toEqual([
      ['across', 'lean_oppose', set],
      ['same-side', 'lean_oppose', undefined],
      ['against-mixed', 'mixed', undefined],
      ['nothing-set', 'unknown', undefined],
    ])
  })

  it('keeps who put it forward and its source', () => {
    expect(waiting.map((s) => [s.proposal.origin, s.source?.id])).toEqual([
      ['model', 'record'],
      ['reader', 'paper'],
    ])
  })
})
