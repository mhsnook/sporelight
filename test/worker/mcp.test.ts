import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { EDITORS_ID } from '../../shared/schema.ts'
import { AGENT_KEY_PREFIX } from '../../worker/auth.ts'
import { FIND_LIMIT } from '../../worker/mcp.ts'
import { editor, nextIp, partyWrite, post, rows, seed } from './helpers.ts'

// An MCP client talking to the Worker's /mcp, from its own address, with a key if it has one.
async function connect(from = nextIp(), key?: string) {
  const client = new Client({ name: 'test-agent', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL('https://sporelight.test/mcp'), {
    fetch: (url, init) => exports.default.fetch(new Request(url, init)),
    requestInit: { headers: { 'cf-connecting-ip': from, ...(key ? { 'x-api-key': key } : {}) } },
  })
  await client.connect(transport)
  return client
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> }
const call = async (name: string, args: Record<string, unknown>, key?: string) => (await (await connect(nextIp(), key)).callTool({ name, arguments: args })) as ToolResult
const signUp = async (name: string) => (await call('sign_up', { name })).structuredContent as { id: string; api_key: string; kind: string }
const textOf = (result: ToolResult) => result.content.map((c) => c.text).join('\n')

const evidence = (over: Record<string, unknown> = {}) => ({
  question_id: 'hot',
  decider_id: 'ann',
  kind: 'says',
  reading: 'support',
  quote: 'I will vote for it when it reaches the floor.',
  source_url: `https://news.example/mcp-${crypto.randomUUID()}`,
  ...over,
})

beforeAll(async () => {
  await seed()
  await env.DB.batch(
    [
      `INSERT INTO sources (id, url, title, created_at) VALUES ('src-ann', 'https://news.example/ann-speech', 'Ann speaks', '2026-10-01T00:00:00Z')`,
      `INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('act-ann', 'ann', 'says', '2026-10-01', 'I support this, plainly.', '2026-10-01T00:00:00Z')`,
      `INSERT INTO reports (id, source_id, act_id, created_at) VALUES ('rep-ann', 'src-ann', 'act-ann', '2026-10-01T00:00:00Z')`,
      `INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, created_at, updated_at) VALUES ('read-ann', '${EDITORS_ID}', 'act-ann', 'hot', 'support', 'clear', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    ].map((sql) => env.DB.prepare(sql)),
  )
})

describe('/mcp: reading the record', () => {
  it('offers the read tools, sign_up, whoami and submit_evidence', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['find_deciders', 'get_positions', 'get_record', 'list_questions', 'sign_up', 'submit_evidence', 'whoami'])
    const submit = tools.find((t) => t.name === 'submit_evidence')!
    expect(submit.inputSchema.required).toEqual(expect.arrayContaining(['question_id', 'decider_id', 'quote', 'source_url']))
    expect(submit.inputSchema.required).not.toContain('source_title')
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).not.toContain('submit_evidence')
  })

  it('lists open questions and leaves out closed ones', async () => {
    const { questions } = (await call('list_questions', {})).structuredContent as { questions: { id: string; bodies: { slug: string }[] }[] }
    const ids = questions.map((q) => q.id)
    expect(ids).toEqual(expect.arrayContaining(['hot', 'cold', 'demo-hot', 'closing']))
    expect(ids).not.toContain('closed')
    expect(questions.find((q) => q.id === 'hot')!.bodies.map((b) => b.slug)).toEqual(['congress', 'senate'])
  })

  it('works out positions from the published record, in every body the question is put to', async () => {
    const { people } = (await call('get_positions', { question: 'hot' })).structuredContent as { people: { decider_id: string; standing: string; acts_on_record: number }[] }
    expect(people.map((p) => p.decider_id).sort()).toEqual(['ann', 'bob', 'eve', 'fay'])
    expect(people.find((p) => p.decider_id === 'ann')).toMatchObject({ standing: 'support', acts_on_record: 1 })
    expect(people.find((p) => p.decider_id === 'eve')).toMatchObject({ standing: 'unknown', acts_on_record: 0 })
  })

  it('narrows positions to one body or one standing', async () => {
    const inSenate = (await call('get_positions', { question: 'hot', body: 'senate' })).structuredContent as { people: { decider_id: string }[] }
    expect(inSenate.people.map((p) => p.decider_id)).toEqual(['bob'])
    const supporters = (await call('get_positions', { question: 'hot', standing: 'support' })).structuredContent as { people: { decider_id: string }[] }
    expect(supporters.people.map((p) => p.decider_id)).toEqual(['ann'])
  })

  it('gives the acts behind a position with their sources, by id or slug', async () => {
    const result = (await call('get_record', { question: 'hot', person: 'ann-alpha' })).structuredContent as { record: { words: string; sources: { url: string }[] }[] }
    expect(result.record).toEqual([expect.objectContaining({ words: 'I support this, plainly.', checked: true, sources: [expect.objectContaining({ url: 'https://news.example/ann-speech' })] })])
  })

  it('finds deciders by part of a name', async () => {
    const found = (await call('find_deciders', { name: 'alph' })).structuredContent as { deciders: { id: string; seats: { body: string }[] }[]; more: number }
    expect(found).toEqual({ deciders: [expect.objectContaining({ id: 'ann', seats: [expect.objectContaining({ body: 'Congress' })], url: expect.stringMatching(/\/p\/ann-alpha$/) })], more: 0 })
  })

  it('returns at most FIND_LIMIT deciders, and says how many more matched', async () => {
    const extra = Array.from({ length: FIND_LIMIT + 5 }, (_, i) => ({ id: `many-${i}`, slug: `many-${i}`, name: `Manyname ${i}`, sort_name: `Manyname, ${i}`, external_id: null, url: null }))
    expect((await partyWrite([{ channel: 'deciders', ops: extra.map((value) => ({ type: 'insert', value })) }], undefined, (await editor(`mcp-${crypto.randomUUID()}@reader.test`)).cookie)).status).toBe(200)
    const found = (await call('find_deciders', { name: 'manyname' })).structuredContent as { deciders: unknown[]; more: number }
    expect(found.deciders).toHaveLength(FIND_LIMIT)
    expect(found.more).toBe(5)
  })

  it('says so when a question does not exist', async () => {
    const result = await call('get_positions', { question: 'no-such-question' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/No question "no-such-question"/)
  })
})

describe('/mcp: agents sign up and send evidence as people', () => {
  // One signed-up agent for the tests about what it sends, not about signing up.
  let shared: Promise<{ id: string; api_key: string }> | undefined
  const sender = () => (shared ??= signUp('Shared test agent'))

  it('signs an agent up as a person labelled agent, under the name it gives, with a key shown once', async () => {
    const agent = await signUp('Harbor Watch monitor')
    expect(agent.kind).toBe('agent')
    expect(agent.api_key.startsWith(AGENT_KEY_PREFIX)).toBe(true)
    expect(await rows(`SELECT kind, display_name FROM people WHERE id = ?`, agent.id)).toEqual([{ kind: 'agent', display_name: 'Harbor Watch monitor' }])
    // Better Auth keeps a hash of the key, never the key.
    const stored = await rows<{ key: string }>(`SELECT key FROM auth_api_keys WHERE referenceId = ?`, agent.id)
    expect(stored).toHaveLength(1)
    expect(stored[0].key).not.toContain(agent.api_key.slice(AGENT_KEY_PREFIX.length))
    // The session it signed up with is ended, so the key is the only way in.
    expect(await rows(`SELECT id FROM auth_sessions WHERE userId = ?`, agent.id)).toEqual([])
  })

  it('knows the agent by its key', async () => {
    const agent = await signUp('Council watcher')
    expect((await call('whoami', {}, agent.api_key)).structuredContent).toEqual({ signed_in: true, id: agent.id, name: 'Council watcher', kind: 'agent' })
    expect((await call('whoami', {})).structuredContent).toEqual({ signed_in: false })
  })

  it('queues what a signed-up agent sends as a reader’s proposal under its person', async () => {
    const agent = await signUp('Ferry desk bot')
    const result = await call('submit_evidence', evidence({ submitter_note: 'From our council monitor.' }), agent.api_key)
    expect(result.structuredContent).toMatchObject({ queued: true, duplicate: false, sent_as: { id: agent.id, name: 'Ferry desk bot' } })
    const proposalId = result.structuredContent!.proposal_id as string
    expect(await rows(`SELECT origin, submitted_by, status FROM proposals WHERE id = ?`, proposalId)).toEqual([{ origin: 'reader', submitted_by: agent.id, status: 'pending' }])
    expect((await rows<{ body: string }>(`SELECT body FROM proposal_notes WHERE proposal_id = ?`, proposalId)).map((n) => n.body)).toEqual(['From our council monitor.'])
    // The act is on file with the agent's own review of it, and the editors have not reviewed it.
    expect(await rows(`SELECT reviewer_id, position FROM reviews WHERE act_id IN (SELECT act_id FROM proposal_items WHERE proposal_id = ?)`, proposalId)).toEqual([{ reviewer_id: agent.id, position: 'support' }])
  })

  it('returns what an agent sent in the record at once, marked as not checked by an editor', async () => {
    const agent = await signUp('Fay watcher')
    await call('submit_evidence', evidence({ decider_id: 'fay', quote: 'Fay Zeta said she backs it.' }), agent.api_key)
    const result = (await call('get_record', { question: 'hot', person: 'fay' })).structuredContent as { record: { words: string; checked: boolean }[] }
    expect(result.record).toEqual([expect.objectContaining({ words: 'Fay Zeta said she backs it.', checked: false })])
  })

  it('refuses evidence sent with no key, as the site refuses a post from someone signed out, and writes nothing', async () => {
    const before = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)
    const result = await call('submit_evidence', evidence())
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/^Sign up to send evidence/)
    expect(await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)).toEqual(before)
  })

  it('refuses a key it did not issue, and writes nothing', async () => {
    const before = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)
    const result = await call('submit_evidence', evidence(), `${AGENT_KEY_PREFIX}not-a-key-we-issued`)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/key in x-api-key was refused: Invalid API key/)
    expect(await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)).toEqual(before)
  })

  it('tells an agent over its key’s rate limit to wait, not that its key is bad', async () => {
    const agent = await signUp('Busy bot')
    await env.DB.prepare(`UPDATE auth_api_keys SET rateLimitMax = 1 WHERE referenceId = ?`).bind(agent.id).run()
    expect((await call('whoami', {}, agent.api_key)).structuredContent).toMatchObject({ signed_in: true, id: agent.id })
    const limited = await call('whoami', {}, agent.api_key)
    expect(limited.isError).toBe(true)
    expect(textOf(limited)).toMatch(/^Too many requests with this key\. Try again in \d+ seconds\.$/)
  })

  it('does not sign up a second account on a request that already carries a key', async () => {
    const agent = await signUp('Only once')
    const result = await call('sign_up', { name: 'Again' }, agent.api_key)
    expect(result.isError).toBe(true)
    expect(await rows(`SELECT id FROM people WHERE display_name = 'Again'`)).toEqual([])
  })

  it('offers no way to make an agent account except sign_up', async () => {
    const res = await exports.default.fetch('https://sporelight.test/api/auth/sign-in/anonymous', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://sporelight.test' }, body: '{}' })
    expect(res.status).toBe(404)
  })

  it.each([
    ['a source that is not a web address', { source_url: 'ftp://news.example/story' }],
    ['a quote under ten characters', { quote: 'Yes.' }],
    ['a reading that is not one of the four', { reading: 'lean_oppose' }],
  ])('refuses %s before anything is written', async (_, bad) => {
    const before = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)
    const result = await call('submit_evidence', evidence(bad), (await sender()).api_key)
    expect(result.isError).toBe(true)
    expect(await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)).toEqual(before)
  })

  it('does not queue the same source, person and question twice', async () => {
    const same = evidence()
    const { api_key } = await sender()
    await call('submit_evidence', same, api_key)
    expect((await call('submit_evidence', same, api_key)).structuredContent).toMatchObject({ queued: false, duplicate: true, proposal_id: null })
  })

  it('refuses an unknown person', async () => {
    const result = await call('submit_evidence', evidence({ decider_id: 'nobody' }), (await sender()).api_key)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/Unknown question or decider/)
  })
})

describe('a key in x-api-key on the reader routes', () => {
  const evidenceForm = (url: string) => ({ ...evidence({ source_url: url }), source_title: null, occurred_on: null, submitter_note: null })
  // post() sends no x-api-key, so these call the Worker with the header themselves.
  const postWithKey = (path: string, body: unknown, key: string) =>
    exports.default.fetch(`https://sporelight.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp(), 'x-api-key': key },
      body: JSON.stringify(body),
    })

  it('answers a key it did not issue with a 401 and writes nothing', async () => {
    const url = `https://news.example/bad-key-${crypto.randomUUID()}`
    const res = await postWithKey('/api/proposals', evidenceForm(url), `${AGENT_KEY_PREFIX}not-a-key-we-issued`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'The key in x-api-key was refused: Invalid API key.' })
    expect(await rows(`SELECT id FROM sources WHERE url = ?`, url)).toEqual([])
  })

  it('posts a proposal under the agent whose key it is', async () => {
    const agent = await signUp('Form-posting bot')
    const res = await postWithKey('/api/proposals', evidenceForm(`https://news.example/keyed-${crypto.randomUUID()}`), agent.api_key)
    expect(res.status).toBe(200)
    const { proposal_id } = (await res.json()) as { proposal_id: string }
    expect(await rows(`SELECT submitted_by FROM proposals WHERE id = ?`, proposal_id)).toEqual([{ submitted_by: agent.id }])
  })

  it('refuses a post with no key from someone signed out', async () => {
    const res = await post('/api/proposals', evidenceForm(`https://news.example/no-key-${crypto.randomUUID()}`))
    expect(res.status).toBe(401)
  })
})

describe('/mcp: the record it reads from', () => {
  it('keeps the built record between calls, and rebuilds it once party-db logs a write', async () => {
    const names = async () => ((await call('find_deciders', { name: 'fay' })).structuredContent as { deciders: { name: string }[] }).deciders.map((d) => d.name)
    expect(await names()).toEqual(['Fay Zeta'])
    // A write that skips party-db's log, as seeding does, is not read: the kept record answers.
    await env.DB.prepare(`UPDATE deciders SET name = 'Fay Unlogged' WHERE id = 'fay'`).run()
    expect(await names()).toEqual(['Fay Zeta'])
    // An editor's write goes through the log, so the next call reads the record again.
    expect((await partyWrite([{ channel: 'deciders', ops: [{ type: 'update', value: { id: 'fay', name: 'Fay Logged' } }] }], undefined, (await editor(`mcp-${crypto.randomUUID()}@reader.test`)).cookie)).status).toBe(200)
    expect(await names()).toEqual(['Fay Logged'])
  })
})
