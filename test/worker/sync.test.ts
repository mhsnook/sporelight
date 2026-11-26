import { env } from 'cloudflare:workers'
import { getServerByName } from 'partyserver'
import { beforeAll, describe, expect, it } from 'vitest'
import { EDITORS_ID, type ProposalDraft } from '../../shared/schema.ts'
import type { Tracker } from '../../worker/tracker.ts'
import { editor, type Frame, partySocket, partyWrite, proposal, reader, rows, seed, until, noOutsidePages } from './helpers.ts'

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

// The tables only a signed-in person's connection is sent.
const SIGNED_IN_ONLY = ['proposal_notes', 'proposal_contexts', 'proposal_mentions']

// Every table a write through the room changes, and who may insert into it.
const EDITOR_WRITES = [
  'bodies', 'deciders', 'seats', 'roles', 'questions', 'question_deciders', 'question_bodies', 'offices', 'office_holders', 'question_offices',
  'question_relations', 'set_positions', 'sources', 'acts', 'reports', 'same_acts', 'proposals', 'proposal_items', ...SIGNED_IN_ONLY,
]

let send: Awaited<ReturnType<typeof reader>>['send']
let member: Awaited<ReturnType<typeof reader>>
let editorOne: Awaited<ReturnType<typeof editor>>

beforeAll(async () => {
  noOutsidePages()
  await seed()
  send = (await reader('proposer@reader.test')).send
  member = await reader('member@reader.test', 'A Member')
  editorOne = await editor('editor@reader.test', 'An Editor')
  // One proposal with a submitter note and one read from an article, so each
  // editor-only table has a row to withhold.
  const res = await send('/api/proposals', proposal({ submitter_note: 'Only signed-in people should read this.' }))
  expect(await res.json()).toMatchObject({ ok: true, duplicate: false })
  expect(await (await tracker()).propose(readDraft('on-file'), 'model')).toMatchObject({ ok: true, queued: 1 })
})

describe('writes through the party endpoint', () => {
  const forged = { id: 'forged', proposal_id: 'forged', proposal_item_id: 'forged', question_id: 'hot', decider_id: 'ann', kind: 'review', body: 'x', before: 'x', after: 'x', words: 'x', created_at: '2026-11-19T00:00:00Z' }

  it.each(EDITOR_WRITES)('refuses an insert to %s from a signed-out reader and from a member', async (channel) => {
    const batches = [{ channel, ops: [{ type: 'insert', value: { ...forged, act_id: 'forged' } }] }]
    expect((await partyWrite(batches)).status).toBe(401)
    expect((await partyWrite(batches, undefined, member.cookie)).status).toBe(403)
  })

  it('refuses a member who sends their session token as a bearer instead of the cookie', async () => {
    const [{ token }] = await rows<{ token: string }>(`SELECT token FROM auth_sessions WHERE "userId" = ?`, member.personId)
    expect((await partyWrite(insertBody, token)).status).toBe(401)
    expect(await rows(`SELECT id FROM bodies WHERE id = 'new-body'`)).toEqual([])
  })

  it('takes an editor write and stores it', async () => {
    const res = await partyWrite(insertBody, undefined, editorOne.cookie)
    expect(res.status).toBe(200)
    expect(await rows(`SELECT id, name FROM bodies WHERE id = 'new-body'`)).toEqual([{ id: 'new-body', name: 'New Body' }])
  })

  const setPosition = { id: 'cold:ann', question_id: 'cold', decider_id: 'ann', position: 'lean_support', reason: 'Told the caucus she will vote yes.', set_at: '2026-11-19T00:00:00.000Z' }

  it('takes a set position from an editor, lets the editor change it and take it back, and refuses a member each time', async () => {
    const write = (op: string, value: Record<string, unknown>, cookie: string) => partyWrite([{ channel: 'set_positions', ops: [{ type: op, value }] }], undefined, cookie)
    expect((await write('insert', setPosition, editorOne.cookie)).status).toBe(200)
    expect((await write('update', { id: 'cold:ann', position: 'oppose' }, member.cookie)).status).toBe(403)
    expect((await write('update', { id: 'cold:ann', position: 'support' }, editorOne.cookie)).status).toBe(200)
    expect(await rows(`SELECT position, reason FROM set_positions WHERE id = 'cold:ann'`)).toEqual([{ position: 'support', reason: 'Told the caucus she will vote yes.' }])
    expect((await write('delete', { id: 'cold:ann' }, member.cookie)).status).toBe(403)
    expect((await write('delete', { id: 'cold:ann' }, editorOne.cookie)).status).toBe(200)
    expect(await rows(`SELECT id FROM set_positions WHERE id = 'cold:ann'`)).toEqual([])
  })

  it('takes a link between two questions from an editor', async () => {
    const value = { id: 'cold>hot', question_id: 'cold', related_id: 'hot', kind: 'related', sort: 0 }
    expect((await partyWrite([{ channel: 'question_relations', ops: [{ type: 'insert', value }] }], undefined, editorOne.cookie)).status).toBe(200)
    expect(await rows(`SELECT question_id, related_id, kind FROM question_relations WHERE id = 'cold>hot'`)).toEqual([{ question_id: 'cold', related_id: 'hot', kind: 'related' }])
  })

  it('refuses a comment written through the room by anyone, an editor included, since comments are posted through the Worker', async () => {
    const comment = { id: 'c1', thread_id: 'hot:ann', person_id: member.personId, body: 'y', created_at: '2026-11-19T00:00:00Z' }
    const batches = [{ channel: 'comments', ops: [{ type: 'insert', value: comment }] }]
    expect((await partyWrite(batches)).status).toBe(401)
    for (const cookie of [member.cookie, editorOne.cookie]) expect((await partyWrite(batches, undefined, cookie)).status).toBe(403)
    expect(await rows(`SELECT id FROM comments WHERE id = 'c1'`)).toEqual([])
  })

  it('lets an editor delete a comment, and refuses a member deleting even their own', async () => {
    await member.send('/api/comments', { question_id: 'hot', decider_id: 'ann', body: 'A comment to delete.' })
    const [{ id }] = await rows<{ id: string }>(`SELECT id FROM comments WHERE body = 'A comment to delete.'`)
    const remove = [{ channel: 'comments', ops: [{ type: 'delete', value: { id } }] }]
    expect((await partyWrite(remove)).status).toBe(401)
    expect((await partyWrite(remove, undefined, member.cookie)).status).toBe(403)
    expect(await rows(`SELECT id FROM comments WHERE id = ?`, id)).toHaveLength(1)
    expect((await partyWrite(remove, undefined, editorOne.cookie)).status).toBe(200)
    expect(await rows(`SELECT id FROM comments WHERE id = ?`, id)).toEqual([])
  })

  it('lets no one, an editor included, add or change a person through the room, so nobody makes themselves an editor', async () => {
    const added = [{ channel: 'people', ops: [{ type: 'insert', value: { id: 'made-up', kind: 'person', display_name: 'Nobody', role: 'editor', deactivated_at: null, created_at: '2026-11-20T12:00:00.000Z' } }] }]
    const promoted = [{ channel: 'people', ops: [{ type: 'update', value: { id: member.personId, role: 'editor' } }] }]
    for (const batches of [added, promoted]) {
      expect((await partyWrite(batches)).status).toBe(401)
      expect((await partyWrite(batches, undefined, member.cookie)).status).toBe(403)
      expect((await partyWrite(batches, undefined, editorOne.cookie)).status).toBe(403)
    }
    expect(await rows(`SELECT id FROM people WHERE id = 'made-up'`)).toEqual([])
    expect(await rows(`SELECT role FROM people WHERE id = ?`, member.personId)).toEqual([{ role: 'member' }])
  })
})

describe('what a socket is sent', () => {
  // Subscribes to each signed-in-only table and waits for every answer. A
  // refused subscribe is answered with an empty reset, so the client's load
  // settles; what matters is that it carries no rows.
  async function askForSignedInOnly(socket: Awaited<ReturnType<typeof partySocket>>) {
    const before = socket.frames.length
    for (const channel of SIGNED_IN_ONLY) socket.send({ subscribe: channel })
    await until(() => SIGNED_IN_ONLY.every((channel) => socket.frames.slice(before).some((f) => f.channel === channel)))
  }
  const PRIVATE = ['Only signed-in people should read this.', 'Text before the passage', 'Text after the passage', 'Eve Epsilon was absent']

  it('sends a signed-out reader the public tables and nothing from the tables only signed-in people read', async () => {
    const reader = await partySocket()
    await until(() => reader.channels().has('bodies') && reader.channels().has('questions'))
    await askForSignedInOnly(reader)
    for (const channel of SIGNED_IN_ONLY) expect(rowsOn(reader.frames, channel)).toEqual([])
    reader.close()
  })

  it('sends a signed-out reader the passage of what came in, on its report, and none of the text around it', async () => {
    const reader = await partySocket()
    await until(() => reader.channels().has('bodies'))
    reader.send({ subscribe: 'proposals' })
    reader.send({ subscribe: 'proposal_items' })
    await until(() => rowsOn(reader.frames, 'proposal_items').length > 0 && rowsOn(reader.frames, 'proposals').length > 0)
    await askForSignedInOnly(reader)
    expect(rowsOn(reader.frames, 'reports').map((r) => r.passage)).toContain('Bob Beta said: I will vote against it, on-file.')
    const sent = JSON.stringify(reader.frames)
    for (const text of PRIVATE) expect(sent).not.toContain(text)
    reader.close()
  })

  it('treats a socket with a session token in the query, or a forged cookie, as signed out', async () => {
    const [{ token }] = await rows<{ token: string }>(`SELECT token FROM auth_sessions WHERE "userId" = ?`, member.personId)
    for (const socket of [await partySocket(token), await partySocket(undefined, 'better-auth.session_token=not-a-real-session')]) {
      await until(() => socket.channels().has('bodies'))
      await askForSignedInOnly(socket)
      for (const channel of SIGNED_IN_ONLY) expect(rowsOn(socket.frames, channel)).toEqual([])
      socket.close()
    }
  })

  it.each([
    ['a member', () => member.cookie],
    ['an editor', () => editorOne.cookie],
  ])('sends %s the proposal notes, contexts and mentions on connect', async (_, cookie) => {
    const socket = await partySocket(undefined, cookie())
    await until(() => SIGNED_IN_ONLY.every((channel) => socket.channels().has(channel)))
    expect(rowsOn(socket.frames, 'proposal_notes').map((n) => n.body)).toContain('Only signed-in people should read this.')
    expect(rowsOn(socket.frames, 'proposal_contexts').map((c) => [c.before, c.after])).toContainEqual(['Text before the passage, on-file.', 'Text after the passage, on-file.'])
    expect(rowsOn(socket.frames, 'proposal_mentions').map((m) => [m.decider_id, m.words])).toContainEqual(['eve', 'Eve Epsilon was absent, on-file'])
    socket.close()
  })

  it('sends everyone the positions editors set and the links between questions', async () => {
    const setPosition = { id: 'hot:eve', question_id: 'hot', decider_id: 'eve', position: 'oppose', reason: 'Said so at the town hall.', set_at: '2026-11-19T00:00:00.000Z' }
    const relation = { id: 'hot>closing', question_id: 'hot', related_id: 'closing', kind: 'related', sort: 0 }
    const before = await partySocket()
    await until(() => before.channels().has('bodies'))
    const seen = before.frames.length
    expect((await partyWrite([{ channel: 'set_positions', ops: [{ type: 'insert', value: setPosition }] }, { channel: 'question_relations', ops: [{ type: 'insert', value: relation }] }], undefined, editorOne.cookie)).status).toBe(200)

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

  it('broadcasts a new proposal note to a member and an editor and not to a signed-out reader', async () => {
    const reader = await partySocket()
    const sockets = [await partySocket(undefined, member.cookie), await partySocket(undefined, editorOne.cookie)]
    await until(() => reader.channels().has('bodies') && sockets.every((s) => s.channels().has('proposal_notes')))
    const seen = { reader: reader.frames.length, others: sockets.map((s) => s.frames.length) }

    const res = await send('/api/proposals', proposal({ source_url: 'https://news.example/live', submitter_note: 'A second private note.' }))
    expect(await res.json()).toMatchObject({ ok: true, duplicate: false })

    // A later write is sent after everything the proposal committed, so once the
    // reader has it, any note that was going to reach the reader already has.
    const marker = { ...body, id: 'after-live', slug: 'after-live' }
    expect((await partyWrite([{ channel: 'bodies', ops: [{ type: 'insert', value: marker }] }], undefined, editorOne.cookie)).status).toBe(200)
    await until(() => rowsOn(reader.frames.slice(seen.reader), 'bodies').some((b) => b.id === 'after-live'))

    expect(rowsOn(reader.frames.slice(seen.reader), 'sources').map((src) => src.url)).toContain('https://news.example/live')
    expect(rowsOn(reader.frames, 'proposal_notes')).toEqual([])
    for (const [i, socket] of sockets.entries()) {
      await until(() => socket.frames.slice(seen.others[i]).some((f) => f.channel === 'proposal_notes'))
      expect(rowsOn(socket.frames.slice(seen.others[i]), 'proposal_notes').map((n) => n.body)).toEqual(['A second private note.'])
      socket.close()
    }
    reader.close()
  })

  it('broadcasts the text around a new passage and the people only named to a member and not to a signed-out reader', async () => {
    const reader = await partySocket()
    const signedIn = await partySocket(undefined, member.cookie)
    await until(() => reader.channels().has('bodies') && SIGNED_IN_ONLY.every((channel) => signedIn.channels().has(channel)))
    // The reader has the proposal tables open, as the feed's waiting mode does.
    reader.send({ subscribe: 'proposals' })
    reader.send({ subscribe: 'proposal_items' })
    await until(() => reader.channels().has('proposals') && reader.channels().has('proposal_items'))
    const seen = { reader: reader.frames.length, signedIn: signedIn.frames.length }

    expect(await (await tracker()).propose(readDraft('live'), 'model')).toMatchObject({ ok: true, queued: 1 })

    const marker = { ...body, id: 'after-read', slug: 'after-read' }
    expect((await partyWrite([{ channel: 'bodies', ops: [{ type: 'insert', value: marker }] }], undefined, editorOne.cookie)).status).toBe(200)
    await until(() => rowsOn(reader.frames.slice(seen.reader), 'bodies').some((b) => b.id === 'after-read'))

    // The reader is sent the item, and the report with its passage, and nothing else of what was read.
    expect(rowsOn(reader.frames.slice(seen.reader), 'proposal_items')).toHaveLength(1)
    expect(rowsOn(reader.frames.slice(seen.reader), 'reports').map((r) => r.passage)).toEqual(['Bob Beta said: I will vote against it, live.'])
    const sent = JSON.stringify(reader.frames)
    for (const text of PRIVATE) expect(sent).not.toContain(text)
    for (const channel of SIGNED_IN_ONLY) expect(rowsOn(reader.frames, channel)).toEqual([])

    await until(() => ['proposal_contexts', 'proposal_mentions'].every((channel) => signedIn.frames.slice(seen.signedIn).some((f) => f.channel === channel)))
    expect(rowsOn(signedIn.frames.slice(seen.signedIn), 'proposal_contexts').map((c) => [c.before, c.after])).toEqual([['Text before the passage, live.', 'Text after the passage, live.']])
    expect(rowsOn(signedIn.frames.slice(seen.signedIn), 'proposal_mentions').map((m) => [m.decider_id, m.words])).toEqual([['eve', 'Eve Epsilon was absent, live']])
    reader.close()
    signedIn.close()
  })
})

describe('reviews in the sync room', () => {
  const review = (id: string, reviewer_id: string, position = 'support') => ({
    id,
    reviewer_id,
    act_id: 'act-reviewed',
    question_id: 'hot',
    position,
    weight: 'clear',
    based_on: null,
    created_at: '2026-11-24T00:00:00.000Z',
    updated_at: '2026-11-24T00:00:00.000Z',
  })
  const write = (type: string, value: Record<string, unknown>, cookie?: string) => partyWrite([{ channel: 'reviews', ops: [{ type, value }] }], undefined, cookie)

  beforeAll(async () => {
    await env.DB.prepare(`INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('act-reviewed', 'ann', 'says', '2026-11-20', 'I am for it.', '2026-11-20T00:00:00Z')`).run()
  })

  it('refuses a review from a signed-out reader', async () => {
    expect((await write('insert', review('signed-out', EDITORS_ID))).status).toBe(401)
    expect(await rows(`SELECT id FROM reviews WHERE act_id = 'act-reviewed'`)).toEqual([])
  })

  it('takes a member review under their own id, and fills their id in when it is left out', async () => {
    expect((await write('insert', review('by-member', member.personId), member.cookie)).status).toBe(200)
    const { reviewer_id: _, ...unsigned } = review('by-editor', '')
    expect((await write('insert', unsigned, editorOne.cookie)).status).toBe(200)
    expect(await rows(`SELECT id, reviewer_id FROM reviews WHERE act_id = 'act-reviewed' ORDER BY id`)).toEqual([
      { id: 'by-editor', reviewer_id: editorOne.personId },
      { id: 'by-member', reviewer_id: member.personId },
    ])
  })

  it('refuses a review written under someone else, a member or an editor writing it', async () => {
    expect((await write('insert', { ...review('as-editor', editorOne.personId), question_id: 'cold' }, member.cookie)).status).toBe(403)
    expect((await write('insert', { ...review('as-member', member.personId), question_id: 'cold' }, editorOne.cookie)).status).toBe(403)
    expect((await write('insert', { ...review('as-editors', EDITORS_ID), question_id: 'cold' }, editorOne.cookie)).status).toBe(403)
    expect(await rows(`SELECT id FROM reviews WHERE question_id = 'cold'`)).toEqual([])
  })

  it("lets its author change a review, and refuses anyone else, an editor included, changing or deleting it", async () => {
    const change = { id: 'by-member', position: 'mixed', updated_at: '2026-11-24T01:00:00.000Z' }
    expect((await write('update', change, member.cookie)).status).toBe(200)
    expect((await write('update', { ...change, position: 'oppose' }, editorOne.cookie)).status).toBe(403)
    expect((await write('update', { ...change, reviewer_id: editorOne.personId }, editorOne.cookie)).status).toBe(403)
    expect((await write('delete', { id: 'by-member' }, editorOne.cookie)).status).toBe(403)
    expect(await rows(`SELECT reviewer_id, position FROM reviews WHERE id = 'by-member'`)).toEqual([{ reviewer_id: member.personId, position: 'mixed' }])
  })

  it('refuses a second review by one reviewer of one act on one question', async () => {
    expect((await write('insert', review('by-member-again', member.personId, 'oppose'), member.cookie)).ok).toBe(false)
    expect(await rows(`SELECT id FROM reviews WHERE reviewer_id = ? AND act_id = 'act-reviewed'`, member.personId)).toEqual([{ id: 'by-member' }])
  })

  it('lets its author delete a review', async () => {
    expect((await write('insert', { ...review('to-delete', member.personId), question_id: 'closing' }, member.cookie)).status).toBe(200)
    expect((await write('delete', { id: 'to-delete' }, member.cookie)).status).toBe(200)
    expect(await rows(`SELECT id FROM reviews WHERE id = 'to-delete'`)).toEqual([])
  })

  it("takes a member's review confirming someone else's, and lets the first one's author delete theirs, leaving the copy", async () => {
    await env.DB.prepare(`INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('act-confirmed', 'ann', 'says', '2026-11-21', 'I back it.', '2026-11-21T00:00:00Z')`).run()
    const on = { act_id: 'act-confirmed' }
    expect((await write('insert', { ...review('first-word', editorOne.personId), ...on }, editorOne.cookie)).status).toBe(200)
    expect((await write('insert', { ...review('confirmed', member.personId), ...on, based_on: 'first-word' }, member.cookie)).status).toBe(200)
    expect((await write('delete', { id: 'first-word' }, editorOne.cookie)).status).toBe(200)
    expect(await rows(`SELECT id, reviewer_id, position, based_on FROM reviews WHERE act_id = 'act-confirmed'`)).toEqual([{ id: 'confirmed', reviewer_id: member.personId, position: 'support', based_on: null }])
  })

  it('sends every review to a signed-out reader', async () => {
    const socket = await partySocket()
    await until(() => rowsOn(socket.frames, 'reviews').some((r) => r.id === 'by-member'))
    expect(rowsOn(socket.frames, 'reviews').find((r) => r.id === 'by-member')).toMatchObject({ reviewer_id: member.personId, position: 'mixed' })
    socket.close()
  })
})

describe('acts marked as the same in the sync room', () => {
  const mark = () => ({ act_id: 'act-again', same_as_id: 'act-first', marked_by: editorOne.personId, marked_at: '2026-11-25T00:00:00.000Z' })
  const insert = () => [{ channel: 'same_acts', ops: [{ type: 'insert', value: mark() }] }]

  beforeAll(async () => {
    await env.DB.batch(
      [
        `INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('act-first', 'ann', 'says', '2026-11-20', 'First.', '2026-11-20T00:00:00Z')`,
        `INSERT INTO acts (id, decider_id, kind, occurred_on, body, created_at) VALUES ('act-again', 'ann', 'says', '2026-11-20', 'Again.', '2026-11-21T00:00:00Z')`,
      ].map((sql) => env.DB.prepare(sql)),
    )
  })

  it('refuses a mark from a signed-out reader and from a member', async () => {
    expect((await partyWrite(insert())).status).toBe(401)
    expect((await partyWrite(insert(), undefined, member.cookie)).status).toBe(403)
    expect(await rows(`SELECT act_id FROM same_acts`)).toEqual([])
  })

  it('takes a mark from an editor, sends it to a signed-out reader, and lets the editor take it away', async () => {
    expect((await partyWrite(insert(), undefined, editorOne.cookie)).status).toBe(200)
    const socket = await partySocket()
    await until(() => rowsOn(socket.frames, 'same_acts').some((r) => r.act_id === 'act-again'))
    socket.close()
    expect((await partyWrite([{ channel: 'same_acts', ops: [{ type: 'delete', value: { act_id: 'act-again' } }] }], undefined, editorOne.cookie)).status).toBe(200)
    expect(await rows(`SELECT act_id FROM same_acts`)).toEqual([])
    expect(await rows(`SELECT id FROM acts WHERE id IN ('act-first', 'act-again') ORDER BY id`)).toEqual([{ id: 'act-again' }, { id: 'act-first' }])
  })
})
