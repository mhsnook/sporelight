import type { FoundPublishedOn, Proposal, ProposalDraft, ProposalItem, UnreadReason } from '../shared/schema.ts'

export type RosterEntry = { id: string; name: string; sort_name: string }
export type SearchHit = { url: string; title: string; description?: string; lastModifiedDate?: string }

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Finds roster members named in a piece of text. A person matches on first name
// then last name with at most a middle name between them; a bare last name only
// counts when nobody else on the roster shares it.
export function rosterMatcher(roster: RosterEntry[]): (text: string) => string[] {
  const parsed = roster.map((r) => {
    const [last, rest = ''] = r.sort_name.split(',')
    return { id: r.id, last: fold(last.trim()), first: fold(rest.trim().split(/\s+/)[0] ?? '') }
  })
  const lastCount = new Map<string, number>()
  for (const p of parsed) lastCount.set(p.last, (lastCount.get(p.last) ?? 0) + 1)

  const patterns = parsed
    .filter((p) => p.first && p.last)
    .map((p) => ({
      id: p.id,
      full: new RegExp(`\\b${escape(p.first)}\\b(?:\\s+\\S+){0,2}?\\s+${escape(p.last)}\\b`),
      titled: lastCount.get(p.last) === 1 ? new RegExp(`\\b(?:rep|sen|senator|representative|councilmember|councillor|mayor|governor)\\.?\\s+${escape(p.last)}\\b`) : null,
    }))

  return (text) => {
    const haystack = fold(text)
    return patterns.filter((p) => p.full.test(haystack) || p.titled?.test(haystack)).map((p) => p.id)
  }
}

const MAX_PEOPLE_PER_HIT = 3

// The roster members a hit names, or nothing if it is not worth a lead. A hit
// that names more people than MAX_PEOPLE_PER_HIT is a roundup, which is no
// one's statement.
export function peopleInHit(hit: SearchHit, match: (text: string) => string[]): string[] {
  if (!/^https?:\/\//.test(hit.url)) return []
  if ((hit.description ?? hit.title).trim().length < 10) return []
  const people = match(`${hit.title}\n${hit.description ?? ''}`)
  return people.length > MAX_PEOPLE_PER_HIT ? [] : people
}

// The search provider's date for a result. It is when the page last changed,
// as far as the provider knows, which is not always when it was published.
export const hitPublished = (hit: SearchHit): FoundPublishedOn | null => {
  const on = hit.lastModifiedDate?.slice(0, 10)
  return on && /^\d{4}-\d{2}-\d{2}$/.test(on) ? { on, from: 'search' } : null
}

// One hit is one proposal, with an item for each person it names. `notRead`
// is given for a lead queued because the article could not be read: its `why`
// is added to the note. `published` is the page's own date when the page gave
// one, or else the search result's.
export function leadFromHit(
  hit: SearchHit,
  questionId: string,
  query: string,
  match: (text: string) => string[],
  notRead?: { unread: UnreadReason; why: string },
  published: FoundPublishedOn | null = hitPublished(hit),
): ProposalDraft | null {
  const people = peopleInHit(hit, match)
  if (people.length === 0) return null
  const quote = (hit.description ?? hit.title).trim().slice(0, 2000)
  const occurred_on = published?.on ?? null
  return {
    source: { url: hit.url, title: hit.title.slice(0, 300) || null, published },
    note: `Search excerpt, not a verified quote. Found by searching: ${query}${notRead ? `\n${notRead.why}` : ''}`,
    unread: notRead?.unread,
    items: people.map((decider_id) => ({ question_id: questionId, decider_id, kind: 'says', occurred_on, quote, reading: null })),
  }
}

// Leads nobody typed in. One an editor turned down stays turned down.
export const isAutomated = (origin: Proposal['origin']) => origin === 'news_search' || origin === 'model'

// An item proposed earlier from the same source. `turnedDown` (SQLite's 0 or 1) when the editors
// said its act says nothing on the question; `quote` is its words, or a lead's excerpt.
export type Proposed = Pick<ProposalItem, 'question_id' | 'decider_id'> & { turnedDown: boolean | number; quote: string }

// Whether an item already proposed from the same source stands in the way of a
// new one for the same person and question. A search hit or a model's reading
// is the same lead however it is worded, so anything earlier blocks it,
// rejected or not. A
// person can bring a better quote than one that was turned down: theirs is
// blocked only by an item the editors did not turn down, or by the same words.
export function alreadyProposed(earlier: Proposed[], item: Pick<Proposed, 'question_id' | 'decider_id' | 'quote'>, origin: Proposal['origin']): boolean {
  return earlier.some(
    (e) => e.question_id === item.question_id && e.decider_id === item.decider_id && (isAutomated(origin) || !e.turnedDown || e.quote === item.quote),
  )
}
