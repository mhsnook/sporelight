import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { nextIp, rows, seed } from './helpers.ts'

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
      `INSERT INTO readings (id, act_id, question_id, position, weight, via_question_id, created_at) VALUES ('read-ann', 'act-ann', 'hot', 'support', 'clear', NULL, '2026-10-01T00:00:00Z')`,
    ].map((sql) => env.DB.prepare(sql)),
  )
})

describe('/mcp: reading the record', () => {
  it('offers the read tools, sign_up, whoami and submit_evidence', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['find_people', 'get_positions', 'get_record', 'list_questions', 'sign_up', 'submit_evidence', 'whoami'])
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
    expect(result.record).toEqual([expect.objectContaining({ words: 'I support this, plainly.', sources: [expect.objectContaining({ url: 'https://news.example/ann-speech' })] })])
  })

  it('finds people by part of a name', async () => {
    const { people } = (await call('find_people', { name: 'alph' })).structuredContent as { people: { id: string; seats: { body: string }[] }[] }
    expect(people).toEqual([expect.objectContaining({ id: 'ann', seats: [expect.objectContaining({ body: 'Congress' })] })])
  })

  it('says so when a question does not exist', async () => {
    const result = await call('get_positions', { question: 'no-such-question' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/No question "no-such-question"/)
  })
})

describe('/mcp: agents sign up and send evidence as people', () => {
  it('signs an agent up as a person labelled agent, under the name it gives, with a key shown once', async () => {
    const agent = await signUp('Harbor Watch monitor')
    expect(agent.kind).toBe('agent')
    expect(agent.api_key).toMatch(/^sporelight_/)
    expect(await rows(`SELECT kind, display_name, muted_at FROM people WHERE id = ?`, agent.id)).toEqual([{ kind: 'agent', display_name: 'Harbor Watch monitor', muted_at: null }])
    // Better Auth keeps a hash of the key, never the key.
    const stored = await rows<{ key: string }>(`SELECT key FROM auth_api_keys WHERE referenceId = ?`, agent.id)
    expect(stored).toHaveLength(1)
    expect(stored[0].key).not.toContain(agent.api_key.slice('sporelight_'.length))
    // The session it signed up with is ended, so the key is the only way in.
    expect(await rows(`SELECT id FROM auth_sessions WHERE userId = ?`, agent.id)).toEqual([])
  })

  it('knows the agent by its key', async () => {
    const agent = await signUp('Council watcher')
    expect((await call('whoami', {}, agent.api_key)).structuredContent).toEqual({ signed_in: true, id: agent.id, name: 'Council watcher', kind: 'agent', muted: false })
    expect((await call('whoami', {})).structuredContent).toEqual({ signed_in: false })
  })

  it('queues what a signed-up agent sends as a reader’s proposal under its person', async () => {
    const agent = await signUp('Ferry desk bot')
    const result = await call('submit_evidence', evidence({ submitter_note: 'From our council monitor.' }), agent.api_key)
    expect(result.structuredContent).toMatchObject({ queued: true, duplicate: false, sent_as: { id: agent.id, name: 'Ferry desk bot' } })
    const proposalId = result.structuredContent!.proposal_id as string
    expect(await rows(`SELECT origin, submitted_by, status FROM proposals WHERE id = ?`, proposalId)).toEqual([{ origin: 'reader', submitted_by: agent.id, status: 'pending' }])
    expect((await rows<{ body: string }>(`SELECT body FROM proposal_notes WHERE proposal_id = ?`, proposalId)).map((n) => n.body)).toEqual(['From our council monitor.'])
    // Nothing reaches the record before review.
    expect(await rows(`SELECT id FROM readings WHERE act_id IN (SELECT act_id FROM proposal_items WHERE proposal_id = ?)`, proposalId)).toEqual([])
  })

  it('queues evidence sent with no key as an anonymous reader’s', async () => {
    const result = await call('submit_evidence', evidence())
    expect(result.structuredContent).toMatchObject({ queued: true, sent_as: null })
    expect(await rows(`SELECT origin, submitted_by FROM proposals WHERE id = ?`, result.structuredContent!.proposal_id)).toEqual([{ origin: 'reader', submitted_by: null }])
  })

  it('refuses a key it did not issue, rather than sending anonymously, and writes nothing', async () => {
    const before = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)
    const result = await call('submit_evidence', evidence(), 'sporelight_not-a-key-we-issued')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/not one this site issued/)
    expect(await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)).toEqual(before)
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
    const result = await call('submit_evidence', evidence(bad))
    expect(result.isError).toBe(true)
    expect(await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)).toEqual(before)
  })

  it('does not queue the same source, person and question twice', async () => {
    const same = evidence()
    await call('submit_evidence', same)
    expect((await call('submit_evidence', same)).structuredContent).toMatchObject({ queued: false, duplicate: true, proposal_id: null })
  })

  it('refuses an unknown person', async () => {
    const result = await call('submit_evidence', evidence({ decider_id: 'nobody' }))
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/Unknown question or decider/)
  })
})
