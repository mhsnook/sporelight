import { env } from 'cloudflare:workers'
import { getServerByName } from 'partyserver'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ProposalDraft } from '../../shared/schema.ts'
import type { Tracker } from '../../worker/tracker.ts'
import { post, proposal, rows, seed, noOutsidePages } from './helpers.ts'

const tracker = () => getServerByName<Env, Tracker>(env.Tracker, 'main')
// What the Worker answers a proposal it queued, and one it already had.
const QUEUED = { ok: true, duplicate: false, proposal_id: expect.any(String) }
const DUPLICATE = { ok: true, duplicate: true, proposal_id: null }
const count = async (table: string) => (await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n
const totals = async () => ({
  sources: await count('sources'),
  proposals: await count('proposals'),
  items: await count('proposal_items'),
  notes: await count('proposal_notes'),
})

beforeAll(async () => {
  noOutsidePages()
  await seed()
})

describe('POST /api/proposals: refused input', () => {
  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON null', 'null'],
  ])('refuses %s', async (_, raw) => {
    const res = await post('/api/proposals', raw)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Expected a JSON body.' })
  })

  it.each([
    ['a JSON array', '[]'],
    ['a JSON string', '"I support it"'],
    ['a JSON number', '42'],
  ])('refuses %s with a 400 and writes nothing', async (_, raw) => {
    const before = await totals()
    expect((await post('/api/proposals', raw)).status).toBe(400)
    expect(await totals()).toEqual(before)
  })

  it.each([
    ['quote', { quote: 'too short' }],
    ['quote', { quote: 'x'.repeat(2001) }],
    ['source_url', { source_url: `https://news.example/${'x'.repeat(2000)}` }],
    ['source_url', { source_url: 'javascript:alert(document.cookie)' }],
    ['source_url', { source_url: 'data:text/html,<script>alert(1)</script>' }],
    ['source_url', { source_url: 'ftp://news.example/story' }],
    ['source_title', { source_title: 'x'.repeat(301) }],
    ['submitter_note', { submitter_note: 'x'.repeat(1001) }],
  ])('refuses a bad %s and writes nothing', async (field, bad) => {
    const before = await totals()
    const res = await post('/api/proposals', proposal(bad))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(new RegExp(`^${field}: `))
    expect(await totals()).toEqual(before)
  })

  it('ignores fields only the server or an editor sets', async () => {
    const url = 'https://news.example/forged-fields'
    const res = await post('/api/proposals', {
      ...proposal({ source_url: url }),
      id: 'forged-proposal',
      proposal_id: 'forged-proposal',
      act_id: 'forged-act',
      origin: 'model',
      status: 'accepted',
      weight: 'concrete',
      passage: 'A forged passage.',
      unread: 'refused',
      context: { before: 'Forged.', after: 'Forged.' },
      mentions: [{ decider_id: 'bob', words: 'Forged.' }],
      sort: 99,
      submitted_by: 'admin',
      reviewed_at: '2026-11-01',
    })
    const answer = await res.json()
    expect(answer).toEqual(QUEUED)
    const [row] = await rows(
      `SELECT p.id AS proposal_id, p.origin, p.status AS proposal_status, p.submitted_by, p.reviewed_at, p.unread,
              i.id, i.act_id, i.status, i.weight, i.passage, i.sort
       FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id JOIN sources s ON s.id = p.source_id WHERE s.url = ?`,
      url,
    )
    expect(row).toMatchObject({ origin: 'reader', proposal_status: 'pending', submitted_by: null, reviewed_at: null, unread: null, status: 'pending', weight: 'clear', passage: null, sort: 0 })
    expect([row.proposal_id, row.id, row.act_id]).not.toContain('forged-proposal')
    expect((answer as { proposal_id: string }).proposal_id).toBe(row.proposal_id)
    expect(row.act_id).not.toBe('forged-act')
    expect(await rows(`SELECT id FROM proposal_contexts WHERE proposal_id = ?1 UNION ALL SELECT id FROM proposal_mentions WHERE proposal_id = ?1`, row.proposal_id)).toEqual([])
  })

  it('answers a filled-in honeypot as if it worked and writes nothing', async () => {
    const before = await totals()
    const res = await post('/api/proposals', { ...proposal({ source_url: 'https://news.example/honeypot' }), website: 'https://spam.example' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await totals()).toEqual(before)
  })

  it.each([
    ['question', { question_id: 'no-such-question' }],
    ['decider', { decider_id: 'no-such-person' }],
  ])('refuses an unknown %s and leaves no source behind', async (_, bad) => {
    const before = await totals()
    const res = await post('/api/proposals', proposal({ ...bad, source_url: `https://news.example/unknown-${_}` }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Unknown question or decider.' })
    expect(await totals()).toEqual(before)
  })

  it('limits one address to six posts a minute', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      statuses.push((await post('/api/proposals', proposal({ quote: 'too short' }), '192.0.2.77')).status)
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400, 429])
  })
})

describe('POST /api/proposals: a new source', () => {
  it('writes a source, a pending proposal, one item and the submitter note', async () => {
    const url = 'https://news.example/new-source'
    const res = await post('/api/proposals', proposal({ source_url: `${url}#comments`, submitter_note: 'Second paragraph.' }))
    expect(res.status).toBe(200)
    const answer = (await res.json()) as { proposal_id: string }
    expect(answer).toEqual(QUEUED)

    const [source] = await rows<{ id: string; title: string }>(`SELECT * FROM sources WHERE url = ?`, url)
    expect(source.title).toBe('Ann Alpha backs the bill')
    const proposals = await rows(`SELECT * FROM proposals WHERE source_id = ?`, source.id)
    expect(proposals).toMatchObject([{ id: answer.proposal_id, origin: 'reader', status: 'pending', unread: null, reviewed_at: null }])
    const items = await rows(`SELECT * FROM proposal_items WHERE proposal_id = ?`, proposals[0].id)
    expect(items).toMatchObject([
      {
        question_id: 'hot',
        decider_id: 'ann',
        kind: 'says',
        reading: 'support',
        weight: 'clear',
        passage: null,
        status: 'pending',
        quote: 'I will vote for this bill when it comes up.',
        occurred_on: '2026-11-01',
      },
    ])
    expect(await rows(`SELECT kind, body, proposal_item_id FROM proposal_notes WHERE proposal_id = ?`, proposals[0].id)).toEqual([
      { kind: 'submitter', body: 'Second paragraph.', proposal_item_id: null },
    ])
  })

  it('writes no note when the submitter left none', async () => {
    await post('/api/proposals', proposal({ source_url: 'https://news.example/no-note' }))
    expect(await rows(`SELECT n.id FROM proposal_notes n JOIN proposals p ON p.id = n.proposal_id JOIN sources s ON s.id = p.source_id WHERE s.url = ?`, 'https://news.example/no-note')).toEqual([])
  })
})

describe('POST /api/proposals: duplicates from the same source', () => {
  const url = 'https://news.example/duplicates'
  const itemsFor = (decider: string) =>
    rows<{ id: string; status: string; quote: string }>(
      `SELECT i.id, i.status, i.quote FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id JOIN sources s ON s.id = p.source_id WHERE s.url = ? AND i.decider_id = ? ORDER BY p.created_at`,
      url,
      decider,
    )
  const submit = async (overrides: Record<string, unknown>) =>
    (await (await post('/api/proposals', proposal({ source_url: url, ...overrides }))).json()) as { ok: boolean; duplicate: boolean; proposal_id: string | null }

  it('a pending item blocks the same person and question, whatever the quote', async () => {
    expect(await submit({ decider_id: 'bob' })).toEqual(QUEUED)
    expect(await submit({ decider_id: 'bob', quote: 'A different sentence from the article.' })).toEqual(DUPLICATE)
    expect(await submit({ decider_id: 'bob', source_url: `${url}#later` })).toEqual(DUPLICATE)
    expect(await itemsFor('bob')).toHaveLength(1)
  })

  it('does not block another person or another question, and reuses the source', async () => {
    expect(await submit({ decider_id: 'eve' })).toEqual(QUEUED)
    expect(await submit({ decider_id: 'bob', question_id: 'cold' })).toEqual(QUEUED)
    expect(await rows(`SELECT id FROM sources WHERE url = ?`, url)).toHaveLength(1)
  })

  it('a published item blocks the same person and question', async () => {
    expect(await submit({ decider_id: 'fay' })).toEqual(QUEUED)
    await env.DB.prepare(`UPDATE proposal_items SET status = 'accepted' WHERE id = ?`).bind((await itemsFor('fay'))[0].id).run()
    expect(await submit({ decider_id: 'fay', quote: 'A different sentence from the article.' })).toEqual(DUPLICATE)
  })

  it('a rejected item blocks a reader only for the same quote', async () => {
    expect(await submit({ decider_id: 'ann', quote: 'The words that were turned down.' })).toEqual(QUEUED)
    await env.DB.prepare(`UPDATE proposal_items SET status = 'rejected' WHERE id = ?`).bind((await itemsFor('ann'))[0].id).run()
    expect(await submit({ decider_id: 'ann', quote: 'The words that were turned down.' })).toEqual(DUPLICATE)
    expect(await submit({ decider_id: 'ann', quote: 'A better quote from the same article.' })).toEqual(QUEUED)
    expect((await itemsFor('ann')).map((i) => i.status)).toEqual(['rejected', 'pending'])
  })

  it('a rejected item blocks the news search whatever the quote', async () => {
    const newsUrl = 'https://news.example/rejected-lead'
    const draft = (quote: string) => ({ source: { url: newsUrl, title: null }, note: null, items: [{ question_id: 'hot', decider_id: 'ann', kind: 'says' as const, occurred_on: null, quote, reading: null }] })
    expect(await (await tracker()).propose(draft('Ann Alpha said something.'), 'news_search')).toEqual({ ok: true, queued: 1, proposal_id: expect.any(String) })
    await env.DB.prepare(
      `UPDATE proposal_items SET status = 'rejected' WHERE proposal_id IN (SELECT p.id FROM proposals p JOIN sources s ON s.id = p.source_id WHERE s.url = ?)`,
    )
      .bind(newsUrl)
      .run()
    expect(await (await tracker()).propose(draft('Ann Alpha said something else.'), 'news_search')).toEqual({ ok: true, queued: 0, proposal_id: null })
    expect(await (await tracker()).propose(draft('Ann Alpha said something.'), 'news_search')).toEqual({ ok: true, queued: 0, proposal_id: null })
  })
})

describe('Tracker.propose', () => {
  type DraftItem = ProposalDraft['items'][number]
  const draftItem = (over: Partial<DraftItem> = {}): DraftItem => ({ question_id: 'hot', decider_id: 'ann', kind: 'says', occurred_on: null, quote: 'Some words from the article.', reading: 'support', ...over })
  const propose = async (name: string, items: DraftItem[], more: Partial<ProposalDraft> = {}, origin: 'reader' | 'news_search' | 'model' = 'model') => {
    const result = await (await tracker()).propose({ source: { url: `https://news.example/propose-${name}`, title: null }, note: null, items, ...more }, origin)
    if (!result.ok || !result.proposal_id) throw new Error(`not queued: ${JSON.stringify(result)}`)
    return result.proposal_id
  }
  const itemsOf = (proposalId: string) => rows<{ id: string; decider_id: string; weight: string | null; passage: string | null }>(`SELECT id, decider_id, weight, passage FROM proposal_items WHERE proposal_id = ? ORDER BY sort`, proposalId)

  it('returns the id of the proposal it wrote', async () => {
    const id = await propose('id', [draftItem()])
    expect(await rows(`SELECT s.url FROM proposals p JOIN sources s ON s.id = p.source_id WHERE p.id = ?`, id)).toEqual([{ url: 'https://news.example/propose-id' }])
  })

  it('gives an item that came with no weight the usual one for its kind', async () => {
    const id = await propose('usual-weight', [draftItem(), draftItem({ decider_id: 'bob', kind: 'commits' }), draftItem({ decider_id: 'eve', kind: 'does', reading: 'oppose' })])
    expect((await itemsOf(id)).map((i) => [i.decider_id, i.weight])).toEqual([
      ['ann', 'clear'],
      ['bob', 'concrete'],
      ['eve', 'concrete'],
    ])
  })

  it('keeps the weight an item came with', async () => {
    const id = await propose('given-weight', [draftItem({ weight: 'passing' }), draftItem({ decider_id: 'bob', kind: 'does', weight: 'passing' }), draftItem({ decider_id: 'eve', weight: 'concrete' })])
    expect((await itemsOf(id)).map((i) => [i.decider_id, i.weight])).toEqual([
      ['ann', 'passing'],
      ['bob', 'passing'],
      ['eve', 'concrete'],
    ])
  })

  it('gives a lead no weight, whatever came with it', async () => {
    const id = await propose('lead-weight', [draftItem({ reading: null }), draftItem({ decider_id: 'bob', kind: 'does', reading: null, weight: 'concrete' })], {}, 'news_search')
    expect((await itemsOf(id)).map((i) => [i.decider_id, i.weight])).toEqual([
      ['ann', null],
      ['bob', null],
    ])
  })

  it('stores the passage an item came with, and none for an item without one', async () => {
    const id = await propose('passage', [draftItem({ passage: 'Ann Alpha said some words from the article. Then she left.' }), draftItem({ decider_id: 'bob' })])
    expect((await itemsOf(id)).map((i) => i.passage)).toEqual(['Ann Alpha said some words from the article. Then she left.', null])
  })

  it('stores why a lead’s article was not read, and nothing when no reason is given', async () => {
    const unread = await propose('unread', [draftItem({ reading: null })], { unread: 'no_text' }, 'news_search')
    const read = await propose('read', [draftItem()])
    expect(await rows(`SELECT id, unread FROM proposals WHERE id IN (?, ?) ORDER BY unread IS NULL`, unread, read)).toEqual([
      { id: unread, unread: 'no_text' },
      { id: read, unread: null },
    ])
  })

  it('stores the text either side of a passage against its item, only for the items that have it', async () => {
    const id = await propose('context', [draftItem(), draftItem({ decider_id: 'bob', context: { before: 'The paragraph before.', after: 'The paragraph after.' } })])
    const [, bob] = await itemsOf(id)
    expect(await rows(`SELECT proposal_id, proposal_item_id, before, after FROM proposal_contexts WHERE proposal_id = ?`, id)).toEqual([
      { proposal_id: id, proposal_item_id: bob.id, before: 'The paragraph before.', after: 'The paragraph after.' },
    ])
    expect(await rows(`SELECT 1 FROM proposal_items WHERE proposal_id = ?1 AND (quote LIKE '%The paragraph before.%' OR passage LIKE '%The paragraph before.%')`, id)).toEqual([])
  })

  it('stores the people the article only names', async () => {
    const id = await propose('mentions', [draftItem()], { mentions: [{ decider_id: 'bob', words: 'Bob Beta was absent' }, { decider_id: 'eve', words: 'Eve Epsilon did not comment' }] })
    expect(await rows(`SELECT decider_id, words FROM proposal_mentions WHERE proposal_id = ? ORDER BY decider_id`, id)).toEqual([
      { decider_id: 'bob', words: 'Bob Beta was absent' },
      { decider_id: 'eve', words: 'Eve Epsilon did not comment' },
    ])
  })

  it('writes no context or mention for a draft that has none', async () => {
    const id = await propose('bare', [draftItem()])
    expect(await rows(`SELECT id FROM proposal_contexts WHERE proposal_id = ?1 UNION ALL SELECT id FROM proposal_mentions WHERE proposal_id = ?1`, id)).toEqual([])
  })

  it('writes nothing when a draft names an unknown person as only named', async () => {
    const before = await totals()
    const url = 'https://news.example/propose-unknown-mention'
    const result = await (await tracker()).propose({ source: { url, title: null }, note: null, items: [draftItem()], mentions: [{ decider_id: 'no-such-person', words: 'Was absent' }] }, 'model')
    expect(result).toEqual({ ok: false, status: 400, error: 'Unknown question or decider.' })
    expect(await totals()).toEqual(before)
    expect(await count('proposal_mentions WHERE decider_id = \'no-such-person\'')).toBe(0)
  })
})

// Last in the file: it fills the queue for every test after it.
describe('POST /api/proposals: a full queue', () => {
  it('refuses a new proposal once 500 are pending', async () => {
    const pending = await count(`proposals WHERE status = 'pending'`)
    await env.DB.prepare(`INSERT INTO sources (id, url, created_at) VALUES ('filler', 'https://news.example/filler', '2026-11-01')`).run()
    const fill = Array.from({ length: 500 - pending }, (_, i) =>
      env.DB.prepare(`INSERT INTO proposals (id, source_id, origin, created_at) VALUES (?, 'filler', 'reader', '2026-11-01')`).bind(`filler-${i}`),
    )
    await env.DB.batch(fill)
    expect(await count(`proposals WHERE status = 'pending'`)).toBe(500)

    const before = await totals()
    const res = await post('/api/proposals', proposal({ source_url: 'https://news.example/one-too-many' }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'The review queue is full right now. Please try again later.' })
    expect(await totals()).toEqual(before)
  })

  it('takes proposals again once one is reviewed', async () => {
    await env.DB.prepare(`UPDATE proposals SET status = 'reviewed' WHERE id = 'filler-0'`).run()
    const res = await post('/api/proposals', proposal({ source_url: 'https://news.example/after-review' }))
    expect(await res.json()).toEqual(QUEUED)
  })
})
