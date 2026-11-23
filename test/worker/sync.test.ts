import { env } from 'cloudflare:workers'
import { getServerByName } from 'partyserver'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ProposalDraft } from '../../shared/schema.ts'
import type { Tracker } from '../../worker/tracker.ts'
import { EDITOR_TOKEN, type Frame, mailbox, partySocket, partyWrite, postAs, proposal, reader, rows, seed, signIn, until, noOutsidePages } from './helpers.ts'

const body = { id: 'new-body', slug: 'new-body', name: 'New Body', jurisdiction: null, description: null, is_demo: false, sort: 9, next_term_on: null, next_term_label: null }
const rowsOn = (frames: Frame[], channel: string) => frames.filter((f) => f.channel === channel).flatMap((f) => f.ops.map((op) => op.value))
const insertBody = [{ channel: 'bodies', ops: [{ type: 'insert', value: body }] }]

const tracker = () => getServerByName<Env, Tracker>(env.Tracker, 'main')

// What reading an article queues: an item with its passage, which is public,
// and the text around it and the people only named, which are not.
const readDraft = (name: string): ProposalDraft => ({
  source: { url: `https://news.example/read-${name}`, title: null },
  note: null,
  items: [
    {
      question_id: 'hot',
      decider_id: 'bob',
      kind: 'says',
      occurred_on: null,
      quote: `I will vote against it, ${name}.`,
      reading: 'oppose',
      passage: `Bob Beta said: I will vote against it, ${name}.`,
      context: { before: `Text before the passage, ${name}.`, after: `Text after the passage, ${name}.` },
    },
  ],
  mentions: [{ decider_id: 'eve', words: `Eve Epsilon was absent, ${name}` }],
})

// The tables only an editor's connection is sent.
const EDITOR_ONLY = ['proposal_notes', 'proposal_contexts', 'proposal_mentions']

let send: ReturnType<typeof postAs>

beforeAll(async () => {
  noOutsidePages()
  await seed()
  send = (await reader('proposer@reader.test')).send
  // One proposal with a submitter note and one read from an article, so each
  // editor-only table has a row to withhold.
  const res = await send('/api/proposals', proposal({ submitter_note: 'Only editors should read this.' }))
  expect(await res.json()).toMatchObject({ ok: true, duplicate: false })
  expect(await (await tracker()).propose(readDraft('on-file'), 'model')).toMatchObject({ ok: true, queued: 1 })
})

describe('writes through the party endpoint', () => {
  it('refuses an anonymous write to a public collection', async () => {
    const res = await partyWrite(insertBody)
    expect(res.status).toBe(401)
    expect(await rows(`SELECT id FROM bodies WHERE id = 'new-body'`)).toEqual([])
  })

  it('refuses a write with the wrong token', async () => {
    const res = await partyWrite(insertBody, 'not-the-token')
    expect(res.status).toBe(401)
    expect(await rows(`SELECT id FROM bodies WHERE id = 'new-body'`)).toEqual([])
  })

  it('refuses an anonymous comment, which readers post through the Worker instead', async () => {
    const comment = { id: 'c1', thread_id: 'hot:ann', person_id: 'anyone', body: 'y', created_at: '2026-11-19T00:00:00Z' }
    expect((await partyWrite([{ channel: 'comments', ops: [{ type: 'insert', value: comment }] }])).status).toBe(401)
    expect(await rows(`SELECT id FROM comments`)).toEqual([])
  })

  it('takes an editor write and stores it', async () => {
    const res = await partyWrite(insertBody, EDITOR_TOKEN)
    expect(res.status).toBe(200)
    expect(await rows(`SELECT id, name FROM bodies WHERE id = 'new-body'`)).toEqual([{ id: 'new-body', name: 'New Body' }])
  })

  const setPosition = { id: 'hot:ann', question_id: 'hot', decider_id: 'ann', position: 'lean_support', reason: 'Told the caucus she will vote yes.', set_at: '2026-11-19T00:00:00.000Z' }
  const relation = { id: 'hot>cold', question_id: 'hot', related_id: 'cold', kind: 'smaller_step', sort: 0 }

  it.each([
    ['set_positions', setPosition],
    ['question_relations', relation],
  ])('refuses an anonymous write to %s, and one with the wrong token', async (channel, value) => {
    const batches = [{ channel, ops: [{ type: 'insert', value: { ...value, id: `${value.id}-refused` } }] }]
    expect((await partyWrite(batches)).status).toBe(401)
    expect((await partyWrite(batches, 'not-the-token')).status).toBe(401)
    expect(await rows(`SELECT id FROM ${channel} WHERE id = ?`, `${value.id}-refused`)).toEqual([])
  })

  it('takes a set position from an editor, lets the editor change it and take it back', async () => {
    const value = { ...setPosition, id: 'cold:ann', question_id: 'cold' }
    expect((await partyWrite([{ channel: 'set_positions', ops: [{ type: 'insert', value }] }], EDITOR_TOKEN)).status).toBe(200)
    expect(await rows(`SELECT question_id, decider_id, position, reason FROM set_positions WHERE id = 'cold:ann'`)).toEqual([
      { question_id: 'cold', decider_id: 'ann', position: 'lean_support', reason: 'Told the caucus she will vote yes.' },
    ])
    expect((await partyWrite([{ channel: 'set_positions', ops: [{ type: 'update', value: { id: 'cold:ann', position: 'support' } }] }], EDITOR_TOKEN)).status).toBe(200)
    expect(await rows(`SELECT position, reason FROM set_positions WHERE id = 'cold:ann'`)).toEqual([{ position: 'support', reason: 'Told the caucus she will vote yes.' }])
    expect((await partyWrite([{ channel: 'set_positions', ops: [{ type: 'delete', value: { id: 'cold:ann' } }] }], EDITOR_TOKEN)).status).toBe(200)
    expect(await rows(`SELECT id FROM set_positions WHERE id = 'cold:ann'`)).toEqual([])
  })

  it('takes a link between two questions from an editor', async () => {
    const value = { ...relation, id: 'cold>hot', question_id: 'cold', related_id: 'hot', kind: 'related' }
    expect((await partyWrite([{ channel: 'question_relations', ops: [{ type: 'insert', value }] }], EDITOR_TOKEN)).status).toBe(200)
    expect(await rows(`SELECT question_id, related_id, kind FROM question_relations WHERE id = 'cold>hot'`)).toEqual([{ question_id: 'cold', related_id: 'hot', kind: 'related' }])
  })

  it.each(EDITOR_ONLY)('refuses an anonymous write to %s', async (channel) => {
    const value = { id: 'forged', proposal_id: 'forged', proposal_item_id: 'forged', question_id: 'hot', decider_id: 'ann', kind: 'review', body: 'x', before: 'x', after: 'x', words: 'x', created_at: '2026-11-19T00:00:00Z' }
    expect((await partyWrite([{ channel, ops: [{ type: 'insert', value }] }])).status).toBe(401)
    expect(await rows(`SELECT id FROM ${channel} WHERE id = 'forged'`)).toEqual([])
  })

  it('refuses an editor insert to comments, which only allows delete', async () => {
    const comment = { id: 'c2', thread_id: 'hot:ann', person_id: 'anyone', body: 'y', created_at: '2026-11-19T00:00:00Z' }
    expect((await partyWrite([{ channel: 'comments', ops: [{ type: 'insert', value: comment }] }], EDITOR_TOKEN)).status).toBe(403)
  })
})

describe('a signed-in reader in the sync room', () => {
  const mail = mailbox()
  let cookie = ''
  let personId = ''
  // The raw token Better Auth keeps for the session, which the cookie carries signed.
  let sessionToken = ''

  beforeAll(async () => {
    cookie = await signIn(mail, 'room@reader.test')
    const [row] = await rows<{ id: string; token: string }>(`SELECT u.id, s.token FROM auth_users u JOIN auth_sessions s ON s."userId" = u.id WHERE u.email = 'room@reader.test'`)
    personId = row.id
    sessionToken = row.token
  })

  it('refuses their write to a public collection, with the session cookie or the session token', async () => {
    const theirs = [{ channel: 'bodies', ops: [{ type: 'insert', value: { ...body, id: 'reader-body', slug: 'reader-body' } }] }]
    expect((await partyWrite(theirs, undefined, cookie)).status).toBe(401)
    expect((await partyWrite(theirs, sessionToken)).status).toBe(401)
    expect(await rows(`SELECT id FROM bodies WHERE id = 'reader-body'`)).toEqual([])
  })

  it('refuses their write to their own person, which they rename through the Worker instead', async () => {
    const rename = [{ channel: 'people', ops: [{ type: 'update', value: { id: personId, display_name: 'Renamed' } }] }]
    expect((await partyWrite(rename, undefined, cookie)).status).toBe(401)
    expect((await partyWrite(rename, sessionToken)).status).toBe(401)
    expect(await rows(`SELECT display_name FROM people WHERE id = ?`, personId)).toEqual([{ display_name: null }])
  })

  it.each([
    ['the session cookie', () => [undefined, cookie] as const],
    ['the session token', () => [sessionToken, undefined] as const],
  ])('sends a socket opened with %s nothing from the tables only editors read', async (_, credentials) => {
    const socket = await partySocket(...credentials())
    await until(() => socket.channels().has('bodies'))
    const before = socket.frames.length
    for (const channel of EDITOR_ONLY) socket.send({ subscribe: channel })
    await until(() => EDITOR_ONLY.every((channel) => socket.frames.slice(before).some((f) => f.channel === channel)))
    for (const channel of EDITOR_ONLY) expect(rowsOn(socket.frames, channel)).toEqual([])
    socket.close()
  })

  it('lets no one add a person through the room', async () => {
    const added = [{ channel: 'people', ops: [{ type: 'insert', value: { id: 'made-up', display_name: 'Nobody', created_at: '2026-11-20T12:00:00.000Z' } }] }]
    expect((await partyWrite(added, EDITOR_TOKEN)).status).toBe(403)
    expect((await partyWrite(added, undefined, cookie)).status).toBe(401)
    expect(await rows(`SELECT id FROM people WHERE id = 'made-up'`)).toEqual([])
  })
})

describe('what a socket is sent', () => {
  // Subscribes to each editor-only table and waits for every answer. A refused
  // subscribe is answered with an empty reset, so the client's load settles;
  // what matters is that it carries no rows.
  async function askForEditorOnly(socket: Awaited<ReturnType<typeof partySocket>>) {
    const before = socket.frames.length
    for (const channel of EDITOR_ONLY) socket.send({ subscribe: channel })
    await until(() => EDITOR_ONLY.every((channel) => socket.frames.slice(before).some((f) => f.channel === channel)))
  }
  const PRIVATE = ['Only editors should read this.', 'Text before the passage', 'Text after the passage', 'Eve Epsilon was absent', 'A rule only editors should read.']

  it('sends an anonymous reader the public tables and nothing from the tables only editors read', async () => {
    const reader = await partySocket()
    await until(() => reader.channels().has('bodies') && reader.channels().has('questions'))
    await askForEditorOnly(reader)
    for (const channel of EDITOR_ONLY) expect(rowsOn(reader.frames, channel)).toEqual([])
    reader.close()
  })

  it('sends a reader who asks for proposals the passage of an item and none of the text around it', async () => {
    const reader = await partySocket()
    await until(() => reader.channels().has('bodies'))
    reader.send({ subscribe: 'proposals' })
    reader.send({ subscribe: 'proposal_items' })
    await until(() => rowsOn(reader.frames, 'proposal_items').length > 0 && rowsOn(reader.frames, 'proposals').length > 0)
    await askForEditorOnly(reader)
    expect(rowsOn(reader.frames, 'proposal_items').map((i) => i.passage)).toContain('Bob Beta said: I will vote against it, on-file.')
    const sent = JSON.stringify(reader.frames)
    for (const text of PRIVATE) expect(sent).not.toContain(text)
    reader.close()
  })

  it.each([
    ['a wrong token', 'not-the-token'],
    ['a prefix of the token', EDITOR_TOKEN.slice(0, -1)],
  ])('treats a socket with %s as a reader', async (_, token) => {
    const socket = await partySocket(token)
    await until(() => socket.channels().has('bodies'))
    await askForEditorOnly(socket)
    for (const channel of EDITOR_ONLY) expect(rowsOn(socket.frames, channel)).toEqual([])
    socket.close()
  })

  it('sends an editor the proposal notes, contexts and mentions on connect', async () => {
    const editor = await partySocket(EDITOR_TOKEN)
    await until(() => EDITOR_ONLY.every((channel) => editor.channels().has(channel)))
    expect(rowsOn(editor.frames, 'proposal_notes').map((n) => n.body)).toContain('Only editors should read this.')
    expect(rowsOn(editor.frames, 'proposal_contexts').map((c) => [c.before, c.after])).toContainEqual(['Text before the passage, on-file.', 'Text after the passage, on-file.'])
    expect(rowsOn(editor.frames, 'proposal_mentions').map((m) => [m.decider_id, m.words])).toContainEqual(['eve', 'Eve Epsilon was absent, on-file'])
    editor.close()
  })

  it('sends everyone the positions editors set and the links between questions', async () => {
    const setPosition = { id: 'hot:eve', question_id: 'hot', decider_id: 'eve', position: 'oppose', reason: 'Said so at the town hall.', set_at: '2026-11-19T00:00:00.000Z' }
    const relation = { id: 'hot>closing', question_id: 'hot', related_id: 'closing', kind: 'related', sort: 0 }
    const before = await partySocket()
    await until(() => before.channels().has('bodies'))
    const seen = before.frames.length
    expect((await partyWrite([{ channel: 'set_positions', ops: [{ type: 'insert', value: setPosition }] }, { channel: 'question_relations', ops: [{ type: 'insert', value: relation }] }], EDITOR_TOKEN)).status).toBe(200)

    // A reader already connected is told of both as they are written.
    await until(() => rowsOn(before.frames.slice(seen), 'set_positions').length > 0 && rowsOn(before.frames.slice(seen), 'question_relations').length > 0)
    expect(rowsOn(before.frames.slice(seen), 'set_positions')).toEqual([setPosition])
    expect(rowsOn(before.frames.slice(seen), 'question_relations')).toEqual([relation])
    before.close()

    // One who connects afterwards is sent both without asking.
    const after = await partySocket()
    await until(() => after.channels().has('set_positions') && after.channels().has('question_relations'))
    expect(rowsOn(after.frames, 'set_positions')).toContainEqual(setPosition)
    expect(rowsOn(after.frames, 'question_relations')).toContainEqual(relation)
    after.close()
  })

  it('broadcasts a new proposal note to the editor and not to the reader', async () => {
    const reader = await partySocket()
    const editor = await partySocket(EDITOR_TOKEN)
    await until(() => reader.channels().has('bodies') && editor.channels().has('proposal_notes'))
    const seen = { reader: reader.frames.length, editor: editor.frames.length }

    const res = await send('/api/proposals', proposal({ source_url: 'https://news.example/live', submitter_note: 'A second private note.' }))
    expect(await res.json()).toMatchObject({ ok: true, duplicate: false })

    // A later write is sent after everything the proposal committed, so once the
    // reader has it, any note that was going to reach the reader already has.
    const marker = { ...body, id: 'after-live', slug: 'after-live' }
    expect((await partyWrite([{ channel: 'bodies', ops: [{ type: 'insert', value: marker }] }], EDITOR_TOKEN)).status).toBe(200)
    await until(() => rowsOn(reader.frames.slice(seen.reader), 'bodies').some((b) => b.id === 'after-live'))

    // The reader is sent the public half of the same proposal.
    expect(rowsOn(reader.frames.slice(seen.reader), 'sources').map((src) => src.url)).toContain('https://news.example/live')
    expect(rowsOn(reader.frames, 'proposal_notes')).toEqual([])
    await until(() => editor.frames.slice(seen.editor).some((f) => f.channel === 'proposal_notes'))
    expect(rowsOn(editor.frames.slice(seen.editor), 'proposal_notes').map((n) => n.body)).toEqual(['A second private note.'])
    reader.close()
    editor.close()
  })

  it('broadcasts the text around a new passage, the people only named and a new question rule to the editor and not to the reader', async () => {
    const reader = await partySocket()
    const editor = await partySocket(EDITOR_TOKEN)
    await until(() => reader.channels().has('bodies') && EDITOR_ONLY.every((channel) => editor.channels().has(channel)))
    // The reader has the proposal tables open, as the feed's waiting mode does.
    reader.send({ subscribe: 'proposals' })
    reader.send({ subscribe: 'proposal_items' })
    await until(() => reader.channels().has('proposals') && reader.channels().has('proposal_items'))
    const seen = { reader: reader.frames.length, editor: editor.frames.length }

    expect(await (await tracker()).propose(readDraft('live'), 'model')).toMatchObject({ ok: true, queued: 1 })

    const marker = { ...body, id: 'after-read', slug: 'after-read' }
    expect((await partyWrite([{ channel: 'bodies', ops: [{ type: 'insert', value: marker }] }], EDITOR_TOKEN)).status).toBe(200)
    await until(() => rowsOn(reader.frames.slice(seen.reader), 'bodies').some((b) => b.id === 'after-read'))

    // The reader is sent the item with its passage, and nothing else of what was read.
    expect(rowsOn(reader.frames.slice(seen.reader), 'proposal_items').map((i) => i.passage)).toEqual(['Bob Beta said: I will vote against it, live.'])
    const sent = JSON.stringify(reader.frames)
    for (const text of PRIVATE) expect(sent).not.toContain(text)
    for (const channel of EDITOR_ONLY) expect(rowsOn(reader.frames, channel)).toEqual([])

    await until(() => ['proposal_contexts', 'proposal_mentions'].every((channel) => editor.frames.slice(seen.editor).some((f) => f.channel === channel)))
    expect(rowsOn(editor.frames.slice(seen.editor), 'proposal_contexts').map((c) => [c.before, c.after])).toEqual([['Text before the passage, live.', 'Text after the passage, live.']])
    expect(rowsOn(editor.frames.slice(seen.editor), 'proposal_mentions').map((m) => [m.decider_id, m.words])).toEqual([['eve', 'Eve Epsilon was absent, live']])
    reader.close()
    editor.close()
  })
})
