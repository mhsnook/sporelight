import { exports } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { editor, noOutsidePages, reader, rows } from './helpers.ts'

const call = (path: string, method: string, cookie?: string, body?: unknown) =>
  exports.default.fetch(`http://sporelight.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

let member = ''
let editorCookie = ''
beforeAll(async () => {
  member = (await reader('member@reader.test')).cookie
  editorCookie = (await editor('editor@reader.test')).cookie
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe.each([
  ['/api/editor/news-search', 'POST'],
  ['/api/editor/news-runs', 'GET'],
])('%s', (path, method) => {
  it('is refused signed out, with a forged cookie, and to a member', async () => {
    expect((await call(path, method)).status).toBe(401)
    expect((await call(path, method, 'better-auth.session_token=not-a-real-session')).status).toBe(401)
    expect((await call(path, method, member)).status).toBe(403)
  })

  it('is answered for an editor', async () => {
    const res = await call(path, method, editorCookie, method === 'POST' ? {} : undefined)
    expect(res.status).toBe(200)
    // This file seeds no questions, so the news search runs without searching.
    const expected = { '/api/editor/news-search': { questions: [], deferred: 0 }, '/api/editor/news-runs': { runs: expect.any(Array) } }
    expect(await res.json()).toEqual(expected[path as keyof typeof expected])
  })
})

describe('the runs of the news search', () => {
  const start = (body: unknown) => call('/api/editor/news-search', 'POST', editorCookie, body)

  it('records a run under the id the editor gave, with its steps, and lists it newest first', async () => {
    const runId = crypto.randomUUID()
    expect((await start({ run_id: runId })).status).toBe(200)

    const one = await call(`/api/editor/news-runs/${runId}`, 'GET', editorCookie)
    expect(await one.json()).toEqual({
      run: { id: runId, started_at: expect.any(String), started_by: 'editor', outcome: 'searched', finished_at: expect.any(String), detail: JSON.stringify({ questions: [], deferred: 0 }) },
      steps: [{ kind: 'plan', questions: [], queriesPerQuestion: 0, maxReads: expect.any(Number) }],
    })
    const { runs } = (await (await call('/api/editor/news-runs', 'GET', editorCookie)).json()) as { runs: { id: string }[] }
    expect(runs[0].id).toBe(runId)
  })

  it('refuses a run id that is not a UUID', async () => {
    expect((await start({ run_id: '../other' })).status).toBe(400)
  })

  it('says a run it has not recorded is not there, and refuses a member', async () => {
    expect((await call(`/api/editor/news-runs/${crypto.randomUUID()}`, 'GET', editorCookie)).status).toBe(404)
    expect((await call(`/api/editor/news-runs/${crypto.randomUUID()}`, 'GET', member)).status).toBe(403)
  })
})

describe('/api/read-article', () => {
  const dryRun = (body: unknown, cookie = member) => call('/api/read-article', 'POST', cookie, body)


  it('is refused signed out', async () => {
    expect((await call('/api/read-article', 'POST', undefined, { url: 'https://news.example/a', question_id: 'hot' })).status).toBe(401)
  })

  it('needs a web address and a question', async () => {
    expect((await dryRun({})).status).toBe(400)
  })

  it.each([
    ['a file address', { url: 'file:///etc/passwd', question_id: 'hot' }],
    ['a script address', { url: 'javascript:alert(1)', question_id: 'hot' }],
    ['an address that is not text', { url: 42, question_id: 'hot' }],
    ['a question id that is not text', { url: 'https://news.example/a', question_id: ['hot'] }],
  ])('refuses %s', async (_, body) => {
    expect((await dryRun(body, editorCookie)).status).toBe(400)
  })

  it('answers 404 for a question that does not exist, without fetching, and keeps nothing to reuse', async () => {
    const fetched = noOutsidePages()
    const res = await dryRun({ url: 'https://news.example/a', question_id: 'no-such-question' }, editorCookie)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Unknown question.' })
    expect(fetched).not.toHaveBeenCalled()
    expect(await rows(`SELECT result FROM tool_runs WHERE target LIKE 'no-such-question %'`)).toEqual([{ result: null }])
  })

  beforeAll(async () => {
    await rows(`INSERT INTO bodies (id, slug, name) VALUES ('b', 'b', 'Body')`)
    await rows(`INSERT INTO questions (id, slug, body_id, kind, title, short_title, status) VALUES ('trial', 'trial', 'b', 'position', 'Trial?', 'Trial', 'open')`)
  })

  it('reads a page once for a question and gives the same answer to the next person who asks', async () => {
    const fetched = noOutsidePages()
    const first = await dryRun({ url: 'https://news.example/once#top', question_id: 'trial' }, member)
    expect(await first.json()).toMatchObject({ outcome: 'not_read' })
    const again = await dryRun({ url: 'https://news.example/once', question_id: 'trial' }, editorCookie)
    expect(await again.json()).toMatchObject({ outcome: 'not_read', reused_from: expect.any(String) })
    expect(fetched).toHaveBeenCalledTimes(1)
  })

  it('limits how many a member asks for in a minute, and not an editor', async () => {
    noOutsidePages()
    const limited = (await reader('busy@reader.test')).cookie
    const statuses = []
    for (let i = 0; i < 7; i++) statuses.push((await dryRun({ url: `https://news.example/many-${i}`, question_id: 'trial' }, limited)).status)
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    expect(statuses.slice(5)).toEqual([429, 429])
    for (let i = 0; i < 7; i++) expect((await dryRun({ url: `https://news.example/editor-${i}`, question_id: 'trial' }, editorCookie)).status).toBe(200)
  })
})
