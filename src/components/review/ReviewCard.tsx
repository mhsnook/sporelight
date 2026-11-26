import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { SOURCE_KINDS, isUnreadLead, type Proposal, type ProposalMention, type ProposalNote, type PublishedOnFrom, type Source } from '../../../shared/schema.ts'
import { useTracker } from '../../lib/tracker.tsx'
import { addedEntry, decisionStandings, missingFrom, outlook, presumedEntry, type EntryDraft } from '../../lib/review-form.ts'
import { KIND_NOUN, UNREAD_TEXT, timeAgo, formatDate, hostOf, publishedLine, sourceLabel, standingLabel } from '../../lib/position.ts'
import { Token } from '../bits.tsx'
import { ArchivedCopy } from '../RecordItem.tsx'
import { ArchiveControls } from '../ArchiveControls.tsx'
import { ReviewEntry } from './ReviewEntry.tsx'

const ORIGIN_LINE: Record<Proposal['origin'], string> = {
  reader: 'Sent in by a reader',
  news_search: 'Found by the news search',
  partner: 'Sent in by a partner',
  model: 'Read by a model',
}

const DATE_FROM: Record<PublishedOnFrom, string> = {
  page: 'from the page',
  search: 'from the search results, which may be when the page last changed',
  editor: 'set by an editor',
}

const SOURCE_KIND_LABEL: Record<(typeof SOURCE_KINDS)[number], string> = {
  article: 'Article',
  press_release: 'Press release',
  official_record: 'Official record',
  transcript: 'Transcript',
  social_post: 'Post',
}

// How the card on top of the stack is moving: resting, leaving after a
// publish, leaving after a dismissal, or about to rise from the stack.
type CardPhase = 'in' | 'publishing' | 'dismissing' | 'arriving'

const PHASE: Record<CardPhase, string> = {
  in: 'opacity-100 transition-[transform,opacity] duration-500 ease-[cubic-bezier(.2,.7,.2,1)]',
  publishing: '-translate-y-10 scale-[0.98] opacity-0 transition-[transform,opacity] duration-[450ms] ease-in',
  dismissing: '-translate-x-[90px] -rotate-3 opacity-0 transition-[transform,opacity] duration-[450ms] ease-in',
  arriving: 'translate-x-2.5 translate-y-3.5 opacity-0',
}

export const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`
const TAG = 'tag text-faint'
const SHEET = 'absolute inset-0 rounded-[22px] border-2 border-ink bg-surface'

export function ReviewCard({
  proposal,
  source,
  notes,
  mentions,
  drafts,
  setDrafts,
  reviewNote,
  setReviewNote,
  publishedOn,
  setPublishedOn,
  behind,
  readOnly,
  leaving,
  error,
  onPublish,
  onDismissAll,
}: {
  proposal: Proposal
  source: Source
  notes: ProposalNote[]
  mentions: ProposalMention[]
  drafts: EntryDraft[]
  setDrafts: (update: (drafts: EntryDraft[]) => EntryDraft[]) => void
  reviewNote: string
  setReviewNote: (note: string) => void
  // The source's publish date as the editor set it on this card; undefined until they do.
  publishedOn: string | null | undefined
  setPublishedOn: (day: string | null) => void
  // How many proposals wait behind this one.
  behind: number
  readOnly: boolean
  leaving: 'publishing' | 'dismissing' | null
  error: string | null
  onPublish: () => void
  onDismissAll: () => void
}) {
  const { tracker } = useTracker()
  const [arrived, setArrived] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setArrived(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  const phase: CardPhase = leaving ?? (arrived ? 'in' : 'arriving')
  const shown: Source = publishedOn === undefined ? source : { ...source, published_on: publishedOn, published_on_from: 'editor' }
  const age = timeAgo(shown.published_on)

  const patch = (key: string, changes: Partial<EntryDraft>) => setDrafts((all) => all.map((d) => (d.key === key ? { ...d, ...changes } : d)))
  const first = drafts[0]
  const firstQuestion = first && tracker.questionById.get(first.question_id)
  const root = firstQuestion && tracker.rootOf(firstQuestion)
  const sameRoot = drafts.every((d) => {
    const q = tracker.questionById.get(d.question_id)
    return q && tracker.rootOf(q).id === root?.id
  })
  const roster = useMemo(() => (root ? tracker.rosterOf(root) : []), [tracker, root?.id])

  const open = drafts.filter((d) => !d.dismissed)
  // A person's entries sit together, where their first one is.
  const firstAt = (d: EntryDraft) => drafts.findIndex((x) => x.decider_id !== null && x.decider_id === d.decider_id)
  const inOrder = drafts.map((d, i) => ({ d, at: firstAt(d) === -1 ? i : firstAt(d), i })).sort((a, b) => a.at - b.at || a.i - b.i).map(({ d }) => d)
  const dismissed = drafts.length - open.length
  const missing = open.map(missingFrom).find((m) => m !== null) ?? null
  // The first entry that sits across from a position editors set. One makes this a bigger decision than a routine review.
  const across = open
    .map((d) => {
      const question = tracker.questionById.get(d.question_id)
      return question && { draft: d, question, view: outlook(tracker, d, question, d.reading) }
    })
    .find((e) => e?.view.across)
  const acrossName = across && (tracker.deciderById.get(across.draft.decider_id ?? '')?.name ?? 'this person')
  const isReported = useMemo(() => tracker.reports.some((r) => r.source_id === source.id), [tracker, source.id])
  const isLead = isUnreadLead(proposal)
  const excerpt = isLead ? (drafts[0]?.items[0]?.excerpt ?? undefined) : undefined
  const proposalNotes = notes.filter((n) => n.kind === 'submitter' && !n.proposal_item_id)
  const itemNotes = (d: EntryDraft) => notes.filter((n) => n.kind === 'submitter' && n.proposal_item_id && d.items.some((i) => i.id === n.proposal_item_id)).map((n) => n.body)

  // Two acts by one person are two entries and one person.
  const count = (entries: EntryDraft[]) => new Set(entries.map((d) => d.decider_id ?? d.key)).size
  let publishLabel: ReactNode = open.length ? `Publish ${people(count(open))}` : 'Nothing left to publish'
  if (missing) publishLabel = `Publish needs ${missing}`
  else if (across && open.length === 1) {
    const { draft, question, view } = across
    const action = draft.decision.action
    publishLabel = `Publish, ${{ keep: 'keep', lift: 'show', set: 'set' }[action]} ${standingLabel(decisionStandings(draft, view)[action], question)}`
  }

  return (
    <div className="relative mr-2.5 mb-3.5">
      {behind > 1 && <div className={`${SHEET} translate-x-2.5 translate-y-3.5`} />}
      {behind > 0 && <div className={`${SHEET} translate-x-[5px] translate-y-[7px]`} />}
      <article
        aria-label={sourceLabel(source)}
        data-phase={phase}
        className={`relative rounded-[22px] border-ink bg-surface motion-reduce:transition-none ${across ? 'border-[3px] shadow-hard-lg' : 'border-2'} ${PHASE[phase]}`}
      >
        {across && (
          <div className="flex flex-col gap-2 rounded-t-[19px] bg-terminal p-5 text-paper">
            <span className="tag self-start rounded-full border-2 border-paper px-2.5 py-[3px]">Contradicts our recorded position</span>
            <h2 className="text-[26px] leading-[1.1] font-black">
              A new {KIND_NOUN[across.draft.kind]} {across.draft.kind === 'says' ? 'from' : 'by'} {acrossName} contradicts our recorded position
            </h2>
            <p className="text-[15px] leading-[1.45]">
              Check the source closely. Then decide below: keep our position, set a new one, or lift it and show the calculated result, {standingLabel(across.view.then?.calculated ?? 'unknown', across.question)}.
            </p>
          </div>
        )}
        <header className={`flex flex-col gap-2 border-b-2 border-ink bg-paper px-5 pt-4 pb-[18px] ${across ? '' : 'rounded-t-[20px]'}`}>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <span className="tag rounded-full border-2 border-ink bg-surface px-2.5 py-[3px]">{isReported ? 'Source on the record' : 'New source'}</span>
            <span className="tag text-muted">
              {[source.kind ? SOURCE_KIND_LABEL[source.kind] : null, hostOf(source.url)].filter(Boolean).join(' · ')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <p className="text-[17px] font-extrabold" data-testid="published">
              {publishedLine(shown)}
            </p>
            {age && (
              <span className="rounded-full border-2 border-ink bg-mixed/40 px-2.5 py-[2px] text-sm font-bold">
                {age}
              </span>
            )}
            {shown.published_on && shown.published_on_from && <span className="text-[13px] text-muted">{DATE_FROM[shown.published_on_from]}</span>}
            {!readOnly && <PublishedOnControl value={shown.published_on} edited={publishedOn !== undefined} onChange={setPublishedOn} />}
          </div>
          <h2 className="text-[21px] leading-[1.2] font-extrabold tracking-[-0.01em]">
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer" className="hover:underline">
                {sourceLabel(source)} ↗
              </a>
            ) : (
              sourceLabel(source)
            )}
          </h2>
          <p className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-sm text-muted">
            {source.url && !isLead && (
              <a href={source.url} target="_blank" rel="noreferrer" className="link font-bold text-ink">
                Read the source <span className="hidden sm:inline">[O]</span>
              </a>
            )}
            <ArchivedCopy source={source} />
            <span>
              {ORIGIN_LINE[proposal.origin]} on {formatDate(proposal.created_at)}
            </span>
          </p>
          {proposalNotes.map((n) => (
            <p key={n.id} className="text-sm whitespace-pre-line">
              {proposal.origin === 'reader' ? 'Reader’s note' : 'Note'}: {n.body}
            </p>
          ))}
          {!readOnly && <ArchiveControls source={source} />}
        </header>

        <div className="px-5">
          {isLead && (
            <>
              <div className="my-[18px] flex flex-col gap-2.5 rounded-[14px] border-2 border-dashed border-ink bg-paper p-4">
                <p className="text-[19px] font-extrabold">We could not read this article.</p>
                <p className="leading-normal">
                  {proposal.unread ? `${UNREAD_TEXT[proposal.unread]}, so` : 'The article was not read, so'} nothing on this card is filled in. Open the source, then say what each person said or did.
                </p>
                {source.url && (
                  <a href={source.url} target="_blank" rel="noreferrer" className="btn btn-primary self-start">
                    Open the source ↗ <span className="hidden sm:inline">[O]</span>
                  </a>
                )}
              </div>
              {excerpt && (
                <div className="pb-4">
                  <p className={`${TAG} mb-1.5`}>Search excerpt, not checked</p>
                  <p className="leading-[1.55] text-muted">{excerpt}</p>
                </div>
              )}
            </>
          )}

          <p className={`${TAG} flex justify-between gap-2 pt-3.5 pb-3`}>
            <span>{people(count(drafts))} {isLead ? 'named in the excerpt' : 'in this source'}</span>
            {sameRoot && root && <span>{root.short_title}</span>}
          </p>
          <fieldset disabled={readOnly} className="min-w-0">
            {inOrder.map((d, i) => (
              <ReviewEntry
                key={d.key}
                entry={d}
                onChange={(changes) => patch(d.key, changes)}
                onDismiss={(dismissed) => (d.items.length || !dismissed ? patch(d.key, { dismissed }) : setDrafts((all) => all.filter((x) => x.key !== d.key)))}
                proposal={proposal}
                source={shown}
                notes={itemNotes(d)}
                roster={roster}
                continued={i > 0 && d.decider_id !== null && inOrder[i - 1].decider_id === d.decider_id && !inOrder[i - 1].dismissed}
                readOnly={readOnly}
              />
            ))}
          </fieldset>

          {mentions.length > 0 && (
            <div className="border-t-2 border-dashed border-line pt-3 pb-3.5 text-sm text-muted">
              <p className="mb-1.5 font-bold text-ink">Named here, with nothing of their own to record</p>
              {mentions.map((m) => (
                <p key={m.id} className="my-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Token standing="unknown" className="size-3" />
                  <b className="text-ink">{tracker.deciderById.get(m.decider_id)?.name ?? m.decider_id}</b>
                  <span>“{m.words}”</span>
                  {!readOnly && first && !drafts.some((d) => d.decider_id === m.decider_id) && (
                    <button type="button" className="link cursor-pointer text-[13px] font-semibold" onClick={() => setDrafts((all) => [...all, presumedEntry(all[0], m.decider_id, m.words)])}>
                      Record what it says of them, as presumed
                    </button>
                  )}
                </p>
              ))}
            </div>
          )}

          <div className="-mx-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-y-2 border-ink bg-mint px-5 py-4">
            <p>
              <b>End of the people {isLead ? 'named' : 'in this source'}.</b>{' '}
              <span className="text-muted">
                {open.length} to publish{dismissed ? ` · ${dismissed} dismissed` : ''}
              </span>
            </p>
            {!readOnly && first && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setDrafts((all) => [...all, addedEntry(all.find((d) => d.items.length) ?? all[0], tracker.deciderById.get(first.decider_id ?? '')?.name ?? 'the first person')])}
              >
                Add another person
              </button>
            )}
          </div>

          <div className="py-[18px]">
            <label className="label" htmlFor="review_note">
              Article review note <span className="font-normal text-faint">(only editors see this)</span>
            </label>
            <input id="review_note" value={reviewNote} disabled={readOnly} onChange={(e) => setReviewNote(e.target.value)} placeholder="Add a note on the whole article review…" className="field" />
            {error && <p className="mt-2 text-sm font-semibold text-oppose">Not saved: {error}</p>}
          </div>
        </div>

        {!readOnly && (
          <div className="sticky bottom-0 z-[3] flex gap-2.5 rounded-b-[20px] border-t-2 border-ink bg-surface px-5 pt-3.5 pb-[18px]">
            <button id="reject" type="button" onClick={onDismissAll} className="btn btn-lg flex-1">
              {drafts.length > 1 ? 'Dismiss all' : 'Dismiss'} <span className="hidden font-semibold text-faint sm:inline">[R]</span>
            </button>
            <button id="approve" type="button" onClick={onPublish} disabled={!!missing} className={`btn btn-lg flex-[2] ${across ? 'btn-primary' : 'btn-go'}`}>
              {publishLabel} {!missing && <span className="hidden font-semibold sm:inline">[A]</span>}
            </button>
          </div>
        )}
      </article>
    </div>
  )
}

// Sets the source's publish date, or says it is not known. Kept on the card and
// written with it, like the rest of the editor's changes.
function PublishedOnControl({ value, edited, onChange }: { value: string | null; edited: boolean; onChange: (day: string | null) => void }) {
  const id = useId()
  return (
    <details className="text-[13px] text-muted">
      <summary className="cursor-pointer underline underline-offset-2">{value ? 'Change the date' : 'Set the date'}</summary>
      <span className="mt-1 flex flex-wrap items-center gap-2">
        <label htmlFor={id}>Publish date</label>
        <input
          id={id}
          type="date"
          value={value ?? ''}
          max={new Date().toISOString().slice(0, 10)}
          // A date input reads empty while a date is half typed; only "Not known" says the date is not known.
          onChange={(e) => e.target.value && onChange(e.target.value)}
          className="field w-auto py-1 text-[13px]"
        />
        <button type="button" className="underline underline-offset-2" onClick={() => onChange(null)}>
          Not known
        </button>
        <span>{edited ? 'Saved when this card is published or dismissed.' : ''}</span>
      </span>
    </details>
  )
}
