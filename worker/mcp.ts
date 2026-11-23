import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { getServerByName } from 'partyserver'
import { z } from 'zod'
import { proposalInputSchema, type Question } from '../shared/schema.ts'
import { STANDINGS } from '../src/lib/position.ts'
import { buildTracker, isHeld, type Contender, type RecordEntry, type Tracker as TrackerView } from '../src/lib/build-tracker.ts'
import { identifyPartner, orgIdSchema, partnerSecretSchema } from './partners.ts'
import { loadRecord } from './record.ts'
import type { Tracker } from './tracker.ts'

// What a client reads before it calls any tool.
const INSTRUCTIONS = `Sporelight tracks where the people in a body (a legislature, a council) stand on open questions, from dated acts: things they said, commitments they made, and uses of their office.

Read with list_questions, find_people, get_positions and get_record. Everything they return is published: an editor has checked it against its source.

Send evidence with submit_evidence. It is not published: it waits for an editor, who reads it against its source. Name your organisation with an org id and a secret you choose. The first submission under an org id claims it for that secret, and later submissions under it must carry the same secret.`

const shape = proposalInputSchema.shape
const evidenceInput = z.object({
  org: orgIdSchema.describe('Your organisation’s id, such as "harbor-watch". The first submission under an id claims it.'),
  secret: partnerSecretSchema.describe('A secret you choose the first time and send every time after. Keep it private.'),
  question_id: shape.question_id.describe('The question this act bears on: an id from list_questions, either a question or one of its sub-questions.'),
  decider_id: shape.decider_id.describe('The person who did or said it: an id from find_people or get_positions.'),
  kind: shape.kind.describe('says: words in any medium. commits: a formal, public, revocable commitment such as cosponsoring or signing a letter. does: using the office itself, such as voting.'),
  reading: shape.reading.describe('Which way the act points on the question. lean_support is probable support that the words leave uncertain.'),
  quote: shape.quote.describe('The person’s exact words, or for a commitment or a vote, the source’s sentence that reports it.'),
  source_url: shape.source_url.describe('Where an editor can read it: the article, record or post.'),
  source_title: shape.source_title.unwrap().optional().describe('The outlet and headline.'),
  occurred_on: shape.occurred_on.unwrap().optional().describe('The day it happened, as YYYY-MM-DD, if the source says.'),
  submitter_note: shape.submitter_note.unwrap().optional().describe('Anything the editor should know. Only editors read it.'),
})

const today = () => new Date().toISOString().slice(0, 10)
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }], structuredContent: value as Record<string, unknown> })
const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

function serverFor(env: Env, req: Request) {
  const origin = new URL(req.url).origin
  // The record is read once per request, and only by a tool that needs it.
  let view: Promise<TrackerView> | undefined
  const tracker = () => (view ??= loadRecord(env.DB).then((data) => buildTracker(data, today())))
  const findQuestion = (t: TrackerView, idOrSlug: string) => t.questionById.get(idOrSlug) ?? t.questionBySlug.get(idOrSlug)
  const questionPage = (t: TrackerView, q: Question) => `${origin}/q/${t.rootOf(q).slug}`
  const personPage = (t: TrackerView, q: Question, slug: string) => `${origin}/q/${t.rootOf(q).slug}/${slug}`

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
        .filter((q) => !q.parent_id && t.isOpen(q))
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
    'find_people',
    {
      description: 'People whose name contains the given text, with their claims on seats today. certainty is certain or likely for a holder, possible for someone who may yet hold the seat.',
      inputSchema: z.object({ name: z.string().trim().min(2).describe('Part of a name, such as a surname.') }),
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      const t = await tracker()
      const wanted = name.toLowerCase()
      const people = t.deciders
        .filter((d) => d.name.toLowerCase().includes(wanted))
        .slice(0, 25)
        .map((d) => ({
          id: d.id,
          slug: d.slug,
          name: d.name,
          seats: (t.rolesByDecider.get(d.id) ?? []).flatMap((role) => {
            const seat = t.seatById.get(role.seat_id)
            const body = seat && t.bodyById.get(seat.body_id)
            return seat && body ? [{ body: body.name, seat: seat.label, affiliation: role.affiliation, certainty: role.certainty }] : []
          }),
        }))
      return json({ people })
    },
  )

  server.registerTool(
    'get_positions',
    {
      description: 'Where each person a question is put to stands today, worked out from their published record the way the question’s page shows it.',
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
      description: 'The published acts behind one person’s position on one question, newest first, with the sources that report each.',
      inputSchema: z.object({
        question: z.string().describe('A question id or slug.'),
        person: z.string().describe('A person’s id or slug from find_people or get_positions.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ question: wantedQuestion, person: wantedPerson }) => {
      const t = await tracker()
      const q = findQuestion(t, wantedQuestion)
      const d = t.deciderById.get(wantedPerson) ?? t.deciderBySlug.get(wantedPerson)
      if (!q) return refusal(`No question "${wantedQuestion}".`)
      if (!d) return refusal(`No person "${wantedPerson}".`)
      const entry = (e: RecordEntry) => ({
        kind: e.act.kind,
        occurred_on: e.act.occurred_on,
        words: e.act.body,
        reading: e.reading.position,
        weight: e.reading.weight,
        via_sub_question: e.via?.title ?? null,
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
        'Put forward one act by one person, read on one question, for an editor to check against its source. Nothing is published until an editor accepts it. A source already sent with the same person and question is not queued twice.',
      inputSchema: evidenceInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ org, secret, source_url, source_title, submitter_note, occurred_on, ...item }) => {
      // The same limit per address as the public forms, checked before the secret, which is slow to hash on purpose.
      const address = req.headers.get('cf-connecting-ip') ?? 'unknown'
      if (!(await env.POST_LIMITER.limit({ key: address })).success) return refusal('That is a lot of posts in a short time. Give it a minute.')
      const partner = await identifyPartner(env.DB, org, secret)
      if (!partner) return refusal(`The org id "${org}" is taken, and that secret is not the one it was claimed with.`)
      const room = await getServerByName<Env, Tracker>(env.Tracker, 'main')
      const result = await room.propose(
        {
          source: { url: source_url, title: source_title ?? null },
          note: [`Sent by ${partner.org} through the MCP endpoint.`, submitter_note].filter(Boolean).join('\n\n'),
          items: [{ ...item, occurred_on: occurred_on ?? null }],
        },
        'partner',
        partner.id,
      )
      if (!result.ok) return refusal(result.error)
      return json({
        queued: result.queued > 0,
        duplicate: result.queued === 0,
        proposal_id: result.proposal_id,
        org_claimed_now: partner.claimed,
        url: result.proposal_id ? `${origin}/latest?proposal=${result.proposal_id}` : null,
      })
    },
  )

  return server
}

export function handleMcp(req: Request, env: Env): Promise<Response> {
  return createMcpHandler(() => serverFor(env, req)).fetch(req)
}
