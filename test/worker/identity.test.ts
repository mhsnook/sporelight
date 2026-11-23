import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { askForCode, codeIn, cookieFrom, type Frame, mailbox, nextIp, partySocket, post, proposal, rows, seed, signIn, until, noOutsidePages } from './helpers.ts'

const mail = mailbox()
const comment = (overrides: Record<string, unknown> = {}) => ({ question_id: 'hot', decider_id: 'ann', author_name: 'typed-name', body: 'A comment.', ...overrides })
const personFor = async (email: string) =>
  (await rows<{ id: string; display_name: string | null; muted_at: string | null }>(`SELECT p.id, p.display_name, p.muted_at FROM people p JOIN auth_users u ON u.id = p.id WHERE u.email = ?`, email))[0]

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
    expect(await personFor('new@reader.test')).toEqual({ id: expect.any(String), display_name: null, muted_at: null })
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
  it('ties a comment to the person, and takes the first name they post under as theirs', async () => {
    const cookie = await signIn(mail, 'commenter@reader.test')
    const person = await personFor('commenter@reader.test')
    expect((await post('/api/comments', comment({ author_name: 'First Name', body: 'First comment.' }), undefined, undefined, cookie)).status).toBe(200)
    expect((await post('/api/comments', comment({ author_name: 'Another Name', body: 'Second comment.' }), undefined, undefined, cookie)).status).toBe(200)
    expect(await rows(`SELECT author_name, person_id FROM comments WHERE body IN ('First comment.', 'Second comment.') ORDER BY created_at`)).toEqual([
      { author_name: 'First Name', person_id: person.id },
      { author_name: 'First Name', person_id: person.id },
    ])
    expect((await personFor('commenter@reader.test')).display_name).toBe('First Name')
  })

  it('leaves a signed-out comment tied to nobody, under the name typed', async () => {
    expect((await post('/api/comments', comment({ author_name: 'Just Visiting', body: 'Signed out.' }))).status).toBe(200)
    expect(await rows(`SELECT author_name, person_id FROM comments WHERE body = 'Signed out.'`)).toEqual([{ author_name: 'Just Visiting', person_id: null }])
  })

  it('records who submitted a proposal, and nobody for a signed-out one', async () => {
    const cookie = await signIn(mail, 'submitter@reader.test')
    const person = await personFor('submitter@reader.test')
    const signedIn = await post('/api/proposals', proposal({ source_url: 'https://news.example/signed-in' }), undefined, undefined, cookie)
    const signedOut = await post('/api/proposals', proposal({ source_url: 'https://news.example/signed-out' }))
    const ids = [(await signedIn.json()) as { proposal_id: string }, (await signedOut.json()) as { proposal_id: string }].map((r) => r.proposal_id)
    expect(await rows(`SELECT submitted_by FROM proposals WHERE id = ?`, ids[0])).toEqual([{ submitted_by: person.id }])
    expect(await rows(`SELECT submitted_by FROM proposals WHERE id = ?`, ids[1])).toEqual([{ submitted_by: null }])
  })

  it('treats a forged cookie as signed out', async () => {
    const forged = 'better-auth.session_token=not-a-real-session'
    expect((await post('/api/comments', comment({ author_name: 'Forger', body: 'Forged cookie.' }), undefined, undefined, forged)).status).toBe(200)
    expect(await rows(`SELECT person_id FROM comments WHERE body = 'Forged cookie.'`)).toEqual([{ person_id: null }])
  })
})
