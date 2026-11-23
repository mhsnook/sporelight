import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { allCollections } from '../../shared/schema.ts'
import { nextIp, rows, seed } from './helpers.ts'

// An MCP client talking to the Worker's /mcp, from its own address.
async function connect(from = nextIp()) {
  const client = new Client({ name: 'test-agent', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL('http://sporelight.test/mcp'), {
    fetch: (url, init) => exports.default.fetch(new Request(url, init)),
    requestInit: { headers: { 'cf-connecting-ip': from } },
  })
  await client.connect(transport)
  return client
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> }
const call = async (name: string, args: Record<string, unknown>, from?: string) => (await (await connect(from)).callTool({ name, arguments: args })) as ToolResult
const textOf = (result: ToolResult) => result.content.map((c) => c.text).join('\n')

const evidence = (over: Record<string, unknown> = {}) => ({
  org: 'harbor-watch',
  secret: 'a secret harbor watch chose',
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
  it('offers the read tools and submit_evidence, which asks for an org id and a secret', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['find_people', 'get_positions', 'get_record', 'list_questions', 'submit_evidence'])
    const submit = tools.find((t) => t.name === 'submit_evidence')!
    expect(submit.inputSchema.required).toEqual(expect.arrayContaining(['org', 'secret', 'question_id', 'decider_id', 'quote', 'source_url']))
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

describe('/mcp: submit_evidence', () => {
  it('claims an unused org id with the secret, and queues the act for review as a partner’s', async () => {
    const result = await call('submit_evidence', evidence({ org: 'first-claim', submitter_note: 'From our council monitor.' }))
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ queued: true, duplicate: false, org_claimed_now: true })
    const proposalId = result.structuredContent!.proposal_id as string

    const [partner] = await rows<{ id: string; secret_hash: string }>(`SELECT id, secret_hash FROM partners WHERE org = 'first-claim'`)
    const [proposal] = await rows<{ origin: string; submitted_by: string; status: string }>(`SELECT origin, submitted_by, status FROM proposals WHERE id = ?`, proposalId)
    expect(proposal).toEqual({ origin: 'partner', submitted_by: partner.id, status: 'pending' })
    const notes = await rows<{ body: string }>(`SELECT body FROM proposal_notes WHERE proposal_id = ?`, proposalId)
    expect(notes.map((n) => n.body)).toEqual(['Sent by first-claim through the MCP endpoint.\n\nFrom our council monitor.'])
    // Nothing reaches the record before review.
    expect(await rows(`SELECT id FROM readings WHERE act_id IN (SELECT act_id FROM proposal_items WHERE proposal_id = ?)`, proposalId)).toEqual([])
  })

  it('accepts later posts under a claimed org id with the same secret', async () => {
    await call('submit_evidence', evidence({ org: 'returning-org' }))
    const again = await call('submit_evidence', evidence({ org: 'returning-org' }))
    expect(again.structuredContent).toMatchObject({ queued: true, org_claimed_now: false })
    expect(await rows(`SELECT id FROM partners WHERE org = 'returning-org'`)).toHaveLength(1)
  })

  it('refuses a claimed org id with another secret, and writes nothing', async () => {
    await call('submit_evidence', evidence({ org: 'taken-org' }))
    const before = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)
    const result = await call('submit_evidence', evidence({ org: 'taken-org', secret: 'somebody else’s guess at it' }))
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/"taken-org" is taken/)
    expect(await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals`)).toEqual(before)
  })

  it('treats org ids that differ only in case as one id', async () => {
    await call('submit_evidence', evidence({ org: 'case-org' }))
    const result = await call('submit_evidence', evidence({ org: 'Case-Org', secret: 'not the secret case-org chose' }))
    expect(textOf(result)).toMatch(/"case-org" is taken/)
  })

  it('keeps only a salted hash of the secret, in a table no collection serves', async () => {
    await call('submit_evidence', evidence({ org: 'hashed-org', secret: 'plain words nobody should store' }))
    const [row] = await rows<{ secret_hash: string; secret_salt: string }>(`SELECT secret_hash, secret_salt FROM partners WHERE org = 'hashed-org'`)
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.secret_salt).toMatch(/^[0-9a-f]{32}$/)
    expect(allCollections.map((c) => c.name)).not.toContain('partners')
  })

  it.each([
    ['a short secret', { secret: 'short' }],
    ['an org id with spaces', { org: 'harbor watch' }],
    ['a source that is not a web address', { source_url: 'ftp://news.example/story' }],
    ['a quote under ten characters', { quote: 'Yes.' }],
  ])('refuses %s before anything is written', async (_, bad) => {
    const before = await rows<{ n: number }>(`SELECT (SELECT COUNT(*) FROM proposals) + (SELECT COUNT(*) FROM partners) AS n`)
    const result = await call('submit_evidence', evidence({ org: `bad-${crypto.randomUUID().slice(0, 8)}`, ...bad }))
    expect(result.isError).toBe(true)
    expect(await rows<{ n: number }>(`SELECT (SELECT COUNT(*) FROM proposals) + (SELECT COUNT(*) FROM partners) AS n`)).toEqual(before)
  })

  it('does not queue the same source, person and question twice', async () => {
    const same = evidence({ org: 'dup-org' })
    await call('submit_evidence', same)
    const again = await call('submit_evidence', same)
    expect(again.structuredContent).toMatchObject({ queued: false, duplicate: true, proposal_id: null })
  })

  it('refuses an unknown person, and writes no proposal', async () => {
    const result = await call('submit_evidence', evidence({ org: 'unknown-person-org', decider_id: 'nobody' }))
    expect(result.isError).toBe(true)
    expect(await rows(`SELECT p.id FROM proposals p JOIN partners o ON o.id = p.submitted_by WHERE o.org = 'unknown-person-org'`)).toEqual([])
  })
})
