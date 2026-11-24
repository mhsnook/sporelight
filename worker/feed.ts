import { buildTracker } from '../src/lib/build-tracker.ts'
import { STORY_PAGE, atomHref, buildStories } from '../src/lib/feed.ts'
import { atomFeed } from './atom.ts'
import { loadRecord } from './record.ts'

// The published tables the feed reads. Proposals and their notes are never read here.
const FEED_TABLES = new Set(['bodies', 'deciders', 'seats', 'roles', 'questions', 'question_bodies', 'sources', 'acts', 'reports', 'reviews'])

// GET /feed.xml, with the same `question` and `body` filters as /news.
export async function atomResponse(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const questionSlug = url.searchParams.get('question') || undefined
  const bodySlug = url.searchParams.get('body') || undefined
  const self = atomHref({ question: questionSlug, body: bodySlug })
  // Keyed on the two filters alone, so extra or reordered parameters share an entry.
  const key = new Request(url.origin + self)
  const cached = await caches.default.match(key)
  if (cached) return cached

  const tracker = buildTracker(await loadRecord(env.DB, FEED_TABLES), new Date().toISOString().slice(0, 10))
  const question = questionSlug ? tracker.questionBySlug.get(questionSlug) : undefined
  const body = bodySlug ? tracker.bodyBySlug.get(bodySlug) : undefined
  if ((questionSlug && !question) || (bodySlug && !body)) return new Response('No such question or body.', { status: 404 })

  const stories = buildStories(tracker, { questionId: question?.id, bodyId: body?.id }).slice(0, STORY_PAGE)
  const filtered = [question?.short_title, body?.name].filter(Boolean).join(', ')
  const xml = atomFeed(stories, {
    origin: url.origin,
    title: `Sporelight: latest on the record${filtered ? ` (${filtered})` : ''}`,
    self,
    page: self.replace('/feed.xml', '/news'),
  })
  const res = new Response(xml, { headers: { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'public, max-age=300' } })
  ctx.waitUntil(caches.default.put(key, res.clone()))
  return res
}
