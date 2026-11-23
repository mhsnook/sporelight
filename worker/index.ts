import { getServerByName, routePartykitRequest } from 'partyserver'
import { ARCHIVE_CRON, archiveNow, archiveSources, type Archiver } from './archive.ts'
import { commentInputSchema, displayNameSchema, proposalInputSchema, type Person } from '../shared/schema.ts'
import { RUN_ID } from '../shared/news-run.ts'
import { auth, signedInPerson } from './auth.ts'
import { isEditorRequest } from './editor.ts'
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

async function handleProposal(req: Request, env: Env): Promise<Response> {
  const posted = await readerPost(req, env)
  if (posted instanceof Response) return posted
  const parsed = proposalInputSchema.safeParse(posted.body)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return Response.json({ error: `${first.path.join('.')}: ${first.message}` }, { status: 400 })
  }
  const { source_url, source_title, submitter_note, ...item } = parsed.data
  const result = await (await tracker(env)).propose({ source: { url: source_url, title: source_title }, note: submitter_note, items: [item] }, 'reader', posted.person.id)
  return result.ok
    ? Response.json({ ok: true, duplicate: result.queued === 0, proposal_id: result.proposal_id })
    : Response.json({ error: result.error }, { status: result.status })
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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/api/auth/')) {
      // Each code sent is an email from our domain, so sending one counts as a post.
      if (url.pathname === '/api/auth/email-otp/send-verification-otp' && (await overLimit(req, env))) return tooMany()
      return auth(env).handler(req)
    }
    if (url.pathname === '/api/me/name' && req.method === 'POST') return handleDisplayName(req, env)
    if (url.pathname === '/feed.xml' && req.method === 'GET') return atomResponse(req, env, ctx)
    if (url.pathname === '/api/proposals' && req.method === 'POST') return handleProposal(req, env)
    if (url.pathname === '/api/comments' && req.method === 'POST') return handleComment(req, env)
    if (url.pathname === '/api/editor/session') {
      return (await isEditorRequest(req, env)) ? Response.json({ ok: true }) : new Response('unauthorized', { status: 401 })
    }
    if (url.pathname === '/api/editor/news-search' && req.method === 'POST') {
      if (!(await isEditorRequest(req, env))) return new Response('unauthorized', { status: 401 })
      return startNewsSearch(req, env, ctx)
    }
    if (url.pathname === '/api/editor/news-runs' && req.method === 'GET') {
      if (!(await isEditorRequest(req, env))) return new Response('unauthorized', { status: 401 })
      return Response.json({ runs: await listRuns(env.DB) })
    }
    const runPath = url.pathname.match(/^\/api\/editor\/news-runs\/([^/]+)$/)
    if (runPath && req.method === 'GET') {
      if (!(await isEditorRequest(req, env))) return new Response('unauthorized', { status: 401 })
      const found = await runWithSteps(env.DB, runPath[1])
      return found ? Response.json(found) : Response.json({ error: 'No run has that id yet.' }, { status: 404 })
    }
    if (url.pathname === '/api/editor/read-article' && req.method === 'POST') {
      if (!(await isEditorRequest(req, env))) return new Response('unauthorized', { status: 401 })
      const body = (await req.json().catch(() => null)) as { url?: unknown; question_id?: unknown } | null
      const target = typeof body?.url === 'string' && /^https?:\/\//.test(body.url) ? body.url : null
      if (!target || typeof body?.question_id !== 'string') return Response.json({ error: 'Expected a url and a question_id.' }, { status: 400 })
      const result = await dryRunArticle(env, target, body.question_id)
      return Response.json(result, { status: 'error' in result ? 404 : 200 })
    }
    if (url.pathname === '/api/editor/archive' && req.method === 'POST') {
      if (!(await isEditorRequest(req, env))) return new Response('unauthorized', { status: 401 })
      const body = (await req.json().catch(() => null)) as { source_id?: unknown } | null
      if (typeof body?.source_id !== 'string') return Response.json({ error: 'Expected a source_id.' }, { status: 400 })
      const result = await archiveNow(env, roomForLongRun(env), body.source_id)
      return 'error' in result ? Response.json({ error: result.error }, { status: result.status }) : Response.json(result)
    }
    return (await routePartykitRequest(req, env)) ?? new Response('not found', { status: 404 })
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
