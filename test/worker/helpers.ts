import { env, exports } from 'cloudflare:workers'
import { vi } from 'vitest'
import worker from '../../worker/index.ts'
import { EDITOR_TOKEN } from './editor-token.ts'
import { EDITORS_ID, type Proposal, type ProposalItem } from '../../shared/schema.ts'
import { buildTracker } from '../../src/lib/build-tracker.ts'
import { claimOf, type Claim } from '../../src/lib/claims.ts'
import { loadRecord } from '../../worker/record.ts'

export { EDITOR_TOKEN }

// One table of each kind a proposal or a news search reads. Each test file gets
// its own database, so a file seeds once and its tests share the rows.
//
//   congress  the body the questions are listed under; Ann, Eve and Fay sit in it
//   senate    a second body the hot question is also put to; Bob sits in it
//   demo      a demo body with a hot question of its own; Cara sits in it
//   Dan sits nowhere
export async function seed() {
  await env.DB.batch(
    [
      `INSERT INTO bodies (id, slug, name, is_demo) VALUES
        ('congress', 'congress', 'Congress', 0), ('senate', 'senate', 'Senate', 0), ('demo', 'demo', 'Demo Council', 1)`,
      `INSERT INTO deciders (id, slug, name, sort_name) VALUES
        ('ann', 'ann-alpha', 'Ann Alpha', 'Alpha, Ann'), ('bob', 'bob-beta', 'Bob Beta', 'Beta, Bob'),
        ('cara', 'cara-gamma', 'Cara Gamma', 'Gamma, Cara'), ('dan', 'dan-delta', 'Dan Delta', 'Delta, Dan'),
        ('eve', 'eve-epsilon', 'Eve Epsilon', 'Epsilon, Eve'), ('fay', 'fay-zeta', 'Fay Zeta', 'Zeta, Fay')`,
      `INSERT INTO seats (id, body_id, label) VALUES
        ('s-ann', 'congress', 'Seat 1'), ('s-eve', 'congress', 'Seat 2'), ('s-fay', 'congress', 'Seat 3'), ('s-bob', 'senate', 'Seat 1'), ('s-cara', 'demo', 'Seat 1')`,
      `INSERT INTO roles (id, seat_id, decider_id) VALUES
        ('r-ann', 's-ann', 'ann'), ('r-eve', 's-eve', 'eve'), ('r-fay', 's-fay', 'fay'), ('r-bob', 's-bob', 'bob'), ('r-cara', 's-cara', 'cara')`,
      `INSERT INTO questions (id, slug, body_id, kind, title, short_title, is_hot, status, closed_on) VALUES
        ('hot', 'hot', 'congress', 'position', 'Hot question?', 'Hot Topic', 1, 'open', NULL),
        ('cold', 'cold', 'congress', 'position', 'Cold question?', 'Cold Topic', 0, 'open', NULL),
        ('closed', 'closed', 'congress', 'position', 'Closed question?', 'Closed Topic', 1, 'lapsed', '2020-01-01'),
        ('closing', 'closing', 'congress', 'position', 'Closing question?', 'Closing Topic', 1, 'lapsed', '2999-01-01'),
        ('demo-hot', 'demo-hot', 'demo', 'position', 'Demo question?', 'Demo Topic', 1, 'open', NULL)`,
      `INSERT INTO question_bodies (id, question_id, body_id) VALUES ('qb-hot-senate', 'hot', 'senate')`,
    ].map((sql) => env.DB.prepare(sql)),
  )
}

// A reader's submission fetches its page for the publish date after answering.
// Files that post one without testing that answer every outside fetch with 404.
export const noOutsidePages = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('not found', { status: 404 }))

let ip = 0
export const nextIp = () => `10.0.${Math.floor(++ip / 250)}.${ip % 250}`

// The Worker limits each address to a few posts a minute, so every call comes
// from a new one unless the test names it. `cookie` is a signed-in reader's.
export function post(path: string, body: unknown, from = nextIp(), token?: string, cookie?: string) {
  return exports.default.fetch(`http://sporelight.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': from,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

export type SentEmail = { from: { email: string; name: string }; to: string; subject: string; text: string }

// The Worker with its email binding replaced, so a test can read the code it
// sends. Sessions live in D1, so a cookie it hands out also works on `post`.
export function mailbox() {
  const sent: SentEmail[] = []
  const mailEnv = { ...env, EMAIL: { send: async (message: SentEmail) => (sent.push(message), { messageId: `m-${sent.length}` }) } } as unknown as Env
  const call = (path: string, body: unknown, from: string, cookie?: string) =>
    worker.fetch(
      new Request(`https://sporelight.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': from, origin: 'https://sporelight.test', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }) as Request<unknown, IncomingRequestCfProperties>,
      mailEnv,
      {} as ExecutionContext,
    )
  return { sent, call }
}

export const askForCode = (mail: ReturnType<typeof mailbox>, email: string, from = nextIp()) =>
  mail.call('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' }, from)

export const codeIn = (message: SentEmail) => /\b(\d{6})\b/.exec(message.text)?.[1] ?? ''

export const cookieFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

// Signs in the way a browser does: ask for a code, read it from the email, send it back.
export async function signIn(mail: ReturnType<typeof mailbox>, email: string): Promise<string> {
  const before = mail.sent.length
  const from = nextIp()
  const asked = await askForCode(mail, email, from)
  if (!asked.ok) throw new Error(`no code sent: ${asked.status} ${await asked.text()}`)
  await until(() => mail.sent.length > before)
  const res = await mail.call('/api/auth/sign-in/email-otp', { email, otp: codeIn(mail.sent.at(-1)!) }, from)
  if (!res.ok) throw new Error(`not signed in: ${res.status} ${await res.text()}`)
  return cookieFrom(res)
}

// A person signed in with a display name, ready to post proposals and comments.
export async function reader(email: string, displayName = 'A Reader') {
  const cookie = await signIn(mailbox(), email)
  const named = await post('/api/me/name', { display_name: displayName }, undefined, undefined, cookie)
  if (!named.ok) throw new Error(`not named: ${named.status} ${await named.text()}`)
  const [row] = await rows<{ id: string }>(`SELECT id FROM auth_users WHERE email = ?`, email)
  return { cookie, personId: row.id, send: postAs(cookie) }
}

// `post` with a signed-in person's cookie.
export const postAs =
  (cookie: string) =>
  (path: string, body: unknown, from = nextIp()) =>
    post(path, body, from, undefined, cookie)

export const proposal = (overrides: Record<string, unknown> = {}) => ({
  question_id: 'hot',
  decider_id: 'ann',
  kind: 'says',
  reading: 'support',
  quote: 'I will vote for this bill when it comes up.',
  source_url: 'https://news.example/story-1',
  source_title: 'Ann Alpha backs the bill',
  occurred_on: '2026-11-01',
  submitter_note: null,
  ...overrides,
})

export const rows = async <T = Record<string, unknown>>(sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql).bind(...binds).all<T>()).results

const PARTY = 'http://sporelight.test/parties/tracker/main?proto=party-db'

// What the browser's party-db client sends on a write. A signed-in reader's
// browser also sends their `cookie`.
export function partyWrite(batches: unknown, token?: string, cookie?: string) {
  return exports.default.fetch(PARTY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(batches),
  })
}

export type Frame = { channel: string; seq: number | string; ops: { type: string; value: Record<string, unknown> }[] }

// A party-db socket as the browser opens one, recording every batch it is sent.
export async function partySocket(token?: string, cookie?: string) {
  const res = await exports.default.fetch(`${PARTY}${token ? `&token=${token}` : ''}`, { headers: { upgrade: 'websocket', ...(cookie ? { cookie } : {}) } })
  const ws = res.webSocket
  if (!ws) throw new Error(`no socket: ${res.status} ${await res.text()}`)
  const frames: Frame[] = []
  ws.addEventListener('message', (e) => {
    frames.push(JSON.parse(e.data as string))
  })
  ws.accept()
  return {
    frames,
    send: (frame: unknown) => ws.send(JSON.stringify(frame)),
    channels: () => new Set(frames.map((f) => f.channel)),
    close: () => ws.close(),
  }
}

export async function until(check: () => boolean | Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// Every proposal item as the queue shows it, through claimOf over the record as
// it is now, with its proposal's fields beside it, oldest proposal first.
export type ClaimRow = ProposalItem &
  Omit<Claim, 'item'> &
  Pick<Proposal, 'origin' | 'submitted_by' | 'reviewed_at' | 'unread'> & { url: string; proposal_status: Proposal['status']; proposed_at: string }
export async function claims(): Promise<ClaimRow[]> {
  const tracker = buildTracker(await loadRecord(env.DB), new Date().toISOString().slice(0, 10))
  const items = await rows<ProposalItem & Proposal & { item_id: string; url: string; proposal_status: Proposal['status']; proposed_at: string }>(
    `SELECT i.*, i.id AS item_id, p.source_id, p.origin, p.submitted_by, p.reviewed_at, p.unread, p.status AS proposal_status, p.created_at AS proposed_at, s.url
     FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id JOIN sources s ON s.id = p.source_id ORDER BY p.created_at, i.sort`,
  )
  return items.map(({ item_id, source_id, origin, submitted_by, reviewed_at, unread, proposal_status, proposed_at, url, proposal_id, sort, decider_id, question_id, act_id, excerpt }) => {
    const item: ProposalItem = { id: item_id, proposal_id, sort, decider_id, question_id, act_id, excerpt }
    const { item: _, ...claim } = claimOf(tracker, { source_id, submitted_by, status: proposal_status }, item)
    return { ...item, ...claim, origin, submitted_by, reviewed_at, unread, url, proposal_status, proposed_at }
  })
}

// The editors' review of an item's act on its question, as publishing or dismissing it writes.
export async function editorsSay(itemId: string, position: 'support' | null) {
  const [i] = await rows<{ act_id: string; question_id: string }>(`SELECT act_id, question_id FROM proposal_items WHERE id = ?`, itemId)
  await env.DB.prepare(
    `INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, created_at, updated_at) VALUES (?, '${EDITORS_ID}', ?, ?, ?, ?, '2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z')`,
  )
    .bind(crypto.randomUUID(), i.act_id, i.question_id, position, position && 'clear')
    .run()
}
