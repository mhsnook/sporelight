import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { askForCode, codeIn, cookieFrom, type Frame, mailbox, nextIp, partySocket, post, postAs, proposal, reader, rows, seed, signIn, until, noOutsidePages } from './helpers.ts'

const mail = mailbox()
const comment = (overrides: Record<string, unknown> = {}) => ({ question_id: 'hot', decider_id: 'ann', body: 'A comment.', ...overrides })
const personFor = async (email: string) =>
  (await rows<{ id: string; display_name: string | null }>(`SELECT p.id, p.display_name FROM people p JOIN auth_users u ON u.id = p.id WHERE u.email = ?`, email))[0]

beforeAll(async () => {
  noOutsidePages()
  await seed()
})

describe('signing in with a code sent by email', () => {
  it('sends one code to the address asked for, from the address in config', async () => {
    const before = mail.sent.length
    const res = await askForCode(mail, 'first@reader.test')
    expect(res.status).toBe(200)
    await until(() => mail.sent.length > before)
    const [message] = mail.sent.slice(before)
    expect(message.to).toBe('first@reader.test')
    expect(message.from.email).toBe(env.EMAIL_FROM)
    expect(codeIn(message)).toMatch(/^\d{6}$/)
  })

  it('signs in a new address with its code and adds a person with no name yet', async () => {
    const cookie = await signIn(mail, 'new@reader.test')
    expect(cookie).toMatch(/session_token=/)
    expect(await personFor('new@reader.test')).toEqual({ id: expect.any(String), display_name: null })
  })

  it('signs the same address in again as the same person', async () => {
    await signIn(mail, 'again@reader.test')
    const first = await personFor('again@reader.test')
    await signIn(mail, 'again@reader.test')
    expect(await rows(`SELECT id FROM people WHERE id = ?`, first.id)).toHaveLength(1)
    expect(await personFor('again@reader.test')).toEqual(first)
  })

  it('refuses a wrong code, and after three wrong tries refuses the right one', async () => {
    const before = mail.sent.length
    const from = nextIp()
    await askForCode(mail, 'guesser@reader.test', from)
    await until(() => mail.sent.length > before)
    const code = codeIn(mail.sent.at(-1)!)
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 3; i++) {
      expect((await mail.call('/api/auth/sign-in/email-otp', { email: 'guesser@reader.test', otp: wrong }, from)).ok).toBe(false)
    }
    const res = await mail.call('/api/auth/sign-in/email-otp', { email: 'guesser@reader.test', otp: code }, from)
    expect(res.ok).toBe(false)
    expect(cookieFrom(res)).not.toMatch(/session_token=/)
    expect(await personFor('guesser@reader.test')).toBeUndefined()
  })

  it('refuses a code sent to another address', async () => {
    const before = mail.sent.length
    const from = nextIp()
    await askForCode(mail, 'owner@reader.test', from)
    await until(() => mail.sent.length > before)
    const res = await mail.call('/api/auth/sign-in/email-otp', { email: 'thief@reader.test', otp: codeIn(mail.sent.at(-1)!) }, from)
    expect(res.ok).toBe(false)
    expect(await personFor('thief@reader.test')).toBeUndefined()
  })

  it('stops sending codes to one address after a few asks in a minute', async () => {
    const from = nextIp()
    const statuses = []
    for (let i = 0; i < 5; i++) statuses.push((await askForCode(mail, 'flood@reader.test', from)).status)
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200])
    expect(statuses.slice(3)).toEqual([429, 429])
  })

  it('signs out, after which the cookie no longer names anyone', async () => {
    const cookie = await signIn(mail, 'leaving@reader.test')
    expect((await mail.call('/api/auth/sign-out', {}, nextIp(), cookie)).ok).toBe(true)
    expect((await post('/api/me/name', { display_name: 'Gone' }, undefined, undefined, cookie)).status).toBe(401)
  })
})

describe('what the public is sent about a person', () => {
  it('sends a reader the person and their name, and never their email address', async () => {
    const cookie = await signIn(mail, 'private.address@reader.test')
    expect((await post('/api/me/name', { display_name: 'Public Name' }, undefined, undefined, cookie)).status).toBe(200)
    const person = await personFor('private.address@reader.test')

    const reader = await partySocket()
    await until(() => reader.frames.some((f) => f.channel === 'people' && f.ops.some((op) => op.value.id === person.id)))
    const sent = JSON.stringify(reader.frames)
    expect(sent).toContain('Public Name')
    expect(sent).not.toContain('private.address@reader.test')
    expect(new Set(reader.frames.map((f: Frame) => f.channel))).not.toContain('auth_users')
    reader.close()
  })

  it('refuses a display name with no session, and a blank one with a session', async () => {
    expect((await post('/api/me/name', { display_name: 'Anyone' })).status).toBe(401)
    const cookie = await signIn(mail, 'blank@reader.test')
    const res = await post('/api/me/name', { display_name: '   ' }, undefined, undefined, cookie)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/^display_name: /)
  })
})

describe('what a signed-in person posts', () => {
  it('ties a comment to the person, under the name they chose', async () => {
    const { personId, send } = await reader('named.commenter@reader.test', 'First Name')
    expect((await send('/api/comments', comment({ body: 'First comment.' }))).status).toBe(200)
    expect(await rows(`SELECT person_id FROM comments WHERE body = 'First comment.'`)).toEqual([{ person_id: personId }])
    expect((await personFor('named.commenter@reader.test')).display_name).toBe('First Name')
  })

  it('records who submitted a proposal', async () => {
    const { personId, send } = await reader('submitter@reader.test')
    const res = await send('/api/proposals', proposal({ source_url: 'https://news.example/signed-in' }))
    const { proposal_id } = (await res.json()) as { proposal_id: string }
    expect(await rows(`SELECT origin, submitted_by FROM proposals WHERE id = ?`, proposal_id)).toEqual([{ origin: 'reader', submitted_by: personId }])
  })

  it.each([
    ['no cookie', undefined],
    ['a forged cookie', 'better-auth.session_token=not-a-real-session'],
  ])('refuses a proposal sent with %s, and queues nothing', async (_, cookie) => {
    const url = `https://news.example/signed-out-${cookie ? 'forged' : 'none'}`
    const res = await post('/api/proposals', proposal({ source_url: url }), undefined, undefined, cookie)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Sign in to post.' })
    expect(await rows(`SELECT id FROM sources WHERE url = ?`, url)).toEqual([])
  })

  it('adds the person for a valid session whose row is missing, once, even for two posts at once', async () => {
    const cookie = await signIn(mail, 'rowless@reader.test')
    const { id } = await personFor('rowless@reader.test')
    await env.DB.prepare(`DELETE FROM people WHERE id = ?`).bind(id).run()
    const send = postAs(cookie)
    const [first, second] = await Promise.all([
      send('/api/comments', comment({ body: 'Rowless, first.', display_name: 'Rowless' })),
      send('/api/proposals', proposal({ source_url: 'https://news.example/rowless' })),
    ])
    expect([first.status, second.status]).toEqual([200, 200])
    expect(await rows(`SELECT id, display_name FROM people WHERE id = ?`, id)).toEqual([{ id, display_name: 'Rowless' }])
  })

  it('refuses a comment sent with a cookie that has been signed out', async () => {
    const { cookie, send } = await reader('gone.commenter@reader.test')
    expect((await mail.call('/api/auth/sign-out', {}, nextIp(), cookie)).ok).toBe(true)
    expect((await send('/api/comments', comment({ body: 'After signing out.' }))).status).toBe(401)
    expect(await rows(`SELECT id FROM comments WHERE body = 'After signing out.'`)).toEqual([])
  })
})
