import { WEIGHTS, type Direction, type Position, type Weight } from './schema.ts'
const DAY = 86_400_000
export const FRESH_DAYS = 180
export const STALE_DAYS = 730

export type Footing = 'unknown' | 'on_record' | 'fresh' | 'established' | 'sparse' | 'stale'

export const FOOTING_LABEL: Record<Footing, string> = {
  unknown: 'No evidence',
  on_record: 'On the record',
  fresh: 'Fresh',
  established: 'Established',
  sparse: 'Sparse',
  stale: 'Stale',
}

export const FOOTING_HINT: Record<Footing, string> = {
  unknown: 'Nothing on file yet.',
  on_record: 'Backed by a vote, or by a commitment such as a cosponsorship that still stands.',
  fresh: `The most recent item is under ${FRESH_DAYS} days old.`,
  established: 'Several items, none of them recent.',
  sparse: 'Rests on a single item.',
  stale: `Nothing newer than ${Math.round(STALE_DAYS / 365)} years.`,
}

// One entry on someone's record, as footing sees it. `onRecord` is true for an
// act that binds them on this very question and still holds: a use of office,
// or a commitment in force, read directly. One of those is enough and never
// goes stale. Everything else is a dated signal.
export type Signal = { occurred_on: string; onRecord: boolean }

export function footingOf(signals: Signal[], now: Date = new Date()): Footing {
  if (!signals.length) return 'unknown'
  if (signals.some((s) => s.onRecord)) return 'on_record'
  const newest = Math.max(...signals.map((s) => Date.parse(s.occurred_on)))
  const ageDays = (now.getTime() - newest) / DAY
  if (ageDays > STALE_DAYS) return 'stale'
  if (signals.length === 1) return 'sparse'
  if (ageDays <= FRESH_DAYS) return 'fresh'
  return 'established'
}

// Footings that tell a reader "this could use another look".
export const NEEDS_ATTENTION: ReadonlySet<Footing> = new Set(['unknown', 'sparse', 'stale'])

// One reading on someone's record, as the calculation sees it. `inForce` is
// false only for a commitment that has been taken back.
export type Read = { position: Position; weight: Weight; occurred_on: string; inForce: boolean }

const SIDE: Record<Position, -1 | 0 | 1> = { support: 1, lean_support: 1, mixed: 0, lean_oppose: -1, oppose: -1 }
export const sideOf = (position: Position) => SIDE[position]

const TOWARD_MIDDLE: Record<Position, Position> = { support: 'lean_support', lean_support: 'mixed', mixed: 'mixed', lean_oppose: 'mixed', oppose: 'lean_oppose' }

// What several readings of one weight come to: the position they share, a lean
// if they share only a side, and mixed if they do not.
function together(positions: Position[]): Position {
  const distinct = new Set(positions)
  if (distinct.size === 1) return positions[0]
  const sides = new Set(positions.map(sideOf))
  return sides.size > 1 ? 'mixed' : sides.has(1) ? 'lean_support' : sides.has(-1) ? 'lean_oppose' : 'mixed'
}

const newestOf = (reads: Read[]) => {
  const day = reads.reduce((max, r) => (r.occurred_on > max ? r.occurred_on : max), '')
  return reads.filter((r) => r.occurred_on === day)
}

// Where a record leaves someone on a position question, or null with nothing
// that counts. The rules, in order:
//   1. A commitment taken back does not count.
//   2. The most recent concrete act decides: a later vote supersedes an
//      earlier one, and an earlier commitment.
//   3. A clear statement made after that act, on another side, moves the
//      result one step toward the middle.
//   4. With no concrete act, the most recent clear statement is where they stand.
//   5. Passing remarks count only when there is nothing else, and then only as a lean.
//   6. What someone else says of them counts only when there is nothing of their own, also as a lean.
export function calculatePosition(reads: Read[]): Position | null {
  const counted = reads.filter((r) => r.inForce)
  const concrete = counted.filter((r) => r.weight === 'concrete')
  const clear = counted.filter((r) => r.weight === 'clear')
  if (concrete.length) {
    const latest = newestOf(concrete)
    const base = together(latest.map((r) => r.position))
    const lastConcrete = latest[0].occurred_on
    const since = newestOf(clear.filter((r) => r.occurred_on > lastConcrete))
    return since.length && since.some((r) => sideOf(r.position) !== sideOf(base)) ? TOWARD_MIDDLE[base] : base
  }
  if (clear.length) return together(newestOf(clear).map((r) => r.position))
  const passing = counted.filter((r) => r.weight === 'passing')
  const least = newestOf(passing.length ? passing : counted)
  if (!least.length) return null
  const side = together(least.map((r) => r.position))
  return side === 'support' ? 'lean_support' : side === 'oppose' ? 'lean_oppose' : side
}

// Whether a reading sits across from a position: a no against a yes.
export const isAcross = (position: Position, reading: Position) => sideOf(position) * sideOf(reading) === -1

// Who wrote a review, in the order the summary turns to them.
export const REVIEWER_TIERS = ['editor', 'person', 'agent'] as const
export type ReviewerTier = (typeof REVIEWER_TIERS)[number]

// One review of an act on a question, as the summary sees it.
export type ReviewOf = { reviewer_id: string; tier: ReviewerTier; position: Direction; weight: Weight; updated_at: string }

// What the reviews of one act on one question come to, and whose they were.
export type Summary = { position: Position; weight: Weight; tier: ReviewerTier; count: number }

const SCORE: Record<Position, number> = { support: 2, lean_support: 1, mixed: 0, lean_oppose: -1, oppose: -2 }
const BY_SCORE: Position[] = ['oppose', 'lean_oppose', 'mixed', 'lean_support', 'support']

// The reviews of the first tier that has any: editors', then people's, then
// agents'. Within a tier each reviewer counts once and the reviews are
// averaged, the position on a scale from no (-2) to yes (+2) with halves
// going toward mixed, and the weight rounded down. A mixed and a no average to
// "Probably no", which no single review can say.
export function summarize(reviews: ReviewOf[]): Summary | null {
  const latest = new Map<string, ReviewOf>()
  for (const r of reviews) {
    const seen = latest.get(r.reviewer_id)
    if (!seen || r.updated_at > seen.updated_at) latest.set(r.reviewer_id, r)
  }
  for (const tier of REVIEWER_TIERS) {
    const own = [...latest.values()].filter((r) => r.tier === tier)
    if (!own.length) continue
    const score = own.reduce((sum, r) => sum + SCORE[r.position], 0) / own.length
    const rank = own.reduce((sum, r) => sum + WEIGHTS.indexOf(r.weight), 0) / own.length
    return { position: BY_SCORE[Math.sign(score) * Math.ceil(Math.abs(score) - 0.5) + 2], weight: WEIGHTS[Math.floor(rank)], tier, count: own.length }
  }
  return null
}
