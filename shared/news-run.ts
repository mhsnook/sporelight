// A news search run as it is recorded, and the steps it records as it goes.
// The Worker writes both; the editor's pages read them.

export type NewsReport = {
  // Set when the run stopped early (the search failed or the queue was full), or stopped reading articles because a model call failed.
  error?: string
  // `failed` counts articles read but not queued because writing the proposal failed. The next run reads them again.
  questions: { question: string; hits: number; read: number; queued: number; failed: number }[]
  // Hits that name someone and were neither read nor recorded, because the run
  // reached MAX_READS_PER_RUN or a model call failed.
  deferred: number
}

export type RunStarter = 'cron' | 'editor'
export type RunOutcome = 'running' | 'skipped' | 'searched' | 'stopped' | 'failed'

// A row of `news_runs`. `detail` is the report's JSON once searched or stopped, and the reason or error otherwise.
export type NewsRun = { id: string; started_at: string; started_by: RunStarter; outcome: RunOutcome; finished_at: string | null; detail: string | null }

// `lead`: the article could not be read, so the search excerpt was queued instead.
export type ReadOutcome = 'queued' | 'lead' | 'nothing' | 'failed'

export type NewsStep =
  | { kind: 'plan'; questions: string[]; queriesPerQuestion: number; maxReads: number }
  | { kind: 'searched'; question: string; query: string; hits: number; named: number }
  | { kind: 'reading'; question: string; url: string; title: string | null }
  | { kind: 'read'; question: string; url: string; title: string | null; outcome: ReadOutcome; queued: number; detail: string | null }
  // The run carries on searching and queues what it finds as leads, without reading the articles.
  | { kind: 'stopped_reading'; reason: string }
  | { kind: 'stopped'; reason: string }

export const RUN_ID = /^[0-9a-f-]{36}$/
