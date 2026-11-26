import { getServerByName, routePartykitRequest } from 'partyserver'
import { ARCHIVE_CRON, archiveNow, archiveSources, type Archiver } from './archive.ts'
import { commentInputSchema, displayNameSchema, proposalInputSchema, sourceUrl, type AccountRole, type Person } from '../shared/schema.ts'
import { RUN_ID } from '../shared/news-run.ts'
import { fetchPublishedOn } from './article.ts'
import { auth, grantFirstEditor, hasActiveEditor, KeyRefused, signedInAccount, signedInPerson } from './auth.ts'
import { handleMcp } from './mcp.ts'
import { claimRun, dropRun, finishRun } from './tool-runs.ts'
import { atomResponse } from './feed.ts'
import { dryRunArticle, listRuns, NEWS_CRON, runNewsSearch, runWithSteps, type Submitter } from './news.ts'
import type { Tracker } from './tracker.ts'

export { Tracker } from './tracker.ts'

export const ROOM = 'main'

const tracker = (env: Env) => getServerByName<Env, Tracker>(env.Tracker, ROOM)

// For runs that last minutes. The room is evicted from memory while they read,
// and a call on a stub taken before that reaches a fresh instance without
// running onStart, so its write path is not set up. getServerByName runs
// onStart first, so each write asks for the room afresh.
const roomForLongRun = (env: Env): Submitter & Archiver => ({
  propose: async (...args) => (await tracker(env)).propose(...args),
  catalogue: async (source) => (await tracker(env)).catalogue(source),
  setArchiveUrl: async (...args) => (await tracker(env)).setArchiveUrl(...args),
})

// The editor's browser names the run, so it can follow the run's steps while
// this request stays open. The request is what keeps the Worker running.
async function startNewsSearch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { run_id?: unknown } | null
  const runId = body?.run_id
  if (runId !== undefined && (typeof runId !== 'string' || !RUN_ID.test(runId))) return Response.json({ error: 'Expected a run_id that is a UUID.' }, { status: 400 })
  const run = runNewsSearch(env, roomForLongRun(env), 'editor', new Date(), runId)
  ctx.waitUntil(run.catch(() => {}))
  return Response.json(await run)
}

async function handleSetup(req: Request, env: Env): Promise<Response> {
  const person = await signedInPerson(req, env)
  if (!person) return new Response('unauthorized', { status: 401 })
  if (person.kind !== 'person') return Response.json({ error: 'An agent cannot be an editor.' }, { status: 403 })
  if (!(await grantFirstEditor(env, person.id))) {
    return (await hasActiveEditor(env))
      ? Response.json({ error: 'This site already has an editor.' }, { status: 409 })
      : Response.json({ error: 'This site is being set up for a different email address.' }, { status: 403 })
  }
  await (await tracker(env)).syncAccount(person.id, 'editor', false)
  return Response.json({ ok: true })
}

// The two tools anyone signed in may start, which call the archive or the model.
// Editors are not held to the per-person limit or to an archive back-off.
async function toolUser(req: Request, env: Env): Promise<{ id: string; role: AccountRole } | Response> {
  const person = await signedInAccount(req, env)
  if (!person) return new Response('unauthorized', { status: 401 })
  if (person.role !== 'editor' && !(await env.TOOL_LIMITER.limit({ key: person.id })).success) {
    return Response.json({ error: 'That is a lot of requests in a short time. Give it a minute.' }, { status: 429 })
  }
  return person
}

const BUSY = 'This is already being done for someone. Try again in a minute.'

async function handleReadArticle(req: Request, env: Env): Promise<Response> {
  const person = await toolUser(req, env)
  if (person instanceof Response) return person
  const body = (await req.json().catch(() => null)) as { url?: unknown; question_id?: unknown } | null
  const target = typeof body?.url === 'string' && /^https?:\/\//.test(body.url) ? sourceUrl(body.url) : null
  if (!target || typeof body?.question_id !== 'string') return Response.json({ error: 'Expected a url and a question_id.' }, { status: 400 })
  const key = `${body.question_id} ${target}`
  const claim = await claimRun(env.DB, 'read_article', key)
  if (!claim.claimed) return claim.running ? Response.json({ error: BUSY }, { status: 409 }) : Response.json({ ...(claim.result as object), reused_from: claim.finished_at })
  try {
    const result = await dryRunArticle(env, target, body.question_id)
    await finishRun(env.DB, 'read_article', key, 'error' in result ? null : result)
    return Response.json(result, { status: 'error' in result ? 404 : 200 })
  } catch (e) {
    await dropRun(env.DB, 'read_article', key)
    throw e
  }
}

async function handleArchive(req: Request, env: Env): Promise<Response> {
  const person = await toolUser(req, env)
  if (person instanceof Response) return person
  const body = (await req.json().catch(() => null)) as { source_id?: unknown } | null
  if (typeof body?.source_id !== 'string') return Response.json({ error: 'Expected a source_id.' }, { status: 400 })
  const claim = await claimRun(env.DB, 'archive', body.source_id)
  if (!claim.claimed) return Response.json({ error: BUSY }, { status: 409 })
  try {
    const result = await archiveNow(env, roomForLongRun(env), body.source_id, new Date(), undefined, { respectBackOff: person.role !== 'editor' })
    return 'error' in result ? Response.json({ error: result.error }, { status: result.status }) : Response.json(result)
  } finally {
    await dropRun(env.DB, 'archive', body.source_id)
  }
}

const tooMany = () => Response.json({ error: 'That is a lot of posts in a short time. Give it a minute.' }, { status: 429 })
const overLimit = async (req: Request, env: Env) => !(await env.POST_LIMITER.limit({ key: req.headers.get('cf-connecting-ip') ?? 'unknown' })).success

// Shared front door for anything a reader can post. Only a signed-in person may.
async function readerPost(req: Request, env: Env): Promise<{ body: Record<string, unknown>; person: Person } | Response> {
  if (await overLimit(req, env)) return tooMany()
  const person = await signedInPerson(req, env)
  if (!person) return Response.json({ error: 'Sign in to post.' }, { status: 401 })
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return Response.json({ error: 'Expected a JSON body.' }, { status: 400 })
  // Honeypot: the form hides this field, so only a bot fills it in. Pretend it worked.
  if (body.website) return Response.json({ ok: true })
  return { body, person }
}

async function handleComment(req: Request, env: Env): Promise<Response> {
  const posted = await readerPost(req, env)
  if (posted instanceof Response) return posted
  const parsed = commentInputSchema.safeParse(posted.body)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return Response.json({ error: `${first.path.join('.')}: ${first.message}` }, { status: 400 })
  }
  const result = await (await tracker(env)).comment(parsed.data, posted.person)
  return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: result.status })
}

async function handleProposal(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const posted = await readerPost(req, env)
  if (posted instanceof Response) return posted
  const parsed = proposalInputSchema.safeParse(posted.body)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return Response.json({ error: `${first.path.join('.')}: ${first.message}` }, { status: 400 })
  }
  const { source_url, source_title, submitter_note, ...item } = parsed.data
  const result = await (await tracker(env)).propose({ source: { url: source_url, title: source_title }, note: submitter_note, items: [item] }, 'reader', posted.person.id)
  if (result.ok && result.undated) ctx.waitUntil(dateReaderSource(env, source_url))
  return result.ok
    ? Response.json({ ok: true, duplicate: result.queued === 0, proposal_id: result.proposal_id })
    : Response.json({ error: result.error }, { status: result.status })
}

async function dateReaderSource(env: Env, url: string) {
  const published = await fetchPublishedOn(url, new Date().toISOString().slice(0, 10)).catch(() => null)
  if (published) await (await tracker(env)).notePublishedOn(url, published)
}

async function handleDisplayName(req: Request, env: Env): Promise<Response> {
  const person = await signedInPerson(req, env)
  if (!person) return new Response('unauthorized', { status: 401 })
  const body = (await req.json().catch(() => null)) as { display_name?: unknown } | null
  const parsed = displayNameSchema.safeParse(body?.display_name)
  if (!parsed.success) return Response.json({ error: `display_name: ${parsed.error.issues[0].message}` }, { status: 400 })
  await (await tracker(env)).setDisplayName(person.id, parsed.data)
  return Response.json({ ok: true })
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  // The anonymous plugin's own routes. Agents sign up only through /mcp, which names them and hands out their key.
  if (url.pathname === '/api/auth/sign-in/anonymous' || url.pathname === '/api/auth/delete-anonymous-user') return new Response('not found', { status: 404 })
  if (url.pathname.startsWith('/api/auth/')) {
    // Each code sent is an email from our domain, so sending one counts as a post.
    if (url.pathname === '/api/auth/email-otp/send-verification-otp' && (await overLimit(req, env))) return tooMany()
    return auth(env).handler(req)
  }
  if (url.pathname === '/api/me/name' && req.method === 'POST') return handleDisplayName(req, env)
  if (url.pathname === '/feed.xml' && req.method === 'GET') return atomResponse(req, env, ctx)
  if (url.pathname === '/api/proposals' && req.method === 'POST') return handleProposal(req, env, ctx)
  if (url.pathname === '/api/comments' && req.method === 'POST') return handleComment(req, env)
  if (url.pathname === '/mcp') return handleMcp(req, env)
  if (url.pathname === '/api/setup' && req.method === 'GET') return Response.json({ needed: !(await hasActiveEditor(env)) })
  if (url.pathname === '/api/setup' && req.method === 'POST') return handleSetup(req, env)
  if (url.pathname.startsWith('/api/editor/')) {
    const person = await signedInAccount(req, env)
    if (!person) return new Response('unauthorized', { status: 401 })
    if (person.role !== 'editor') return Response.json({ error: 'Only editors can do this.' }, { status: 403 })
    if (url.pathname === '/api/editor/news-search' && req.method === 'POST') return startNewsSearch(req, env, ctx)
    if (url.pathname === '/api/editor/news-runs' && req.method === 'GET') return Response.json({ runs: await listRuns(env.DB) })
    // When each person's latest session was last used, for /admin. A session ends when its person signs out, so this can be missing.
    if (url.pathname === '/api/editor/last-seen' && req.method === 'GET') {
      const seen = await env.DB.prepare(`SELECT "userId" AS id, MAX("updatedAt") AS at FROM auth_sessions GROUP BY "userId"`).all<{ id: string; at: string }>()
      return Response.json({ last_seen: Object.fromEntries(seen.results.map((r) => [r.id, r.at])) })
    }
    const runPath = url.pathname.match(/^\/api\/editor\/news-runs\/([^/]+)$/)
    if (runPath && req.method === 'GET') {
      const found = await runWithSteps(env.DB, runPath[1])
      return found ? Response.json(found) : Response.json({ error: 'No run has that id yet.' }, { status: 404 })
    }
    return new Response('not found', { status: 404 })
  }
  if (url.pathname === '/api/read-article' && req.method === 'POST') return handleReadArticle(req, env)
  if (url.pathname === '/api/archive' && req.method === 'POST') return handleArchive(req, env)
  return (await routePartykitRequest(req, env)) ?? new Response('not found', { status: 404 })
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx)
    } catch (e) {
      if (e instanceof KeyRefused) return Response.json({ error: e.message }, { status: e.status })
      throw e
    }
  },

  // Awaited, not left to waitUntil: a run reads articles or waits on capture
  // jobs for minutes, and waitUntil only promises a short time after the
  // handler returns. Each cron in wrangler.jsonc runs one of the two passes.
  async scheduled(controller, env) {
    const now = new Date(controller.scheduledTime)
    if (controller.cron === ARCHIVE_CRON) return console.log('archiving', await archiveSources(env, roomForLongRun(env), now))
    if (controller.cron !== NEWS_CRON) return console.error(`no pass runs on the cron "${controller.cron}"`)
    console.log('news search', await runNewsSearch(env, roomForLongRun(env), 'cron', now))
  },
} satisfies ExportedHandler<Env>
