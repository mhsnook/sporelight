import type { ArchiveNow, ArchiveOutcome as Outcome } from '../shared/schema.ts'

// Getting a Wayback Machine capture of each published source and storing its
// address in sources.archive_url. Lookups need no key; asking for a capture
// (Save Page Now 2) needs an archive.org S3 key.

const AVAILABILITY = 'https://archive.org/wayback/available'
const SAVE = 'https://web.archive.org/save'

// Must match an entry in wrangler.jsonc.
export const ARCHIVE_CRON = '47 */6 * * *'
// Each source costs at most three outside requests: a lookup, a capture request
// and a status check.
export const MAX_ARCHIVE_SOURCES_PER_RUN = 5
const REQUEST_SPACING_MS = 3_000
// Save Page Now gives up on a capture after two minutes.
export const CAPTURE_WAIT_MS = 90_000
const EDITOR_POLLS = 6
const EDITOR_POLL_MS = 5_000

const MAX_FAILURES = 6
const FIRST_RETRY_HOURS = 12
const NO_KEY_RETRY_DAYS = 7
// A capture taken this long before we recorded the source may predate what the
// source says. Any later one is used: a new capture would be later still.
const EARLIEST_CAPTURE_DAYS = 30
const DAY_MS = 86_400_000

// Save Page Now codes that mean the page cannot be captured as it stands, so
// asking again on a timer would not help. Other errors are retried.
const REFUSED = new Set([
  'error:not-found',
  'error:no-access',
  'error:unauthorized',
  'error:blocked',
  'error:blocked-url',
  'error:invalid-url-syntax',
  'error:invalid-host-resolution',
  'error:network-authentication-required',
  'error:filesize-limit',
  'error:method-not-allowed',
])
// Codes about our account or the archive as a whole, not the page.
const STOP = new Set(['error:user-session-limit', 'error:max-daily-bandwidth', 'error:max-daily-bandwidth-from-ip', 'error:blocked-client-ip'])

// Returns the address on the source afterwards, which is an earlier one if it had one.
export type Archiver = { setArchiveUrl(sourceId: string, archiveUrl: string): Promise<string | null> }


type Candidate = {
  id: string
  url: string
  created_at: string
  attempts: number | null
  outcome: Outcome | null
  tried_at: string | null
  job_id: string | null
}

export type ArchiveReport = {
  // Sources due when the run started, including those beyond the cap.
  due: number
  looked: number
  // Of those archived, how many from a capture that already existed.
  found: number
  requested: number
  archived: number
  failed: number
  gave_up: number
  no_key: number
  error?: string
}

type Step =
  | { kind: 'found'; archiveUrl: string }
  | { kind: 'requested'; jobId: string }
  | { kind: 'failed'; detail: string; refused: boolean }
  | { kind: 'no_key' }
  | { kind: 'stop'; reason: string }

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// `wrangler types` declares the secret only when .dev.vars has it, so it is read
// through a cast. The value is "accesskey:secret"; empty means none.
function keyOf(env: Env): string | null {
  const key = (env as { ARCHIVE_ORG_KEY?: string }).ARCHIVE_ORG_KEY
  return key?.includes(':') ? key : null
}

const waybackStamp = (date: Date) => date.toISOString().replace(/\D/g, '').slice(0, 14)

function stampDate(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(stamp)
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null
}

const captureUrl = (timestamp: string, original: string) => `https://web.archive.org/web/${timestamp}/${original}`

// A 429, or a key the archive refuses, is a stop; any other answer is the caller's to read.
async function archiveFetch(name: string, url: string, init: RequestInit, ms: number): Promise<Response | Extract<Step, { kind: 'stop' | 'failed' }>> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
  } catch (e) {
    return { kind: 'failed', detail: `${name} could not be reached (${String(e).slice(0, 120)}).`, refused: false }
  }
  if (res.status === 429 || res.status === 401 || res.status === 403) {
    await res.body?.cancel()
    return { kind: 'stop', reason: `${name} answered ${res.status}.` }
  }
  return res
}

// The capture closest to `near`, or null when there is none we would use.
async function findCapture(url: string, near: Date, recordedAt: Date): Promise<Step | null> {
  const query = new URLSearchParams({ url, timestamp: waybackStamp(near) })
  const res = await archiveFetch('The availability API', `${AVAILABILITY}?${query}`, { headers: { accept: 'application/json' } }, 15_000)
  // Not reaching the availability API is an outage, not a fault of this page.
  if (!(res instanceof Response)) return res.kind === 'failed' ? { kind: 'stop', reason: res.detail } : res
  if (!res.ok) {
    await res.body?.cancel()
    const reason = `The availability API answered ${res.status}.`
    return res.status >= 500 ? { kind: 'stop', reason } : { kind: 'failed', detail: reason, refused: false }
  }
  const body = (await res.json().catch(() => null)) as {
    archived_snapshots?: { closest?: { available?: boolean; status?: string; timestamp?: string; url?: string } }
  } | null
  const closest = body?.archived_snapshots?.closest
  // A capture of a redirect may show wherever the page was sent, not the page.
  if (!closest?.available || !closest.timestamp || !/^2/.test(closest.status ?? '')) return null
  const taken = stampDate(closest.timestamp)
  if (!taken || taken.getTime() < recordedAt.getTime() - EARLIEST_CAPTURE_DAYS * DAY_MS) return null
  return { kind: 'found', archiveUrl: closest.url ? closest.url.replace(/^http:\/\//, 'https://') : captureUrl(closest.timestamp, url) }
}

type SaveError = { status?: string; status_ext?: string; message?: string }

function saveError(body: SaveError | null, fallback: string): Step {
  const ext = body?.status_ext ?? ''
  const detail = [ext, body?.message].filter(Boolean).join(': ') || fallback
  if (STOP.has(ext)) return { kind: 'stop', reason: `Save Page Now: ${detail}` }
  return { kind: 'failed', detail, refused: REFUSED.has(ext) || /robots/i.test(body?.message ?? '') }
}

const saveHeaders = (key: string) => ({ accept: 'application/json', authorization: `LOW ${key}` })

async function requestCapture(url: string, key: string): Promise<Step> {
  const res = await archiveFetch(
    'Save Page Now',
    SAVE,
    { method: 'POST', headers: { ...saveHeaders(key), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ url, skip_first_archive: '1' }) },
    30_000,
  )
  if (!(res instanceof Response)) return res
  const body = (await res.json().catch(() => null)) as (SaveError & { job_id?: string }) | null
  if (res.ok && body?.job_id) return { kind: 'requested', jobId: body.job_id }
  return saveError(body, `Save Page Now answered ${res.status}.`)
}

// null while the job is running, or when its status can no longer be had.
async function captureStatus(jobId: string, key: string): Promise<Step | null> {
  const res = await archiveFetch('Save Page Now', `${SAVE}/status/${encodeURIComponent(jobId)}`, { headers: saveHeaders(key) }, 15_000)
  if (!(res instanceof Response)) return res.kind === 'stop' ? res : null
  const body = (await res.json().catch(() => null)) as (SaveError & { timestamp?: string; original_url?: string }) | null
  if (!res.ok || !body) return null
  if (body.status === 'success' && body.timestamp && body.original_url) return { kind: 'found', archiveUrl: captureUrl(body.timestamp, body.original_url) }
  if (body.status === 'error') return saveError(body, 'The capture failed.')
  return null
}

async function record(
  db: D1Database,
  sourceId: string,
  now: Date,
  outcome: Outcome,
  fields: { attempts: number; nextTryAt: Date | null; jobId?: string | null; detail?: string | null },
) {
  await db
    .prepare(`INSERT OR REPLACE INTO archive_attempts (source_id, attempts, tried_at, outcome, next_try_at, job_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(sourceId, fields.attempts, now.toISOString(), outcome, fields.nextTryAt?.toISOString() ?? null, fields.jobId ?? null, fields.detail?.slice(0, 1000) ?? null)
    .run()
}

// Writes what came of one step. `stored` is the address on the source afterwards.
async function settle(env: Env, tracker: Archiver, source: Candidate, step: Exclude<Step, { kind: 'stop' }>, now: Date): Promise<{ outcome: Outcome; stored?: string | null }> {
  const previous = source.attempts ?? 0
  if (step.kind === 'found') {
    const stored = await tracker.setArchiveUrl(source.id, step.archiveUrl)
    const detail = stored === step.archiveUrl ? stored : `Found ${step.archiveUrl} and kept the address already on the source.`
    await record(env.DB, source.id, now, 'archived', { attempts: 0, nextTryAt: null, detail })
    return { outcome: 'archived', stored }
  }
  if (step.kind === 'requested') {
    // Due again at once, so the next run asks about the job.
    await record(env.DB, source.id, now, 'requested', { attempts: previous, nextTryAt: now, jobId: step.jobId })
    return { outcome: 'requested' }
  }
  if (step.kind === 'no_key') {
    await record(env.DB, source.id, now, 'no_key', { attempts: previous, nextTryAt: new Date(now.getTime() + NO_KEY_RETRY_DAYS * DAY_MS) })
    return { outcome: 'no_key' }
  }
  const attempts = previous + 1
  const giveUp = step.refused || attempts >= MAX_FAILURES
  const nextTryAt = giveUp ? null : new Date(now.getTime() + FIRST_RETRY_HOURS * 3_600_000 * 2 ** (attempts - 1))
  await record(env.DB, source.id, now, giveUp ? 'gave_up' : 'failed', { attempts, nextTryAt, detail: step.detail })
  return { outcome: giveUp ? 'gave_up' : 'failed' }
}

// Looks for a capture and, failing that, asks for one. Writes nothing.
async function step(source: Candidate, key: string | null, spacing: () => Promise<void>): Promise<Step> {
  const recordedAt = new Date(source.created_at)
  const asked = source.outcome === 'requested' && source.tried_at ? new Date(source.tried_at) : null
  // The availability API can take hours to list a new capture, so the job is asked first.
  if (asked && source.job_id && key) {
    const status = await captureStatus(source.job_id, key)
    if (status) return status
    await spacing()
  }
  const found = await findCapture(source.url, asked ?? recordedAt, recordedAt)
  if (found) return found
  // Counted as a failure so a page that never captures backs off.
  if (asked) return { kind: 'failed', detail: `The capture asked for at ${source.tried_at} has not appeared.`, refused: false }
  if (!key) return { kind: 'no_key' }
  await spacing()
  return requestCapture(source.url, key)
}

const CANDIDATE_COLUMNS = `s.id, s.url, s.created_at, a.attempts, a.outcome, a.tried_at, a.job_id`
// A published source is one with a report. A source waiting for a key is due as
// soon as there is one.
const DUE = `
  FROM sources s LEFT JOIN archive_attempts a ON a.source_id = s.id
  WHERE s.url IS NOT NULL AND s.archive_url IS NULL
    AND EXISTS (SELECT 1 FROM reports r WHERE r.source_id = s.id)
    AND (a.source_id IS NULL OR a.next_try_at <= ?1 OR (a.outcome = 'no_key' AND ?2 = 1))`

// The scheduled pass over the oldest sources that are due, up to the cap.
export async function archiveSources(env: Env, tracker: Archiver, now: Date = new Date(), wait: (ms: number) => Promise<void> = pause): Promise<ArchiveReport> {
  const key = keyOf(env)
  const spacing = () => wait(REQUEST_SPACING_MS)
  const binds = [now.toISOString(), key ? 1 : 0]
  const [count, due] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n ${DUE}`).bind(...binds),
    env.DB.prepare(`SELECT ${CANDIDATE_COLUMNS} ${DUE} ORDER BY s.created_at, s.id LIMIT ?3`).bind(...binds, MAX_ARCHIVE_SOURCES_PER_RUN),
  ])
  const report: ArchiveReport = { due: (count.results[0] as { n: number }).n, looked: 0, found: 0, requested: 0, archived: 0, failed: 0, gave_up: 0, no_key: 0 }

  const jobs: { source: Candidate; jobId: string }[] = []
  for (const [i, source] of (due.results as Candidate[]).entries()) {
    if (i > 0) await spacing()
    const result = await step(source, key, spacing)
    if (result.kind === 'stop') {
      report.error = result.reason
      break
    }
    report.looked++
    report[(await settle(env, tracker, source, result, now)).outcome]++
    if (result.kind === 'found') report.found++
    if (result.kind === 'requested') jobs.push({ source, jobId: result.jobId })
  }

  // A job still running after the wait is asked about on the next run.
  if (jobs.length && key) {
    await wait(CAPTURE_WAIT_MS)
    for (const [i, { source, jobId }] of jobs.entries()) {
      if (i > 0) await spacing()
      const status = await captureStatus(jobId, key)
      if (!status || status.kind === 'requested' || status.kind === 'no_key') continue
      if (status.kind === 'stop') {
        report.error ??= status.reason
        break
      }
      report.requested--
      report[(await settle(env, tracker, source, status, now)).outcome]++
    }
  }
  return report
}

const NOT_ARCHIVED: Record<'requested' | 'no_key', string> = {
  requested: 'The capture was asked for and has not finished. The next scheduled run will look for it.',
  no_key: 'No capture was found, and the Worker has no archive.org key to ask for one.',
}

// A request to archive one source now, which waits a little for the capture
// before leaving it to the scheduled pass. An editor's ignores any back-off; a
// member's is answered from the last attempt while the pass is backing off.
export async function archiveNow(
  env: Env,
  tracker: Archiver,
  sourceId: string,
  now: Date = new Date(),
  wait: (ms: number) => Promise<void> = pause,
  { respectBackOff = false }: { respectBackOff?: boolean } = {},
): Promise<ArchiveNow> {
  const row = await env.DB.prepare(`SELECT ${CANDIDATE_COLUMNS}, a.next_try_at, a.detail, s.archive_url FROM sources s LEFT JOIN archive_attempts a ON a.source_id = s.id WHERE s.id = ?`)
    .bind(sourceId)
    .first<Omit<Candidate, 'url'> & { url: string | null; archive_url: string | null; next_try_at: string | null; detail: string | null }>()
  if (!row) return { error: 'Unknown source.', status: 404 }
  if (row.archive_url) return { outcome: 'archived', archive_url: row.archive_url }
  if (respectBackOff && row.outcome && row.outcome !== 'archived' && (row.outcome === 'gave_up' || (row.next_try_at !== null && row.next_try_at > now.toISOString()))) {
    return { outcome: row.outcome, detail: row.detail ?? 'The archive was asked recently. The scheduled pass will try again.' }
  }
  if (!row.url) return { outcome: 'no_url', detail: 'This source has no public address to archive.' }
  const source: Candidate = { ...row, url: row.url, outcome: null }
  const key = keyOf(env)

  let result = await step(source, key, () => wait(REQUEST_SPACING_MS))
  if (result.kind === 'stop') return { error: result.reason, status: 502 }
  let refused: string | null = null
  if (result.kind === 'requested' && key) {
    for (let i = 0; i < EDITOR_POLLS; i++) {
      await wait(EDITOR_POLL_MS)
      const status = await captureStatus(result.jobId, key)
      if (!status || status.kind === 'requested' || status.kind === 'no_key') continue
      if (status.kind === 'stop') refused = status.reason
      else result = status
      break
    }
  }
  // Settled even when a status check was refused, so the job it started is on file.
  const { outcome, stored } = await settle(env, tracker, source, result, now)
  if (refused) return { error: refused, status: 502 }
  if (result.kind === 'found') return { outcome: 'archived', archive_url: stored ?? result.archiveUrl }
  return { outcome: outcome as Exclude<Outcome, 'archived'>, detail: result.kind === 'failed' ? result.detail : NOT_ARCHIVED[result.kind as 'requested' | 'no_key'] }
}
