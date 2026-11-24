import type { Act, Decider, Proposal, ProposalItem, Question, Reading, SetPosition, Source } from '../../shared/schema.ts'
import { groupBy, type Tracker } from './build-tracker.ts'
import type { Standing } from './position.ts'

// `question` keeps stories with a reading on that question or anything under
// it. `body` keeps people with a seat in that body, on questions put to it.
export type FeedFilter = { questionId?: string; bodyId?: string }

type StoryReading = { reading: Reading; question: Question; via: Question | undefined }

// One person's act as one source reports it.
export type StoryItem = {
  act: Act
  decider: Decider
  readings: StoryReading[]
  // The source's own words for the act. They differ from the act's when an
  // earlier source put the act on file.
  words: string
  // The passage of the source those words sit in, if it was kept.
  passage: string | null
  // False when the source reports an act already on the record.
  isNew: boolean
}

// A source entering the record: everything an editor published from it in one
// review. Its reports share the source and the moment they were written.
export type Story = {
  key: string
  source: Source
  at: string
  items: StoryItem[]
  isDemo: boolean
}

// One act a waiting proposal claims, with the readings it claims for it.
export type WaitingItem = {
  // The act the claims describe, unique within one proposal.
  key: string
  decider: Decider
  // The first claim's item carries the act's kind, date and words.
  // Where the person stands on the question before this claim, which counts only once an editor checks it.
  // `across` is the position editors set by hand, when the claim sits on the other side of it.
  claims: { item: ProposalItem; question: Question; reading: NonNullable<ProposalItem['reading']>; before: Standing; across: SetPosition | undefined }[]
}

// A proposal waiting for review: its source and the acts it claims. Nobody has
// checked any of it.
export type WaitingStory = {
  key: string
  at: string
  proposal: Proposal
  source: Source | undefined
  items: WaitingItem[]
  isDemo: boolean
}

export const STORY_PAGE = 20

// A question and every question under it, at any depth.
export function questionFamily(tracker: Pick<Tracker, 'subQuestionsOf'>, questionId: string): Set<string> {
  const family = new Set<string>()
  const visit = (id: string) => {
    if (family.has(id)) return
    family.add(id)
    for (const child of tracker.subQuestionsOf(id)) visit(child.id)
  }
  visit(questionId)
  return family
}

function matcher(tracker: Tracker, filter: FeedFilter) {
  const family = filter.questionId ? questionFamily(tracker, filter.questionId) : null
  const seated = filter.bodyId
    ? new Set(tracker.roles.filter((r) => tracker.seatById.get(r.seat_id)?.body_id === filter.bodyId).map((r) => r.decider_id))
    : null
  return {
    person: (deciderId: string) => !seated || seated.has(deciderId),
    question: (question: Question) => (!family || family.has(question.id)) && (!filter.bodyId || tracker.appliesIn(question, filter.bodyId)),
  }
}

const isDemoQuestion = (tracker: Tracker, question: Question) => tracker.bodyById.get(question.body_id)?.is_demo === true

// The published record as stories, newest first. A story keeps only the people
// the filter keeps, and each person's readings that match it come first.
export function buildStories(tracker: Tracker, filter: FeedFilter = {}): Story[] {
  const match = matcher(tracker, filter)
  const readingsByAct = groupBy(tracker.readings, (r) => r.act_id)
  const byKey = new Map<string, Story>()
  for (const report of tracker.reports) {
    const act = tracker.actById.get(report.act_id)
    const source = tracker.sourceById.get(report.source_id)
    const decider = act && tracker.deciderById.get(act.decider_id)
    if (!act || !source || !decider || !match.person(decider.id)) continue
    const readings = (readingsByAct.get(act.id) ?? [])
      .flatMap((reading) => {
        const question = tracker.questionById.get(reading.question_id)
        if (!question) return []
        const via = reading.via_question_id ? tracker.questionById.get(reading.via_question_id) : undefined
        return [{ reading, question, via, matches: match.question(question) }]
      })
      .sort((a, b) => Number(b.matches) - Number(a.matches) || Number(a.via !== undefined) - Number(b.via !== undefined) || a.question.sort - b.question.sort)
    if (!readings[0]?.matches) continue
    const item: StoryItem = { act, decider, readings: readings.map(({ matches: _, ...r }) => r), words: report.excerpt ?? act.body, passage: report.passage, isNew: act.created_at >= report.created_at }
    const isDemo = readings.some((r) => isDemoQuestion(tracker, r.question))
    const key = `${source.id}@${report.created_at}`
    const story = byKey.get(key)
    if (story) {
      story.items.push(item)
      story.isDemo ||= isDemo
    } else byKey.set(key, { key, source, at: report.created_at, items: [item], isDemo })
  }
  for (const story of byKey.values()) story.items.sort((a, b) => Number(b.isNew) - Number(a.isNew) || a.decider.sort_name.localeCompare(b.decider.sort_name))
  return [...byKey.values()].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key))
}

// What is waiting for review that claims something, one story per proposal,
// newest first. Only pending items with a reading count: rejected items, and
// search leads that only name someone, are left out. Items of one proposal
// that share an act are one item.
export function buildWaiting(tracker: Tracker, proposals: Proposal[], items: ProposalItem[], filter: FeedFilter = {}): WaitingStory[] {
  const match = matcher(tracker, filter)
  const proposalById = new Map(proposals.map((p) => [p.id, p]))
  const stories = new Map<string, WaitingStory>()
  for (const item of [...items].sort((a, b) => a.sort - b.sort)) {
    if (item.status !== 'pending' || item.reading === null) continue
    const proposal = proposalById.get(item.proposal_id)
    const decider = tracker.deciderById.get(item.decider_id)
    const question = tracker.questionById.get(item.question_id)
    if (!proposal || proposal.status !== 'pending' || !decider || !question || !match.person(decider.id) || !match.question(question)) continue
    let story = stories.get(proposal.id)
    if (!story) {
      story = { key: `proposal:${proposal.id}`, at: proposal.created_at, proposal, source: tracker.sourceById.get(proposal.source_id), items: [], isDemo: false }
      stories.set(proposal.id, story)
    }
    story.isDemo ||= isDemoQuestion(tracker, question)
    const claim = { item, question, reading: item.reading, before: tracker.standingFor(question, decider.id), across: tracker.acrossFor(question, decider.id, item.reading) }
    const existing = story.items.find((i) => i.key === item.act_id)
    if (existing) existing.claims.push(claim)
    else story.items.push({ key: item.act_id, decider, claims: [claim] })
  }
  return [...stories.values()].sort((a, b) => b.proposal.created_at.localeCompare(a.proposal.created_at) || a.proposal.id.localeCompare(b.proposal.id))
}

// The record and what is waiting, in one stream by when each entered it.
export type FeedStory = { kind: 'published'; story: Story } | { kind: 'waiting'; story: WaitingStory }

export function mergeFeed(stories: Story[], waiting: WaitingStory[]): FeedStory[] {
  const all: FeedStory[] = [...stories.map((story) => ({ kind: 'published' as const, story })), ...waiting.map((story) => ({ kind: 'waiting' as const, story }))]
  return all.sort((a, b) => b.story.at.localeCompare(a.story.at) || a.story.key.localeCompare(b.story.key))
}

// A cursor names a place in the feed's order, not a story, so it still works
// after the story it was taken from is reviewed, merged or removed.
const cursorOf = (f: FeedStory) => `${f.story.at}|${f.story.key}`
const isAfter = (f: FeedStory, cursor: string) => {
  const cut = cursor.indexOf('|')
  const at = cursor.slice(0, cut)
  return f.story.at < at || (f.story.at === at && f.story.key > cursor.slice(cut + 1))
}

// One page of the feed: what comes after `before` in its order, or the newest.
// `older` is the cursor for the next page.
export function feedPage(feed: FeedStory[], before: string | undefined, size = STORY_PAGE): { page: FeedStory[]; older: string | undefined; isFirst: boolean } {
  const start = before && before.includes('|') ? feed.findIndex((f) => isAfter(f, before)) : 0
  return pageFrom(feed, start === -1 ? feed.length : start, size)
}

function pageFrom(feed: FeedStory[], from: number, size: number) {
  const page = feed.slice(from, from + size)
  return { page, older: from + size < feed.length ? cursorOf(page[page.length - 1]) : undefined, isFirst: from === 0 }
}

// The page that holds one story, in the same shape as `feedPage`, or null if the feed does not have it.
export function pageHolding(feed: FeedStory[], key: string, size = STORY_PAGE): ReturnType<typeof feedPage> | null {
  const at = feed.findIndex((f) => f.story.key === key)
  return at === -1 ? null : pageFrom(feed, Math.floor(at / size) * size, size)
}

// The Atom feed of the same selection. It carries published stories only.
export function atomHref(filter: { question?: string; body?: string }) {
  const params = new URLSearchParams()
  if (filter.question) params.set('question', filter.question)
  if (filter.body) params.set('body', filter.body)
  const query = params.toString()
  return `/feed.xml${query ? `?${query}` : ''}`
}
