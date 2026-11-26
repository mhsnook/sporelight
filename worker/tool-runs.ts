// A reader trial or an archive request that is already running is not started
// again, and a reader trial's result is reused for a day.
const RUNNING_MS = 5 * 60_000
const REUSE_MS = 24 * 60 * 60_000

export type Tool = 'archive' | 'read_article'

type Row = { started_at: string; finished_at: string | null; result: string | null }

export type Claim = { claimed: true } | { claimed: false; running: true } | { claimed: false; running: false; result: unknown; finished_at: string }

// One statement, so two requests for the same target cannot both claim it.
export async function claimRun(db: D1Database, tool: Tool, target: string, now: Date = new Date()): Promise<Claim> {
  const stale = new Date(now.getTime() - RUNNING_MS).toISOString()
  const expired = new Date(now.getTime() - (tool === 'read_article' ? REUSE_MS : 0)).toISOString()
  const claimed = await db
    .prepare(
      `INSERT INTO tool_runs (tool, target, started_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (tool, target) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL, result = NULL
       WHERE (finished_at IS NULL AND started_at < ?4) OR (finished_at IS NOT NULL AND (result IS NULL OR finished_at <= ?5))`,
    )
    .bind(tool, target, now.toISOString(), stale, expired)
    .run()
  if (claimed.meta.changes === 1) return { claimed: true }
  const row = await db.prepare(`SELECT started_at, finished_at, result FROM tool_runs WHERE tool = ? AND target = ?`).bind(tool, target).first<Row>()
  if (!row || row.finished_at === null || row.result === null) return { claimed: false, running: true }
  return { claimed: false, running: false, result: JSON.parse(row.result), finished_at: row.finished_at }
}

// A result of null keeps nothing to reuse, so the next request runs again.
export async function finishRun(db: D1Database, tool: Tool, target: string, result: unknown, now: Date = new Date()) {
  await db
    .prepare(`UPDATE tool_runs SET finished_at = ?, result = ? WHERE tool = ? AND target = ?`)
    .bind(now.toISOString(), result === null ? null : JSON.stringify(result), tool, target)
    .run()
}

export async function dropRun(db: D1Database, tool: Tool, target: string) {
  await db.prepare(`DELETE FROM tool_runs WHERE tool = ? AND target = ?`).bind(tool, target).run()
}
