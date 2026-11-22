// What a news search run reports at the end, and the steps it reports while it
// runs. The editor's page reads both, so they live beside the schema.

export type NewsReport = {
  // Set when the run stopped early: the search failed, the queue was full, or a model call failed.
  error?: string
  // `failed` counts articles read but not queued because writing the proposal failed. The next run reads them again.
  questions: { question: string; hits: number; read: number; queued: number; failed: number }[]
  // Hits that name someone and were neither read nor recorded, because the run
  // reached MAX_READS_PER_RUN or a model call failed.
  deferred: number
}

export type ReadOutcome = 'queued' | 'lead' | 'nothing' | 'failed'

export type NewsStep =
  | { kind: 'plan'; questions: string[]; queriesPerQuestion: number; maxReads: number }
  | { kind: 'searched'; question: string; query: string; hits: number; named: number }
  | { kind: 'reading'; question: string; url: string; title: string | null }
  // `lead`: the article could not be read, so the search excerpt was queued instead.
  | { kind: 'read'; question: string; url: string; title: string | null; outcome: ReadOutcome; queued: number; detail: string | null }
  | { kind: 'stopped'; reason: string }
  | { kind: 'done'; report: NewsReport | { skipped: string } }
  | { kind: 'crashed'; error: string }
