import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../../worker/index.ts'
import { reader, rows, seed } from './helpers.ts'

// /setup with FIRST_EDITOR_EMAIL set, as a production deployment stores it.
const setupWith = (firstEditorEmail: string, cookie: string) =>
  worker.fetch(
    new Request('http://sporelight.test/api/setup', { method: 'POST', headers: { cookie } }) as Request<unknown, IncomingRequestCfProperties>,
    { ...env, FIRST_EDITOR_EMAIL: firstEditorEmail } as Env,
    {} as ExecutionContext,
  )
const roleOf = async (id: string) => (await rows<{ role: string }>(`SELECT role FROM auth_users WHERE id = ?`, id))[0].role

beforeAll(seed)

describe('the first editor when FIRST_EDITOR_EMAIL is set', () => {
  it('refuses anyone signed in with another address, and leaves the site waiting for its first editor', async () => {
    const stranger = await reader('stranger@reader.test')
    const res = await setupWith('owner@reader.test', stranger.cookie)
    expect(res.status).toBe(403)
    expect(await roleOf(stranger.personId)).toBe('member')
    expect(await rows(`SELECT id FROM active_editors`)).toEqual([])
  })

  it('makes the person with that address the first editor, whatever the case of the letters', async () => {
    const owner = await reader('owner@reader.test')
    expect((await setupWith(' Owner@Reader.test ', owner.cookie)).status).toBe(200)
    expect(await roleOf(owner.personId)).toBe('editor')
  })
})
