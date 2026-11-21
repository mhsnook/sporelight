import { fetchArticle } from './article.ts'
import { hitDate, leadFromHit, peopleInHit, rosterMatcher, type RosterEntry, type SearchHit } from './leads.ts'
import { draftFromReading, MODEL, readArticle, readingContext, type Dropped, type ModelAct, type ReadingContext } from './reader.ts'
import { sourceUrl, type Proposal, type ProposalDraft, type UnreadReason } from '../shared/schema.ts'
import type { SubmitResult } from './tracker.ts'

const PROVIDER = 'exa'
const RESULTS_PER_QUERY = 10
// Articles fetched and sent to the model in one run; the rest wait for the next
// run. A failed model call also ends reading for the run, since the usual
// causes (the gateway's spending limit, a rate limit, an outage) would fail the
// rest too. Each read is one outside fetch (plus any redirects), one conversion and
// one model call. On the Workers Free plan a run may make 50 outside requests.
export const MAX_READS_PER_RUN = 15
// Must match an entry in wrangler.jsonc.
export const NEWS_CRON = '17 14 * * *'

type HotQuestion = { id: string; short_title: string; body_id: string; body_name: string }

export type NewsReport = {
  error?: string
  questions: { question: string; hits: number; read: number; queued: number }[]
  // Hits that name someone and were neither read nor recorded, because the run
  // reached MAX_READS_PER_RUN or a model call failed.
  deferred: number
}

type Submitter = { propose(draft: ProposalDraft, origin: Proposal['origin']): Promise<SubmitResult> }

function queriesFor(question: HotQuestion, now: Date): string[] {
  const month = now.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const topic = `"${question.short_title}" ${question.body_name}`
  return [`${topic} statement ${month}`, `${topic} announces support`, `${topic} opposes`, `${topic} cosponsor OR endorses OR votes`]
}

function roster(db: D1Database, question: { id: string; body_id: string }) {
  return db
    .prepare(
      `SELECT DISTINCT d.id, d.name, d.sort_name
       FROM roles r JOIN seats s ON s.id = r.seat_id JOIN deciders d ON d.id = r.decider_id
       WHERE s.body_id = ?1 OR s.body_id IN (SELECT body_id FROM question_bodies WHERE question_id = ?2)`,
    )
    .bind(question.body_id, question.id)
    .all<RosterEntry>()
}

export type ArticleOutcome =
  | { outcome: 'acts'; context: ReadingContext; acts: ModelAct[]; dropped: Dropped[]; draft: ProposalDraft }
  | { outcome: 'no_acts'; context: ReadingContext; dropped: Dropped[] }
  | { outcome: 'not_read'; reason: string; unread: UnreadReason; modelCallFailed?: boolean }

// Fetches one article and has the model read it for these people on this
// question. Writes nothing.
export async function readOneArticle(
  env: Env,
  article: { url: string; title: string | null; date: string | null },
  questionId: string,
  people: RosterEntry[],
  today: string,
  query: string | null,
  text?: string,
): Promise<ArticleOutcome> {
  let body = text
  if (body === undefined) {
    const fetched = await fetchArticle(env, article.url)
    if (!fetched.ok) return { outcome: 'not_read', reason: fetched.reason, unread: fetched.unread }
    body = fetched.text
  }
  const context = await readingContext(env.DB, questionId, people, today)
  if (!context) return { outcome: 'not_read', reason: 'The question no longer exists.', unread: 'model_failed' }
  const reading = await readArticle(env, context, { ...article, text: body }, today)
  if (!reading.ok) return { outcome: 'not_read', reason: reading.reason, unread: 'model_failed', modelCallFailed: reading.callFailed }
  if (reading.acts.length === 0) return { outcome: 'no_acts', context, dropped: reading.dropped }
  return { outcome: 'acts', context, acts: reading.acts, dropped: reading.dropped, draft: draftFromReading(article, reading.acts, reading.dropped, query, reading.mentions) }
}

// A hit is skipped once its article has been looked at for the question, or
// once anything from it has been proposed on the question or a sub-question of
// it, which is how hits queued before the read log existed are recognised.
async function alreadyHandled(db: D1Database, url: string, questionId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM article_reads WHERE url = ?1 AND question_id = ?2
       UNION ALL
       SELECT 1 FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id JOIN sources s ON s.id = p.source_id JOIN questions q ON q.id = i.question_id
       WHERE s.url = ?1 AND (q.id = ?2 OR q.parent_id = ?2)
       LIMIT 1`,
    )
    .bind(url, questionId)
    .first()
  return row !== null
}

function recordRead(db: D1Database, url: string, questionId: string, now: Date, outcome: 'queued' | 'no_acts' | 'not_read', model: string | null, detail: string | null) {
  return db
    .prepare(`INSERT OR REPLACE INTO article_reads (url, question_id, read_at, outcome, model, detail) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(url, questionId, now.toISOString(), outcome, model, detail?.slice(0, 2000) ?? null)
    .run()
}

const droppedDetail = (dropped: Dropped[]) => (dropped.length ? dropped.map((d) => `${d.act.person_id} on ${d.act.question_id}: "${d.act.quote.slice(0, 120)}" ${d.why}`).join('\n') : null)

// Searches the news for each question marked as in the news. Each hit that
// names someone on the roster is fetched and read by a model, which queues the
// acts the article records, each with words checked against the article text.
// An article the model finds nothing in queues nothing. One that cannot be
// fetched or read falls back to a lead with the search excerpt. Nothing here
// is published without review.
export async function searchNews(env: Env, tracker: Submitter, now: Date = new Date()): Promise<NewsReport> {
  const today = now.toISOString().slice(0, 10)
  const hot = await env.DB.prepare(
    `SELECT q.id, q.short_title, q.body_id, b.name AS body_name
     FROM questions q JOIN bodies b ON b.id = q.body_id
     WHERE q.is_hot = 1 AND b.is_demo = 0 AND (q.status = 'open' OR q.closed_on > ?)`,
  )
    .bind(today)
    .all<HotQuestion>()

  const report: NewsReport = { questions: [], deferred: 0 }
  let reads = 0
  let modelDown = false
  // Every query of a question returns many of the same hits. A hit tried this
  // run and left unrecorded is not tried again until the next run.
  const deferred = new Set<string>()
  const tried = new Set<string>()
  for (const question of hot.results) {
    const members = (await roster(env.DB, question)).results
    const byId = new Map(members.map((m) => [m.id, m]))
    const match = rosterMatcher(members)
    const tally = { question: question.short_title, hits: 0, read: 0, queued: 0 }
    const stop = (error: string) => {
      report.error = error
      report.questions.push(tally)
      return report
    }

    for (const query of queriesFor(question, now)) {
      const response = await env.AI.websearch({ gatewayId: env.AI_GATEWAY, provider: PROVIDER, query, limit: RESULTS_PER_QUERY }).catch((e: unknown) => e)
      if (!(response instanceof Response) || !response.ok) {
        const detail = response instanceof Response ? `${response.status}: ${(await response.text()).slice(0, 200)}` : String(response).slice(0, 200)
        return stop(`Web search failed (${detail})`)
      }
      const { items } = (await response.json()) as { items: SearchHit[] }
      tally.hits += items.length
      for (const hit of items) {
        const people = peopleInHit(hit, match)
        if (people.length === 0) continue
        const url = sourceUrl(hit.url)
        const key = `${url} ${question.id}`
        if (tried.has(key) || (await alreadyHandled(env.DB, url, question.id))) continue
        if (reads >= MAX_READS_PER_RUN || modelDown) {
          deferred.add(key)
          report.deferred = deferred.size
          continue
        }
        reads++
        tally.read++
        tried.add(key)

        const article = { url, title: hit.title || null, date: hitDate(hit) }
        const result = await readOneArticle(env, article, question.id, people.map((id) => byId.get(id)!), today, query)
        let draft: ProposalDraft | null
        let origin: Proposal['origin']
        if (result.outcome === 'acts') {
          draft = result.draft
          origin = 'model'
        } else if (result.outcome === 'no_acts') {
          await recordRead(env.DB, url, question.id, now, 'no_acts', MODEL, droppedDetail(result.dropped))
          continue
        } else {
          if (result.modelCallFailed) {
            modelDown = true
            report.error = `Stopped reading articles: ${result.reason}`
          }
          draft = leadFromHit(hit, question.id, query, match, { unread: result.unread, why: `The article was not read: ${result.reason}` })
          origin = 'news_search'
        }
        if (!draft) continue
        const submitted = await tracker.propose(draft, origin).catch((e: unknown): SubmitResult => ({ ok: false, status: 500, error: String(e).slice(0, 200) }))
        if (!submitted.ok && submitted.status === 429) return stop(submitted.error)
        // Not recorded, so the next run reads it again.
        if (!submitted.ok) {
          report.error = `Could not queue ${url}: ${submitted.error}`
          continue
        }
        tally.queued += submitted.queued
        if (result.outcome !== 'acts') await recordRead(env.DB, url, question.id, now, 'not_read', null, result.reason)
        else if (submitted.queued > 0) await recordRead(env.DB, url, question.id, now, 'queued', MODEL, droppedDetail(result.dropped))
        else await recordRead(env.DB, url, question.id, now, 'no_acts', MODEL, 'Every act found was already proposed from this source.')
      }
    }
    report.questions.push(tally)
  }
  return report
}

// What reading one article for one question would queue, for an editor to try
// the model against a real page. Nothing is written. Everyone on the question's
// roster named anywhere in the article is read for, up to DRY_RUN_PEOPLE.
const DRY_RUN_PEOPLE = 8

export async function dryRunArticle(env: Env, url: string, questionId: string, now: Date = new Date()) {
  const today = now.toISOString().slice(0, 10)
  const question = await env.DB.prepare(`SELECT id, body_id FROM questions WHERE id = ?`).bind(questionId).first<{ id: string; body_id: string }>()
  if (!question) return { error: 'Unknown question.' }
  const fetched = await fetchArticle(env, url)
  if (!fetched.ok) return { outcome: 'not_read' as const, reason: fetched.reason, unread: fetched.unread, model: MODEL }
  const members = (await roster(env.DB, question)).results
  const match = rosterMatcher(members)
  const byId = new Map(members.map((m) => [m.id, m]))
  const people = match(fetched.text)
    .slice(0, DRY_RUN_PEOPLE)
    .map((id) => byId.get(id)!)
  const article = { chars: fetched.text.length, truncated: fetched.truncated, opening: fetched.text.slice(0, 600) }
  if (people.length === 0) return { outcome: 'no_people' as const, model: MODEL, article }
  const result = await readOneArticle(env, { url: sourceUrl(url), title: null, date: null }, question.id, people, today, null, fetched.text)
  return { ...result, model: MODEL, article, people: people.map((p) => p.name) }
}

type RunStarter = 'cron' | 'editor'
type RunOutcome = 'skipped' | 'searched' | 'stopped' | 'failed'

// Runs the news search and records the run in `news_runs`.
export async function runNewsSearch(env: Env, tracker: Submitter, startedBy: RunStarter, now: Date = new Date()): Promise<NewsReport | { skipped: string }> {
  if (startedBy === 'cron') {
    const queue = await queueState(env.DB, now)
    if (!queue.attended) {
      const skipped = `${queue.waiting} automated ${queue.waiting === 1 ? 'proposal is' : 'proposals are'} waiting, and ${queue.reviewedAt ? `the last was reviewed at ${queue.reviewedAt}` : 'none has been reviewed'}.`
      await recordRun(env.DB, now, startedBy, 'skipped', skipped)
      return { skipped }
    }
  }
  try {
    const report = await searchNews(env, tracker, now)
    await recordRun(env.DB, now, startedBy, report.error ? 'stopped' : 'searched', JSON.stringify(report))
    return report
  } catch (e) {
    await recordRun(env.DB, now, startedBy, 'failed', String(e))
    throw e
  }
}

// A run that cannot be recorded still runs: the log has the same report.
function recordRun(db: D1Database, now: Date, startedBy: RunStarter, outcome: RunOutcome, detail: string) {
  return db
    .prepare(`INSERT INTO news_runs (id, started_at, started_by, outcome, detail) VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now.toISOString(), startedBy, outcome, detail.slice(0, 4000))
    .run()
    .catch((e: unknown) => console.error('could not record the news run', String(e)))
}

// Whether the scheduled search should run today: when nothing it queued earlier
// is waiting, or when an editor has reviewed something it queued in the last
// day. An unattended queue stops filling, and the first review starts it again
// at the next run.
async function queueState(db: D1Database, now: Date): Promise<{ attended: boolean; waiting: number; reviewedAt: string | null }> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const { waiting, reviewedAt } = (await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM proposals WHERE status = 'pending' AND origin IN ('news_search', 'model')) AS waiting,
         (SELECT MAX(reviewed_at) FROM proposals WHERE status = 'reviewed' AND origin IN ('news_search', 'model')) AS reviewedAt`,
    )
    .first<{ waiting: number; reviewedAt: string | null }>())!
  return { attended: waiting === 0 || (reviewedAt !== null && reviewedAt > dayAgo), waiting, reviewedAt }
}

export const queueIsAttended = async (db: D1Database, now: Date) => (await queueState(db, now)).attended
