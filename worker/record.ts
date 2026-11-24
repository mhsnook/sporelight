import { D1Adapter } from 'party-db/server'
import { publicCollections } from '../shared/schema.ts'
import { buildTracker, type Tracker, type TrackerData } from '../src/lib/build-tracker.ts'

const ALL_TABLES = new Set(publicCollections.map((c) => c.name))

// The published tables, read the way a browser receives them, for buildTracker.
// A table left out of `tables` comes back empty.
export async function loadRecord(db: D1Database, tables: ReadonlySet<string> = ALL_TABLES): Promise<TrackerData> {
  const adapter = new D1Adapter(db, publicCollections.filter((c) => tables.has(c.name)))
  await adapter.init()
  const rows = new Map((await adapter.snapshot()).map((batch) => [batch.channel, batch.ops.map((op) => op.value)]))
  const of = <T,>(channel: string) => (rows.get(channel) ?? []) as T[]
  return {
    bodies: of('bodies'),
    deciders: of('deciders'),
    seats: of('seats'),
    roles: of('roles'),
    questions: of('questions'),
    questionBodies: of('question_bodies'),
    questionDeciders: of('question_deciders'),
    offices: of('offices'),
    officeHolders: of('office_holders'),
    questionOffices: of('question_offices'),
    questionRelations: of('question_relations'),
    setPositions: of('set_positions'),
    sources: of('sources'),
    acts: of('acts'),
    reports: of('reports'),
    reviews: of('reviews'),
  }
}

type Built = { seq: number; day: string; tracker: Tracker }
const built = new WeakMap<D1Database, Built>()

// The record built as the pages build it, kept in this isolate between requests
// and rebuilt only when party-db's log has moved on, or the day has. Writes that
// skip the log, such as `pnpm db:seed`, are not seen until the next logged write.
export async function currentTracker(db: D1Database, day: string): Promise<Tracker> {
  // party-db makes _oplog on its first start; until then nothing is kept.
  const seq = await db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM _oplog`)
    .first<{ seq: number }>()
    .then((row) => row?.seq ?? null)
    .catch(() => null)
  const kept = built.get(db)
  if (seq !== null && kept && kept.seq === seq && kept.day === day) return kept.tracker
  const tracker = buildTracker(await loadRecord(db), day)
  if (seq !== null) built.set(db, { seq, day, tracker })
  return tracker
}
