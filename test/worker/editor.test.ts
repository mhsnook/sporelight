import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { isEditorRequest, isEditorToken } from '../../worker/editor.ts'
import { EDITOR_TOKEN } from './helpers.ts'

const call = (path: string, method: string, token?: string) =>
  exports.default.fetch(`http://sporelight.test${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} })

describe.each([
  ['/api/editor/session', 'GET'],
  ['/api/editor/news-search', 'POST'],
  ['/api/editor/news-runs', 'GET'],
])('%s', (path, method) => {
  it('is refused without a token', async () => {
    expect((await call(path, method)).status).toBe(401)
  })

  it('is refused with the wrong token', async () => {
    expect((await call(path, method, `${EDITOR_TOKEN}x`)).status).toBe(401)
    expect((await call(path, method, EDITOR_TOKEN.slice(0, -1))).status).toBe(401)
  })

  it('is accepted with the editor token', async () => {
    const res = await call(path, method, EDITOR_TOKEN)
    expect(res.status).toBe(200)
    // This file seeds no questions, so the news search runs without searching.
    const expected = { '/api/editor/session': { ok: true }, '/api/editor/news-search': { questions: [], deferred: 0 }, '/api/editor/news-runs': { runs: expect.any(Array) } }
    expect(await res.json()).toEqual(expected[path as keyof typeof expected])
  })
})

describe('the runs of the news search', () => {
  const post = (body: unknown) =>
    exports.default.fetch('http://sporelight.test/api/editor/news-search', {
      method: 'POST',
      headers: { authorization: `Bearer ${EDITOR_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('records a run under the id the editor gave, with its steps, and lists it newest first', async () => {
    const runId = crypto.randomUUID()
    expect((await post({ run_id: runId })).status).toBe(200)

    const one = await call(`/api/editor/news-runs/${runId}`, 'GET', EDITOR_TOKEN)
    expect(await one.json()).toEqual({
      run: { id: runId, started_at: expect.any(String), started_by: 'editor', outcome: 'searched', finished_at: expect.any(String), detail: JSON.stringify({ questions: [], deferred: 0 }) },
      steps: [{ kind: 'plan', questions: [], queriesPerQuestion: 0, maxReads: expect.any(Number) }],
    })
    const { runs } = (await (await call('/api/editor/news-runs', 'GET', EDITOR_TOKEN)).json()) as { runs: { id: string }[] }
    expect(runs[0].id).toBe(runId)
  })

  it('refuses a run id that is not a UUID', async () => {
    expect((await post({ run_id: '../other' })).status).toBe(400)
  })

  it('says a run it has not recorded is not there, and refuses without a token', async () => {
    expect((await call(`/api/editor/news-runs/${crypto.randomUUID()}`, 'GET', EDITOR_TOKEN)).status).toBe(404)
    expect((await call(`/api/editor/news-runs/${crypto.randomUUID()}`, 'GET')).status).toBe(401)
  })
})

describe('/api/editor/read-article', () => {
  it('is refused without a token', async () => {
    expect((await call('/api/editor/read-article', 'POST')).status).toBe(401)
  })

  const dryRun = (body: unknown) =>
    exports.default.fetch('http://sporelight.test/api/editor/read-article', {
      method: 'POST',
      headers: { authorization: `Bearer ${EDITOR_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('needs a web address and a question', async () => {
    expect((await call('/api/editor/read-article', 'POST', EDITOR_TOKEN)).status).toBe(400)
  })

  it.each([
    ['a file address', { url: 'file:///etc/passwd', question_id: 'hot' }],
    ['a script address', { url: 'javascript:alert(1)', question_id: 'hot' }],
    ['an address that is not text', { url: 42, question_id: 'hot' }],
    ['a question id that is not text', { url: 'https://news.example/a', question_id: ['hot'] }],
  ])('refuses %s', async (_, body) => {
    expect((await dryRun(body)).status).toBe(400)
  })

  it('answers 404 for a question that does not exist, without fetching', async () => {
    const res = await dryRun({ url: 'https://news.example/a', question_id: 'no-such-question' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Unknown question.' })
  })
})

// A Preview deployed without the secret has no EDITOR_TOKEN. Nobody is an editor there.
describe('with no editor token configured', () => {
  const unset = [
    ['empty', { ...env, EDITOR_TOKEN: '' }],
    ['missing', { ...env, EDITOR_TOKEN: undefined }],
  ] as unknown as [string, Env][]

  it.each(unset)('accepts no token when the secret is %s', async (_, noSecret) => {
    for (const token of ['', 'undefined', 'null', EDITOR_TOKEN]) expect(await isEditorToken(token, noSecret)).toBe(false)
  })

  it.each(unset)('accepts no request when the secret is %s', async (_, noSecret) => {
    for (const authorization of ['Bearer ', 'Bearer undefined', `Bearer ${EDITOR_TOKEN}`]) {
      expect(await isEditorRequest(new Request('http://sporelight.test/', { headers: { authorization } }), noSecret)).toBe(false)
    }
  })
})
