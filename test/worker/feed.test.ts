import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { EDITORS_ID } from '../../shared/schema.ts'
import { type Frame, partySocket, postAs, proposal, reader, rows, seed, until, noOutsidePages, claims, editorsSay } from './helpers.ts'

const rowsOn = (frames: Frame[], channel: string) => frames.filter((f) => f.channel === channel).flatMap((f) => f.ops.map((op) => op.value))
const storyIds = (xml: string) => [...xml.matchAll(/<id>urn:sporelight:story:([^:<]+):[^<]+<\/id>/g)].map((m) => m[1])
const feed = (query = '') => exports.default.fetch(`http://sporelight.test/feed.xml${query}`)

const PUBLISHED = `<b>"Medicare" & 'you'</b>\u0007 — I am for it.`
const WAITING = 'A pending claim nobody has checked yet, with a reading.'
const REJECTED = 'A claim an editor turned down after reading the source.'

// Two published stories. The first source reports Ann on the hot question and
// its measure, and Bob on the hot question. The second reports Ann on the cold
// question. A pending proposal and a rejected one sit beside them.
let send: ReturnType<typeof postAs>

beforeAll(async () => {
  noOutsidePages()
  await seed()
  send = (await reader('feed@reader.test')).send
  await env.DB.batch(
    [
      `INSERT INTO questions (id, slug, body_id, parent_id, kind, title, short_title, is_hot, status, implies_on_parent) VALUES
        ('hot-bill', 'hot-bill', 'congress', 'hot', 'formal_act', 'Have they cosponsored the bill?', 'Bill', 0, 'open', 'support')`,
      `INSERT INTO sources (id, url, title, created_at) VALUES
        ('src-1', 'https://news.example/a?x=1&y=2', 'Ann <signs> on', '2026-11-10T00:00:00.000Z'),
        ('src-2', 'https://news.example/b', NULL, '2026-11-11T00:00:00.000Z')`,
      `INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES
        ('act-hot', 'ann', 'says', '2026-11-09', ?1, '2026-11-10T09:00:00.000Z'),
        ('act-cold', 'ann', 'does', '2026-11-01', 'Voted to table the cold motion.', '2026-11-11T09:00:00.000Z'),
        ('act-bob', 'bob', 'says', '2026-11-08', 'I will vote against it.', '2026-11-10T09:00:00.000Z')`,
      `INSERT INTO reports (id, source_id, act_id, created_at) VALUES
        ('rep-1', 'src-1', 'act-hot', '2026-11-10T09:00:00.000Z'), ('rep-2', 'src-2', 'act-cold', '2026-11-11T09:00:00.000Z'),
        ('rep-3', 'src-1', 'act-bob', '2026-11-10T09:00:00.000Z')`,
      `INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, created_at, updated_at) VALUES
        ('rd-1', '${EDITORS_ID}', 'act-hot', 'hot-bill', 'support', 'clear', '2026-11-10T09:00:00.000Z', '2026-11-10T09:00:00.000Z'),
        ('rd-3', '${EDITORS_ID}', 'act-cold', 'cold', 'oppose', 'passing', '2026-11-11T09:00:00.000Z', '2026-11-11T09:00:00.000Z'),
        ('rd-4', '${EDITORS_ID}', 'act-bob', 'hot', 'oppose', 'clear', '2026-11-10T09:00:00.000Z', '2026-11-10T09:00:00.000Z')`,
    ].map((sql) => (sql.includes('?1') ? env.DB.prepare(sql).bind(PUBLISHED) : env.DB.prepare(sql))),
  )
  for (const [quote, url] of [
    [WAITING, 'https://news.example/waiting'],
    [REJECTED, 'https://news.example/rejected'],
  ]) {
    expect(await (await send('/api/proposals', proposal({ quote, source_url: url }))).json()).toMatchObject({ ok: true, duplicate: false })
  }
  const rejected = (await claims()).find((c) => c.quote === REJECTED)!
  await editorsSay(rejected.id, null)
})

describe('GET /feed.xml', () => {
  it('serves Atom with one entry per story, newest into the record first', async () => {
    const res = await feed()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/atom+xml; charset=utf-8')
    const xml = await res.text()
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/)
    expect(storyIds(xml)).toEqual(['src-2', 'src-1'])
    expect(xml).toContain('<updated>2026-11-11T09:00:00.000Z</updated>')
    expect(xml).toContain('<title>Ann &lt;signs&gt; on (2 people)</title>')
    expect(xml).toContain('<link rel="related" type="text/html" title="Ann Alpha" href="http://sporelight.test/p/ann-alpha"/>')
    expect(xml).toContain('<link rel="related" type="text/html" title="Bob Beta" href="http://sporelight.test/p/bob-beta"/>')
  })

  it('carries nothing that is waiting for review or was rejected', async () => {
    const xml = await (await feed()).text()
    expect((await claims()).filter((c) => c.quote === WAITING).map((c) => c.verdict)).toEqual(['waiting'])
    expect(xml).not.toContain(WAITING)
    expect(xml).not.toContain(REJECTED)
    expect(xml).not.toContain('news.example/waiting')
    expect(xml).not.toContain('news.example/rejected')
  })

  it('escapes the words, titles and links it carries and drops characters XML cannot hold', async () => {
    const xml = await (await feed()).text()
    expect(xml).toContain('“&lt;b&gt;&quot;Medicare&quot; &amp; &apos;you&apos;&lt;/b&gt; — I am for it.”')
    expect(xml).toContain('href="https://news.example/a?x=1&amp;y=2"')
    expect(xml).toContain('Source: Ann &lt;signs&gt; on https://news.example/a?x=1&amp;y=2')
    expect(xml).not.toContain('<b>')
    expect(xml).not.toContain('\u0007')
  })

  it('says who is in each story and what each act shows on each question', async () => {
    const xml = await (await feed()).text()
    expect(xml).toContain('Bill: Signed on\nHot Topic: Yes (through Bill)\nhttp://sporelight.test/q/hot-bill/ann-alpha')
    expect(xml).toContain('Bob Beta, statement on 2026-11-08:\n“I will vote against it.”\nHot Topic: No\n')
  })

  it('marks a passing reading as a signal', async () => {
    const xml = await (await feed()).text()
    expect(xml).toContain('Cold Topic: No (a signal)')
    expect(xml).not.toContain('Hot Topic: No (a signal)')
  })

  it('gives the archived copy beside a source that has one', async () => {
    await env.DB.prepare(`UPDATE sources SET archive_url = ? WHERE id = 'src-2'`).bind('https://web.archive.org/web/20261111000000/https://news.example/b').run()
    // An earlier test's response is still in the five-minute cache.
    await caches.default.delete(new Request('http://sporelight.test/feed.xml'))
    const xml = await (await feed()).text()
    expect(xml).toContain('Source: news.example (Publish date not known) (archived: https://web.archive.org/web/20261111000000/https://news.example/b)')
    expect(xml).toContain('Source: Ann &lt;signs&gt; on https://news.example/a?x=1&amp;y=2 (Publish date not known)</content>')
    await env.DB.prepare(`UPDATE sources SET archive_url = NULL WHERE id = 'src-2'`).run()
    await caches.default.delete(new Request('http://sporelight.test/feed.xml'))
  })

  it('gives the source’s publish date in the title and beside the source', async () => {
    await env.DB.prepare(`UPDATE sources SET published_on = '2018-07-19', published_on_from = 'page' WHERE id = 'src-1'`).run()
    await caches.default.delete(new Request('http://sporelight.test/feed.xml'))
    const xml = await (await feed()).text()
    expect(xml).toContain('<title>Ann &lt;signs&gt; on (Published 2018-07-19; 2 people)</title>')
    expect(xml).toContain('Source: Ann &lt;signs&gt; on https://news.example/a?x=1&amp;y=2 (Published 2018-07-19)')
    // The entry's own times stay the day it entered the record.
    expect(xml).toContain('<published>2026-11-10T09:00:00.000Z</published>')
    await env.DB.prepare(`UPDATE sources SET published_on = NULL, published_on_from = NULL WHERE id = 'src-1'`).run()
    await caches.default.delete(new Request('http://sporelight.test/feed.xml'))
  })

  it('takes a question and everything under it', async () => {
    const ids = async (query: string) => storyIds(await (await feed(query)).text())
    expect(await ids('?question=hot')).toEqual(['src-1'])
    expect(await ids('?question=hot-bill')).toEqual(['src-1'])
    expect(await ids('?question=cold')).toEqual(['src-2'])
    expect(await ids('?body=congress')).toEqual(['src-2', 'src-1'])
    expect(await ids('?body=demo')).toEqual([])
    // Bob sits in the Senate, so a Congress-only feed leaves him out of the story.
    expect(await (await feed('?body=congress')).text()).not.toContain('Bob Beta')
  })

  it('names the selection and links back to the same slice of the page', async () => {
    const xml = await (await feed('?question=hot')).text()
    expect(xml).toContain('<title>Sporelight: latest on the record (Hot Topic)</title>')
    expect(xml).toContain('<link rel="alternate" type="text/html" href="http://sporelight.test/news?question=hot"/>')
  })

  it('answers 404 for a question or body that does not exist', async () => {
    expect((await feed('?question=nope')).status).toBe(404)
    expect((await feed('?body=nope')).status).toBe(404)
  })
})

describe('what a reader socket is sent of proposals', () => {
  it('sends none until the reader subscribes, then the whole table', async () => {
    const reader = await partySocket()
    await until(() => reader.channels().has('bodies') && reader.channels().has('reviews'))

    // A new proposal while connected: its source reaches the reader, the proposal does not.
    const seen = reader.frames.length
    expect(await (await send('/api/proposals', proposal({ quote: 'Posted while a reader is connected.', source_url: 'https://news.example/live' }))).json()).toMatchObject({
      ok: true,
      duplicate: false,
    })
    await until(() => reader.frames.slice(seen).some((f) => f.channel === 'sources'))
    expect(reader.channels().has('proposals')).toBe(false)
    expect(reader.channels().has('proposal_items')).toBe(false)

    // What the feed's waiting mode asks for: both tables, unsliced.
    reader.send({ subscribe: 'proposals' })
    reader.send({ subscribe: 'proposal_items' })
    await until(() => rowsOn(reader.frames, 'proposal_items').length > 0 && rowsOn(reader.frames, 'proposals').length > 0)
    const sentIn = new Set(rowsOn(reader.frames, 'proposal_items').map((i) => i.act_id))
    const acts = await rows<{ id: string }>(`SELECT id FROM acts WHERE body IN (?, ?)`, WAITING, 'Posted while a reader is connected.')
    expect(acts).toHaveLength(2)
    for (const a of acts) expect(sentIn).toContain(a.id)
    expect(rowsOn(reader.frames, 'proposal_notes')).toEqual([])
    reader.close()
  })
})
