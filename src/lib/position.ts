import type { ActKind, Direction, Position, Proposal, Question, Role, Source, UnreadReason, Weight } from '../../shared/schema.ts'

export type Standing = Position | 'unknown'

export const STANDINGS: Standing[] = ['support', 'lean_support', 'mixed', 'lean_oppose', 'oppose', 'unknown']

// One scale for where someone stands and for what one act shows.
export const POSITION_LABEL: Record<Position, string> = {
  support: 'Yes',
  lean_support: 'Probably yes',
  mixed: 'Mixed',
  lean_oppose: 'Probably no',
  oppose: 'No',
}

// What one act shows, in the review form and the reader's form.
export const DIRECTION_LABEL: Record<Direction, string> = {
  support: 'Support',
  lean_support: 'Probable',
  mixed: 'Mixed',
  oppose: 'Against',
}

export const WEIGHT_LABEL: Record<Weight, string> = {
  presumed: 'Presumed',
  passing: 'Passing',
  clear: 'Clear',
  concrete: 'Concrete',
}

export const WEIGHT_HINT: Record<Weight, string> = {
  presumed: 'Presumed: someone else’s account of where they stand, with no words or act of their own. Lists them as a lean until we have a quote.',
  passing: 'Passing: a remark in passing, or about something next to the question. Shows as a signal.',
  clear: 'Clear: says where they stand on this question in plain terms.',
  concrete: 'Concrete: a vote, a signature, a pledge or another use of office. Puts them on the record.',
}

// An act of each kind, as a noun in a sentence.
export const KIND_NOUN: Record<ActKind, string> = {
  says: 'statement',
  commits: 'commitment',
  does: 'action',
}

export const UNREAD_TEXT: Record<UnreadReason, string> = {
  refused: 'The site turned our reader away',
  unreachable: 'The page could not be reached',
  not_an_article: 'The page is not something our reader can read',
  no_text: 'The page gave our reader almost no text, which usually means a paywall',
  model_failed: 'The model did not return a reading',
}

// On a formal-act question the record says whether they did it, so its absence is a known "no".
export function standingLabel(standing: Standing, question: Pick<Question, 'kind' | 'act_label'>): string {
  if (standing === 'unknown') return question.kind === 'formal_act' ? 'Has not' : 'No record yet'
  if (question.kind === 'formal_act' && standing === 'support') return question.act_label ?? 'Signed on'
  return POSITION_LABEL[standing]
}

export const STANDING_BG: Record<Standing, string> = {
  support: 'bg-support',
  lean_support: 'bg-lean-support',
  mixed: 'bg-mixed',
  lean_oppose: 'bg-lean-oppose',
  oppose: 'bg-oppose',
  unknown: 'bg-unknown',
}

export const STANDING_COLOR: Record<Standing, string> = {
  support: 'var(--color-support)',
  lean_support: 'var(--color-lean-support)',
  mixed: 'var(--color-mixed)',
  lean_oppose: 'var(--color-lean-oppose)',
  oppose: 'var(--color-oppose)',
  unknown: 'var(--color-unknown)',
}

// Left to right across a chamber: the yes side, the undecided middle, the no side.
export const SPECTRUM: Standing[] = ['support', 'lean_support', 'mixed', 'unknown', 'lean_oppose', 'oppose']

export const KIND_LABEL: Record<ActKind, string> = {
  says: 'Statement',
  commits: 'Commitment',
  does: 'Action',
}

// For the forms, where someone has to pick one.
export const KIND_CHOICE: Record<ActKind, string> = {
  says: 'Said it (a statement, interview or post)',
  commits: 'Committed to it (cosponsored, signed, pledged)',
  does: 'Did it (voted, scheduled, ratified)',
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
export const formatDate = (iso: string) => dateFmt.format(new Date(iso))

// The first date shown for a source. A date from the search results is not
// called a publish date: it may be when the page last changed.
export function publishedLine(source: Pick<Source, 'published_on' | 'published_on_from'>): string {
  if (!source.published_on) return 'Publish date not known'
  return `${source.published_on_from === 'search' ? 'Search result dated' : 'Published'} ${formatDate(source.published_on)}`
}

// What happened to an article the day a proposal was made from it, for "8 years before it was read".
export const FOUND: Record<Proposal['origin'], string> = {
  reader: 'sent in',
  news_search: 'found',
  partner: 'sent in',
  model: 'read',
}

// A source published at least this long before it was found is said to be old.
export const OLD_SOURCE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

// How long before `foundAt` a source was published, as "8 years" or "3 months",
// or null when it is less than OLD_SOURCE_DAYS or not known.
export function ageWhenFound(publishedOn: string | null, foundAt: string): string | null {
  if (!publishedOn) return null
  const days = Math.floor((Date.parse(foundAt.slice(0, 10)) - Date.parse(publishedOn)) / DAY_MS)
  if (!(days >= OLD_SOURCE_DAYS)) return null
  const [n, unit] = days >= 365 ? [Math.floor(days / 365.25) || 1, 'year'] : [Math.floor(days / 30.44) || 1, 'month']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

// What to call a source in a list or a heading.
export const sourceLabel = (source: { title: string | null; url: string | null }) => source.title ?? (source.url ? hostOf(source.url) : 'A document with no public link')

export function hostOf(url: string | null): string {
  try {
    return url ? new URL(url).hostname : 'No link'
  } catch {
    return url ?? 'No link'
  }
}

type Claim = Pick<Role, 'starts_on' | 'ends_on' | 'certainty' | 'contest'>
const CONTEST: Record<NonNullable<Role['contest']>, string> = { primary: 'primary', general: 'general election', runoff: 'runoff', recount: 'recount' }

// Where someone's claim on a seat stands on a day, in a few words. A sitting
// member, a member-elect, the leader in a recount and a challenger are all
// claims; only the dates, the certainty and the contest differ.
export function claimLabel(role: Claim, day: string): string {
  const pending = role.contest ? `, ${CONTEST[role.contest]} pending` : ', not settled'
  if (role.ends_on !== null && role.ends_on <= day) return `held the seat until ${formatDate(role.ends_on)}`
  if (role.starts_on !== null && role.starts_on > day) {
    const from = formatDate(role.starts_on)
    if (role.certainty === 'certain') return `takes the seat ${from}`
    if (role.certainty === 'likely') return `likely to take the seat ${from}${pending}`
    return role.contest === 'primary' || role.contest === 'general' ? `running in the ${CONTEST[role.contest]}` : `may take the seat ${from}${pending}`
  }
  if (role.certainty === 'likely') return `likely holds the seat${pending}`
  if (role.certainty === 'possible') return `may hold the seat${pending}`
  return role.ends_on ? `holds the seat until ${formatDate(role.ends_on)}` : 'holds the seat'
}

// The same, as the few words that go before a name in a list under a seat.
export function claimTag(role: Claim, day: string): string {
  if (role.certainty === 'possible' && role.contest) return CONTEST[role.contest]
  const upcoming = role.starts_on !== null && role.starts_on > day
  const when = upcoming ? `from ${formatDate(role.starts_on!)}` : 'now'
  return role.certainty === 'certain' ? when : `${role.certainty === 'likely' ? 'likely' : 'possibly'} ${when}`
}

