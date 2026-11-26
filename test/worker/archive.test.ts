import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { getServerByName } from 'partyserver'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARCHIVE_CRON, archiveNow, archiveSources, MAX_ARCHIVE_SOURCES_PER_RUN } from '../../worker/archive.ts'
import { NEWS_CRON } from '../../worker/news.ts'
import worker from '../../worker/index.ts'
import wranglerConfig from '../../wrangler.jsonc?raw'
import type { Tracker } from '../../worker/tracker.ts'
import { editor, partySocket, post, reader, rows, seed, until } from './helpers.ts'

const NOW = new Date('2026-11-19T12:00:00Z')
const HOUR = 3_600_000
const KEY = 'access:secret'
const noWait = async () => {}

const tracker = () => getServerByName<Env, Tracker>(env.Tracker, 'main')
const keyed = { ...env, ARCHIVE_ORG_KEY: KEY } as Env
const unkeyed = { ...env, ARCHIVE_ORG_KEY: '' } as Env

beforeAll(async () => {
  await seed()
  await env.DB.prepare(`INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('act-1', 'ann', 'says', '2026-11-01', 'Words.', '2026-11-01T00:00:00Z')`).run()
})

// Each test starts from its own sources.
beforeEach(async () => {
  await env.DB.batch(['DELETE FROM reports', 'DELETE FROM archive_attempts', 'DELETE FROM sources'].map((sql) => env.DB.prepare(sql)))
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function addSource(id: string, { url = `https://news.example/${id}`, created = '2026-11-01T00:00:00Z', published = true }: { url?: string | null; created?: string; published?: boolean } = {}) {
  await env.DB.prepare(`INSERT INTO sources (id, url, title, created_at) VALUES (?, ?, ?, ?)`).bind(id, url, id, created).run()
  if (published) await env.DB.prepare(`INSERT INTO reports (id, source_id, act_id, created_at) VALUES (?, ?, 'act-1', ?)`).bind(`r-${id}`, id, created).run()
}

type Answer = Response | (() => Response)
// Stands in for the Internet Archive. `available` answers the availability API
// for one page, `save` a capture request, `status` a job status check.
function archive({ available = () => null, save, status }: { available?: (url: string, timestamp: string) => unknown; save?: (url: string) => Answer; status?: (job: string) => Answer } = {}) {
  const calls: { kind: 'available' | 'save' | 'status'; url: string; auth: string | null }[] = []
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const auth = req.headers.get('authorization')
    if (url.href.startsWith('https://archive.org/wayback/available')) {
      const page = url.searchParams.get('url')!
      calls.push({ kind: 'available', url: page, auth })
      const closest = await available(page, url.searchParams.get('timestamp')!)
      return closest instanceof Response ? closest : Response.json({ url: page, archived_snapshots: closest ? { closest } : {} })
    }
    if (url.href === 'https://web.archive.org/save' && req.method === 'POST') {
      const page = String((await req.formData()).get('url'))
      calls.push({ kind: 'save', url: page, auth })
      const answer = save?.(page) ?? Response.json({ url: page, job_id: `job-${page}` })
      return typeof answer === 'function' ? answer() : answer
    }
    if (url.pathname.startsWith('/save/status/')) {
      const job = decodeURIComponent(url.pathname.slice('/save/status/'.length))
      calls.push({ kind: 'status', url: job, auth })
      const answer = status?.(job) ?? Response.json({ status: 'pending', job_id: job })
      return typeof answer === 'function' ? answer() : answer
    }
    throw new Error(`unexpected fetch ${req.method} ${url.href}`)
  })
  return { calls, spy, kinds: () => calls.map((c) => c.kind) }
}

const snapshot = (page: string, timestamp: string) => ({ available: true, status: '200', timestamp, url: `http://web.archive.org/web/${timestamp}/${page}` })
const archiveUrl = async (id: string) => (await rows<{ archive_url: string | null }>(`SELECT archive_url FROM sources WHERE id = ?`, id))[0]?.archive_url
const attempt = async (id: string) => (await rows(`SELECT attempts, outcome, next_try_at, job_id, detail FROM archive_attempts WHERE source_id = ?`, id))[0]

describe('archiveSources', () => {
  it('stores an existing capture close to when the source was recorded, without asking for a new one', async () => {
    await addSource('a')
    const ia = archive({ available: (page) => snapshot(page, '20261102030405') })
    const report = await archiveSources(keyed, await tracker(), NOW, noWait)

    expect(ia.kinds()).toEqual(['available'])
    // The lookup asks for the capture nearest the moment the source was recorded.
    expect(new URL(ia.spy.mock.calls[0][0] as string).searchParams.get('timestamp')).toBe('20261101000000')
    expect(await archiveUrl('a')).toBe('https://web.archive.org/web/20261102030405/https://news.example/a')
    expect(await attempt('a')).toMatchObject({ outcome: 'archived', attempts: 0, next_try_at: null })
    expect(report).toMatchObject({ due: 1, looked: 1, found: 1, archived: 1, requested: 0 })
  })

  it('asks for a capture when the only one is from well before the source, and stores it once the job succeeds', async () => {
    await addSource('b')
    const ia = archive({
      available: (page) => snapshot(page, '20200101000000'),
      status: (job) => Response.json({ status: 'success', job_id: job, timestamp: '20261119120100', original_url: 'https://news.example/b' }),
    })
    const report = await archiveSources(keyed, await tracker(), NOW, noWait)

    expect(ia.kinds()).toEqual(['available', 'save', 'status'])
    expect(ia.calls.filter((c) => c.kind !== 'available').every((c) => c.auth === `LOW ${KEY}`)).toBe(true)
    expect(ia.calls[0].auth).toBeNull()
    expect(await archiveUrl('b')).toBe('https://web.archive.org/web/20261119120100/https://news.example/b')
    expect(report).toMatchObject({ looked: 1, found: 0, requested: 0, archived: 1 })
  })

  it('leaves a job still running for the next run, which finds the capture by looking it up', async () => {
    await addSource('c')
    archive()
    expect(await archiveSources(keyed, await tracker(), NOW, noWait)).toMatchObject({ requested: 1, archived: 0 })
    expect(await attempt('c')).toMatchObject({ outcome: 'requested', job_id: 'job-https://news.example/c', next_try_at: NOW.toISOString() })
    expect(await archiveUrl('c')).toBeNull()

    vi.restoreAllMocks()
    const later = new Date(NOW.getTime() + 6 * HOUR)
    const ia = archive({ available: (page, timestamp) => (timestamp === '20261119120000' ? snapshot(page, '20261119120230') : null) })
    expect(await archiveSources(keyed, await tracker(), later, noWait)).toMatchObject({ looked: 1, found: 1, archived: 1 })
    // The job's status has expired, so it is looked up near the time it was
    // asked for, and not asked for again.
    expect(ia.kinds()).toEqual(['status', 'available'])
    expect(await archiveUrl('c')).toBe('https://web.archive.org/web/20261119120230/https://news.example/c')
  })

  it('backs off after a failed capture, doubling the wait, and gives up after six', async () => {
    await addSource('d')
    let at = NOW
    const failing = () => archive({ status: (job) => Response.json({ status: 'error', job_id: job, status_ext: 'error:gateway-timeout', message: 'The server did not respond.' }) })
    failing()
    await archiveSources(keyed, await tracker(), at, noWait)
    expect(await attempt('d')).toMatchObject({ outcome: 'failed', attempts: 1, next_try_at: new Date(at.getTime() + 12 * HOUR).toISOString(), detail: 'error:gateway-timeout: The server did not respond.' })

    // Not due on the next run, six hours later.
    vi.restoreAllMocks()
    const quiet = archive()
    expect(await archiveSources(keyed, await tracker(), new Date(at.getTime() + 6 * HOUR), noWait)).toMatchObject({ due: 0, looked: 0 })
    expect(quiet.calls).toEqual([])

    const waits: number[] = []
    for (let n = 2; n <= 6; n++) {
      vi.restoreAllMocks()
      failing()
      at = new Date((await attempt('d'))!.next_try_at as string)
      await archiveSources(keyed, await tracker(), at, noWait)
      const row = (await attempt('d'))!
      expect(row.attempts).toBe(n)
      if (row.next_try_at) waits.push((new Date(row.next_try_at as string).getTime() - at.getTime()) / HOUR)
    }
    expect(waits).toEqual([24, 48, 96, 192])
    expect(await attempt('d')).toMatchObject({ outcome: 'gave_up', attempts: 6, next_try_at: null })

    vi.restoreAllMocks()
    const after = archive()
    expect(await archiveSources(keyed, await tracker(), new Date(at.getTime() + 365 * 24 * HOUR), noWait)).toMatchObject({ due: 0 })
    expect(after.calls).toEqual([])
  })

  it('gives up at once on a page the archive cannot capture', async () => {
    await addSource('e')
    archive({ status: (job) => Response.json({ status: 'error', job_id: job, status_ext: 'error:no-access', message: 'Target URL could not be accessed (status=403).' }) })
    await archiveSources(keyed, await tracker(), NOW, noWait)
    expect(await attempt('e')).toMatchObject({ outcome: 'gave_up', attempts: 1, next_try_at: null })
  })

  it('counts a capture that was asked for and never appeared as a failure, without asking again in the same run', async () => {
    await addSource('f')
    archive()
    await archiveSources(keyed, await tracker(), NOW, noWait)
    vi.restoreAllMocks()
    const ia = archive()
    await archiveSources(keyed, await tracker(), new Date(NOW.getTime() + 6 * HOUR), noWait)
    expect(ia.kinds()).toEqual(['status', 'available'])
    expect(await attempt('f')).toMatchObject({ outcome: 'failed', attempts: 1 })
  })

  it(`looks at no more than ${MAX_ARCHIVE_SOURCES_PER_RUN} sources a run, oldest first`, async () => {
    for (let i = 0; i < 7; i++) await addSource(`g${i}`, { created: `2026-10-0${7 - i}T00:00:00Z` })
    const ia = archive({ available: (page) => snapshot(page, '20261010000000') })
    const report = await archiveSources(keyed, await tracker(), NOW, noWait)
    expect(report).toMatchObject({ due: 7, looked: 5, archived: 5 })
    expect(ia.calls.map((c) => c.url)).toEqual(['g6', 'g5', 'g4', 'g3', 'g2'].map((id) => `https://news.example/${id}`))
    expect(await archiveUrl('g0')).toBeNull()
    expect(await archiveUrl('g1')).toBeNull()
  })

  it('makes at most three outside requests per source', async () => {
    for (let i = 0; i < 7; i++) await addSource(`h${i}`)
    const ia = archive({ status: (job) => Response.json({ status: 'success', job_id: job, timestamp: '20261119120100', original_url: job.slice(4) }) })
    await archiveSources(keyed, await tracker(), NOW, noWait)
    expect(ia.calls).toHaveLength(3 * MAX_ARCHIVE_SOURCES_PER_RUN)
  })

  it('skips sources with no URL and sources nothing published cites', async () => {
    await addSource('no-url', { url: null })
    await addSource('unpublished', { published: false })
    const ia = archive()
    expect(await archiveSources(keyed, await tracker(), NOW, noWait)).toMatchObject({ due: 0, looked: 0 })
    expect(ia.calls).toEqual([])
    expect(await attempt('no-url')).toBeUndefined()
  })

  it('without a key, only looks, and picks the source up again as soon as there is a key', async () => {
    await addSource('k')
    const ia = archive()
    expect(await archiveSources(unkeyed, await tracker(), NOW, noWait)).toMatchObject({ no_key: 1 })
    expect(ia.kinds()).toEqual(['available'])
    expect(await attempt('k')).toMatchObject({ outcome: 'no_key', attempts: 0 })

    const soon = new Date(NOW.getTime() + 6 * HOUR)
    expect(await archiveSources(unkeyed, await tracker(), soon, noWait)).toMatchObject({ due: 0 })
    expect(await archiveSources(keyed, await tracker(), soon, noWait)).toMatchObject({ due: 1, requested: 1 })
  })

  it('stops the run without counting anything against a source when the archive answers 429', async () => {
    await addSource('l1', { created: '2026-10-01T00:00:00Z' })
    await addSource('l2', { created: '2026-10-02T00:00:00Z' })
    const ia = archive({ available: () => new Response('Too Many Requests', { status: 429 }) })
    const report = await archiveSources(keyed, await tracker(), NOW, noWait)
    expect(report).toMatchObject({ due: 2, looked: 0, error: 'The availability API answered 429.' })
    expect(ia.calls).toHaveLength(1)
    expect(await rows(`SELECT * FROM archive_attempts`)).toEqual([])
  })

  it('backs off a source the availability API answers 4xx for, and goes on to the next', async () => {
    await addSource('v1', { created: '2026-10-01T00:00:00Z' })
    await addSource('v2', { created: '2026-10-02T00:00:00Z' })
    archive({ available: (page) => (page.endsWith('v1') ? new Response('Bad Request', { status: 400 }) : snapshot(page, '20261003000000')) })
    expect(await archiveSources(keyed, await tracker(), NOW, noWait)).toMatchObject({ looked: 2, failed: 1, archived: 1 })
    expect(await attempt('v1')).toMatchObject({ outcome: 'failed', attempts: 1, detail: 'The availability API answered 400.' })
  })

  it('does not use a capture of a redirect', async () => {
    await addSource('w')
    const ia = archive({ available: (page) => ({ ...snapshot(page, '20261102000000'), status: '302' }) })
    await archiveSources(keyed, await tracker(), NOW, noWait)
    expect(ia.kinds()).toEqual(['available', 'save', 'status'])
    expect(await archiveUrl('w')).toBeNull()
  })

  it('asks a job that was still running how it went before looking the page up', async () => {
    await addSource('x')
    archive()
    await archiveSources(keyed, await tracker(), NOW, noWait)
    vi.restoreAllMocks()
    const ia = archive({ status: (job) => Response.json({ status: 'success', job_id: job, timestamp: '20261119120300', original_url: 'https://news.example/x' }) })
    await archiveSources(keyed, await tracker(), new Date(NOW.getTime() + 6 * HOUR), noWait)
    expect(ia.kinds()).toEqual(['status'])
    expect(await archiveUrl('x')).toBe('https://web.archive.org/web/20261119120300/https://news.example/x')
  })

  it('stops checking jobs when the status endpoint answers 429, and leaves them to the next run', async () => {
    await addSource('y')
    archive({ status: () => new Response('Too Many Requests', { status: 429 }) })
    expect(await archiveSources(keyed, await tracker(), NOW, noWait)).toMatchObject({ requested: 1, error: 'Save Page Now answered 429.' })
    expect(await attempt('y')).toMatchObject({ outcome: 'requested', job_id: 'job-https://news.example/y' })
  })

  it('keeps an address an editor already put on the source', async () => {
    await addSource('m')
    const room = await tracker()
    expect(await room.setArchiveUrl('m', 'https://archive.ph/abc')).toBe('https://archive.ph/abc')
    expect(await room.setArchiveUrl('m', 'https://web.archive.org/web/1/x')).toBe('https://archive.ph/abc')
    expect(await archiveUrl('m')).toBe('https://archive.ph/abc')
  })

  it('tells an editor the address actually on the source when it already had one', async () => {
    await addSource('z')
    const room = await tracker()
    archive({
      // An editor gives an address while the lookup is under way.
      available: async (page) => {
        await room.setArchiveUrl('z', 'https://archive.ph/zzz')
        return snapshot(page, '20261102000000')
      },
    })
    expect(await archiveNow(keyed, room, 'z', NOW, noWait)).toEqual({ outcome: 'archived', archive_url: 'https://archive.ph/zzz' })
    expect(await attempt('z')).toMatchObject({ outcome: 'archived', detail: expect.stringContaining('kept the address already on the source') })
  })

  it('sends the archived address to a connected browser through the sync socket', async () => {
    await addSource('n')
    const reader = await partySocket()
    await until(() => reader.channels().has('sources'))
    archive({ available: (page) => snapshot(page, '20261102000000') })
    await archiveSources(keyed, await tracker(), NOW, noWait)
    const sent = () => reader.frames.filter((f) => f.channel === 'sources').flatMap((f) => f.ops).filter((op) => op.value.id === 'n' && op.value.archive_url)
    await until(() => sent().length > 0)
    expect(sent()[0]).toMatchObject({ type: 'update', value: { id: 'n', archive_url: 'https://web.archive.org/web/20261102000000/https://news.example/n', url: 'https://news.example/n' } })
    reader.close()
  })
})

describe('archiveNow', () => {
  it('ignores the back-off and waits for its capture', async () => {
    await addSource('p')
    await env.DB.prepare(`INSERT INTO archive_attempts (source_id, attempts, tried_at, outcome, next_try_at) VALUES ('p', 6, ?, 'gave_up', NULL)`).bind(NOW.toISOString()).run()
    let checks = 0
    archive({ status: (job) => (++checks < 3 ? Response.json({ status: 'pending', job_id: job }) : Response.json({ status: 'success', job_id: job, timestamp: '20261119120200', original_url: 'https://news.example/p' })) })
    expect(await archiveNow(keyed, await tracker(), 'p', NOW, noWait)).toEqual({ outcome: 'archived', archive_url: 'https://web.archive.org/web/20261119120200/https://news.example/p' })
    expect(checks).toBe(3)
    expect(await attempt('p')).toMatchObject({ outcome: 'archived', attempts: 0 })
  })

  it('records the job it started when a status check is refused', async () => {
    await addSource('aa')
    archive({ status: () => new Response('Too Many Requests', { status: 429 }) })
    expect(await archiveNow(keyed, await tracker(), 'aa', NOW, noWait)).toEqual({ error: 'Save Page Now answered 429.', status: 502 })
    expect(await attempt('aa')).toMatchObject({ outcome: 'requested', job_id: 'job-https://news.example/aa' })
  })

  it('says so for a source with no URL, and asks nobody', async () => {
    await addSource('q', { url: null })
    const ia = archive()
    expect(await archiveNow(keyed, await tracker(), 'q', NOW, noWait)).toMatchObject({ outcome: 'no_url' })
    expect(ia.calls).toEqual([])
  })

  it('says why when there is no key', async () => {
    await addSource('r')
    archive()
    expect(await archiveNow(unkeyed, await tracker(), 'r', NOW, noWait)).toMatchObject({ outcome: 'no_key' })
  })
})

describe('POST /api/archive', () => {
  let member = ''
  let editorCookie = ''
  beforeAll(async () => {
    member = (await reader('archiver@reader.test')).cookie
    editorCookie = (await editor('archive-editor@reader.test')).cookie
  })
  const call = (body: unknown, cookie?: string) => post('/api/archive', body, undefined, undefined, cookie)

  it('is for people who are signed in', async () => {
    expect((await call({ source_id: 'x' })).status).toBe(401)
  })

  it.each([
    ['a member', () => member],
    ['an editor', () => editorCookie],
  ])('archives the source from an existing capture for %s', async (_, cookie) => {
    await addSource('s')
    archive({ available: (page) => snapshot(page, '20261102000000') })
    const res = await call({ source_id: 's' }, cookie())
    expect(await res.json()).toEqual({ outcome: 'archived', archive_url: 'https://web.archive.org/web/20261102000000/https://news.example/s' })
  })

  it('answers a member from the last attempt while it is backing off, without asking the archive, and still asks for an editor', async () => {
    await addSource('t')
    await env.DB.prepare(`INSERT INTO archive_attempts (source_id, attempts, tried_at, outcome, next_try_at, detail) VALUES ('t', 1, ?, 'failed', ?, 'The capture failed.')`)
      .bind(new Date().toISOString(), new Date(Date.now() + 12 * HOUR).toISOString())
      .run()
    const ia = archive({ available: (page) => snapshot(page, '20261102000000') })
    expect(await (await call({ source_id: 't' }, member)).json()).toMatchObject({ outcome: 'failed', detail: 'The capture failed.' })
    expect(ia.calls).toEqual([])
    expect(await (await call({ source_id: 't' }, editorCookie)).json()).toMatchObject({ outcome: 'archived' })
  })

  it('makes one request when the same source is asked for twice at once', async () => {
    await addSource('u')
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const ia = archive({ available: async (page) => (await held, snapshot(page, '20261102000000')) })
    const first = call({ source_id: 'u' }, member)
    await until(() => ia.calls.length > 0)
    const second = await call({ source_id: 'u' }, editorCookie)
    release()
    expect(second.status).toBe(409)
    expect((await first).status).toBe(200)
    expect(ia.kinds()).toEqual(['available'])
  })

  it('answers 400 without a source id and 404 for one that does not exist', async () => {
    expect((await call({}, member)).status).toBe(400)
    expect((await call({ source_id: 'nope' }, member)).status).toBe(404)
  })
})

describe('the scheduled run', () => {
  it('runs on crons wrangler.jsonc schedules, one for each pass', () => {
    const crons = JSON.parse(`[${/"triggers":\s*\{\s*"crons":\s*\[([^\]]*)\]/.exec(wranglerConfig)?.[1] ?? ''}]`) as string[]
    expect(crons.toSorted()).toEqual([ARCHIVE_CRON, NEWS_CRON].toSorted())
  })

  const fire = (cron: string) => worker.scheduled(createScheduledController({ scheduledTime: NOW, cron }), env)

  it('archives on its own cron, without searching the news', async () => {
    await addSource('t')
    const websearch = vi.spyOn(env.AI, 'websearch')
    archive({ available: (page) => snapshot(page, '20261102000000') })
    await fire(ARCHIVE_CRON)
    expect(await archiveUrl('t')).toBe('https://web.archive.org/web/20261102000000/https://news.example/t')
    expect(websearch).not.toHaveBeenCalled()
  })

  it('runs neither pass on a cron it does not know', async () => {
    await addSource('ab')
    const websearch = vi.spyOn(env.AI, 'websearch')
    const ia = archive()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await fire('0 0 * * *')
    expect(ia.calls).toEqual([])
    expect(websearch).not.toHaveBeenCalled()
  })

  it('does not archive on the news search cron', async () => {
    await addSource('u')
    vi.spyOn(env.AI, 'websearch').mockImplementation(async () => Response.json({ items: [] }))
    const ia = archive()
    await fire(NEWS_CRON)
    expect(ia.calls).toEqual([])
  })
})
