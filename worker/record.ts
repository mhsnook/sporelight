import { D1Adapter } from 'party-db/server'
import { publicCollections } from '../shared/schema.ts'
import type { TrackerData } from '../src/lib/build-tracker.ts'

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
    readings: of('readings'),
  }
}
