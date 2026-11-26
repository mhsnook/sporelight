import { PartyDbServer, D1Adapter, getTokenFromRequest, type PersistenceAdapter } from 'party-db/server'
import {
  EDITORS_ID,
  NEWS_READER_ID,
  allCollections,
  sourceUrl,
  pairId,
  replacesPublishedOn,
  usualWeight,
  type Act,
  type Comment,
  type CommentInput,
  type FoundPublishedOn,
  type Person,
  type Proposal,
  type ProposalDraft,
  type ProposalContext,
  type ProposalItem,
  type ProposalMention,
  type ProposalNote,
  type Report,
  type Review,
  type Source,
} from '../shared/schema.ts'
import { isEditorToken } from './editor.ts'
import { alreadyProposed, type Proposed } from './leads.ts'

const MAX_PENDING = 500
const MAX_NOTE_CHARS = 4000

// `queued` counts the items that were new. Zero means something already proposed from this source stood in the way of every one.
// `undated` says the source still has no date as sure as the page's own.
export type SubmitResult = { ok: true; queued: number; proposal_id: string | null; source_id: string; undated: boolean } | { ok: false; status: number; error: string }

// The write that gives a source on file a found date, if that date outranks the one it has.
const datingOf = (known: Pick<Source, 'id' | 'published_on_from'>, published: FoundPublishedOn) =>
  replacesPublishedOn(published.from, known) ? [{ channel: 'sources', ops: [{ type: 'update' as const, value: { id: known.id, published_on: published.on, published_on_from: published.from } }] }] : []

export class Tracker extends PartyDbServer<Env> {
  collections = [...allCollections]

  auth = async (req: Request) => {
    const token = getTokenFromRequest(req)
    return token && (await isEditorToken(token, this.env)) ? { claims: { sub: 'editor' } } : null
  }

  // party-db replays its change log to a reconnecting client, and sends entries
  // for a table this room no longer serves to everyone, since no access rule is
  // left to filter them. A table dropped by a migration (submissions held
  // editor-only notes) would be replayed to anonymous readers, so its entries
  // are cleared before the room takes any connection.
  async onStart() {
    await super.onStart()
    const served = this.collections.map((c) => c.name)
    await this.env.DB.prepare(`DELETE FROM _oplog WHERE channel NOT IN (${served.map(() => '?').join(', ')})`)
      .bind(...served)
      .run()
  }

  protected createAdapter(): PersistenceAdapter {
    return new D1Adapter(this.env.DB, this.collections, { oplogRetention: this.oplogRetention })
  }

  // What comes in enters here rather than through CRUD so readers never need
  // write access to the room. Each item with a reading is written as an act,
  // its report in the source and the sender's review of it; a search lead,
  // which names a person and no act, only as an item.
  async propose(draft: ProposalDraft, origin: Proposal['origin'], submittedBy: string = NEWS_READER_ID, isRetry = false): Promise<SubmitResult> {
    const db = this.env.DB
    const pending = await db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'`).first<{ n: number }>()
    if ((pending?.n ?? 0) >= MAX_PENDING) {
      return { ok: false, status: 429, error: 'The review queue is full right now. Please try again later.' }
    }

    const url = sourceUrl(draft.source.url)
    const known = await this.sourceAt(url)
    const published = draft.source.published ?? null
    const dated = known && published ? datingOf(known, published) : []
    const undated = replacesPublishedOn('page', { published_on_from: known && !dated.length ? known.published_on_from : (published?.from ?? null) })
    let items = draft.items
    if (known) {
      // Earlier items from this source, with their words and whether the editors said their act says nothing on the question.
      const seen = await db
        .prepare(
          `SELECT i.question_id, i.decider_id, COALESCE(a.body, i.excerpt, '') AS quote,
             EXISTS (SELECT 1 FROM reviews r WHERE r.act_id = i.act_id AND r.question_id = i.question_id AND r.reviewer_id = ?2 AND r.position IS NULL) AS turnedDown
           FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id LEFT JOIN acts a ON a.id = i.act_id WHERE p.source_id = ?1`,
        )
        .bind(known.id, EDITORS_ID)
        .all<Omit<Proposed, 'turnedDown'> & { turnedDown: number }>()
      items = items.filter((i) => !alreadyProposed(seen.results.map((e) => ({ ...e, turnedDown: e.turnedDown === 1 })), i, origin))
    }
    if (items.length === 0) return { ok: true, queued: 0, proposal_id: null, source_id: await this.catalogue(draft.source), undated }

    const now = new Date().toISOString()
    const source: Source = {
      id: known?.id ?? crypto.randomUUID(),
      url,
      title: draft.source.title,
      publisher: null,
      published_on: published?.on ?? null,
      published_on_from: published?.from ?? null,
      kind: null,
      archive_url: null,
      stored_copy: null,
      created_at: now,
    }
    const proposal: Proposal = { id: crypto.randomUUID(), source_id: source.id, origin, submitted_by: submittedBy, status: 'pending', unread: draft.unread ?? null, created_at: now, reviewed_at: null }
    const acts: Act[] = []
    const reports: Report[] = []
    const reviews: Review[] = []
    const rows: ProposalItem[] = items.map((item, sort) => {
      const row: ProposalItem = { id: crypto.randomUUID(), proposal_id: proposal.id, sort, decider_id: item.decider_id, question_id: item.question_id, act_id: null, excerpt: null }
      if (item.reading === null) return { ...row, excerpt: item.quote }
      const act: Act = { id: crypto.randomUUID(), decider_id: item.decider_id, kind: item.kind, occurred_on: item.occurred_on, body: item.quote, primary_source_id: null, withdrawn_on: null, created_at: now }
      acts.push(act)
      reports.push({ id: crypto.randomUUID(), source_id: source.id, act_id: act.id, excerpt: null, passage: item.passage ?? null, created_at: now })
      const weight = item.weight ?? usualWeight(item.kind)
      reviews.push({ id: crypto.randomUUID(), reviewer_id: submittedBy, act_id: act.id, question_id: item.question_id, position: item.reading, weight, based_on: null, created_at: now, updated_at: now })
      return { ...row, act_id: act.id }
    })
    const contexts: ProposalContext[] = items.flatMap((item, i) =>
      item.context ? [{ id: rows[i].id, proposal_id: proposal.id, proposal_item_id: rows[i].id, before: item.context.before, after: item.context.after }] : [],
    )
    const mentions: ProposalMention[] = (draft.mentions ?? []).map((m) => ({ id: crypto.randomUUID(), proposal_id: proposal.id, decider_id: m.decider_id, words: m.words }))
    const noteRow = (body: string, itemId: string | null): ProposalNote => ({
      id: crypto.randomUUID(),
      proposal_id: proposal.id,
      proposal_item_id: itemId,
      kind: 'submitter',
      body: body.slice(0, MAX_NOTE_CHARS),
      created_at: now,
    })
    const notes = [
      ...(draft.note ? [noteRow(draft.note, null)] : []),
      ...items.flatMap((item, i) => (item.note ? [noteRow(item.note, rows[i].id)] : [])),
    ]
    try {
      // In this order: each batch may only point at rows an earlier one wrote.
      await this.commit([
        ...(known ? dated : [{ channel: 'sources', ops: [{ type: 'insert' as const, value: source }] }]),
        ...(acts.length
          ? [
              { channel: 'acts', ops: acts.map((value) => ({ type: 'insert' as const, value })) },
              { channel: 'reports', ops: reports.map((value) => ({ type: 'insert' as const, value })) },
              { channel: 'reviews', ops: reviews.map((value) => ({ type: 'insert' as const, value })) },
            ]
          : []),
        { channel: 'proposals', ops: [{ type: 'insert', value: proposal }] },
        { channel: 'proposal_items', ops: rows.map((value) => ({ type: 'insert' as const, value })) },
        ...(notes.length ? [{ channel: 'proposal_notes', ops: notes.map((value) => ({ type: 'insert' as const, value })) }] : []),
        ...(contexts.length ? [{ channel: 'proposal_contexts', ops: contexts.map((value) => ({ type: 'insert' as const, value })) }] : []),
        ...(mentions.length ? [{ channel: 'proposal_mentions', ops: mentions.map((value) => ({ type: 'insert' as const, value })) }] : []),
      ])
      return { ok: true, queued: rows.length, proposal_id: proposal.id, source_id: source.id, undated }
    } catch (e) {
      const message = String(e)
      // Someone else added this URL between the lookup and the commit. The
      // second pass finds their source.
      if (message.includes('UNIQUE') && !isRetry) return this.propose(draft, origin, submittedBy, true)
      if (message.includes('FOREIGN KEY')) return { ok: false, status: 400, error: 'Unknown question or decider.' }
      throw e
    }
  }

  // Goes through the sync log so open browsers show the archived copy. An
  // address already on the source, such as one an editor pasted, is kept and
  // returned instead.
  async setArchiveUrl(sourceId: string, archiveUrl: string): Promise<string | null> {
    const row = await this.env.DB.prepare(`SELECT archive_url FROM sources WHERE id = ?`).bind(sourceId).first<{ archive_url: string | null }>()
    if (!row || row.archive_url) return row?.archive_url ?? null
    await this.commit([{ channel: 'sources', ops: [{ type: 'update', value: { id: sourceId, archive_url: archiveUrl } }] }])
    return archiveUrl
  }

  // An article read with nothing to queue is still kept as a source, so it is
  // known what was read and when it was published. Returns the source's id.
  async catalogue(found: ProposalDraft['source'], isRetry = false): Promise<string> {
    const url = sourceUrl(found.url)
    const published = found.published ?? null
    const known = await this.sourceAt(url)
    if (known) {
      const dated = published ? datingOf(known, published) : []
      if (dated.length) await this.commit(dated)
      return known.id
    }
    const source: Source = {
      id: crypto.randomUUID(),
      url,
      title: found.title,
      publisher: null,
      published_on: published?.on ?? null,
      published_on_from: published?.from ?? null,
      kind: null,
      archive_url: null,
      stored_copy: null,
      created_at: new Date().toISOString(),
    }
    try {
      await this.commit([{ channel: 'sources', ops: [{ type: 'insert', value: source }] }])
      return source.id
    } catch (e) {
      // Someone else added this URL between the lookup and the commit.
      if (String(e).includes('UNIQUE') && !isRetry) return this.catalogue(found, true)
      throw e
    }
  }

  // For a page a reader sent in, once its date has been read.
  async notePublishedOn(url: string, published: FoundPublishedOn) {
    const known = await this.sourceAt(sourceUrl(url))
    const dated = known ? datingOf(known, published) : []
    if (dated.length) await this.commit(dated)
  }

  private sourceAt(url: string) {
    return this.env.DB.prepare(`SELECT id, published_on_from FROM sources WHERE url = ?`).bind(url).first<Pick<Source, 'id' | 'published_on_from'>>()
  }

  // Two requests from one new session can both find no row and both add it.
  async addPerson(id: string, createdAt: string, kind: Person['kind']) {
    const person: Person = { id, kind, display_name: null, created_at: createdAt }
    try {
      await this.commit([{ channel: 'people', ops: [{ type: 'insert', value: person }] }])
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e
    }
  }

  async setDisplayName(personId: string, displayName: string) {
    await this.commit([{ channel: 'people', ops: [{ type: 'update', value: { id: personId, display_name: displayName } }] }])
  }

  // A comment is shown under its person's display_name. Someone without one
  // names themselves with their first comment, in the same write.
  async comment(input: CommentInput, person: Person): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const naming = person.display_name === null ? input.display_name : undefined
    if (person.display_name === null && !naming) return { ok: false, status: 400, error: 'Choose a display name before you comment.' }
    const known = await this.env.DB.prepare(
      `SELECT 1 FROM questions q, deciders d WHERE q.id = ? AND d.id = ?`,
    )
      .bind(input.question_id, input.decider_id)
      .first()
    if (!known) return { ok: false, status: 400, error: 'Unknown question or decider.' }
    const row: Comment = {
      id: crypto.randomUUID(),
      thread_id: pairId(input.question_id, input.decider_id),
      person_id: person.id,
      body: input.body,
      created_at: new Date().toISOString(),
    }
    await this.commit([
      ...(naming ? [{ channel: 'people', ops: [{ type: 'update' as const, value: { id: person.id, display_name: naming } }] }] : []),
      { channel: 'comments', ops: [{ type: 'insert', value: row }] },
    ])
    return { ok: true }
  }
}
