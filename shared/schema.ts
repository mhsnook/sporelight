import { z } from 'zod'
import { definePartyCollection } from 'party-db'

export const POSITIONS = ['support', 'lean_support', 'mixed', 'lean_oppose', 'oppose'] as const
export const positionSchema = z.enum(POSITIONS)
export type Position = z.infer<typeof positionSchema>

// How much an act binds the person, not where it happened (the source says that).
//   says     words, in any medium
//   commits  a formal, public, revocable commitment: cosponsoring, signing, pledging
//   does     using the office itself: voting, scheduling, ratifying
export const ACT_KINDS = ['says', 'commits', 'does'] as const
export const actKindSchema = z.enum(ACT_KINDS)
export type ActKind = z.infer<typeof actKindSchema>

// Which way one act points on a question. It is four of the five positions:
// an act supports, probably supports (lean_support: the words leave it
// uncertain or unclear), is mixed, or is against. Support for only part of a
// proposal is not one of these: it is support on a smaller step. "Probably no"
// is only ever where a person is listed.
export const DIRECTIONS = ['support', 'lean_support', 'mixed', 'oppose'] as const
export const directionSchema = z.enum(DIRECTIONS)
export type Direction = z.infer<typeof directionSchema>

// How much an act counts on the question it is read on.
//   presumed  someone else's account of where they stand, with nothing of their own
//   passing   a remark in passing, or about something next to the question: a signal
//   clear     says where they stand on this question in plain terms
//   concrete  a vote, a signature, a pledge or another use of office
export const WEIGHTS = ['presumed', 'passing', 'clear', 'concrete'] as const
// What a reading of something the person themselves did or said can be.
export const OWN_WEIGHTS = ['passing', 'clear', 'concrete'] as const
// A reading firm enough to say something on a parent question too.
export const carriesUp = (weight: (typeof WEIGHTS)[number]) => weight === 'clear' || weight === 'concrete'
export const weightSchema = z.enum(WEIGHTS)
export type Weight = z.infer<typeof weightSchema>

export const SOURCE_KINDS = ['article', 'press_release', 'official_record', 'transcript', 'social_post'] as const

export const bodySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  jurisdiction: z.string().nullable(),
  description: z.string().nullable(),
  is_demo: z.boolean(),
  sort: z.number(),
  // The day the body next changes over and what it is called from then on.
  next_term_on: z.string().nullable(),
  next_term_label: z.string().nullable(),
})
export type Body = z.infer<typeof bodySchema>

export const deciderSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  sort_name: z.string(),
  external_id: z.string().nullable(),
  url: z.string().nullable(),
})
export type Decider = z.infer<typeof deciderSchema>

export const seatSchema = z.object({
  id: z.string(),
  body_id: z.string(),
  chamber: z.string().nullable(),
  region: z.string().nullable(),
  label: z.string(),
  is_voting: z.boolean(),
  next_election_on: z.string().nullable(),
})
export type Seat = z.infer<typeof seatSchema>

// How sure it is that someone holds a seat or an office over its dates. It is
// a fact about the holding, not the person. A seat or office is shown as held
// by its certain or likely holder; possible holders are shown beside them.
export const CERTAINTIES = ['certain', 'likely', 'possible'] as const
export const certaintySchema = z.enum(CERTAINTIES)
export type Certainty = z.infer<typeof certaintySchema>

// A role is one claim on a seat: who, between which dates, and how sure. There
// is no separate kind for a challenger. Someone running for a seat is a possible
// holder from the next term, a member-elect a certain one, and whoever holds
// it today a certain one with no end known.
export const CONTESTS = ['primary', 'general', 'runoff', 'recount'] as const

export const roleSchema = z.object({
  id: z.string(),
  seat_id: z.string(),
  decider_id: z.string(),
  // What the claim still depends on, for one that is not settled.
  contest: z.enum(CONTESTS).nullable(),
  affiliation: z.string().nullable(),
  starts_on: z.string().nullable(),
  ends_on: z.string().nullable(),
  certainty: certaintySchema,
})
export type Role = z.infer<typeof roleSchema>

// Whether a dated row holds on a day. A null start is "since before we kept
// track" and a null end is "no end known". The end day itself is excluded, so
// one holder can end on the day the next starts.
export const inEffect = (row: { starts_on: string | null; ends_on: string | null }, day: string) =>
  (row.starts_on === null || row.starts_on <= day) && (row.ends_on === null || day < row.ends_on)

// Whether a dated row is still to come on a day. A row can end before it would
// start, as a candidate's claim does when they withdraw; it is not to come once ended.
export const stillAhead = (row: { starts_on: string | null; ends_on: string | null }, day: string) =>
  row.starts_on !== null && row.starts_on > day && (row.ends_on === null || day < row.ends_on)

// A key role, such as a committee chair. It outlives its holders.
export const officeSchema = z.object({
  id: z.string(),
  // null is a role held at large: it belongs to its holder in their own right
  // and shows with them in every body they sit in.
  body_id: z.string().nullable(),
  chamber: z.string().nullable(),
  label: z.string(),
  sort: z.number(),
})
export type Office = z.infer<typeof officeSchema>

export const officeHolderSchema = z.object({
  id: z.string(),
  office_id: z.string(),
  decider_id: z.string(),
  starts_on: z.string().nullable(),
  ends_on: z.string().nullable(),
  source_id: z.string().nullable(),
  certainty: certaintySchema,
})
export type OfficeHolder = z.infer<typeof officeHolderSchema>

// Puts a question to a body beyond the one in questions.body_id.
export const questionBodySchema = z.object({
  id: z.string(),
  question_id: z.string(),
  body_id: z.string(),
})
export type QuestionBody = z.infer<typeof questionBodySchema>

// An ask put to whoever holds an office on the day being viewed.
export const questionOfficeSchema = z.object({
  id: z.string(),
  question_id: z.string(),
  office_id: z.string(),
})
export type QuestionOffice = z.infer<typeof questionOfficeSchema>

export const questionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  body_id: z.string(),
  parent_id: z.string().nullable(),
  // 'position' asks where someone stands; 'formal_act' asks whether they did a
  // specific recordable thing (cosponsored, signed, voted), so having no stance
  // there means "has not", not "unknown".
  kind: z.enum(['position', 'formal_act']),
  title: z.string(),
  short_title: z.string(),
  description: z.string().nullable(),
  reference_url: z.string().nullable(),
  chamber: z.string().nullable(),
  is_hot: z.boolean(),
  sort: z.number(),
  // Seats needed to carry the question. null means a simple majority.
  threshold: z.number().int().positive().nullable(),
  act_label: z.string().nullable(),
  status: z.enum(['open', 'resolved', 'lapsed']),
  closed_on: z.string().nullable(),
  closed_note: z.string().nullable(),
  // The day a decision is expected, if one is set.
  decides_on: z.string().nullable(),
  // What doing the thing this sub-question asks about says on its parent: a
  // supporting reading here also writes this reading there, as cosponsoring a
  // bill is support for its policy and signing a letter against it is not.
  // null means a reading here says nothing about the parent.
  implies_on_parent: directionSchema.nullable(),
})
export type Question = z.infer<typeof questionSchema>

// A question with rows here, or in question_offices, is an ask of those people
// only. One with neither applies to every seat in its body or chamber.
export const questionDeciderSchema = z.object({
  id: z.string(),
  question_id: z.string(),
  decider_id: z.string(),
  role_label: z.string().nullable(),
})
export type QuestionDecider = z.infer<typeof questionDeciderSchema>

// Links a question to a narrower version of it, or to a neighbouring one.
// For a smaller step, `question_id` is the fuller proposal and `related_id`
// the step: supporting the step is not supporting the whole.
export const RELATION_KINDS = ['smaller_step', 'related'] as const
export const questionRelationSchema = z.object({
  id: z.string(),
  question_id: z.string(),
  related_id: z.string(),
  kind: z.enum(RELATION_KINDS),
  sort: z.number(),
})
export type QuestionRelation = z.infer<typeof questionRelationSchema>

// A position editors set by hand. While a row exists the person is listed as
// this, with the reason beside it, and not as their record works out.
export const setPositionSchema = z.object({
  id: z.string(),
  question_id: z.string(),
  decider_id: z.string(),
  position: positionSchema,
  reason: z.string(),
  set_at: z.string(),
})
export type SetPosition = z.infer<typeof setPositionSchema>

// Where a source's publish date came from, least sure first: the search
// provider's date for the result, the page's own metadata, or an editor.
export const PUBLISHED_ON_FROM = ['search', 'page', 'editor'] as const
export type PublishedOnFrom = (typeof PUBLISHED_ON_FROM)[number]
// A date found for an article, before any editor has seen it.
export type FoundPublishedOn = { on: string; from: Exclude<PublishedOnFrom, 'editor'> }

// Before this, a page's metadata date is a placeholder, not when the page was
// published, and an editor's date is a typing mistake.
export const EARLIEST_PUBLISHED = '1991-01-01'
export const isPublishDay = (day: string, today: string) => z.iso.date().safeParse(day).success && day >= EARLIEST_PUBLISHED && day <= today

// Whether a date from `next` should replace what a source has. An editor's
// word, a date or an empty one, ranks above any automated one.
export const replacesPublishedOn = (next: PublishedOnFrom, current: Pick<Source, 'published_on_from'>) =>
  PUBLISHED_ON_FROM.indexOf(next) > (current.published_on_from === null ? -1 : PUBLISHED_ON_FROM.indexOf(current.published_on_from))

export const sourceSchema = z.object({
  id: z.string(),
  // null for a document that reached us without a public address
  url: z.string().nullable(),
  title: z.string().nullable(),
  publisher: z.string().nullable(),
  published_on: z.string().nullable(),
  // null only while nothing is known. An editor can leave the date empty, which says it is not known and keeps automated dates off it.
  published_on_from: z.enum(PUBLISHED_ON_FROM).nullable(),
  kind: z.enum(SOURCE_KINDS).nullable(),
  archive_url: z.string().nullable(),
  stored_copy: z.string().nullable(),
  created_at: z.string(),
})
export type Source = z.infer<typeof sourceSchema>

export const actSchema = z.object({
  id: z.string(),
  decider_id: z.string(),
  kind: actKindSchema,
  occurred_on: z.string(),
  body: z.string(),
  // The record of the act itself, as opposed to a source that reports it.
  primary_source_id: z.string().nullable(),
  // Only a commitment can be taken back. Words and uses of office are
  // answered by a later act.
  withdrawn_on: z.string().nullable(),
  created_at: z.string(),
})
export type Act = z.infer<typeof actSchema>

export const reportSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  act_id: z.string(),
  excerpt: z.string().nullable(),
  // The passage of the source the act's words sit in.
  passage: z.string().nullable(),
  created_at: z.string(),
})
export type Report = z.infer<typeof reportSchema>

export const readingSchema = z.object({
  id: z.string(),
  act_id: z.string(),
  question_id: z.string(),
  position: directionSchema,
  weight: weightSchema,
  // Set on a reading written because a sub-question implies support on this one.
  via_question_id: z.string().nullable(),
  created_at: z.string(),
})
export type Reading = z.infer<typeof readingSchema>

export const PROPOSAL_ORIGINS = ['reader', 'news_search', 'partner', 'model'] as const

export const UNREAD_REASONS = ['refused', 'unreachable', 'not_an_article', 'no_text', 'model_failed'] as const
export type UnreadReason = (typeof UNREAD_REASONS)[number]

export const proposalSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  origin: z.enum(PROPOSAL_ORIGINS),
  submitted_by: z.string().nullable(),
  status: z.enum(['pending', 'reviewed']),
  // Why a lead's article was not read. null when it was read, or never fetched.
  unread: z.enum(UNREAD_REASONS).nullable(),
  created_at: z.string(),
  reviewed_at: z.string().nullable(),
})
export type Proposal = z.infer<typeof proposalSchema>

export const proposalItemSchema = z.object({
  id: z.string(),
  proposal_id: z.string(),
  sort: z.number(),
  decider_id: z.string(),
  question_id: z.string(),
  // Names an act already on file, or the id a new act will take if the item is
  // accepted, so it may match no row in `acts`. Items that share it describe
  // one act.
  act_id: z.string(),
  kind: actKindSchema,
  occurred_on: z.string().nullable(),
  quote: z.string(),
  // The passage of the source the quote sits in, when the article was read.
  passage: z.string().nullable(),
  // Both null on a news-search lead: a search hit names a person, not a position.
  reading: directionSchema.nullable(),
  weight: weightSchema.nullable(),
  status: z.enum(['pending', 'accepted', 'rejected']),
})
export type ProposalItem = z.infer<typeof proposalItemSchema>

export const proposalNoteSchema = z.object({
  id: z.string(),
  proposal_id: z.string(),
  proposal_item_id: z.string().nullable(),
  kind: z.enum(['submitter', 'review']),
  body: z.string(),
  created_at: z.string(),
})
export type ProposalNote = z.infer<typeof proposalNoteSchema>

// The text either side of an item's passage in the article it was read from.
export const proposalContextSchema = z.object({
  id: z.string(),
  proposal_id: z.string(),
  proposal_item_id: z.string(),
  before: z.string(),
  after: z.string(),
})
export type ProposalContext = z.infer<typeof proposalContextSchema>

// Someone the article was read for and names, with nothing to record.
export const proposalMentionSchema = z.object({
  id: z.string(),
  proposal_id: z.string(),
  decider_id: z.string(),
  words: z.string(),
})
export type ProposalMention = z.infer<typeof proposalMentionSchema>

// What the archiving pass records about a source in archive_attempts.
export type ArchiveOutcome = 'archived' | 'requested' | 'failed' | 'no_key' | 'gave_up'

// The answer to an editor's POST /api/editor/archive.
export type ArchiveNow =
  | { outcome: 'archived'; archive_url: string }
  | { outcome: Exclude<ArchiveOutcome, 'archived'> | 'no_url'; detail: string | null }
  | { error: string; status: number }

// A link we will put in an href.
export const webAddressSchema = z.url({ protocol: /^https?$/ }).max(2000)
export const isWebAddress = (value: string | null): value is string => value !== null && webAddressSchema.safeParse(value).success

// What the public form may send: one act by one person, read on one question.
export const proposalInputSchema = z.object({
  question_id: z.string().min(1),
  decider_id: z.string().min(1),
  kind: actKindSchema,
  reading: directionSchema,
  quote: z.string().trim().min(10).max(2000),
  source_url: webAddressSchema,
  source_title: z.string().trim().max(300).nullable(),
  occurred_on: z.iso.date().nullable(),
  submitter_note: z.string().trim().max(1000).nullable(),
})
export type ProposalInput = z.infer<typeof proposalInputSchema>

// What the Worker turns into a proposal. Each item is a separate act. An item's
// note is kept in proposal_notes, where only editors read it.
export type ProposalDraft = {
  source: { url: string; title: string | null; published?: FoundPublishedOn | null }
  note: string | null
  unread?: UnreadReason
  items: (Pick<ProposalItem, 'question_id' | 'decider_id' | 'kind' | 'occurred_on' | 'quote' | 'reading'> &
    Partial<Pick<ProposalItem, 'weight' | 'passage'>> & { note?: string | null; context?: { before: string; after: string } })[]
  mentions?: { decider_id: string; words: string }[]
}

// A lead the news search queued without reading its article: it names people and claims nothing.
export const isUnreadLead = (proposal: Pick<Proposal, 'origin'>) => proposal.origin === 'news_search'

// A name as the last part of an address.
export const slugOf = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

// What an act of a kind counts as until someone says otherwise.
export const usualWeight = (kind: ActKind): Weight => (kind === 'says' ? 'clear' : 'concrete')

// Whether a question is still open on a day. A closing date can lie ahead: a
// bill is known to die when its Congress ends.
export const isOpenOn = (question: Pick<Question, 'status' | 'closed_on'>, day: string) =>
  question.status === 'open' || (question.closed_on !== null && question.closed_on > day)

// Two links to one page should find one source, so the part after # is dropped.
export function sourceUrl(url: string): string {
  const hash = url.indexOf('#')
  return (hash === -1 ? url : url.slice(0, hash)).trim()
}

// Someone who has signed in. The id is their sign-in account's id; their email
// address is kept with that account and never here, since this table is public.
export const personSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  muted_at: z.string().nullable(),
  created_at: z.string(),
})
export type Person = z.infer<typeof personSchema>

export const displayNameSchema = z.string().trim().min(1).max(60)

// How long a sign-in code sent by email works.
export const SIGN_IN_CODE_MINUTES = 5

export const commentSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  author_name: z.string(),
  // Null for a comment posted while signed out.
  person_id: z.string().nullable(),
  body: z.string(),
  created_at: z.string(),
})
export type Comment = z.infer<typeof commentSchema>

export const commentInputSchema = z.object({
  question_id: z.string().min(1),
  decider_id: z.string().min(1),
  author_name: displayNameSchema,
  body: z.string().trim().min(1).max(2000),
})
export type CommentInput = z.infer<typeof commentInputSchema>

// The only identity this room's `auth` hook ever verifies is an editor, so
// 'authed' here means "editor". Readers who sign in are verified by the Worker
// on the requests they post; don't hand them a uid in this room.
const editorWrites = { read: 'public', insert: 'authed', update: 'authed', delete: 'authed' } as const

export const publicCollections = [
  definePartyCollection({ name: 'bodies', key: 'id', schema: bodySchema, access: editorWrites }),
  definePartyCollection({ name: 'deciders', key: 'id', schema: deciderSchema, access: editorWrites }),
  definePartyCollection({ name: 'seats', key: 'id', schema: seatSchema, access: editorWrites }),
  definePartyCollection({ name: 'roles', key: 'id', schema: roleSchema, access: editorWrites }),
  definePartyCollection({ name: 'questions', key: 'id', schema: questionSchema, access: editorWrites }),
  definePartyCollection({ name: 'question_deciders', key: 'id', schema: questionDeciderSchema, access: editorWrites }),
  definePartyCollection({ name: 'question_bodies', key: 'id', schema: questionBodySchema, access: editorWrites }),
  definePartyCollection({ name: 'offices', key: 'id', schema: officeSchema, access: editorWrites }),
  definePartyCollection({ name: 'office_holders', key: 'id', schema: officeHolderSchema, access: editorWrites }),
  definePartyCollection({ name: 'question_offices', key: 'id', schema: questionOfficeSchema, access: editorWrites }),
  definePartyCollection({ name: 'question_relations', key: 'id', schema: questionRelationSchema, access: editorWrites }),
  definePartyCollection({ name: 'set_positions', key: 'id', schema: setPositionSchema, access: editorWrites }),
  definePartyCollection({ name: 'sources', key: 'id', schema: sourceSchema, access: editorWrites }),
  definePartyCollection({ name: 'acts', key: 'id', schema: actSchema, access: editorWrites }),
  definePartyCollection({ name: 'reports', key: 'id', schema: reportSchema, access: editorWrites }),
  definePartyCollection({ name: 'readings', key: 'id', schema: readingSchema, access: editorWrites }),
] as const

// Unreviewed proposals are public. Add no column here that only an editor
// should read; that belongs in proposal_notes.
//
// Both are sliced so a browser loads them only when a page asks: readers, whose
// pages show no proposals, download none, and the editor's unfiltered queries
// load the whole table. The slice columns never change on a row, which party-db
// requires; `status` does, so it cannot be one.
export const proposalsCollection = definePartyCollection({ name: 'proposals', key: 'id', schema: proposalSchema, sliceBy: 'source_id', access: editorWrites })
export const proposalItemsCollection = definePartyCollection({
  name: 'proposal_items',
  key: 'id',
  schema: proposalItemSchema,
  sliceBy: 'proposal_id',
  access: editorWrites,
})

export const proposalNotesCollection = definePartyCollection({
  name: 'proposal_notes',
  key: 'id',
  schema: proposalNoteSchema,
  access: 'authed',
})

// Sliced by thread, so a reader loads and hears only the threads they have open.
// Readers post through the Worker, which stamps and validates the row; editors
// may delete.
export const commentsCollection = definePartyCollection({
  name: 'comments',
  key: 'id',
  schema: commentSchema,
  sliceBy: 'thread_id',
  access: { read: 'public', delete: 'authed' },
})

// Rows are added by the Worker when someone first signs in, and an editor mutes
// a person by setting muted_at.
export const peopleCollection = definePartyCollection({ name: 'people', key: 'id', schema: personSchema, access: { read: 'public', update: 'authed' } })

export const proposalContextsCollection = definePartyCollection({ name: 'proposal_contexts', key: 'id', schema: proposalContextSchema, access: 'authed' })
export const proposalMentionsCollection = definePartyCollection({ name: 'proposal_mentions', key: 'id', schema: proposalMentionSchema, access: 'authed' })

export const allCollections = [
  ...publicCollections,
  proposalsCollection,
  proposalItemsCollection,
  proposalNotesCollection,
  proposalContextsCollection,
  proposalMentionsCollection,
  commentsCollection,
  peopleCollection,
] as const

export const pairId = (questionId: string, deciderId: string) => `${questionId}:${deciderId}`
