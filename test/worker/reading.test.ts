import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { getServerByName } from 'partyserver'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchArticle, MAX_BYTES } from '../../worker/article.ts'
import worker from '../../worker/index.ts'
import type { SearchHit } from '../../worker/leads.ts'
import { dryRunArticle, MAX_READS_PER_RUN, NEWS_CRON, queueIsAttended, runNewsSearch, searchNews } from '../../worker/news.ts'
import { MODEL } from '../../worker/reader.ts'
import type { Tracker } from '../../worker/tracker.ts'
import type { NewsStep } from '../../shared/news-run.ts'
import type { Proposal, ProposalDraft } from '../../shared/schema.ts'
import { proposal, rows, seed, until, reader } from './helpers.ts'

const NOW = new Date('2026-11-19T12:00:00Z')
const TODAY = NOW.toISOString().slice(0, 10)

// Under the hot question: a measure put to everyone, an ask put to Bob by name,
// and an ask put to whoever chairs the committee, which Ann does now and Bob
// did before her.
beforeAll(async () => {
  await seed()
  await env.DB.batch(
    [
      `INSERT INTO questions (id, slug, body_id, parent_id, kind, title, short_title, is_hot, status) VALUES
        ('hot-bill', 'hot-bill', 'congress', 'hot', 'formal_act', 'Have they cosponsored the bill?', 'Bill', 0, 'open'),
        ('hot-ask-bob', 'hot-ask-bob', 'congress', 'hot', 'position', 'Will Bob hold a hearing?', 'Hearing', 0, 'open'),
        ('hot-ask-chair', 'hot-ask-chair', 'congress', 'hot', 'position', 'Will the chair schedule a markup?', 'Markup', 0, 'open'),
        ('hot-old', 'hot-old', 'congress', 'hot', 'formal_act', 'Did they sign the old letter?', 'Old letter', 0, 'lapsed')`,
      `INSERT INTO question_deciders (id, question_id, decider_id) VALUES ('qd-bob', 'hot-ask-bob', 'bob')`,
      `INSERT INTO offices (id, body_id, label) VALUES ('chair', 'congress', 'Committee chair')`,
      `INSERT INTO office_holders (id, office_id, decider_id, starts_on, ends_on) VALUES
        ('h-bob', 'chair', 'bob', '2020-01-01', '2025-01-03'), ('h-ann', 'chair', 'ann', '2025-01-03', NULL)`,
      `INSERT INTO question_offices (id, question_id, office_id) VALUES ('qo-chair', 'hot-ask-chair', 'chair')`,
    ].map((sql) => env.DB.prepare(sql)),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

const FILLER = ' The committee met for several hours and heard from witnesses on both sides of the debate.'.repeat(4)
// Three paragraphs once converted to text: the title, the body and the filler.
const page = (body: string, head = '') => `<html><head><title>T</title>${head}</head>\n<body><article><p>${body}</p>\n<p>${FILLER}</p></article></body></html>`

type Act = Record<string, unknown>
const act = (overrides: Act = {}): Act => ({
  person_id: 'ann',
  question_id: 'hot',
  kind: 'says',
  quote: 'I will vote for this bill when it reaches the floor',
  occurred_on: '2026-11-16',
  position: 'support',
  weight: 'clear',
  reason: 'A direct statement of how she will vote.',
  ...overrides,
})

// A run of the news search in which the search returns `hits` for the hot
// question only, every page in `pages` can be fetched, and the model answers
// `answer(prompt)`. An answer that lists acts names nobody as only named
// unless it says so.
function stubbed({ hits, pages, answer }: { hits: SearchHit[]; pages: Record<string, string | number>; answer: (prompt: string) => unknown }) {
  const websearch = vi.fn(async ({ query }: { query: string }) => Response.json({ items: query.includes('"Hot Topic"') ? hits : [] }))
  const toMarkdown = vi.fn(async (doc: { blob: Blob }) => ({ format: 'text', data: (await doc.blob.text()).replace(/<[^>]+>/g, ' ') }))
  const run = vi.fn(async (_model: string, inputs: { messages: { content: string }[] }) => {
    const given = answer(inputs.messages[1].content)
    if (given instanceof Error) throw given
    const reply = typeof given === 'object' && given !== null && 'acts' in given ? { named_only: [], ...given } : given
    return { choices: [{ message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }
  })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    const found = pages[url]
    if (found === undefined) throw new Error(`unexpected fetch of ${url}`)
    return typeof found === 'number' ? new Response('no', { status: found }) : new Response(found, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  })
  return { env: { ...env, AI: { websearch, toMarkdown, run } } as unknown as Env, websearch, toMarkdown, run, fetcher }
}

const hit = (url: string, title = 'Ann Alpha on the plan'): SearchHit => ({ url, title, description: 'Rep. Alpha spoke about the plan this week.', lastModifiedDate: '2026-11-17T09:00:00Z' })

const tracker = () => getServerByName<Env, Tracker>(env.Tracker, 'main')

const proposalsFor = (url: string) =>
  rows<{ id: string; origin: string; unread: string | null }>(`SELECT p.id, p.origin, p.unread FROM proposals p JOIN sources s ON s.id = p.source_id WHERE s.url = ?`, url)
const itemsFor = (url: string) =>
  rows(
    `SELECT i.decider_id, i.question_id, i.kind, i.occurred_on, i.quote, i.reading, i.weight, i.passage
     FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id JOIN sources s ON s.id = p.source_id WHERE s.url = ? ORDER BY i.sort`,
    url,
  )
const notesFor = (url: string) =>
  rows<{ body: string; on_item: number }>(
    `SELECT n.body, n.proposal_item_id IS NOT NULL AS on_item FROM proposal_notes n JOIN proposals p ON p.id = n.proposal_id JOIN sources s ON s.id = p.source_id WHERE s.url = ? ORDER BY on_item, n.body`,
    url,
  )
const contextsFor = (url: string) =>
  rows<{ decider_id: string; before: string; after: string }>(
    `SELECT i.decider_id, c.before, c.after FROM proposal_contexts c JOIN proposal_items i ON i.id = c.proposal_item_id JOIN proposals p ON p.id = c.proposal_id AND p.id = i.proposal_id
     JOIN sources s ON s.id = p.source_id WHERE s.url = ? ORDER BY i.sort`,
    url,
  )
const mentionsFor = (url: string) =>
  rows<{ decider_id: string; words: string }>(`SELECT m.decider_id, m.words FROM proposal_mentions m JOIN proposals p ON p.id = m.proposal_id JOIN sources s ON s.id = p.source_id WHERE s.url = ? ORDER BY m.decider_id`, url)
const readsOf = (url: string) => rows<{ question_id: string; outcome: string; model: string | null; detail: string | null }>(`SELECT r.question_id, r.outcome, r.model, r.detail FROM article_reads r JOIN sources s ON s.id = r.source_id WHERE s.url = ?`, url)

describe('reading articles', () => {
  it('queues one proposal per article with an item per act whose words are in the article', async () => {
    const url = 'https://news.example/read-1'
    const body = 'Ann Alpha said: “I will vote for this bill when it reaches the floor.” Bob Beta voted against the rule on Tuesday.'
    const s = stubbed({
      hits: [hit(url, 'Ann Alpha and Bob Beta on the plan')],
      pages: { [url]: page(body) },
      answer: () => ({
        acts: [act(), act({ person_id: 'bob', kind: 'does', quote: 'Bob Beta voted against the rule on Tuesday', occurred_on: '2026-11-18', position: 'oppose', weight: 'passing', reason: 'The rule governs debate on the bill.' })],
      }),
    })
    const report = await searchNews(s.env, await tracker(), NOW)

    expect(report.questions[0]).toMatchObject({ question: 'Hot Topic', read: 1, queued: 2 })
    expect(s.fetcher).toHaveBeenCalledTimes(1)
    expect(s.run).toHaveBeenCalledTimes(1)
    expect(await proposalsFor(url)).toEqual([expect.objectContaining({ origin: 'model', unread: null })])
    // Each item carries the weight the model gave it and the paragraph its words sit in.
    expect(await itemsFor(url)).toEqual([
      { decider_id: 'ann', question_id: 'hot', kind: 'says', occurred_on: '2026-11-16', quote: 'I will vote for this bill when it reaches the floor', reading: 'support', weight: 'clear', passage: body },
      { decider_id: 'bob', question_id: 'hot', kind: 'does', occurred_on: '2026-11-18', quote: 'Bob Beta voted against the rule on Tuesday', reading: 'oppose', weight: 'passing', passage: body },
    ])
    const notes = await notesFor(url)
    expect(notes[0]).toMatchObject({ on_item: 0 })
    expect(notes[0].body).toContain(MODEL)
    expect(notes.slice(1).map((n) => n.body)).toEqual(["Model's reason: A direct statement of how she will vote.", "Model's reason: The rule governs debate on the bill."])
    expect(await readsOf(url)).toEqual([{ question_id: 'hot', outcome: 'queued', model: MODEL, detail: null }])
  })

  it('keeps the model reason out of every public column', async () => {
    const reasons = ['A direct statement of how she will vote.', 'The rule governs debate on the bill.']
    for (const reason of reasons) {
      const like = `%${reason}%`
      expect(
        await rows(
          `SELECT 1 FROM proposal_items WHERE quote LIKE ?1 OR passage LIKE ?1
           UNION ALL SELECT 1 FROM proposals WHERE submitted_by LIKE ?1
           UNION ALL SELECT 1 FROM sources WHERE title LIKE ?1 OR url LIKE ?1`,
          like,
        ),
      ).toEqual([])
      expect(await rows(`SELECT 1 FROM proposal_notes WHERE body LIKE ?`, like)).toHaveLength(1)
    }
  })

  it('keeps the text either side of each passage, and the people only named, in tables only editors are sent', async () => {
    const url = 'https://news.example/read-context-and-mentions'
    const s = stubbed({
      hits: [hit(url, 'Ann Alpha and Bob Beta on the plan')],
      pages: { [url]: page('Ann Alpha said: “I will vote for this bill when it reaches the floor.” Bob Beta was absent.') },
      answer: () => ({ acts: [act()], named_only: [{ person_id: 'bob', quote: 'Bob Beta was absent' }, { person_id: 'ann', quote: 'Ann Alpha said' }, { person_id: 'bob', quote: 'Bob Beta walked out' }] }),
    })
    await searchNews(s.env, await tracker(), NOW)
    expect(await contextsFor(url)).toEqual([{ decider_id: 'ann', before: 'T', after: FILLER.trim() }])
    expect(await mentionsFor(url)).toEqual([{ decider_id: 'bob', words: 'Bob Beta was absent' }])
    expect(await rows(`SELECT 1 FROM proposal_items WHERE quote LIKE ?1 OR passage LIKE ?1`, '%The committee met%')).toEqual([])
  })

  it('reads for a question linked to the one in the news, in the same body, and queues an act read on it', async () => {
    const url = 'https://news.example/read-step'
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO questions (id, slug, body_id, kind, title, short_title) VALUES ('hot-step', 'hot-step', 'congress', 'position', 'A smaller step?', 'Smaller Step'), ('demo-step', 'demo-step', 'demo', 'position', 'In another body?', 'Elsewhere')`),
      env.DB.prepare(`INSERT INTO question_relations (id, question_id, related_id, kind, sort) VALUES ('rel-step', 'hot', 'hot-step', 'smaller_step', 0), ('rel-demo', 'hot', 'demo-step', 'related', 1)`),
    ])
    const quote = 'I will vote for the smaller step'
    const s = stubbed({
      hits: [hit(url)],
      pages: { [url]: page(`Rep. Alpha said: ${quote}.`) },
      answer: () => ({ acts: [{ person_id: 'ann', question_id: 'hot-step', kind: 'says', quote, occurred_on: null, position: 'support', weight: 'clear', reason: 'She says so.' }], named_only: [] }),
    })
    await searchNews(s.env, await tracker(), NOW)
    const prompt = (s.run.mock.calls[0][1] as { messages: { content: string }[] }).messages[1].content
    expect(prompt).toContain('"question_id": "hot-step"')
    expect(prompt).not.toContain('"question_id": "demo-step"')
    expect(await itemsFor(url)).toEqual([expect.objectContaining({ decider_id: 'ann', question_id: 'hot-step', reading: 'support' })])
    await env.DB.batch([env.DB.prepare(`DELETE FROM question_relations WHERE id IN ('rel-step', 'rel-demo')`)])
  })

  it('routes the search and the model through the app gateway', async () => {
    const url = 'https://news.example/read-gateway'
    const s = stubbed({ hits: [hit(url)], pages: { [url]: page('Nothing much.') }, answer: () => ({ acts: [] }) })
    await searchNews(s.env, await tracker(), NOW)
    // Both have to go through the gateway that carries the spending limit.
    expect(s.websearch.mock.calls[0][0]).toMatchObject({ gatewayId: env.AI_GATEWAY })
    expect((s.run.mock.calls[0] as unknown[])[2]).toEqual({ gateway: { id: env.AI_GATEWAY } })
  })

  it('tells the model the question, its open sub-questions, and which of them are put to each person', async () => {
    const url = 'https://news.example/read-context'
    const s = stubbed({ hits: [hit(url, 'Ann Alpha and Bob Beta on the plan')], pages: { [url]: page('Words.') }, answer: () => ({ acts: [] }) })
    await searchNews(s.env, await tracker(), NOW)
    const prompt = (s.run.mock.calls[0][1] as { messages: { content: string }[] }).messages[1].content
    const people = JSON.parse(prompt.split('People, with the questions each can be read on:\n')[1].split('\n\nArticle:')[0])
    // Ann chairs the committee today, so the markup ask is put to her and not
    // to Bob, who chaired it before. The lapsed letter is offered to no one.
    expect(people).toEqual([
      { person_id: 'ann', name: 'Ann Alpha', question_ids: ['hot', 'hot-bill', 'hot-ask-chair'] },
      { person_id: 'bob', name: 'Bob Beta', question_ids: ['hot', 'hot-bill', 'hot-ask-bob'] },
    ])
    expect(prompt).not.toContain('hot-old')
  })

  it('drops an act whose quote is not in the article, and queues nothing when none is left', async () => {
    const url = 'https://news.example/read-paraphrase'
    const s = stubbed({
      hits: [hit(url)],
      pages: { [url]: page('Ann Alpha said she would probably back the bill.') },
      answer: () => ({ acts: [act({ quote: 'I will back this bill' })] }),
    })
    const report = await searchNews(s.env, await tracker(), NOW)
    expect(report.questions[0]).toMatchObject({ read: 1, queued: 0 })
    expect(await proposalsFor(url)).toEqual([])
    expect(await readsOf(url)).toEqual([{ question_id: 'hot', outcome: 'no_acts', model: MODEL, detail: 'ann on hot: "I will back this bill" quotes words that are not in the article' }])
  })

  it('drops an act by someone the article was not read for, or on a question not put to them', async () => {
    const url = 'https://news.example/read-wrong-people'
    const text = 'Ann Alpha said: “I will vote for this bill when it reaches the floor.” Cara Gamma agreed with every word of it.'
    const s = stubbed({
      hits: [hit(url)],
      pages: { [url]: page(text) },
      answer: () => ({
        acts: [act({ question_id: 'hot-ask-bob' }), act({ person_id: 'cara', quote: 'Cara Gamma agreed with every word of it' }), act({ question_id: 'hot-bill', kind: 'commits' })],
      }),
    })
    await searchNews(s.env, await tracker(), NOW)
    expect((await itemsFor(url)).map((i) => i.question_id)).toEqual(['hot-bill'])
    expect((await notesFor(url))[0].body).toContain('2 more acts were left out')
  })

  it('queues nothing when the model finds no act', async () => {
    const url = 'https://news.example/read-nothing'
    const s = stubbed({ hits: [hit(url)], pages: { [url]: page('Ann Alpha was seen at the ribbon cutting.') }, answer: () => ({ acts: [] }) })
    await searchNews(s.env, await tracker(), NOW)
    expect(await proposalsFor(url)).toEqual([])
    expect(await readsOf(url)).toEqual([{ question_id: 'hot', outcome: 'no_acts', model: MODEL, detail: null }])
  })

  it.each([
    ['the site refuses the fetch', 403, () => ({ acts: [] }), 'The site answered 403.', 'refused'],
    ['the page is gone', 404, () => ({ acts: [] }), 'The site answered 404.', 'unreachable'],
    ['the page has almost no text', '<html><body>Subscribe</body></html>', () => ({ acts: [] }), 'The page has almost no text', 'no_text'],
    ['the model call fails', page('Words.'), () => new Error('3040: capacity'), 'The model call failed (Error: 3040: capacity).', 'model_failed'],
    ['the model answers with something that is not JSON', page('Words.'), () => 'Sure! Here are the acts:', "The model's answer did not fit the expected shape", 'model_failed'],
    ['the model answers in the wrong shape', page('Words.'), () => ({ statements: [] }), "The model's answer did not fit the expected shape", 'model_failed'],
  ])('falls back to the search excerpt, with why the article was not read, when %s', async (name, body, answer, reason, unread) => {
    const url = `https://news.example/read-fallback-${name.replaceAll(' ', '-')}`
    const s = stubbed({ hits: [hit(url)], pages: { [url]: body }, answer })
    await searchNews(s.env, await tracker(), NOW)
    expect(await proposalsFor(url)).toEqual([expect.objectContaining({ origin: 'news_search', unread })])
    expect(await itemsFor(url)).toEqual([expect.objectContaining({ decider_id: 'ann', reading: null, weight: null, passage: null, quote: 'Rep. Alpha spoke about the plan this week.' })])
    expect((await notesFor(url))[0].body).toContain(`The article was not read: ${reason}`)
    expect(await readsOf(url)).toEqual([expect.objectContaining({ outcome: 'not_read', model: null })])
  })

  it('does not fetch or read the same article for the same question again', async () => {
    const url = 'https://news.example/read-twice'
    const first = stubbed({ hits: [hit(url)], pages: { [url]: page('Nothing of note.') }, answer: () => ({ acts: [] }) })
    await searchNews(first.env, await tracker(), NOW)
    expect(first.fetcher).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()

    const second = stubbed({ hits: [hit(url)], pages: {}, answer: () => ({ acts: [] }) })
    const report = await searchNews(second.env, await tracker(), NOW)
    expect(second.fetcher).not.toHaveBeenCalled()
    expect(second.run).not.toHaveBeenCalled()
    expect(report.questions[0]).toMatchObject({ read: 0, queued: 0 })
  })

  it('does not read an article already proposed from on the question before the read log existed', async () => {
    const url = 'https://news.example/read-old-lead'
    await (await tracker()).propose({ source: { url, title: null }, note: null, items: [{ question_id: 'hot', decider_id: 'ann', kind: 'says', occurred_on: null, quote: 'An old search excerpt.', reading: null }] }, 'news_search')
    const s = stubbed({ hits: [hit(url)], pages: {}, answer: () => ({ acts: [] }) })
    await searchNews(s.env, await tracker(), NOW)
    expect(s.fetcher).not.toHaveBeenCalled()
  })

  it('reads at most MAX_READS_PER_RUN articles in a run and leaves the rest for the next', async () => {
    const urls = Array.from({ length: MAX_READS_PER_RUN + 3 }, (_, i) => `https://news.example/cap-${i}`)
    const pages = Object.fromEntries(urls.map((u) => [u, page('Nothing of note.')]))
    const first = stubbed({ hits: urls.map((u) => hit(u)), pages, answer: () => ({ acts: [] }) })
    const report = await searchNews(first.env, await tracker(), NOW)
    expect(first.fetcher).toHaveBeenCalledTimes(MAX_READS_PER_RUN)
    expect(report.questions[0].read).toBe(MAX_READS_PER_RUN)
    // Every query returns the same hits; each one left over is counted once.
    expect(report.deferred).toBe(3)
    vi.restoreAllMocks()

    const second = stubbed({ hits: urls.map((u) => hit(u)), pages, answer: () => ({ acts: [] }) })
    await searchNews(second.env, await tracker(), NOW)
    expect(second.fetcher.mock.calls.map(([u]) => String(u))).toEqual(urls.slice(MAX_READS_PER_RUN))
  })
})

describe('the publish date', () => {
  const PUBLISHED = '<meta property="article:published_time" content="2018-07-19" />'
  const said = 'Ann Alpha said: “I will vote for this bill when it reaches the floor.”'
  const sourceOf = async (url: string) => (await rows<{ published_on: string | null; published_on_from: string | null }>(`SELECT published_on, published_on_from FROM sources WHERE url = ?`, url))[0]
  const promptOf = (s: ReturnType<typeof stubbed>) => s.run.mock.calls[0][1].messages[1].content

  it('stores the page’s own date on the source and gives it to the model in place of the search date', async () => {
    const url = 'https://news.example/date-page'
    const s = stubbed({ hits: [hit(url)], pages: { [url]: page(said, PUBLISHED) }, answer: () => ({ acts: [act({ occurred_on: null })] }) })
    await searchNews(s.env, await tracker(), NOW)
    expect(await sourceOf(url)).toEqual({ published_on: '2018-07-19', published_on_from: 'page' })
    expect(promptOf(s)).toContain(`${url}\nPublished 2018-07-19, according to the page`)
    expect(promptOf(s)).not.toContain('2026-11-17')
    // The rule that an act's date is not the article's still stands.
    expect(s.run.mock.calls[0][1].messages[0].content).toContain("This is not the article's date unless the article says the act happened that day")
  })

  it('falls back to the search result’s date, and says what it is', async () => {
    const url = 'https://news.example/date-search'
    const s = stubbed({ hits: [hit(url)], pages: { [url]: page(said) }, answer: () => ({ acts: [act()] }) })
    await searchNews(s.env, await tracker(), NOW)
    expect(await sourceOf(url)).toEqual({ published_on: '2026-11-17', published_on_from: 'search' })
    expect(promptOf(s)).toContain('Dated 2026-11-17 by the search results, which may be when the page last changed')
  })

  it('keeps an article the model found nothing in as a source, with its title and date, and points the read at it', async () => {
    const url = 'https://news.example/date-nothing-found'
    const s = stubbed({ hits: [hit(url, 'Ann Alpha on something else')], pages: { [url]: page(said, PUBLISHED) }, answer: () => ({ acts: [] }) })
    await searchNews(s.env, await tracker(), NOW)
    expect(await proposalsFor(url)).toEqual([])
    expect(await rows(`SELECT title, published_on, published_on_from FROM sources WHERE url = ?`, url)).toEqual([{ title: 'Ann Alpha on something else', published_on: '2018-07-19', published_on_from: 'page' }])
    expect(await readsOf(url)).toEqual([expect.objectContaining({ question_id: 'hot', outcome: 'no_acts' })])
  })

  it('tells the model when no date is known', async () => {
    const url = 'https://news.example/date-none'
    const s = stubbed({ hits: [{ ...hit(url), lastModifiedDate: undefined }], pages: { [url]: page(said) }, answer: () => ({ acts: [act()] }) })
    await searchNews(s.env, await tracker(), NOW)
    expect(await sourceOf(url)).toEqual({ published_on: null, published_on_from: null })
    expect(promptOf(s)).toContain(`${url}\nPublish date not known`)
  })

  it('dates a lead from the page when the page was fetched but not read', async () => {
    const url = 'https://news.example/date-lead'
    const s = stubbed({ hits: [hit(url)], pages: { [url]: `<html><head>${PUBLISHED}</head><body><p>Subscribe to read this story.</p></body></html>` }, answer: () => ({ acts: [] }) })
    await searchNews(s.env, await tracker(), NOW)
    expect(await proposalsFor(url)).toEqual([expect.objectContaining({ origin: 'news_search', unread: 'no_text' })])
    expect(await sourceOf(url)).toEqual({ published_on: '2018-07-19', published_on_from: 'page' })
    expect(await itemsFor(url)).toEqual([expect.objectContaining({ occurred_on: '2018-07-19' })])
    expect(s.run).not.toHaveBeenCalled()
  })

  it('fills in a source on file with no date, and replaces a search date with the page’s', async () => {
    const empty = 'https://news.example/date-fill'
    const searched = 'https://news.example/date-upgrade'
    await env.DB.prepare(
      `INSERT INTO sources (id, url, title, published_on, published_on_from, created_at) VALUES ('src-fill', ?1, 'On file', NULL, NULL, '2026-01-01'), ('src-upgrade', ?2, 'On file', '2026-11-01', 'search', '2026-01-01')`,
    )
      .bind(empty, searched)
      .run()
    const s = stubbed({ hits: [hit(empty), hit(searched)], pages: { [empty]: page(said, PUBLISHED), [searched]: page(said, PUBLISHED) }, answer: () => ({ acts: [act()] }) })
    await searchNews(s.env, await tracker(), NOW)
    expect(await sourceOf(empty)).toEqual({ published_on: '2018-07-19', published_on_from: 'page' })
    expect(await sourceOf(searched)).toEqual({ published_on: '2018-07-19', published_on_from: 'page' })
  })

  it('does not overwrite a date an editor set, or an editor’s word that the date is not known', async () => {
    const dated = 'https://news.example/date-editor'
    const unknown = 'https://news.example/date-editor-unknown'
    await env.DB.prepare(
      `INSERT INTO sources (id, url, title, published_on, published_on_from, created_at) VALUES ('src-editor', ?1, 'On file', '2018-07-20', 'editor', '2026-01-01'), ('src-editor-unknown', ?2, 'On file', NULL, 'editor', '2026-01-01')`,
    )
      .bind(dated, unknown)
      .run()
    const s = stubbed({ hits: [hit(dated), hit(unknown)], pages: { [dated]: page(said, PUBLISHED), [unknown]: page(said, PUBLISHED) }, answer: () => ({ acts: [act()] }) })
    await searchNews(s.env, await tracker(), NOW)
    expect(await sourceOf(dated)).toEqual({ published_on: '2018-07-20', published_on_from: 'editor' })
    expect(await sourceOf(unknown)).toEqual({ published_on: null, published_on_from: 'editor' })
  })

  it('reads the date of a page a reader sends in, after answering them', async () => {
    const url = 'https://news.example/date-reader'
    const { send } = await reader('dater@reader.test')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(page(said, PUBLISHED), { headers: { 'content-type': 'text/html' } }))
    const res = await send('/api/proposals', proposal({ source_url: url, quote: 'I will vote for this bill when it reaches the floor.' }))
    expect(res.status).toBe(200)
    // The date is read in waitUntil, after the answer.
    await until(async () => (await sourceOf(url))?.published_on_from === 'page')
    expect(await sourceOf(url)).toEqual({ published_on: '2018-07-19', published_on_from: 'page' })
    expect(fetcher).toHaveBeenCalledWith(url, expect.anything())
  })
})

describe('the steps a run reports', () => {
  it('says what it searched, which article it is reading, and how each read ended', async () => {
    const urls = ['https://news.example/steps-acts', 'https://news.example/steps-none', 'https://news.example/steps-refused']
    const s = stubbed({
      hits: urls.map((u) => hit(u)),
      pages: { [urls[0]]: page('Ann Alpha said: “I will vote for this bill when it reaches the floor.”'), [urls[1]]: page('Nothing of note.'), [urls[2]]: 403 },
      answer: (prompt) => (prompt.includes('I will vote') ? { acts: [act()] } : { acts: [] }),
    })
    const steps: NewsStep[] = []
    await searchNews(s.env, await tracker(), NOW, (step) => steps.push(step))

    expect(steps[0]).toEqual({ kind: 'plan', questions: ['Hot Topic', 'Closing Topic'], queriesPerQuestion: 4, maxReads: MAX_READS_PER_RUN })
    expect(steps.filter((st) => st.kind === 'searched')).toHaveLength(8)
    expect(steps[1]).toMatchObject({ kind: 'searched', question: 'Hot Topic', hits: 3, named: 3 })
    const reads = steps.filter((st) => st.kind === 'reading' || st.kind === 'read').map((st) => [st.kind, st.url, st.kind === 'read' ? st.outcome : null])
    expect(reads).toEqual([
      ['reading', urls[0], null],
      ['read', urls[0], 'queued'],
      ['reading', urls[1], null],
      ['read', urls[1], 'nothing'],
      ['reading', urls[2], null],
      ['read', urls[2], 'lead'],
    ])
  })
})

describe('when queueing fails', () => {
  it('does not record the read, so the next run tries again', async () => {
    const url = 'https://news.example/queue-fails'
    const s = stubbed({ hits: [hit(url)], pages: { [url]: page('Ann Alpha said: “I will vote for this bill when it reaches the floor.”') }, answer: () => ({ acts: [act()] }) })
    const room = await tracker()
    const failing = { propose: async () => ({ ok: false as const, status: 400, error: 'Unknown question or decider.' }), catalogue: (source: ProposalDraft['source']) => room.catalogue(source) }
    const steps: NewsStep[] = []
    const report = await searchNews(s.env, failing, NOW, (step) => steps.push(step))
    expect(report.questions[0]).toMatchObject({ read: 1, queued: 0, failed: 1 })
    expect(steps).toContainEqual(expect.objectContaining({ kind: 'read', url, outcome: 'failed', detail: 'Unknown question or decider.' }))
    expect(await readsOf(url)).toEqual([])
  })

  it('does not record the read when queueing throws, and carries on with the rest of the run', async () => {
    const urls = ['https://news.example/queue-throws-0', 'https://news.example/queue-throws-1']
    const s = stubbed({ hits: urls.map((u) => hit(u)), pages: Object.fromEntries(urls.map((u) => [u, page('Ann Alpha said: “I will vote for this bill when it reaches the floor.”')])), answer: () => ({ acts: [act()] }) })
    const room = await tracker()
    const propose = vi.fn(async (draft: ProposalDraft, origin: Proposal['origin']) => (propose.mock.calls.length === 1 ? Promise.reject(new Error('D1 is down')) : room.propose(draft, origin)))
    const report = await searchNews(s.env, { propose, catalogue: (source) => room.catalogue(source) }, NOW)
    expect(propose).toHaveBeenCalledTimes(2)
    expect(report.error).toBeUndefined()
    expect(report.questions[0]).toMatchObject({ read: 2, queued: 1, failed: 1 })
    expect(await readsOf(urls[0])).toEqual([])
    expect(await readsOf(urls[1])).toEqual([expect.objectContaining({ outcome: 'queued' })])
  })

  it('records an article whose every act was already proposed as having nothing new', async () => {
    const url = 'https://news.example/queue-nothing-new'
    const s = stubbed({ hits: [hit(url)], pages: { [url]: page('Ann Alpha said: “I will vote for this bill when it reaches the floor.”') }, answer: () => ({ acts: [act()] }) })
    const room = await tracker()
    const nothingNew = { propose: async (draft: ProposalDraft) => ({ ok: true as const, queued: 0, proposal_id: null, source_id: await room.catalogue(draft.source), undated: false }), catalogue: (source: ProposalDraft['source']) => room.catalogue(source) }
    await searchNews(s.env, nothingNew, NOW)
    expect(await readsOf(url)).toEqual([expect.objectContaining({ outcome: 'no_acts' })])
  })
})

describe('when a model call fails', () => {
  it('falls back for that article and leaves the rest of the run for the next one', async () => {
    const urls = ['https://news.example/down-0', 'https://news.example/down-1', 'https://news.example/down-2']
    const pages = Object.fromEntries(urls.map((u) => [u, page('Nothing of note.')]))
    const first = stubbed({ hits: urls.map((u) => hit(u)), pages, answer: () => new Error('2016: spending limit reached') })
    const report = await searchNews(first.env, await tracker(), NOW)
    expect(first.run).toHaveBeenCalledTimes(1)
    expect(report.error).toBe('Stopped reading articles: The model call failed (Error: 2016: spending limit reached).')
    expect(await proposalsFor(urls[0])).toEqual([expect.objectContaining({ origin: 'news_search' })])
    expect(await readsOf(urls[1])).toEqual([])
    vi.restoreAllMocks()

    const second = stubbed({ hits: urls.map((u) => hit(u)), pages, answer: () => ({ acts: [] }) })
    await searchNews(second.env, await tracker(), NOW)
    expect(second.fetcher.mock.calls.map(([u]) => String(u))).toEqual(urls.slice(1))
  })
})

const resetQueue = () => env.DB.prepare(`UPDATE proposals SET status = 'reviewed', reviewed_at = '2026-01-01T00:00:00Z'`).run()

describe('queueIsAttended', () => {
  const at = (iso: string) => new Date(iso)
  // Each case starts from a queue with nothing pending and nothing reviewed
  // lately, then adds what it needs.
  const clearQueue = resetQueue
  const pending = async (origin: string) => {
    const id = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sources (id, url, created_at) VALUES (?, ?, '2026-11-18T00:00:00Z')`).bind(id, `https://news.example/queue-${id}`),
      env.DB.prepare(`INSERT INTO proposals (id, source_id, origin, status, created_at) VALUES (?, ?, ?, 'pending', '2026-11-18T00:00:00Z')`).bind(id, id, origin),
    ])
    return id
  }
  const review = (id: string, when: string) => env.DB.prepare(`UPDATE proposals SET status = 'reviewed', reviewed_at = ? WHERE id = ?`).bind(when, id).run()

  it('goes ahead when nothing automated is waiting', async () => {
    await clearQueue()
    expect(await queueIsAttended(env.DB, NOW)).toBe(true)
  })

  it('is not held up by proposals readers leave waiting', async () => {
    await clearQueue()
    await pending('reader')
    await pending('reader')
    expect(await queueIsAttended(env.DB, NOW)).toBe(true)
  })

  it('holds back while automated leads wait and none was reviewed in the last day', async () => {
    await clearQueue()
    await pending('news_search')
    await pending('model')
    expect(await queueIsAttended(env.DB, NOW)).toBe(false)
  })

  it('goes ahead for a day after an editor reviews an automated lead', async () => {
    await clearQueue()
    await pending('model')
    await review(await pending('news_search'), '2026-11-19T02:00:00Z')
    expect(await queueIsAttended(env.DB, at('2026-11-19T12:00:00Z'))).toBe(true)
    expect(await queueIsAttended(env.DB, at('2026-11-20T12:00:00Z'))).toBe(false)
  })

  it('does not count a review of a reader proposal as attending to the news leads', async () => {
    await clearQueue()
    await pending('model')
    await review(await pending('reader'), '2026-11-19T02:00:00Z')
    expect(await queueIsAttended(env.DB, NOW)).toBe(false)
  })
})

describe('the scheduled run', () => {
  const runs = () => rows<{ started_by: string; outcome: string; detail: string }>(`SELECT started_by, outcome, detail FROM news_runs`)
  beforeEach(() => env.DB.prepare(`DELETE FROM news_runs`).run())
  const fire = (on: Env = env) => worker.scheduled(createScheduledController({ scheduledTime: NOW, cron: NEWS_CRON }), on)
  const queueLead = async (url: string) =>
    (await tracker()).propose({ source: { url, title: null }, note: null, items: [{ question_id: 'hot', decider_id: 'ann', kind: 'says', occurred_on: null, quote: 'A lead nobody has looked at.', reading: null }] }, 'news_search')

  it('does not search while the queue is unattended, and records the skip with how many proposals are waiting and when one was last reviewed', async () => {
    await resetQueue()
    await queueLead('https://news.example/scheduled-waiting')
    const websearch = vi.spyOn(env.AI, 'websearch')
    await fire()
    expect(websearch).not.toHaveBeenCalled()
    expect(await runs()).toEqual([{ started_by: 'cron', outcome: 'skipped', detail: '1 automated proposal is waiting, and the last was reviewed at 2026-01-01T00:00:00Z.' }])
  })

  it('searches once the queue is attended, and records the run with its report', async () => {
    await env.DB.prepare(`UPDATE proposals SET status = 'reviewed', reviewed_at = '2026-11-19T02:00:00Z' WHERE status = 'pending'`).run()
    const websearch = vi.spyOn(env.AI, 'websearch').mockImplementation(async () => Response.json({ items: [] }))
    await fire()
    expect(websearch).toHaveBeenCalled()
    const [run] = await runs()
    expect(run).toMatchObject({ started_by: 'cron', outcome: 'searched' })
    expect(JSON.parse(run.detail)).toMatchObject({ deferred: 0, questions: expect.arrayContaining([expect.objectContaining({ question: 'Hot Topic', read: 0 })]) })
    // Its steps are recorded in order, starting with the plan.
    const steps = await rows<{ step: string }>(`SELECT s.step FROM news_run_steps s JOIN news_runs r ON r.id = s.run_id WHERE r.started_by = 'cron' ORDER BY s.seq`)
    expect(steps.map((r) => JSON.parse(r.step).kind)).toEqual(['plan', ...Array(websearch.mock.calls.length).fill('searched')])
  })

  it('records a run whose search failed as stopped', async () => {
    await resetQueue()
    vi.spyOn(env.AI, 'websearch').mockImplementation(async () => new Response('quota', { status: 429 }))
    await fire()
    expect(await runs()).toEqual([expect.objectContaining({ started_by: 'cron', outcome: 'stopped', detail: expect.stringContaining('Web search failed (429: quota)') })])
  })

  it('records a run that threw, and still throws', async () => {
    await resetQueue()
    const broken = { ...env, DB: { prepare: (sql: string) => (sql.includes('q.is_hot = 1') ? { bind: () => ({ all: () => Promise.reject(new Error('D1 is down')) }) } : env.DB.prepare(sql)), batch: env.DB.batch.bind(env.DB) } } as unknown as Env
    await expect(fire(broken)).rejects.toThrow('D1 is down')
    expect(await runs()).toEqual([{ started_by: 'cron', outcome: 'failed', detail: 'Error: D1 is down' }])
  })

  it('records a run an editor started, which goes ahead whatever the queue', async () => {
    await resetQueue()
    await queueLead('https://news.example/editor-run-recorded')
    const websearch = vi.spyOn(env.AI, 'websearch').mockImplementation(async () => Response.json({ items: [] }))
    await runNewsSearch(env, await tracker(), 'editor', NOW)
    expect(websearch).toHaveBeenCalled()
    expect(await runs()).toEqual([expect.objectContaining({ started_by: 'editor', outcome: 'searched' })])
  })
})

describe('fetchArticle', () => {
  const ai = () => ({ toMarkdown: vi.fn(async (doc: { blob: Blob }) => ({ format: 'text', data: await doc.blob.text() })) })
  const serve = (response: () => Response) => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
  const body = (bytes: number) => 'a'.repeat(bytes)

  it('refuses a page whose declared size is over the limit, without reading it', async () => {
    serve(() => new Response(body(10), { headers: { 'content-type': 'text/html', 'content-length': String(MAX_BYTES + 1) } }))
    const AI = ai()
    expect(await fetchArticle({ AI } as unknown as Env, 'https://news.example/huge', TODAY)).toEqual({ ok: false, unread: 'not_an_article', reason: 'The page is too large to read.' })
    expect(AI.toMarkdown).not.toHaveBeenCalled()
  })

  it('stops reading a page with no declared size once it passes the limit', async () => {
    const chunk = new TextEncoder().encode(body(1_000_000))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++
        controller.enqueue(chunk)
      },
    })
    serve(() => new Response(stream, { headers: { 'content-type': 'text/html' } }))
    const AI = ai()
    expect(await fetchArticle({ AI } as unknown as Env, 'https://news.example/endless', TODAY)).toEqual({ ok: false, unread: 'not_an_article', reason: 'The page is too large to read.' })
    expect(sent).toBeLessThan(10)
    expect(AI.toMarkdown).not.toHaveBeenCalled()
  })

  it('refuses something that is not an article without converting it', async () => {
    serve(() => new Response(body(5000), { headers: { 'content-type': 'image/png' } }))
    const AI = ai()
    expect(await fetchArticle({ AI } as unknown as Env, 'https://news.example/picture', TODAY)).toMatchObject({ ok: false, unread: 'not_an_article' })
    expect(AI.toMarkdown).not.toHaveBeenCalled()
  })

  it('reports a conversion that fails or throws as a page it could not read', async () => {
    serve(() => new Response(page('Words.'), { headers: { 'content-type': 'text/html' } }))
    const failing = { toMarkdown: async () => ({ format: 'error', error: 'unsupported' }) }
    expect(await fetchArticle({ AI: failing } as unknown as Env, 'https://news.example/a', TODAY)).toMatchObject({ ok: false, unread: 'no_text', reason: expect.stringContaining('unsupported') })
    const throwing = { toMarkdown: async () => Promise.reject(new Error('binding down')) }
    expect(await fetchArticle({ AI: throwing } as unknown as Env, 'https://news.example/a', TODAY)).toMatchObject({ ok: false, unread: 'no_text', reason: expect.stringContaining('binding down') })
  })

  it.each([401, 403, 429])('says the site refused when it answers %i', async (status) => {
    serve(() => new Response('no', { status }))
    expect(await fetchArticle({ AI: ai() } as unknown as Env, 'https://news.example/a', TODAY)).toEqual({ ok: false, unread: 'refused', reason: `The site answered ${status}.` })
  })

  it.each([404, 500, 503])('says the page could not be reached when the site answers %i', async (status) => {
    serve(() => new Response('no', { status }))
    expect(await fetchArticle({ AI: ai() } as unknown as Env, 'https://news.example/a', TODAY)).toEqual({ ok: false, unread: 'unreachable', reason: `The site answered ${status}.` })
  })

  it('says the page could not be reached when the fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'))
    expect(await fetchArticle({ AI: ai() } as unknown as Env, 'https://news.example/a', TODAY)).toMatchObject({ ok: false, unread: 'unreachable', reason: expect.stringContaining('connection reset') })
  })

  it('says the page gave no text when what is left of it is a few words', async () => {
    serve(() => new Response('Subscribe to read this story.', { headers: { 'content-type': 'text/plain' } }))
    expect(await fetchArticle({ AI: ai() } as unknown as Env, 'https://news.example/a', TODAY)).toMatchObject({ ok: false, unread: 'no_text' })
  })

  it('leaves out the metadata the converter puts before the page text', async () => {
    serve(() => new Response(page('Words.'), { headers: { 'content-type': 'text/html' } }))
    const story = `Sen. Ann Alpha, chair of the Health, Labor & Pensions committee, said she would vote for it.${FILLER}`
    const converting = { toMarkdown: async () => ({ format: 'text', data: `title: Alpha backs the plan\ndescription: Health, Labor &amp; Pensions chair backs it\nimage: https://news.example/a.jpg\n\nAlpha backs the plan\n\n${story}` }) }
    const article = await fetchArticle({ AI: converting } as unknown as Env, 'https://news.example/a', TODAY)
    expect(article).toMatchObject({ ok: true })
    expect(article.ok && article.text).toBe(`Alpha backs the plan\n\n${story}`)
  })

  it('leaves out a metadata header with an empty value or a namespaced key', async () => {
    serve(() => new Response(page('Words.'), { headers: { 'content-type': 'text/html' } }))
    const story = `Ann Alpha said she would vote for it.${FILLER}`
    const converting = { toMarkdown: async () => ({ format: 'text', data: `title: Alpha backs the plan\ndescription:\nog:image: https://news.example/a.jpg\n\n${story}` }) }
    const article = await fetchArticle({ AI: converting } as unknown as Env, 'https://news.example/a', TODAY)
    expect(article.ok && article.text).toBe(story.replace(/[ \t]+/g, ' ').trim())
  })

  it('keeps an opening line that only looks like metadata when no blank line closes it', async () => {
    serve(() => new Response(page('Words.'), { headers: { 'content-type': 'text/html' } }))
    const data = `note: the vote was close.${FILLER}`
    const converting = { toMarkdown: async () => ({ format: 'text', data }) }
    expect(await fetchArticle({ AI: converting } as unknown as Env, 'https://news.example/a', TODAY)).toMatchObject({ ok: true, text: data.replace(/[ \t]+/g, ' ').trim() })
  })

  it('gives the date an HTML page states, and none for plain text', async () => {
    serve(() => new Response(page('Ann Alpha said she would vote for it.', '<meta property="article:published_time" content="2018-07-19" />'), { headers: { 'content-type': 'text/html' } }))
    expect(await fetchArticle({ AI: ai() } as unknown as Env, 'https://news.example/a', TODAY)).toMatchObject({ ok: true, published: { on: '2018-07-19', from: 'page' } })
  })

  it('reads a page of plain text without converting it', async () => {
    const text = `Ann Alpha said she would vote for it.\n${FILLER.trim()}`
    serve(() => new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
    const AI = ai()
    expect(await fetchArticle({ AI } as unknown as Env, 'https://news.example/a', TODAY)).toEqual({ ok: true, text, truncated: false, published: null })
    expect(AI.toMarkdown).not.toHaveBeenCalled()
  })
})

describe('Tracker.propose', () => {
  it('cuts a note to a bounded length', async () => {
    const url = 'https://news.example/long-note'
    await (await tracker()).propose({ source: { url, title: null }, note: 'n'.repeat(50_000), items: [{ question_id: 'hot', decider_id: 'ann', kind: 'says', occurred_on: null, quote: 'Some words from it.', reading: null, note: 'i'.repeat(50_000) }] }, 'model')
    const notes = await notesFor(url)
    expect(notes).toHaveLength(2)
    for (const n of notes) expect(n.body.length).toBeLessThanOrEqual(4000)
  })
})

describe('dryRunArticle', () => {
  it('returns what would be queued and writes nothing', async () => {
    const url = 'https://news.example/dry-run'
    const s = stubbed({
      hits: [],
      pages: { [url]: page('Ann Alpha said: “I will vote for this bill when it reaches the floor.” Dan Delta was there too.') },
      answer: () => ({ acts: [act()] }),
    })
    const count = () => rows(`SELECT (SELECT COUNT(*) FROM proposals) AS p, (SELECT COUNT(*) FROM article_reads) AS r`)
    const before = await count()
    const result = await dryRunArticle(s.env, url, 'hot', NOW)
    expect(result).toMatchObject({ outcome: 'acts', model: MODEL, people: ['Ann Alpha'] })
    expect('draft' in result && result.draft.items).toEqual([expect.objectContaining({ decider_id: 'ann', quote: 'I will vote for this bill when it reaches the floor' })])
    expect(await count()).toEqual(before)
  })

  it('says why when the article could not be read', async () => {
    const url = 'https://news.example/dry-run-refused'
    const s = stubbed({ hits: [], pages: { [url]: 403 }, answer: () => ({ acts: [] }) })
    expect(await dryRunArticle(s.env, url, 'hot', NOW)).toMatchObject({ outcome: 'not_read', unread: 'refused', reason: 'The site answered 403.' })
    expect(s.run).not.toHaveBeenCalled()
  })

  it('says so when the article names nobody on the roster', async () => {
    const url = 'https://news.example/dry-run-nobody'
    const s = stubbed({ hits: [], pages: { [url]: page('Dan Delta was there.') }, answer: () => ({ acts: [] }) })
    expect(await dryRunArticle(s.env, url, 'hot', NOW)).toMatchObject({ outcome: 'no_people' })
    expect(s.run).not.toHaveBeenCalled()
  })
})
