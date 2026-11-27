import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { getServerByName } from 'partyserver'
import { z } from 'zod'
import { displayNameSchema, proposalInputSchema, type Person, type Question } from '../shared/schema.ts'
import { STANDINGS } from '../src/lib/position.ts'
import { TIER_LABEL } from '../src/lib/reviewers.ts'
import type { ReviewerTier } from '../shared/standing.ts'
import { isHeld, type Contender, type RecordEntry, type Tracker as TrackerView } from '../src/lib/build-tracker.ts'
import { auth, KeyRefused, signedInPerson } from './auth.ts'
import { currentTracker } from './record.ts'
import type { Tracker } from './tracker.ts'

// What a client reads before it calls any tool.
const INSTRUCTIONS = `Sporelight tracks where the people in a body (a legislature, a council) stand on open questions, from dated acts: things they said, commitments they made, and uses of their office.

Read with list_questions, find_deciders, get_positions and get_record. A decider is someone a question is put to, such as a member of a legislature. They return everything on the record, including readings an editor has not checked yet; each record entry says whether one has.

Send evidence with submit_evidence. It counts at once as your reading, and an editor then checks it against its source.

Sending evidence needs an account, as it does for anyone on the site. Call sign_up once with the name to show beside what you send. It returns an API key, shown only then. Send it in the x-api-key header on every request after; whoami says who the key belongs to. Reading needs no account.`

const shape = proposalInputSchema.shape
const evidenceInput = z.object({
  question_id: shape.question_id.describe('The question this act bears on: an id from list_questions, either a question or one of its sub-questions.'),
  decider_id: shape.decider_id.describe('The person who did or said it: an id from find_deciders or get_positions.'),
  kind: shape.kind.describe('says: words in any medium. commits: a formal, public, revocable commitment such as cosponsoring or signing a letter. does: using the office itself, such as voting.'),
  reading: shape.reading.describe('Which way the act points on the question. lean_support is probable support that the words leave uncertain.'),
  quote: shape.quote.describe('The person’s exact words, or for a commitment or a vote, the source’s sentence that reports it.'),
  source_url: shape.source_url.describe('Where an editor can read it: the article, record or post.'),
  source_title: shape.source_title.unwrap().optional().describe('The outlet and headline.'),
  occurred_on: shape.occurred_on.unwrap().optional().describe('The day it happened, as YYYY-MM-DD, if the source says.'),
  submitter_note: shape.submitter_note.unwrap().optional().describe('Anything a reviewer should know. Only signed-in people read it, not the public.'),
})

export const FIND_LIMIT = 25

const READING_FROM: Record<ReviewerTier, string> = { editor: 'editors', person: 'members', agent: 'agents' }

const today = () => new Date().toISOString().slice(0, 10)
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }], structuredContent: value as Record<string, unknown> })
const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

function serverFor(env: Env, req: Request) {
  const origin = new URL(req.url).origin
  const tracker = () => currentTracker(env.DB, today())
  const findQuestion = (t: TrackerView, idOrSlug: string) => t.questionById.get(idOrSlug) ?? t.questionBySlug.get(idOrSlug)
  const questionPage = (t: TrackerView, q: Question) => `${origin}/q/${t.rootOf(q).slug}`
  const personPage = (t: TrackerView, q: Question, slug: string) => `${origin}/q/${t.rootOf(q).slug}/${slug}`

  // Who sent this request: a person or an agent with a key in x-api-key, or
  // nobody. A key Better Auth refuses comes back as the reason, for the agent.
  let sender: Promise<{ person: Person | null } | { refused: string }> | undefined
  const whoSent = () =>
    (sender ??= signedInPerson(req, env).then(
      (person) => ({ person }),
      (e) => {
        if (e instanceof KeyRefused) return { refused: e.message }
        throw e
      },
    ))
  const keyGiven = req.headers.has('x-api-key')
  const tooMany = async () => !(await env.POST_LIMITER.limit({ key: req.headers.get('cf-connecting-ip') ?? 'unknown' })).success

  const server = new McpServer({ name: 'sporelight', version: '1.0.0' }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'list_questions',
    {
      description: 'The open questions, each with the bodies it is put to and its open sub-questions (measures and asks). Evidence can be sent on a question or a sub-question.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const t = await tracker()
      const brief = (q: Question) => ({ id: q.id, slug: q.slug, title: q.title, short_title: q.short_title, kind: q.kind, description: q.description })
      const questions = t.questions
        .filter((q) => !q.parent_id && q.archived_at === null && t.isOpen(q))
        .map((q) => ({
          ...brief(q),
          bodies: t.bodiesOf(q).map((b) => ({ slug: b.slug, name: b.name })),
          sub_questions: t.subQuestionsOf(q.id).filter(t.isOpen).map(brief),
          url: questionPage(t, q),
        }))
      return json({ questions })
    },
  )

  server.registerTool(
    'find_deciders',
    {
      description:
        'Decision-makers whose name contains the given text: the people questions are put to, not the site’s readers. Each comes with their claims on seats today; certainty is certain or likely for a holder, possible for someone who may yet hold the seat. Returns at most 25, and says how many more matched.',
      inputSchema: z.object({ name: z.string().trim().min(2).describe('Part of a name, such as a surname.') }),
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      const t = await tracker()
      const wanted = name.toLowerCase()
      const matches = t.deciders.filter((d) => d.name.toLowerCase().includes(wanted))
      const deciders = matches.slice(0, FIND_LIMIT).map((d) => ({
        id: d.id,
        slug: d.slug,
        name: d.name,
        seats: (t.rolesByDecider.get(d.id) ?? []).flatMap((role) => {
          const seat = t.seatById.get(role.seat_id)
          const body = seat && t.bodyById.get(seat.body_id)
          return seat && body ? [{ body: body.name, seat: seat.label, affiliation: role.affiliation, certainty: role.certainty }] : []
        }),
      }))
      return json({ deciders, more: matches.length - deciders.length })
    },
  )

  server.registerTool(
    'get_positions',
    {
      description: 'Where each person a question is put to stands today, worked out from their record the way the question’s page shows it.',
      inputSchema: z.object({
        question: z.string().describe('A question id or slug from list_questions.'),
        body: z.string().optional().describe('Only the people in this body, by its slug from list_questions.'),
        standing: z.enum(STANDINGS).optional().describe('Only the people who stand here. unknown is everyone with nothing on record.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ question: wanted, body: bodySlug, standing }) => {
      const t = await tracker()
      const q = findQuestion(t, wanted)
      if (!q) return refusal(`No question "${wanted}". list_questions gives the ids.`)
      const row = (c: Contender, seat: string | null, body: string | null) => ({
        decider_id: c.decider.id,
        name: c.decider.name,
        body,
        seat,
        affiliation: c.role.affiliation,
        standing: c.standing,
        // Differs from standing only where editors set the position by hand.
        from_record: c.calculated,
        set_by_editors: c.set ? { position: c.set.position, reason: c.set.reason } : null,
        footing: c.footing,
        acts_on_record: c.record.length,
        url: personPage(t, q, c.decider.slug),
      })
      const bodies = t.bodiesOf(q).filter((b) => !bodySlug || b.slug === bodySlug)
      if (!bodies.length) return refusal(`"${q.title}" is not put to a body "${bodySlug}".`)
      const everyone = t.isAsk(q)
        ? t.peopleOf(q).flatMap((k) => (bodies.some((b) => b.id === k.seat.body_id) ? [row(k.contender, k.roleLabel ?? k.seat.label, t.bodyById.get(k.seat.body_id)?.name ?? null)] : []))
        : bodies.flatMap((b) => t.board(q, b.id).filter(isHeld).map((s) => row(s.incumbent, s.seat.label, b.name)))
      const people = everyone.filter((p) => !standing || p.standing === standing)
      return json({ question: { id: q.id, title: q.title, kind: q.kind, url: questionPage(t, q) }, people })
    },
  )

  server.registerTool(
    'get_record',
    {
      description:
        'The acts behind one person’s position on one question, newest first, with the sources that report each. `checked` is false for a reading only readers or agents have given. `reading_from` is the group whose reviews the reading comes from: editors count first, then signed-in members, then agents such as the news reader. `reviews` lists every review of the act on the question, those that count first; `confirms` is the id of the review one was made by confirming, and `not_counted_because` is `outranked` (a higher group has reviewed it) or `said_nothing` (it says the act says nothing there while others in its group gave a reading).',
      inputSchema: z.object({
        question: z.string().describe('A question id or slug.'),
        person: z.string().describe('A decider’s id or slug from find_deciders or get_positions.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ question: wantedQuestion, person: wantedPerson }) => {
      const t = await tracker()
      const q = findQuestion(t, wantedQuestion)
      const d = t.deciderById.get(wantedPerson) ?? t.deciderBySlug.get(wantedPerson)
      if (!q) return refusal(`No question "${wantedQuestion}".`)
      if (!d) return refusal(`No person "${wantedPerson}".`)
      const people = new Map(t.people.map((p) => [p.id, p]))
      const reviewers = (e: RecordEntry) => {
        const of = t.reviewersOf(e.act.id, e.reading.question_id)
        if (!of) return { reading_from: null, reviews: [] }
        return {
          reading_from: READING_FROM[of.from],
          reviews: of.rows.map((row) => {
            const person = people.get(row.review.reviewer_id)
            return {
              id: row.review.id,
              reviewer: person?.display_name ?? null,
              reviewer_kind: person ? TIER_LABEL[row.tier] : null,
              position: row.position,
              weight: row.weight,
              given_on_sub_question: row.via?.title ?? null,
              confirms: row.confirms?.id ?? null,
              counts: row.notCounted === null,
              not_counted_because: row.notCounted?.why ?? null,
            }
          }),
        }
      }
      const entry = (e: RecordEntry) => ({
        kind: e.act.kind,
        occurred_on: e.act.occurred_on,
        words: e.act.body,
        reading: e.reading.position,
        weight: e.reading.weight,
        via_sub_question: e.via?.title ?? null,
        checked: e.checked,
        ...reviewers(e),
        no_longer_holds: e.lapse,
        sources: e.reports.map((r) => ({ url: r.source.url, title: r.source.title, archived: r.source.archive_url })),
      })
      const listing = t.listingFor(q, d.id)
      return json({
        question: q.title,
        person: d.name,
        standing: listing.standing,
        record: t.recordFor(q, d.id).map(entry),
        url: personPage(t, q, d.slug),
      })
    },
  )

  server.registerTool(
    'submit_evidence',
    {
      description:
        'Put forward one act by one person, read on one question, for an editor to check against its source. Needs the key sign_up gave, in x-api-key. It counts on the record at once as the agent’s reading, marked as not checked, and an editor checks it against its source. A source already sent with the same person and question is not queued twice.',
      inputSchema: evidenceInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ source_url, source_title, submitter_note, occurred_on, ...item }) => {
      if (await tooMany()) return refusal('That is a lot of posts in a short time. Give it a minute.')
      const sent = await whoSent()
      if ('refused' in sent) return refusal(sent.refused)
      const { person } = sent
      if (!person) return refusal('Sign up to send evidence: call sign_up, then send the key it returns in the x-api-key header.')
      const room = await getServerByName<Env, Tracker>(env.Tracker, 'main')
      const result = await room.propose(
        { source: { url: source_url, title: source_title ?? null }, note: submitter_note ?? null, items: [{ ...item, occurred_on: occurred_on ?? null }] },
        'reader',
        person.id,
      )
      if (!result.ok) return refusal(result.error)
      return json({
        queued: result.queued > 0,
        duplicate: result.queued === 0,
        proposal_id: result.proposal_id,
        sent_as: { id: person.id, name: person.display_name },
        url: result.proposal_id ? `${origin}/news?proposal=${result.proposal_id}` : null,
      })
    },
  )

  server.registerTool(
    'sign_up',
    {
      description:
        'Make an account for this agent, under the name to show beside what it sends. Returns an API key, shown only this once: send it in the x-api-key header on every request after. An agent is listed as an agent wherever its name is shown.',
      inputSchema: z.object({ name: displayNameSchema.describe('The name to show, such as "Harbor Watch monitor".') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name }) => {
      if (keyGiven) return refusal('This request already carries a key in x-api-key. whoami says whose it is.')
      if (await tooMany()) return refusal('That is a lot of sign-ups in a short time. Give it a minute.')
      const betterAuth = auth(env)
      // The agent gets an account with no email address and makes its own key with
      // that session, as a browser would; then the session is ended, so only the
      // key is left.
      // MCP clients send no Origin, which Better Auth's CSRF check refuses. These
      // calls are the Worker's own, so they carry the site's origin.
      const authRequest = new Request(req.url, { method: 'POST', headers: { origin, 'cf-connecting-ip': req.headers.get('cf-connecting-ip') ?? '' } })
      const signIn = await betterAuth.api.signInAnonymous({ headers: authRequest.headers, request: authRequest, asResponse: true })
      if (!signIn.ok) return refusal(`Could not sign up (${signIn.status}): ${(await signIn.text()).slice(0, 200)}`)
      const { user } = (await signIn.json()) as { user: { id: string } }
      const asAgent = new Headers(authRequest.headers)
      asAgent.set('cookie', signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '))
      await (await getServerByName<Env, Tracker>(env.Tracker, 'main')).setDisplayName(user.id, name)
      const created = await betterAuth.api.createApiKey({ body: { name: 'mcp' }, headers: asAgent, request: authRequest, asResponse: false })
      await betterAuth.api.signOut({ headers: asAgent, request: authRequest })
      return json({
        id: user.id,
        name,
        kind: 'agent',
        api_key: created.key,
        header: 'x-api-key',
        note: 'Keep the key private. It is not shown again, and anything sent with it is sent under this name.',
      })
    },
  )

  server.registerTool(
    'whoami',
    {
      description: 'Who the key in x-api-key belongs to, or that the request carries none.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const sent = await whoSent()
      if ('refused' in sent) return refusal(sent.refused)
      const { person } = sent
      return json(person ? { signed_in: true, id: person.id, name: person.display_name, kind: person.kind } : { signed_in: false })
    },
  )

  return server
}

export function handleMcp(req: Request, env: Env): Promise<Response> {
  return createMcpHandler(() => serverFor(env, req)).fetch(req)
}
