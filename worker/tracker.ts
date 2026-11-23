import { PartyDbServer, D1Adapter, getTokenFromRequest, type PersistenceAdapter } from 'party-db/server'
import {
  allCollections,
  sourceUrl,
  pairId,
  replacesPublishedOn,
  usualWeight,
  type Comment,
  type CommentInput,
  type Person,
  type Proposal,
  type ProposalDraft,
  type ProposalContext,
  type ProposalItem,
  type ProposalMention,
  type ProposalNote,
  type Source,
} from '../shared/schema.ts'
import { isEditorToken } from './editor.ts'
import { alreadyProposed } from './leads.ts'

const MAX_PENDING = 500
const MAX_NOTE_CHARS = 4000

// `queued` counts the items that were new. Zero means something already proposed from this source stood in the way of every one.
export type SubmitResult = { ok: true; queued: number; proposal_id: string | null } | { ok: false; status: number; error: string }

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

  // Unreviewed proposals enter here rather than through CRUD so anonymous
  // readers never need write access to the room.
  async propose(draft: ProposalDraft, origin: Proposal['origin'], submittedBy: string | null = null, isRetry = false): Promise<SubmitResult> {
    const db = this.env.DB
    const pending = await db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'`).first<{ n: number }>()
    if ((pending?.n ?? 0) >= MAX_PENDING) {
      return { ok: false, status: 429, error: 'The review queue is full right now. Please try again later.' }
    }

    const url = sourceUrl(draft.source.url)
    const known = await db.prepare(`SELECT id, published_on, published_on_from FROM sources WHERE url = ?`).bind(url).first<Pick<Source, 'id' | 'published_on' | 'published_on_from'>>()
    const published = draft.source.published ?? null
    const dated =
      known && published && replacesPublishedOn(published.from, known)
        ? [{ channel: 'sources', ops: [{ type: 'update' as const, value: { id: known.id, published_on: published.on, published_on_from: published.from } }] }]
        : []
    let items = draft.items
    if (known) {
      const seen = await db
        .prepare(`SELECT i.question_id, i.decider_id, i.status, i.quote FROM proposal_items i JOIN proposals p ON p.id = i.proposal_id WHERE p.source_id = ?`)
        .bind(known.id)
        .all<Pick<ProposalItem, 'question_id' | 'decider_id' | 'status' | 'quote'>>()
      items = items.filter((i) => !alreadyProposed(seen.results, i, origin))
    }
    if (items.length === 0) {
      if (dated.length) await this.commit(dated)
      return { ok: true, queued: 0, proposal_id: null }
    }

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
    const rows: ProposalItem[] = items.map(({ note: _, context: __, ...item }, sort) => ({
      ...item,
      id: crypto.randomUUID(),
      proposal_id: proposal.id,
      sort,
      act_id: crypto.randomUUID(),
      passage: item.passage ?? null,
      // A lead claims no reading, so it claims no weight.
      weight: item.reading === null ? null : (item.weight ?? usualWeight(item.kind)),
      status: 'pending',
    }))
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
        { channel: 'proposals', ops: [{ type: 'insert', value: proposal }] },
        { channel: 'proposal_items', ops: rows.map((value) => ({ type: 'insert' as const, value })) },
        ...(notes.length ? [{ channel: 'proposal_notes', ops: notes.map((value) => ({ type: 'insert' as const, value })) }] : []),
        ...(contexts.length ? [{ channel: 'proposal_contexts', ops: contexts.map((value) => ({ type: 'insert' as const, value })) }] : []),
        ...(mentions.length ? [{ channel: 'proposal_mentions', ops: mentions.map((value) => ({ type: 'insert' as const, value })) }] : []),
      ])
      return { ok: true, queued: rows.length, proposal_id: proposal.id }
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

  // For a page a reader sent in, once its date has been read.
  async notePublishedOn(url: string, publishedOn: string) {
    const row = await this.env.DB.prepare(`SELECT id, published_on, published_on_from FROM sources WHERE url = ?`)
      .bind(sourceUrl(url))
      .first<Pick<Source, 'id' | 'published_on' | 'published_on_from'>>()
    if (!row || !replacesPublishedOn('page', row)) return
    await this.commit([{ channel: 'sources', ops: [{ type: 'update', value: { id: row.id, published_on: publishedOn, published_on_from: 'page' } }] }])
  }

  async addPerson(id: string, createdAt: string) {
    const person: Person = { id, display_name: null, muted_at: null, created_at: createdAt }
    await this.commit([{ channel: 'people', ops: [{ type: 'insert', value: person }] }])
  }

  async setDisplayName(personId: string, displayName: string) {
    await this.commit([{ channel: 'people', ops: [{ type: 'update', value: { id: personId, display_name: displayName } }] }])
  }

  // A signed-in person's comment goes under the name they chose, and the first
  // name they post under becomes that name.
  async comment(input: CommentInput, person: Person | null = null): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const known = await this.env.DB.prepare(
      `SELECT 1 FROM questions q, deciders d WHERE q.id = ? AND d.id = ?`,
    )
      .bind(input.question_id, input.decider_id)
      .first()
    if (!known) return { ok: false, status: 400, error: 'Unknown question or decider.' }
    const row: Comment = {
      id: crypto.randomUUID(),
      thread_id: pairId(input.question_id, input.decider_id),
      author_name: person?.display_name ?? input.author_name,
      person_id: person?.id ?? null,
      body: input.body,
      created_at: new Date().toISOString(),
    }
    const naming = person && person.display_name === null ? [{ channel: 'people', ops: [{ type: 'update' as const, value: { id: person.id, display_name: input.author_name } }] }] : []
    await this.commit([...naming, { channel: 'comments', ops: [{ type: 'insert', value: row }] }])
    return { ok: true }
  }
}
