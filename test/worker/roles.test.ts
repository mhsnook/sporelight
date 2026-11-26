import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { EDITORS_ID } from '../../shared/schema.ts'
import { LAST_EDITOR } from '../../worker/auth.ts'
import { mailbox, nextIp, partySocket, partyWrite, post, reader, rows, seed, until } from './helpers.ts'

const mail = mailbox()
const admin = (path: string, body: unknown, cookie: string) => mail.call(`/api/auth/admin/${path}`, body, nextIp(), cookie)
const setup = (cookie?: string) => post('/api/setup', {}, undefined, undefined, cookie)
const needed = async () => ((await (await exports.default.fetch('http://sporelight.test/api/setup')).json()) as { needed: boolean }).needed
const roleOf = async (id: string) => (await rows<{ role: string; banned: number }>(`SELECT role, banned FROM auth_users WHERE id = ?`, id))[0]
const publicRow = async (id: string) => (await rows<{ role: string; deactivated_at: string | null }>(`SELECT role, deactivated_at FROM people WHERE id = ?`, id))[0]
const newBody = (id: string) => [{ channel: 'bodies', ops: [{ type: 'insert', value: { id, slug: id, name: id, jurisdiction: null, description: null, is_demo: false, sort: 9, next_term_on: null, next_term_label: null } }] }]

let first: Awaited<ReturnType<typeof reader>>
let second: Awaited<ReturnType<typeof reader>>

beforeAll(async () => {
  await seed()
  first = await reader('first@reader.test', 'First')
  second = await reader('second@reader.test', 'Second')
})

describe('the first editor of a new deployment', () => {
  it('counts the identity the retired token wrote as an editor who cannot act or sign in', async () => {
    expect(await roleOf(EDITORS_ID)).toEqual({ role: 'editor', banned: 1 })
    expect(await publicRow(EDITORS_ID)).toEqual({ role: 'editor', deactivated_at: expect.any(String) })
    expect(await needed()).toBe(true)
  })

  it('refuses a signed-out request', async () => {
    expect((await setup()).status).toBe(401)
  })

  it('makes one of two people asking at once the first editor, and refuses the other', async () => {
    const answers = await Promise.all([setup(first.cookie), setup(second.cookie)])
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409])
    const [winner, loser] = answers[0].status === 200 ? [first, second] : [second, first]
    expect(await roleOf(winner.personId)).toEqual({ role: 'editor', banned: 0 })
    expect(await roleOf(loser.personId)).toEqual({ role: 'member', banned: 0 })
    expect(await publicRow(winner.personId)).toEqual({ role: 'editor', deactivated_at: null })
    expect(await needed()).toBe(false)
    // Whoever lost is made an editor by the winner, so the tests below can use both.
    expect((await admin('set-role', { userId: loser.personId, role: 'editor' }, winner.cookie)).status).toBe(200)
  })

  it('refuses everyone once there is an editor', async () => {
    const late = await reader('late@reader.test')
    expect((await setup(late.cookie)).status).toBe(409)
    expect(await roleOf(late.personId)).toEqual({ role: 'member', banned: 0 })
  })
})

describe('changing roles through Better Auth', () => {
  it('lets an editor make a member an editor and back, and copies the role onto the public row', async () => {
    const someone = await reader('promoted@reader.test')
    expect((await partyWrite(newBody('before-promotion'), undefined, someone.cookie)).status).toBe(403)
    expect((await admin('set-role', { userId: someone.personId, role: 'editor' }, first.cookie)).status).toBe(200)
    expect(await publicRow(someone.personId)).toEqual({ role: 'editor', deactivated_at: null })
    expect((await partyWrite(newBody('after-promotion'), undefined, someone.cookie)).status).toBe(200)
    expect((await admin('set-role', { userId: someone.personId, role: 'member' }, first.cookie)).status).toBe(200)
    expect(await publicRow(someone.personId)).toEqual({ role: 'member', deactivated_at: null })
    expect((await partyWrite(newBody('after-demotion'), undefined, someone.cookie)).status).toBe(403)
  })

  it('refuses a member changing anyone’s role, their own included', async () => {
    const someone = await reader('climber@reader.test')
    expect((await admin('set-role', { userId: someone.personId, role: 'editor' }, someone.cookie)).status).toBe(403)
    expect((await admin('set-role', { userId: first.personId, role: 'member' }, someone.cookie)).status).toBe(403)
    expect(await roleOf(someone.personId)).toEqual({ role: 'member', banned: 0 })
  })

  it('refuses a role that does not exist, and a list of roles', async () => {
    const someone = await reader('odd-role@reader.test')
    expect((await admin('set-role', { userId: someone.personId, role: 'admin' }, first.cookie)).ok).toBe(false)
    expect((await admin('set-role', { userId: someone.personId, role: ['editor', 'member'] }, first.cookie)).ok).toBe(false)
    expect(await roleOf(someone.personId)).toEqual({ role: 'member', banned: 0 })
  })

  it('refuses making an agent an editor', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO auth_users (id, name, email, emailVerified, createdAt, updatedAt, isAnonymous, role) VALUES ('agent-1', 'Agent', 'agent-1@agents.sporelight.invalid', 0, 't', 't', 1, 'member')`),
      env.DB.prepare(`INSERT INTO people (id, kind, display_name, created_at) VALUES ('agent-1', 'agent', 'Agent', 't')`),
    ])
    const res = await admin('set-role', { userId: 'agent-1', role: 'editor' }, first.cookie)
    expect(res.status).toBe(400)
    expect(await roleOf('agent-1')).toEqual({ role: 'member', banned: 0 })
  })

  it('gives an editor no route to anyone’s email address or sessions', async () => {
    const someone = await reader('private@reader.test')
    const get = (path: string) => exports.default.fetch(`http://sporelight.test/api/auth/admin/${path}`, { headers: { cookie: first.cookie } })
    const answers = [await get('list-users'), await get(`get-user?id=${someone.personId}`), await admin('list-user-sessions', { userId: someone.personId }, first.cookie)]
    expect(answers.map((res) => res.status)).toEqual([403, 403, 403])
    for (const res of answers) expect(await res.text()).not.toContain('private@reader.test')
  })

  it('refuses an editor impersonating someone, so nobody writes as anyone else', async () => {
    const someone = await reader('impersonated@reader.test')
    expect((await admin('impersonate-user', { userId: someone.personId }, first.cookie)).status).toBe(403)
  })

  it('closes a person’s open socket when their role changes, so it reconnects under the new one', async () => {
    const someone = await reader('socket@reader.test')
    const socket = await partySocket(undefined, someone.cookie)
    await until(() => socket.channels().has('bodies'))
    expect((await admin('set-role', { userId: someone.personId, role: 'editor' }, first.cookie)).status).toBe(200)
    await until(() => socket.closedWith() !== null)
    expect(socket.closedWith()).toBe(4001)
  })
})

describe('keeping one editor who can act', () => {
  it('refuses the last editor who can act making themselves a member, with a reason', async () => {
    await env.DB.prepare(`UPDATE auth_users SET role = 'member' WHERE role = 'editor' AND coalesce(banned, 0) = 0 AND id <> ?`).bind(first.personId).run()
    const res = await admin('set-role', { userId: first.personId, role: 'member' }, first.cookie)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toBe(LAST_EDITOR)
    expect(await roleOf(first.personId)).toEqual({ role: 'editor', banned: 0 })
  })

  it('refuses in the database a change that would leave no editor, whoever makes it', async () => {
    await expect(env.DB.prepare(`UPDATE auth_users SET role = 'member' WHERE role = 'editor' AND coalesce(banned, 0) = 0`).run()).rejects.toThrow(/last editor/)
    await expect(env.DB.prepare(`UPDATE auth_users SET banned = 1 WHERE role = 'editor'`).run()).rejects.toThrow(/last editor/)
    expect((await rows(`SELECT id FROM auth_users WHERE role = 'editor' AND coalesce(banned, 0) = 0`)).length).toBeGreaterThan(0)
  })
})

describe('deactivating a person', () => {
  it('ends their sessions, refuses their sign-in and writes, and marks the public row', async () => {
    const someone = await reader('deactivated@reader.test', 'Gone Soon')
    expect((await post('/api/comments', { question_id: 'hot', decider_id: 'ann', body: 'Before.' }, undefined, undefined, someone.cookie)).status).toBe(200)
    expect((await admin('ban-user', { userId: someone.personId }, first.cookie)).status).toBe(200)

    expect(await publicRow(someone.personId)).toEqual({ role: 'member', deactivated_at: expect.any(String) })
    expect(await rows(`SELECT id FROM auth_sessions WHERE "userId" = ?`, someone.personId)).toEqual([])
    expect((await post('/api/comments', { question_id: 'hot', decider_id: 'ann', body: 'After.' }, undefined, undefined, someone.cookie)).status).toBe(401)
    const before = mail.sent.length
    const askedAgain = await mail.call('/api/auth/email-otp/send-verification-otp', { email: 'deactivated@reader.test', type: 'sign-in' }, nextIp())
    expect(askedAgain.ok).toBe(true)
    await until(() => mail.sent.length > before)
    const code = /\b(\d{6})\b/.exec(mail.sent.at(-1)!.text)![1]
    const signIn = await mail.call('/api/auth/sign-in/email-otp', { email: 'deactivated@reader.test', otp: code }, nextIp())
    expect(signIn.ok).toBe(false)
    expect(await rows(`SELECT id FROM auth_sessions WHERE "userId" = ?`, someone.personId)).toEqual([])

    expect((await admin('unban-user', { userId: someone.personId }, first.cookie)).status).toBe(200)
    expect(await publicRow(someone.personId)).toEqual({ role: 'member', deactivated_at: null })
  })

  it('refuses a member deactivating anyone', async () => {
    const someone = await reader('would-ban@reader.test')
    expect((await admin('ban-user', { userId: first.personId }, someone.cookie)).status).toBe(403)
    expect(await roleOf(first.personId)).toEqual({ role: 'editor', banned: 0 })
  })
})
