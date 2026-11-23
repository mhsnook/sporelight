import { beforeAll, describe, expect, it } from 'vitest'
import { mailbox, post, postAs, reader, rows, seed, signIn } from './helpers.ts'

const comment = (overrides: Record<string, unknown> = {}) => ({ question_id: 'hot', decider_id: 'ann', body: 'Is there a source for this?', ...overrides })
const count = async () => (await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM comments`))[0].n

let send: ReturnType<typeof postAs>
let personId = ''

beforeAll(async () => {
  await seed()
  const signedIn = await reader('commenter@reader.test', 'Reader One')
  send = signedIn.send
  personId = signedIn.personId
})

describe('POST /api/comments', () => {
  it('refuses a comment from someone not signed in, and one with a forged cookie', async () => {
    const before = await count()
    const signedOut = await post('/api/comments', comment({ body: 'Signed out.' }))
    expect(signedOut.status).toBe(401)
    expect(await signedOut.json()).toEqual({ error: 'Sign in to post.' })
    expect((await postAs('better-auth.session_token=not-a-real-session')('/api/comments', comment({ body: 'Forged cookie.' }))).status).toBe(401)
    expect(await count()).toBe(before)
  })

  it('refuses a comment from a signed-in person who has not chosen a display name', async () => {
    const before = await count()
    const res = await postAs(await signIn(mailbox(), 'unnamed@reader.test'))('/api/comments', comment({ body: 'No name yet.' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Choose a display name before you comment.' })
    expect(await count()).toBe(before)
  })

  it.each([
    ['body', { body: '' }],
    ['body', { body: 'x'.repeat(2001) }],
    ['decider_id', { decider_id: '' }],
  ])('names the bad field: %s', async (field, bad) => {
    const before = await count()
    const res = await send('/api/comments', comment(bad))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(new RegExp(`^${field}: `))
    expect(await count()).toBe(before)
  })

  it.each([
    ['question', { question_id: 'no-such-question' }],
    ['decider', { decider_id: 'no-such-person' }],
  ])('refuses an unknown %s', async (_, bad) => {
    const before = await count()
    const res = await send('/api/comments', comment(bad))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Unknown question or decider.' })
    expect(await count()).toBe(before)
  })

  it('answers a filled-in honeypot as if it worked and writes nothing', async () => {
    const before = await count()
    const res = await send('/api/comments', { ...comment(), website: 'x' })
    expect(await res.json()).toEqual({ ok: true })
    expect(await count()).toBe(before)
  })

  it('ignores an id, thread, person or timestamp the reader sends', async () => {
    const res = await send('/api/comments', comment({ id: 'forged', thread_id: 'cold:bob', person_id: 'someone-else', created_at: '2001-01-01T00:00:00Z', body: 'Forged fields.' }))
    expect(await res.json()).toEqual({ ok: true })
    const [row] = await rows<{ id: string; thread_id: string; person_id: string; created_at: string }>(`SELECT id, thread_id, person_id, created_at FROM comments WHERE body = 'Forged fields.'`)
    expect(row.id).not.toBe('forged')
    expect(row.thread_id).toBe('hot:ann')
    expect(row.person_id).toBe(personId)
    expect(row.created_at.startsWith('2001')).toBe(false)
  })

  it('writes a trimmed comment to the thread for that person and question, tied to the person who posted it', async () => {
    const res = await send('/api/comments', comment({ body: ' Is there a recording?\n' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await rows(`SELECT thread_id, person_id, body FROM comments WHERE body = 'Is there a recording?'`)).toEqual([{ thread_id: 'hot:ann', person_id: personId, body: 'Is there a recording?' }])
  })
})
