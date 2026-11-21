// Turns seed/data/*.json into seed/out/seed.sql, plus one file per data set so a
// new one can be added to a live database without replaying the others over
// rows editors have since changed. Seeding writes rows directly, which skips the
// sync log: run it before anyone is connected (a page reload picks the rows up
// from the snapshot).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { carriesUp, slugOf, usualWeight } from '../shared/schema.ts'

const read = (name: string) => JSON.parse(readFileSync(new URL(`../seed/data/${name}`, import.meta.url), 'utf8'))
const congress = read('us-congress.json')
const congressAsks = read('us-congress-asks.json')
const congressElect = read('us-congress-elect.json')
const era = read('us-states-era.json')
const halifax = read('halifax-ferry-fares.json')
// Made-up people for the end-to-end tests. Written to a file of its own and
// left out of seed.sql, so it reaches no database but the one those tests reset.
const demo = JSON.parse(readFileSync(new URL('../test/e2e/fixture.json', import.meta.url), 'utf8'))

const dataSets = new Map<string, string[]>()
let lines: string[] = []
let dataSetName = ''
function dataSet(name: string) {
  dataSetName = name
  lines = []
  dataSets.set(name, lines)
}
class Sql {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}
const sql = (v: unknown) =>
  v instanceof Sql ? v.text : v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? '1' : '0') : `'${String(v).replaceAll("'", "''")}'`
function insert(table: string, row: Record<string, unknown>) {
  lines.push(`INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(sql).join(', ')});`)
}

type SourceRef = { url: string; title: string; kind: string }
// A database that was migrated or edited before this seed ran already has a row
// for the URL under another id, so rows that point at a source look it up.
const sourceId = (url: string) => new Sql(`(SELECT id FROM sources WHERE url = ${sql(url)})`)
function source(ref: SourceRef, created_at: string) {
  const id = `seed-${createHash('sha1').update(ref.url).digest('hex').slice(0, 12)}`
  lines.push(
    `INSERT INTO sources (id, url, title, kind, created_at) VALUES (${[id, ref.url, ref.title, ref.kind, created_at].map(sql).join(', ')}) ON CONFLICT (url) DO UPDATE SET title = excluded.title, kind = excluded.kind;`,
  )
}

const questions = new Map<string, { parent_id: string | null; implies_on_parent: string | null }>()
function question(row: { id: string; parent_id: string | null; implies_on_parent?: string | null } & Record<string, unknown>) {
  const full = { threshold: null, act_label: null, status: 'open', closed_on: null, closed_note: null, decides_on: null, implies_on_parent: null, ...row }
  questions.set(full.id, full)
  insert('questions', full)
}

const sourcesWritten = new Set<string>()
// One act, the source that reports it and what it signals on one question.
// `primary` says the source is the record of the act itself.
function act(a: {
  id: string
  question_id: string
  decider_id: string
  kind: 'says' | 'commits' | 'does'
  position: string
  // Left out, words are clear and a commitment or a use of office is concrete.
  weight?: 'passing' | 'clear' | 'concrete'
  occurred_on: string
  withdrawn_on?: string | null
  body: string
  source: SourceRef
  primary: boolean
}) {
  const created_at = `${a.occurred_on}T00:00:00.000Z`
  const key = `${dataSetName} ${a.source.url}`
  if (!sourcesWritten.has(key)) {
    sourcesWritten.add(key)
    source(a.source, created_at)
  }
  const weight = a.weight ?? usualWeight(a.kind)
  insert('acts', {
    id: a.id,
    decider_id: a.decider_id,
    kind: a.kind,
    occurred_on: a.occurred_on,
    body: a.body,
    primary_source_id: a.primary ? sourceId(a.source.url) : null,
    withdrawn_on: a.withdrawn_on ?? null,
    created_at,
  })
  insert('reports', { id: a.id, source_id: sourceId(a.source.url), act_id: a.id, excerpt: null, passage: null, created_at })
  insert('readings', { id: a.id, act_id: a.id, question_id: a.question_id, position: a.position, weight, via_question_id: null, created_at })
  const q = questions.get(a.question_id)!
  if (q.implies_on_parent && q.parent_id && a.position === 'support' && carriesUp(weight)) {
    insert('readings', { id: `${a.id}:parent`, act_id: a.id, question_id: q.parent_id, position: q.implies_on_parent, weight, via_question_id: a.question_id, created_at })
  }
}

const slugs = new Set<string>()
function slugify(name: string): string {
  const base = slugOf(name)
  let slug = base
  for (let n = 2; slugs.has(slug); n++) slug = `${base}-${n}`
  slugs.add(slug)
  return slug
}

// ---- US Congress: real roster, real cosponsor records ----------------------

dataSet('us-congress')
const US = 'us-congress'
insert('bodies', {
  id: US,
  slug: US,
  name: 'United States Congress',
  jurisdiction: 'United States',
  description: `Members of the 119th Congress, and those elected to the 120th. Roster and cosponsor records as of ${congress.fetched_on}; election results, uncertified, as of ${congressElect.as_of}.`,
  is_demo: false,
  sort: 0,
  next_term_on: congressAsks.next_term.on,
  next_term_label: congressAsks.next_term.label,
})

// Who gives up which seat when the next term starts: the holder of every seat
// that changed hands, and of every seat not yet decided. In an undecided seat
// the holder may come back as one of those who may yet hold it.
if (congressElect.term_starts_on !== congressAsks.next_term.on) throw new Error('the members-elect file and the asks file disagree on when the next term starts')
const TERM = congressElect.term_starts_on
const leaving = new Set<string>([
  ...congressElect.seats.filter((s: any) => s.leaving).map((s: any) => `${s.seat} ${s.leaving}`),
  ...congressElect.pending.map((s: any) => `${s.seat} ${s.holder}`),
])

type CongressSeat = { chamber: string; state: string; district: number | null; senate_class?: number | null }
const seatKey = (m: CongressSeat) => (m.chamber === 'House' ? `${m.state}-${m.district === 0 ? 'AL' : m.district}` : `${m.state}-sen-${m.senate_class}`)
const NON_VOTING = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP'])
function congressSeat(m: CongressSeat): string {
  const house = m.chamber === 'House'
  const id = `${US}:${seatKey(m)}`
  insert('seats', {
    id,
    body_id: US,
    chamber: m.chamber,
    region: m.state,
    label: house ? seatKey(m) : `${m.state} Senate`,
    is_voting: !house || !NON_VOTING.has(m.state),
    next_election_on: null,
  })
  return id
}

const members = new Map<string, any>()
for (const m of congress.members) {
  members.set(m.bioguide, m)
  insert('deciders', { id: m.bioguide, slug: slugify(m.name), name: m.name, sort_name: m.sort_name, external_id: m.bioguide, url: m.url })
  const seatId = congressSeat(m)
  insert('roles', {
    id: `${seatId}:${m.bioguide}`,
    seat_id: seatId,
    decider_id: m.bioguide,
    contest: null,
    affiliation: m.party,
    starts_on: null,
    ends_on: leaving.has(`${seatKey(m)} ${m.bioguide}`) ? TERM : null,
    certainty: 'certain',
  })
}

// Someone who holds a seat from the day the next term starts. A sitting member
// keeps their id and record; anyone else is new here, under an id that is not a
// Bioguide id, since they get one only when sworn in.
function seatFromNextTerm(seatId: string, who: { bioguide?: string; name: string; sort_name?: string; party: string }, certainty: string, contest: string | null = null) {
  let deciderId = who.bioguide
  if (deciderId) {
    if (!members.has(deciderId)) throw new Error(`${seatId} names ${deciderId}, who is not in the roster`)
  } else {
    const slug = slugify(who.name)
    deciderId = `elect-${slug}`
    insert('deciders', { id: deciderId, slug, name: who.name, sort_name: who.sort_name, external_id: null, url: null })
  }
  // A returning holder already has a role in this seat, the one that ends, so
  // the role from the next term needs an id of its own.
  insert('roles', { id: `${seatId}:${deciderId}:${TERM}`, seat_id: seatId, decider_id: deciderId, contest, affiliation: who.party, starts_on: TERM, ends_on: null, certainty })
}

for (const s of congressElect.seats) seatFromNextTerm(congressSeat(s), s.winner, 'certain')

// Seats not decided yet. Whoever is ahead is likely; everyone else still in it
// is possible, the current holder included.
for (const s of congressElect.pending) {
  const seatId = congressSeat(s)
  const holder = members.get(s.holder)
  if (s.likely) seatFromNextTerm(seatId, s.likely, 'likely', s.contest)
  for (const p of s.possible) {
    seatFromNextTerm(seatId, p === 'holder' ? { bioguide: holder.bioguide, name: holder.name, party: holder.party } : p, 'possible', s.contest)
  }
}

question({
  id: 'm4a',
  slug: 'medicare-for-all',
  body_id: US,
  parent_id: null,
  kind: 'position',
  title: 'Do they support Medicare for All?',
  short_title: 'Medicare for All',
  description: 'A single public insurance program that covers everyone, replacing most private coverage. This asks about the policy in general; the measures below ask about specific bills.',
  reference_url: null,
  chamber: null,
  is_hot: true,
  sort: 0,
})

let skipped = 0
congress.bills.forEach((bill: any, i: number) => {
  const qid = `m4a-${bill.id}`
  question({
    id: qid,
    slug: `medicare-for-all-${bill.id}`,
    body_id: US,
    parent_id: 'm4a',
    kind: 'formal_act',
    title: `Have they cosponsored ${bill.label}, the ${bill.title}?`,
    short_title: bill.label,
    description: `The ${bill.chamber} bill, introduced ${bill.introduced_on}.`,
    reference_url: bill.url,
    chamber: bill.chamber,
    is_hot: false,
    sort: i + 1,
    implies_on_parent: 'support',
    // A bill that has not passed dies with its Congress, and a cosponsorship of
    // it stops being a commitment in force.
    status: 'lapsed',
    closed_on: congressAsks.next_term.on,
    closed_note: 'A bill that has not passed dies when its Congress ends.',
  })
  const signers = [
    { bioguide: bill.sponsor, on: bill.introduced_on, act: `Introduced ${bill.label}, the ${bill.title}, as its sponsor.` },
    ...bill.cosponsors.map((c: any) => ({
      bioguide: c.bioguide,
      on: c.on,
      act: `Cosponsored ${bill.label}, the ${bill.title}${c.original ? ', as an original cosponsor' : ''}.`,
    })),
  ]
  for (const s of signers) {
    if (!members.has(s.bioguide)) {
      skipped++ // signed on, then left Congress
      continue
    }
    const stamp = `${s.on}T00:00:00.000Z`
    act({
      id: `${qid}:${s.bioguide}`,
      question_id: qid,
      decider_id: s.bioguide,
      kind: 'commits',
      position: 'support',
      occurred_on: s.on,
      body: s.act,
      source: { url: `${bill.url}/cosponsors`, title: `Congress.gov: ${bill.label} cosponsors`, kind: 'official_record' },
      primary: true,
    })
  }
})

// ---- Asks of key people in Congress: its own file, so it can be added to a
// database without replaying the roster and stances over an editor's changes --

dataSet('us-congress-asks')
const member = (bioguide: string, where: string) => {
  if (!members.has(bioguide)) throw new Error(`${where} names ${bioguide}, who is not in the roster`)
  return bioguide
}
// Also set by the roster's own file. Repeated so this file works alone.
lines.push(`UPDATE bodies SET next_term_on = ${sql(congressAsks.next_term.on)}, next_term_label = ${sql(congressAsks.next_term.label)} WHERE id = ${sql(US)};`)
congressAsks.offices.forEach((o: any, i: number) => {
  insert('offices', { id: o.id, body_id: US, chamber: o.chamber, label: o.label, sort: i })
  for (const h of o.holders) {
    insert('office_holders', {
      id: `${o.id}:${member(h.bioguide, o.id)}`,
      office_id: o.id,
      decider_id: h.bioguide,
      starts_on: h.starts_on ?? null,
      ends_on: h.ends_on ?? null,
      certainty: h.certainty ?? 'certain',
    })
  }
})
congressAsks.asks.forEach((ask: any, i: number) => {
  question({
    id: ask.id,
    slug: ask.slug,
    body_id: US,
    parent_id: ask.parent,
    kind: 'position',
    title: ask.title,
    short_title: ask.short_title,
    description: ask.description,
    reference_url: null,
    chamber: ask.chamber,
    is_hot: false,
    sort: 100 + i,
  })
  // An ask that used to name people and now names offices must not keep both.
  // Only the seed's own rows go: a person an editor added on the site has a random id and stays.
  lines.push(`DELETE FROM question_deciders WHERE question_id = ${sql(ask.id)} AND instr(id, ${sql(`${ask.id}:`)}) = 1;`)
  for (const d of ask.deciders ?? []) {
    insert('question_deciders', { id: `${ask.id}:${member(d.bioguide, ask.id)}`, question_id: ask.id, decider_id: d.bioguide, role_label: d.role_label })
  }
  for (const officeId of ask.offices ?? []) insert('question_offices', { id: `${ask.id}:${officeId}`, question_id: ask.id, office_id: officeId })
})

// ---- The states and the Equal Rights Amendment: the National Archives' list --

dataSet('us-states')
const STATES = 'us-states'
insert('bodies', {
  id: STATES,
  slug: STATES,
  name: 'State legislatures',
  jurisdiction: 'United States',
  description: `The 50 state legislatures, which ratify amendments to the U.S. Constitution. Ratification records from the National Archives as of ${era.as_of}.`,
  is_demo: false,
  sort: 1,
})

const ratified = era.states.filter((s: any) => s.ratified_on)
const late = ratified.filter((s: any) => s.ratified_on > era.deadline)
const rescinded = ratified.filter((s: any) => s.rescinded_on)
const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
question({
  id: 'era',
  slug: 'equal-rights-amendment',
  body_id: STATES,
  parent_id: null,
  kind: 'formal_act',
  title: 'Has the state ratified the Equal Rights Amendment?',
  short_title: 'Equal Rights Amendment',
  description: `Congress sent the amendment to the states in 1972. It needs ${era.threshold} of the ${era.states.length} to ratify. By the deadline, which Congress extended to ${longDate(era.deadline)}, ${ratified.length - late.length} had. Another ${late.length} ratified after it, and ${rescinded.length} of the first ${ratified.length - late.length} have voted to rescind. Whether a late ratification counts, and whether a state can take one back, are unsettled.`,
  reference_url: null,
  chamber: null,
  is_hot: false,
  sort: 0,
  threshold: era.threshold,
  act_label: 'Ratified',
})

for (const state of era.states) {
  const id = `us-state-${state.code}`
  const seatId = `${STATES}:${state.code}`
  insert('deciders', { id, slug: slugify(state.name), name: state.name, sort_name: state.name, external_id: state.code, url: null })
  insert('seats', { id: seatId, body_id: STATES, chamber: null, region: state.code, label: state.code, is_voting: true, next_election_on: null })
  insert('roles', { id: `${seatId}:${id}`, seat_id: seatId, decider_id: id, contest: null, affiliation: null })
  if (!state.ratified_on) continue

  const isLate = state.ratified_on > era.deadline
  const year = (iso: string) => iso.slice(0, 4)
  const record = (suffix: string, on: string, position: string, body: string) =>
    act({
      id: `era:${state.code}:${suffix}`,
      question_id: 'era',
      decider_id: id,
      kind: 'does',
      position,
      occurred_on: on,
      body,
      source: { ...era.source, kind: 'official_record' },
      primary: true,
    })
  record('ratified', state.ratified_on, 'support', `Ratified the Equal Rights Amendment${isLate ? ', after the deadline set by Congress had passed' : ''}.`)
  if (state.rescinded_on) {
    record('rescinded', state.rescinded_on, 'oppose', 'Voted to rescind its ratification of the Equal Rights Amendment. The National Archives records this as a purported rescission.')
  }
}

// ---- Halifax Regional Council: real roster, one real vote on ferry fares ----

dataSet('halifax')
const HFX = halifax.body.id
insert('bodies', {
  ...halifax.body,
  slug: HFX,
  description: `The mayor and the 16 district councillors of Halifax Regional Municipality. Roster and records as of ${halifax.as_of}.`,
  is_demo: false,
  sort: 2,
})
const halifaxIds = new Map<string, string>()
const halifaxMember = (name: string) => {
  if (!halifaxIds.has(name)) throw new Error(`the Halifax file names ${name}, who is not in its roster`)
  return halifaxIds.get(name)!
}
for (const m of halifax.members) {
  const slug = slugify(m.name)
  const id = `hfx-${slug}`
  halifaxIds.set(m.name, id)
  const seatId = `${HFX}:${slugify(`${HFX} ${m.seat}`).slice(HFX.length + 1)}`
  insert('deciders', { id, slug, name: m.name, sort_name: m.sort_name, external_id: null, url: null })
  insert('seats', { id: seatId, body_id: HFX, chamber: null, region: null, label: m.seat, is_voting: true, next_election_on: null })
  insert('roles', { id: `${seatId}:${id}`, seat_id: seatId, decider_id: id, contest: null, affiliation: null })
}
const HFX_Q = halifax.question.id
question({ ...halifax.question, slug: HFX_Q, body_id: HFX, parent_id: null, kind: 'position', reference_url: null, chamber: null, is_hot: false, sort: 0 })
{
  const { vote } = halifax
  const cast = [...vote.for, ...vote.against, ...vote.absent]
  if (cast.length !== halifax.members.length || new Set(cast).size !== cast.length) throw new Error('the Halifax vote does not account for each member once')
  const sides = [
    { names: vote.for, position: 'support', word: 'for' },
    { names: vote.against, position: 'oppose', word: 'against' },
  ]
  for (const side of sides) {
    for (const name of side.names) {
      const id = halifaxMember(name)
      act({
        id: `${HFX_Q}:vote:${id}`,
        question_id: HFX_Q,
        decider_id: id,
        kind: 'does',
        position: side.position,
        occurred_on: vote.on,
        body: `Voted ${side.word} the motion to waive weekday fares on the Alderney ferry for June 2026 (defeated ${vote.for.length} to ${vote.against.length}).`,
        source: halifax.sources[vote.source],
        // The mover's own account of the vote, not the council's minutes.
        primary: false,
      })
    }
  }
  vote.absent.forEach(halifaxMember)
}
halifax.statements.forEach((s: any, i: number) => {
  act({
    id: `${HFX_Q}:says:${i + 1}`,
    question_id: HFX_Q,
    decider_id: halifaxMember(s.name),
    kind: 'says',
    position: s.position,
    occurred_on: s.on,
    body: s.quote,
    source: halifax.sources[s.source],
    primary: false,
  })
})

// ---- End-to-end fixture: fictional, exercises challengers and every footing --

const E2E_FIXTURE = 'e2e-fixture'
dataSet(E2E_FIXTURE)
const D = demo.body.id
insert('bodies', { ...demo.body, slug: D, is_demo: true, sort: 3 })
const demoIds = new Map<string, string>()
const person = (name: string) => {
  if (!demoIds.has(name)) {
    const slug = slugify(name)
    demoIds.set(name, `demo-${slug}`)
    const [first, ...rest] = name.split(' ')
    insert('deciders', { id: `demo-${slug}`, slug, name, sort_name: `${rest.join(' ')}, ${first}`, external_id: null, url: null })
  }
  return demoIds.get(name)!
}
function demoSeats(bodyId: string, seats: any[], next_election_on: string | null) {
  for (const seat of seats) {
    const seatId = `${bodyId}:${slugify(`${bodyId} ${seat.label}`).slice(bodyId.length + 1)}`
    insert('seats', { id: seatId, body_id: bodyId, chamber: null, region: null, label: seat.label, is_voting: true, next_election_on })
    const [name, affiliation] = seat.incumbent
    insert('roles', { id: `${seatId}:${person(name)}`, seat_id: seatId, decider_id: person(name), contest: null, affiliation })
    for (const [cName, cAffiliation, contest] of seat.challengers ?? []) {
      // Someone running for the seat may hold it from the election on.
      insert('roles', { id: `${seatId}:${person(cName)}`, seat_id: seatId, decider_id: person(cName), contest, affiliation: cAffiliation, starts_on: next_election_on, certainty: 'possible' })
    }
  }
}
demoSeats(D, demo.seats, demo.next_election_on)
demo.other_bodies.forEach((body: any, i: number) => {
  const { seats, ...row } = body
  insert('bodies', { ...row, slug: body.id, is_demo: true, sort: 4 + i })
  demoSeats(body.id, seats, null)
})
for (const r of demo.roles_at_large) {
  source({ ...r.source, kind: 'official_record' }, '2026-01-01T00:00:00.000Z')
  insert('offices', { id: r.id, body_id: null, chamber: null, label: r.label, sort: 0 })
  insert('office_holders', { id: `${r.id}:${person(r.holder)}`, office_id: r.id, decider_id: person(r.holder), starts_on: null, ends_on: null, source_id: sourceId(r.source.url) })
}
demo.questions.forEach((q: any, i: number) => {
  question({
    id: q.id,
    slug: q.id,
    body_id: D,
    parent_id: q.parent ?? null,
    kind: q.kind,
    title: q.title,
    short_title: q.short_title,
    description: q.description,
    reference_url: null,
    chamber: null,
    is_hot: q.is_hot ?? false,
    sort: i,
    implies_on_parent: q.kind === 'formal_act' && q.parent ? 'support' : null,
    status: q.status ?? 'open',
    closed_on: q.closed_on ?? null,
    closed_note: q.closed_note ?? null,
    decides_on: q.decides_on ?? null,
    act_label: q.act_label ?? null,
  })
  for (const bodyId of q.bodies ?? []) insert('question_bodies', { id: `${q.id}:${bodyId}`, question_id: q.id, body_id: bodyId })
  for (const [name, role_label] of q.deciders ?? []) {
    insert('question_deciders', { id: `${q.id}:${person(name)}`, question_id: q.id, decider_id: person(name), role_label })
  }
})
demo.relations.forEach(([q, related, kind]: string[], i: number) => {
  insert('question_relations', { id: `${q}>${related}`, question_id: q, related_id: related, kind, sort: i })
})
for (const [q, name, position, reason, on] of demo.set_positions) {
  insert('set_positions', { id: `${q}:${person(name)}`, question_id: q, decider_id: person(name), position, reason, set_at: `${on}T00:00:00.000Z` })
}
// The demo file names each act by where it happened, which decides the kind of
// its source and, unless the row says otherwise, how much the act binds.
const DEMO_SOURCE_KIND: Record<string, string> = { formal_act: 'official_record', vote: 'official_record', social: 'social_post', interview: 'transcript' }
const DEMO_ACT_KIND: Record<string, 'says' | 'commits' | 'does'> = { formal_act: 'commits', vote: 'does' }
demo.acts.forEach(([q, name, medium, position, on, body, title, more = {}]: any[], i: number) => {
  act({
    id: `demo-e${i + 1}`,
    question_id: q,
    decider_id: person(name),
    kind: more.kind ?? DEMO_ACT_KIND[medium] ?? 'says',
    position,
    weight: more.weight,
    occurred_on: on,
    withdrawn_on: more.withdrawn_on,
    body,
    source: { url: `https://example.com/harbor-city/${i + 1}`, title, kind: DEMO_SOURCE_KIND[medium] ?? 'article' },
    primary: medium === 'formal_act' || medium === 'vote',
  })
})

mkdirSync(new URL('../seed/out/', import.meta.url), { recursive: true })
const write = (name: string, rows: string[]) => writeFileSync(new URL(`../seed/out/${name}.sql`, import.meta.url), rows.join('\n') + '\n')
for (const [name, rows] of dataSets) write(name, rows)
const all = [...dataSets].filter(([name]) => name !== E2E_FIXTURE).flatMap(([, rows]) => rows)
write('seed', all)
console.log(`${all.length} rows written to seed/out/seed.sql${skipped ? ` (${skipped} signers no longer in the roster were skipped)` : ''}`)
for (const [name, rows] of dataSets) console.log(name === E2E_FIXTURE ? `  ${rows.length} more, not among them, in seed/out/${name}.sql` : `  ${rows.length} of them also in seed/out/${name}.sql`)
