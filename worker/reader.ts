import { z } from 'zod'
import { ACT_KINDS, DIRECTIONS, OWN_WEIGHTS, type FoundPublishedOn, type ProposalDraft } from '../shared/schema.ts'

// An article as the reader is given it. `published` is the page's own date when
// it has one, or else the date the search result came with.
export type ArticleRef = { url: string; title: string | null; published: FoundPublishedOn | null }

const DATE_LINE: Record<FoundPublishedOn['from'], (day: string) => string> = {
  page: (day) => `Published ${day}, according to the page`,
  search: (day) => `Dated ${day} by the search results, which may be when the page last changed rather than when it was published`,
}

// The model that reads articles. Check the Workers AI catalogue for a planned
// deprecation date before changing it: an id past that date answers 410.
export const MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'

type Asked = { id: string; title: string; short_title: string; description: string | null; kind: 'position' | 'formal_act' }

// What the model is told about the question: the question itself, the
// sub-questions under it that are open, and for each person which of them are
// put to that person. The rules are the ones `buildTracker` applies: a measure
// is put to everyone in the body, or in its chamber; an ask only to the people
// it names or who hold an office it is put to on the day.
export type ReadingContext = {
  question: Asked
  subQuestions: (Asked & { is_ask: boolean })[]
  // Questions linked to this one in the same body: smaller steps toward it and neighbouring questions.
  relatedQuestions: (Asked & { relation: 'smaller_step' | 'related' })[]
  people: { id: string; name: string; questions: string[] }[]
}

export async function readingContext(db: D1Database, questionId: string, people: { id: string; name: string }[], day: string): Promise<ReadingContext | null> {
  const ids = JSON.stringify(people.map((p) => p.id))
  const [question, children, chambers, asked, linked] = await db.batch([
    db.prepare(`SELECT id, title, short_title, description, kind FROM questions WHERE id = ?1`).bind(questionId),
    db
      .prepare(
        `SELECT q.id, q.title, q.short_title, q.description, q.kind, q.chamber,
           EXISTS (SELECT 1 FROM question_deciders l WHERE l.question_id = q.id) OR EXISTS (SELECT 1 FROM question_offices l WHERE l.question_id = q.id) AS is_ask
         FROM questions q
         WHERE q.parent_id = ?1 AND (q.status = 'open' OR q.closed_on > ?2)
         ORDER BY q.sort`,
      )
      .bind(questionId, day),
    db
      .prepare(
        `SELECT DISTINCT r.decider_id, s.chamber FROM roles r JOIN seats s ON s.id = r.seat_id
         WHERE r.decider_id IN (SELECT value FROM json_each(?1))
           AND (r.starts_on IS NULL OR r.starts_on <= ?2) AND (r.ends_on IS NULL OR ?2 < r.ends_on)`,
      )
      .bind(ids, day),
    db
      .prepare(
        `SELECT l.question_id, l.decider_id FROM question_deciders l JOIN questions q ON q.id = l.question_id
         WHERE q.parent_id = ?1 AND l.decider_id IN (SELECT value FROM json_each(?2))
         UNION
         SELECT l.question_id, h.decider_id FROM question_offices l JOIN questions q ON q.id = l.question_id JOIN office_holders h ON h.office_id = l.office_id
         WHERE q.parent_id = ?1 AND h.decider_id IN (SELECT value FROM json_each(?2))
           AND (h.starts_on IS NULL OR h.starts_on <= ?3) AND (h.ends_on IS NULL OR ?3 < h.ends_on)`,
      )
      .bind(questionId, ids, day),
    db
      .prepare(
        `SELECT q.id, q.title, q.short_title, q.description, q.kind, r.kind AS relation
         FROM question_relations r JOIN questions q ON q.id = r.related_id JOIN questions main ON main.id = r.question_id
         WHERE r.question_id = ?1 AND q.body_id = main.body_id AND (q.status = 'open' OR q.closed_on > ?2)
         ORDER BY r.sort`,
      )
      .bind(questionId, day),
  ])
  const root = question.results[0] as Asked | undefined
  if (!root) return null
  const subs = (children.results as (Asked & { chamber: string | null; is_ask: number })[]).map((q) => ({ ...q, is_ask: Boolean(q.is_ask) }))
  const chambersOf = new Map<string, Set<string | null>>()
  for (const row of chambers.results as { decider_id: string; chamber: string | null }[]) {
    chambersOf.set(row.decider_id, (chambersOf.get(row.decider_id) ?? new Set()).add(row.chamber))
  }
  const related = linked.results as ReadingContext['relatedQuestions']
  const askedOf = new Set((asked.results as { question_id: string; decider_id: string }[]).map((r) => `${r.question_id} ${r.decider_id}`))
  return {
    question: { id: root.id, title: root.title, short_title: root.short_title, description: root.description, kind: root.kind },
    subQuestions: subs.map(({ chamber: _, ...q }) => q),
    relatedQuestions: related,
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      questions: [
        root.id,
        ...subs
          .filter((q) => (q.is_ask ? askedOf.has(`${q.id} ${p.id}`) : !q.chamber || chambersOf.get(p.id)?.has(q.chamber)))
          .map((q) => q.id),
        ...related.map((q) => q.id),
      ],
    })),
  }
}

const isoDate = z.iso.date()

// What the model is asked to return. Loose on purpose where the model is likely
// to stray (an unparseable date becomes null); strict on anything an editor
// would otherwise have to catch.
export const modelOutputSchema = z.object({
  acts: z.array(
    z.object({
      person_id: z.string(),
      question_id: z.string(),
      kind: z.enum(ACT_KINDS),
      quote: z.string(),
      occurred_on: z
        .string()
        .nullable()
        .transform((d) => (d && isoDate.safeParse(d).success ? d : null)),
      // How the date was worked out, or what in the article left it unknown.
      date_basis: z.string(),
      position: z.enum(DIRECTIONS),
      weight: z.enum(OWN_WEIGHTS),
      reason: z.string(),
    }),
  ),
  // Left out, it is nobody: an answer with acts is not thrown away for it.
  named_only: z.array(z.object({ person_id: z.string(), quote: z.string() })).default([]),
})
// An act as the model gave it, with where its words sit in the article.
export type ModelAct = z.infer<typeof modelOutputSchema>['acts'][number] & { passage: string; context: { before: string; after: string } }
export type Mention = { person_id: string; words: string }

// The same shape for the model, as JSON Schema.
const { $schema: _, ...OUTPUT_JSON_SCHEMA } = z.toJSONSchema(
  z.object({
    acts: z.array(modelOutputSchema.shape.acts.element.extend({ occurred_on: z.string().nullable() })),
    named_only: modelOutputSchema.shape.named_only.unwrap(),
  }),
  { target: 'draft-7' },
)

const SYSTEM = `You read one news article and list what it records named people doing or saying about one question.

An act is one thing one person did or said. Each act has a kind:
- says: words, in any medium (a statement, an interview, a post, a speech)
- commits: a formal, public, revocable commitment (cosponsoring a bill, signing a letter, taking a pledge)
- does: using the office itself (voting, scheduling a hearing, ratifying)

For each act give:
- person_id and question_id, taken only from the lists you are given; a person can only be read on the questions listed for them
- quote: words copied exactly from the article, character for character, with no ellipsis and no words added. For a statement, the person's own words. For a commitment or a use of office, the article's sentence that reports it
- occurred_on: the date the act happened, as YYYY-MM-DD. The record is ordered by this date and positions are worked out from it, so find it. Use a date the article states. Work out a relative one ("on Tuesday", "yesterday", "last week's vote") from the article's publish date given below, and give a day with no year the year that makes it fall on or before the publish date. Use the publish date itself only when the article reports the act as that day's news ("said in a statement today", "said Tuesday" when Tuesday is the publish date). Give null only when nothing in the article fixes the day, such as an act described as happening at some point in the past. Never give a date after today
- date_basis: how you got the date, in a few words ("stated: on March 3", "worked out: Tuesday before the publish date", "the publish date: reported as today's news"), or, with a null date, what in the article left the day unknown
- position: which way the act points on that question. support; lean_support if it probably supports it but the words leave that uncertain or unclear; mixed; oppose. Support for only part of a proposal is not lean_support: read it on the narrower question if one is listed. On a question that asks whether someone did a specific thing, support means they did it
- weight: how much the act counts on that question. passing for a remark in passing, or an act about something next to the question; clear for words that say where the person stands on this question in plain terms; concrete for a vote, a signature, a pledge or another use of office on this question itself
- reason: one or two sentences for the editor saying why this act counts

Only list an act the article itself reports. A person merely being mentioned, quoted about something else, or described by someone else's opinion is not an act. Most articles record no act for most people: return an empty list when that is so.

A question whose relation_to_main_question is smaller_step is a narrower version of the main question. Support for the smaller step is not support for the main question: list an act on each question it is about, with what it shows there. One sentence can be support on a smaller step and oppose on the main question.

In named_only, list each person from the list whom the article names but records no act for, with the words that name them copied exactly from the article (for example "was absent").`

export function modelPrompt(context: ReadingContext, article: ArticleRef & { text: string }, today: string) {
  const subQuestionIds = new Set(context.subQuestions.map((q) => q.id))
  const questions = [context.question, ...context.subQuestions, ...context.relatedQuestions].map((q) => ({
    question_id: q.id,
    title: q.title,
    description: q.description,
    asks_whether_they_did_it: q.kind === 'formal_act',
    is_sub_question_of: subQuestionIds.has(q.id) ? context.question.id : null,
    relation_to_main_question: 'relation' in q ? q.relation : null,
  }))
  const user = [
    `Today is ${today}.`,
    `Questions:\n${JSON.stringify(questions, null, 1)}`,
    `People, with the questions each can be read on:\n${JSON.stringify(context.people.map((p) => ({ person_id: p.id, name: p.name, question_ids: p.questions })), null, 1)}`,
    `Article: ${article.title ?? '(no title)'}\n${article.url}\n${article.published ? DATE_LINE[article.published.from](article.published.on) : 'Publish date not known'}\n\n${article.text}`,
  ].join('\n\n')
  return {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'acts', schema: OUTPUT_JSON_SCHEMA, strict: true } },
    reasoning_effort: 'none',
    temperature: 0,
    max_completion_tokens: 4000,
  }
}

// For comparing a quote with the article: case, runs of whitespace, curly
// quotes, dashes and invisible characters do not count as differences.
const QUOTE_FOLD: [RegExp, string][] = [
  [/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/[\u00AD\u200B-\u200D\uFEFF]/g, ''],
]
const foldChar = (c: string) => QUOTE_FOLD.reduce((out, [from, to]) => out.replace(from, to), c.normalize('NFKC')).toLowerCase()

// The folded text, and for each of its characters the index in `text` of the
// character it came from, so a match can be cut from the original.
function fold(text: string): { folded: string; from: number[] } {
  let folded = ''
  const from: number[] = []
  let index = 0
  for (const c of text) {
    const out = /\s/.test(c) ? (folded.endsWith(' ') || folded === '' ? '' : ' ') : foldChar(c)
    folded += out
    for (let unit = 0; unit < out.length; unit++) from.push(index)
    index += c.length
  }
  return { folded, from }
}

export const normalise = (text: string) => fold(text).folded.trim()

// Quote marks around the whole quote are the model's, not the speaker's.
// A lone apostrophe at one end is kept: "the members'" ends in one.
function unwrap(needle: string): string {
  let out = needle.trim().replace(/^"+|"+$/g, '').trim()
  while (out.length > 1 && out.startsWith("'") && out.endsWith("'")) out = out.slice(1, -1).trim()
  return out
}

// Where a quote's words sit in the article, and the article's own words
// there, or null if they are not in it. `folded` is the article folded once,
// since an article is searched for every quote. `least` is the fewest
// characters that count as a quote.
function locateInArticle(quote: string, articleText: string, { folded, from }: ReturnType<typeof fold>, least = 10): { start: number; end: number; words: string } | null {
  const needle = unwrap(normalise(quote))
  if (needle.length < least) return null
  const at = folded.indexOf(needle)
  if (at === -1) return null
  const last = from[at + needle.length - 1]
  const end = last + (articleText.codePointAt(last)! > 0xffff ? 2 : 1)
  return { start: from[at], end, words: articleText.slice(from[at], end).trim() }
}

// The article's own words for a quote, or null if they are not in it.
export const findInArticle = (quote: string, articleText: string): string | null => locateInArticle(quote, articleText, fold(articleText))?.words ?? null

// The most of a passage that is published with a quote, and of the text kept
// either side of it for the editor.
export const MAX_PASSAGE_CHARS = 600
const MAX_CONTEXT_CHARS = 700
const SENTENCE_END = /[.!?]["'\u2019\u201D)]*\s/g

// The paragraph a quote sits in, and the paragraphs either side of it. A long
// paragraph is cut back to the sentences around the quote.
export function passageAround(articleText: string, start: number, end: number): { passage: string; before: string; after: string } {
  let from = articleText.lastIndexOf('\n', start - 1) + 1
  let to = articleText.indexOf('\n', end)
  if (to === -1) to = articleText.length
  if (to - from > MAX_PASSAGE_CHARS) {
    const margin = Math.max(0, Math.floor((MAX_PASSAGE_CHARS - (end - start)) / 2))
    // Where the margin reaches the paragraph's own edge, that edge is kept: it is where a sentence starts or ends.
    if (start - margin > from) {
      const left = articleText.slice(start - margin, start)
      const firstEnd = [...left.matchAll(SENTENCE_END)][0]
      from = firstEnd ? start - left.length + firstEnd.index + firstEnd[0].length : start
    }
    if (end + margin < to) {
      const right = articleText.slice(end, end + margin)
      const lastEnd = [...right.matchAll(SENTENCE_END)].at(-1)
      to = lastEnd ? end + lastEnd.index + lastEnd[0].length : end
    }
  }
  // Whole paragraphs, nearest first, for as long as they fit.
  const fit = (paragraphs: string[]) => {
    const kept: string[] = []
    let size = 0
    for (const p of paragraphs) {
      if (!p.trim()) continue
      if ((size += p.length) > MAX_CONTEXT_CHARS) break
      kept.push(p.trim())
    }
    return kept
  }
  return {
    passage: articleText.slice(from, to).trim(),
    before: fit(articleText.slice(0, from).split('\n').reverse()).reverse().join('\n'),
    after: fit(articleText.slice(to).split('\n')).join('\n'),
  }
}

export const quoteIsInArticle = (quote: string, articleText: string) => findInArticle(quote, articleText) !== null

// More than this from one article is more than an editor can check as one
// proposal, and more than an honest reading of one article tends to find.
export const MAX_ACTS_PER_ARTICLE = 8
// Dropped acts listed by name in the proposal's note; the rest are counted.
const DROPPED_LISTED = 5

export type Dropped = { act: Pick<ModelAct, 'person_id' | 'question_id' | 'quote'>; why: string }

export type Reading =
  | { ok: true; acts: ModelAct[]; dropped: Dropped[]; mentions: Mention[] }
  // The model did not answer (`callFailed`), or answered with nothing that
  // fits the schema.
  | { ok: false; reason: string; callFailed: boolean }

// Pulls the model's answer out of what the binding returns. The catalogue
// gives an OpenAI-style completion; older Workers AI models put it in
// `response`, sometimes already parsed.
function answerOf(raw: unknown): unknown {
  const r = raw as { choices?: { message?: { content?: unknown } }[]; response?: unknown }
  const content = r?.choices?.[0]?.message?.content ?? r?.response
  if (typeof content !== 'string') return content
  try {
    return JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    return content
  }
}

export async function readArticle(
  env: Pick<Env, 'AI' | 'AI_GATEWAY'>,
  context: ReadingContext,
  article: ArticleRef & { text: string },
  today: string,
): Promise<Reading> {
  let answer: unknown
  try {
    const raw = await env.AI.run(MODEL as never, modelPrompt(context, article, today) as never, { gateway: { id: env.AI_GATEWAY } })
    answer = answerOf(raw)
  } catch (e) {
    return { ok: false, reason: `The model call failed (${String(e).slice(0, 160)}).`, callFailed: true }
  }
  const parsed = modelOutputSchema.safeParse(answer)
  if (!parsed.success) return { ok: false, reason: `The model's answer did not fit the expected shape (${parsed.error.issues[0]?.message ?? 'unknown'}).`, callFailed: false }

  const allowed = new Map(context.people.map((p) => [p.id, new Set(p.questions)]))
  const acts: ModelAct[] = []
  const dropped: Dropped[] = []
  // One item per person and question, as `alreadyProposed` would allow from
  // later articles: a second act on the same pair is a repeat, or a second
  // reading the editor can add from the review form.
  const taken = new Set<string>()
  const folded = fold(article.text)
  for (const act of parsed.data.acts) {
    const pair = `${act.person_id} ${act.question_id}`
    const found = locateInArticle(act.quote, article.text, folded)
    const why = !allowed.has(act.person_id)
      ? 'names someone the article was not read for'
      : !allowed.get(act.person_id)!.has(act.question_id)
        ? 'is read on a question not put to that person'
        : !found
          ? 'quotes words that are not in the article'
          : taken.has(pair)
            ? 'repeats a person and question already listed'
            : acts.length >= MAX_ACTS_PER_ARTICLE
              ? `is past the limit of ${MAX_ACTS_PER_ARTICLE} acts for one article`
              : null
    if (why || !found) {
      dropped.push({ act: { person_id: act.person_id, question_id: act.question_id, quote: act.quote }, why: why! })
      continue
    }
    taken.add(pair)
    const { passage, before, after } = passageAround(article.text, found.start, found.end)
    acts.push({
      ...act,
      quote: found.words.slice(0, 2000),
      // A date ahead of today is the date of something promised, not of the act.
      occurred_on: act.occurred_on && act.occurred_on <= today ? act.occurred_on : null,
      date_basis: act.occurred_on && act.occurred_on > today ? `Dropped ${act.occurred_on}, which is after today. ${act.date_basis.trim()}`.slice(0, 500) : act.date_basis.trim().slice(0, 500),
      reason: act.reason.trim().slice(0, 1000),
      passage,
      context: { before, after },
    })
  }
  // Someone with an act is not also listed as only named. The words have to be
  // in the article, like a quote.
  const acted = new Set(acts.map((a) => a.person_id))
  const mentions: Mention[] = []
  for (const m of parsed.data.named_only) {
    const at = locateInArticle(m.quote, article.text, folded, 3)
    if (!at || !allowed.has(m.person_id) || acted.has(m.person_id) || mentions.some((x) => x.person_id === m.person_id)) continue
    mentions.push({ person_id: m.person_id, words: at.words.slice(0, 300) })
  }
  return { ok: true, acts, dropped, mentions }
}

// One proposal for the article, with one item per act. The model's reason for
// each act goes in that item's note, which only editors read.
export function draftFromReading(article: ArticleRef, acts: ModelAct[], dropped: Dropped[], query: string | null, mentions: Mention[] = []): ProposalDraft {
  const lines = [
    `Read by ${MODEL}. Each quote below was found word for word in the text fetched from the article.`,
    dropped.length
      ? `${dropped.length} more act${dropped.length === 1 ? ' was' : 's were'} left out: ${dropped
          .slice(0, DROPPED_LISTED)
          .map((d) => `"${d.act.quote.slice(0, 80)}" ${d.why}`)
          .join('; ')}${dropped.length > DROPPED_LISTED ? `; and ${dropped.length - DROPPED_LISTED} more` : ''}.`
      : null,
    query ? `Found by searching: ${query}` : null,
  ]
  return {
    source: { url: article.url, title: article.title?.slice(0, 300) || null, published: article.published },
    note: lines.filter(Boolean).join('\n'),
    items: acts.map((a) => ({
      question_id: a.question_id,
      decider_id: a.person_id,
      kind: a.kind,
      occurred_on: a.occurred_on,
      quote: a.quote,
      passage: a.passage,
      reading: a.position,
      weight: a.weight,
      note: `Model's reason: ${a.reason}\nDate: ${a.date_basis}`,
      context: a.context,
    })),
    mentions: mentions.map((m) => ({ decider_id: m.person_id, words: m.words })),
  }
}
