import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { isUnreadLead, type Proposal, type ProposalContext, type ProposalItem, type ProposalMention, type ProposalNote, type Source } from '../../shared/schema.ts'
import { db } from '../lib/db.ts'
import { editorFetch, signOut } from '../lib/editor.ts'
import { commit } from '../lib/review.ts'
import { planReview, type Write } from '../lib/review-plan.ts'
import { groupBy } from '../lib/build-tracker.ts'
import { decisionOf, draftEntries, outlook, proposalIsAcross, verdictOf, type EntryDraft } from '../lib/review-form.ts'
import { useTracker } from '../lib/tracker.tsx'
import { sourceLabel } from '../lib/position.ts'
import { Syncing, Token } from '../components/bits.tsx'
import { Reveal } from '../components/review/Reveal.tsx'
import { ReviewCard, people } from '../components/review/ReviewCard.tsx'

export const Route = createFileRoute('/editor/')({ component: Queue })

// How many proposals one page of the list beside the open card holds.
const UP_NEXT = 12
// How long the open card takes to leave before the next one arrives.
const LEAVE_MS = 470
const TOAST_MS = 4200

// What the editor had on a card. It is kept while they look at another card, and put back if publishing it fails.
type Work = { drafts: EntryDraft[]; reviewNote: string }
type Finish = { writes: Write[]; how: 'publishing' | 'dismissing'; message: string; work: Work }

function Queue() {
  const { tracker, isReady } = useTracker()
  const proposals = useLiveQuery((q) => q.from({ row: db.proposals }))
  const allItems = useLiveQuery((q) => q.from({ row: db.proposal_items }))
  const allNotes = useLiveQuery((q) => q.from({ row: db.proposal_notes }))
  const allContexts = useLiveQuery((q) => q.from({ row: db.proposal_contexts }))
  const allMentions = useLiveQuery((q) => q.from({ row: db.proposal_mentions }))
  const [tab, setTab] = useState<'pending' | 'reviewed'>('pending')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [listPage, setListPage] = useState(0)
  const [leaving, setLeaving] = useState<{ id: string; how: Finish['how'] } | null>(null)
  const [toast, setToast] = useState<{ text: string; shown: boolean }>({ text: '', shown: false })
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState<Record<string, Work>>({})
  const [attempts, setAttempts] = useState(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const itemsByProposal = useMemo(() => {
    const grouped = groupBy(allItems.data, (i) => i.proposal_id)
    for (const items of grouped.values()) items.sort((a, b) => a.sort - b.sort)
    return grouped
  }, [allItems.data])
  const itemsOf = (proposalId: string) => itemsByProposal.get(proposalId) ?? []
  // Proposals with a claim across from a position editors set. Those are checked first.
  const { pending, reviewed, acrossIds } = useMemo(() => {
    const waiting = proposals.data.filter((p) => p.status === 'pending')
    const acrossIds = new Set(waiting.filter((p) => proposalIsAcross(tracker, itemsByProposal.get(p.id) ?? [])).map((p) => p.id))
    return {
      acrossIds,
      pending: waiting.sort((a, b) => Number(acrossIds.has(b.id)) - Number(acrossIds.has(a.id)) || a.created_at.localeCompare(b.created_at)),
      reviewed: proposals.data.filter((p) => p.status !== 'pending').sort((a, b) => (b.reviewed_at ?? '').localeCompare(a.reviewed_at ?? '')),
    }
  }, [proposals.data, itemsByProposal, tracker])
  const list = tab === 'pending' ? pending : reviewed
  const selected = list.find((p) => p.id === selectedId) ?? list[0]
  const selectedAt = list.findIndex((p) => p.id === selected?.id)
  const selectedSource = selected && tracker.sourceById.get(selected.source_id)
  // The list shrinks as cards are finished, so the page asked for may be past its end.
  const shownPage = Math.min(listPage, Math.max(0, Math.ceil(list.length / UP_NEXT) - 1))
  const listFrom = shownPage * UP_NEXT

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select')) return
      const i = selectedAt
      if (e.key === 'j' && list[i + 1]) setSelectedId(list[i + 1].id)
      else if (e.key === 'k' && list[i - 1]) setSelectedId(list[i - 1].id)
      else if (e.key === 'o' && selectedSource?.url) window.open(selectedSource.url, '_blank', 'noreferrer')
      else if (e.key === 'a' && tab === 'pending') document.getElementById('approve')?.click()
      else if (e.key === 'r' && tab === 'pending') document.getElementById('reject')?.click()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // The list turns to the page the open card is on, so J and K can be followed down it.
  useEffect(() => {
    if (selectedAt !== -1) setListPage(Math.floor(selectedAt / UP_NEXT))
  }, [selected?.id, tab])

  if (!isReady || !proposals.isReady || !allItems.isReady || !allNotes.isReady || !allContexts.isReady || !allMentions.isReady) return <Syncing />

  // The card leaves first. The writes go in once it is gone, which brings the next card up from the stack.
  function finish(proposalId: string, { writes, how, message, work }: Finish) {
    if (leaving) return
    setError(null)
    setLeaving({ id: proposalId, how })
    const later = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms))
    later(() => {
      // A failed write is rolled back, which returns the proposal to the queue. It comes back as the editor left it.
      commit(writes).catch((err: unknown) => {
        setToast((t) => ({ ...t, shown: false }))
        setError(err instanceof Error ? err.message : String(err))
        setStarted((all) => ({ ...all, [proposalId]: work }))
        setAttempts((n) => n + 1)
        setSelectedId(proposalId)
      })
      setLeaving(null)
      setSelectedId(null)
      setToast({ text: message, shown: true })
      window.scrollTo({ top: 0, behavior: 'smooth' })
      later(() => setToast((t) => ({ ...t, shown: false })), TOAST_MS)
    }, LEAVE_MS)
  }

  const total = pending.length + reviewed.length
  const tabClass = (t: typeof tab) => (tab === t ? 'font-black' : 'link cursor-pointer font-semibold')

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
        <h1 className="h-page">Review queue</h1>
        <div
          className="h-3.5 min-w-[200px] flex-1 overflow-hidden rounded-full border-2 border-ink bg-surface sm:h-[18px]"
          role="progressbar"
          aria-label="Reviewed"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={reviewed.length}
        >
          <div className="h-full bg-support transition-[width] duration-[400ms]" style={{ width: `${total ? (reviewed.length / total) * 100 : 0}%` }} />
        </div>
        <p className="tabular-nums">
          <button type="button" aria-pressed={tab === 'reviewed'} className={tabClass('reviewed')} onClick={() => (setTab('reviewed'), setListPage(0))}>
            {reviewed.length} reviewed
          </button>
          {' · '}
          <button type="button" aria-pressed={tab === 'pending'} className={tabClass('pending')} onClick={() => (setTab('pending'), setListPage(0))}>
            {pending.length} to go
          </button>
        </p>
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <NewsSearchButton />
          <button type="button" className="btn btn-sm shadow-none" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <ReadArticleTrial />

      <Reveal open={toast.shown}>
        <p role="status" className="mt-5 rounded-xl border-2 border-ink bg-mint px-3.5 py-2.5 font-bold">
          {toast.text}
        </p>
      </Reveal>
      {error && <p className="mt-5 rounded-xl border-2 border-ink bg-oppose/15 px-3.5 py-2.5 font-bold">Not saved: {error}</p>}

      {!selected || !selectedSource ? (
        <div className="card card-lg mt-10 bg-mint px-5 py-7 text-center sm:mt-12 sm:p-12">
          <h2 className="text-2xl font-black sm:text-[32px]">{!selected ? (tab === 'pending' ? 'The queue is empty.' : 'Nothing reviewed yet.') : 'This proposal points at a source that no longer exists.'}</h2>
          {!selected && tab === 'pending' && <p className="mt-2 text-[15px] sm:text-[17px]">Every lead has been reviewed. The news search runs once a day.</p>}
        </div>
      ) : (
        <Desk
          key={`${selected.id}:${attempts}`}
          restored={started[selected.id]}
          onLeave={(work) => setStarted(({ [selected.id]: _, ...rest }) => (work ? { ...rest, [selected.id]: work } : rest))}
          proposal={selected}
          source={selectedSource}
          items={itemsOf(selected.id)}
          notes={allNotes.data.filter((n) => n.proposal_id === selected.id)}
          contexts={allContexts.data.filter((c) => c.proposal_id === selected.id)}
          mentions={allMentions.data.filter((m) => m.proposal_id === selected.id)}
          behind={list.length - 1}
          leaving={leaving?.id === selected.id ? leaving.how : null}
          onFinish={(done) => finish(selected.id, done)}
        >
          {list.length > 1 && (
            <>
              <h2 className="text-base font-black sm:text-lg">{tab === 'pending' ? 'Waiting' : 'Reviewed'}</h2>
              <ul className="flex flex-col gap-2 sm:gap-2.5">
                {list.slice(listFrom, listFrom + UP_NEXT).map((p) => {
                  const items = itemsOf(p.id)
                  const names = [...new Set(items.map((i) => tracker.deciderById.get(i.decider_id)?.name ?? i.decider_id))]
                  const accepted = items.filter((i) => i.status === 'accepted').length
                  const across = acrossIds.has(p.id)
                  const source = tracker.sourceById.get(p.source_id)
                  const unread = isUnreadLead(p)
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(p.id)}
                        aria-current={p.id === selected.id ? 'true' : undefined}
                        className={`flex w-full cursor-pointer items-start gap-3 rounded-[14px] border-ink px-3.5 py-3 text-left hover:shadow-hard-md ${p.id === selected.id ? 'bg-mint shadow-hard-md' : 'bg-surface'} ${across ? 'border-[3px]' : unread ? 'border-2 border-dashed' : 'border-2'}`}
                      >
                        <Token standing={items.find((i) => i.reading)?.reading ?? 'unknown'} className="mt-0.5 size-[22px]" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2 font-bold">
                            <span className="line-clamp-2 leading-snug">{source ? sourceLabel(source) : 'A source that no longer exists'}</span>
                            {p.id === selected.id ? <span className="tag shrink-0">open</span> : started[p.id] && <span className="tag shrink-0 text-accent">started</span>}
                            {p.status !== 'pending' && (
                              <span className="tag shrink-0">{accepted === 0 ? 'dismissed' : accepted === items.length ? 'published' : `${accepted} of ${items.length} published`}</span>
                            )}
                          </span>
                          <span className="mt-0.5 line-clamp-1 text-sm leading-snug text-muted sm:line-clamp-2">
                            {across ? 'Contradicts our recorded position · ' : unread ? 'Not read · ' : ''}
                            {names.join(', ')}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
              {list.length > UP_NEXT && (
                <nav aria-label={tab === 'pending' ? 'Pages of what is waiting' : 'Pages of what was reviewed'} className="flex items-center justify-between gap-2 text-sm font-semibold">
                  <button type="button" className="btn btn-sm min-h-9 px-3" disabled={shownPage === 0} onClick={() => setListPage(shownPage - 1)}>
                    Previous
                  </button>
                  <span className="text-muted tabular-nums">
                    {listFrom + 1}–{Math.min(listFrom + UP_NEXT, list.length)} of {list.length}
                  </span>
                  <button type="button" className="btn btn-sm min-h-9 px-3" disabled={listFrom + UP_NEXT >= list.length} onClick={() => setListPage(shownPage + 1)}>
                    Next
                  </button>
                </nav>
              )}
            </>
          )}
          <p className="tag mt-1.5 hidden text-[13px] leading-[1.8] font-medium text-faint lg:block">
            J / K move · O open source
            <br />A publish · R dismiss all
          </p>
        </Desk>
      )}
    </div>
  )
}

// The open card and what sits beside it. It holds what the editor has changed
// on the card, none of which is written anywhere until the card is published.
function Desk({
  proposal,
  source,
  items,
  notes,
  contexts,
  mentions,
  behind,
  leaving,
  restored,
  onLeave,
  onFinish,
  children,
}: {
  proposal: Proposal
  source: Source
  items: ProposalItem[]
  notes: ProposalNote[]
  contexts: ProposalContext[]
  mentions: ProposalMention[]
  behind: number
  leaving: Finish['how'] | null
  restored: Work | undefined
  // Called when the editor turns to another card: with their work if they changed anything, or nothing.
  onLeave: (work: Work | undefined) => void
  onFinish: (done: Finish) => void
  children: ReactNode
}) {
  const { tracker } = useTracker()
  const readOnly = proposal.status !== 'pending'
  const [drafts, setDrafts] = useState(
    () =>
      restored?.drafts ??
      draftEntries(items, contexts).map((d) => ({ ...d, note: notes.find((n) => n.kind === 'review' && d.items.some((i) => i.id === n.proposal_item_id))?.body ?? '' })),
  )
  const [reviewNote, setReviewNote] = useState(restored?.reviewNote ?? notes.find((n) => n.kind === 'review' && !n.proposal_item_id)?.body ?? '')
  const [error, setError] = useState<string | null>(null)
  // What to hand back on leaving. A finished card hands back nothing: the queue keeps its work only if the write fails.
  const leaveWith = useRef<Work | undefined>(restored)
  const touched = useRef(restored !== undefined)
  const finished = useRef(false)
  leaveWith.current = touched.current && !finished.current ? { drafts, reviewNote } : undefined
  useEffect(() => () => onLeave(leaveWith.current), [])
  const changeDrafts = (update: (drafts: EntryDraft[]) => EntryDraft[]) => {
    touched.current = true
    setDrafts(update)
  }
  const changeReviewNote = (note: string) => {
    touched.current = true
    setReviewNote(note)
  }

  function finish(dismissAll: boolean) {
    const decide = (d: EntryDraft) => {
      const question = tracker.questionById.get(d.question_id)
      return question && outlook(tracker, d, question, d.reading).across ? decisionOf(d) : null
    }
    try {
      const verdict = verdictOf(drafts, reviewNote, decide, dismissAll)
      const writes = planReview(tracker, proposal, source, verdict, new Date().toISOString())
      const published = new Set(verdict.entries.filter((e) => e.publish).map((e) => e.decider_id)).size
      const title = `“${sourceLabel(source)}”`
      setError(null)
      finished.current = true
      onFinish({
        writes,
        work: { drafts, reviewNote },
        how: published ? 'publishing' : 'dismissing',
        message: `${published ? `Published ${people(published)} from ${title}.` : `Dismissed ${title}.`}${behind ? ' Here is the next card.' : ''}`,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mt-7 grid grid-cols-[minmax(0,1fr)] items-start gap-9 lg:grid-cols-[minmax(0,1fr)_340px]">
      <ReviewCard
        proposal={proposal}
        source={source}
        notes={notes}
        mentions={mentions}
        drafts={drafts}
        setDrafts={changeDrafts}
        reviewNote={reviewNote}
        setReviewNote={changeReviewNote}
        behind={behind}
        readOnly={readOnly}
        leaving={leaving}
        error={error}
        onPublish={() => finish(false)}
        onDismissAll={() => finish(true)}
      />
      <aside className="flex flex-col gap-2.5 lg:sticky lg:top-4">{children}</aside>
    </div>
  )
}

function NewsSearchButton() {
  const [state, setState] = useState<'idle' | 'running' | string>('idle')
  async function run() {
    setState('running')
    try {
      const res = await editorFetch('/api/editor/news-search', { method: 'POST' })
      const report = (await res.json()) as { error?: string; questions: { queued: number }[] }
      setState(report.error ?? `${report.questions.reduce((n, q) => n + q.queued, 0)} new leads queued`)
    } catch {
      setState('News search failed')
    }
  }
  return (
    <>
      {state !== 'idle' && state !== 'running' && <span className="text-sm font-semibold">{state}</span>}
      <button type="button" className="btn btn-sm" onClick={run} disabled={state === 'running'} title="Searches the news for questions marked as in the news">
        {state === 'running' ? 'Searching…' : 'Search the news now'}
      </button>
    </>
  )
}

// Runs the article reader on one page without queueing anything, to see what
// the model makes of it.
function ReadArticleTrial() {
  const { tracker } = useTracker()
  const [result, setResult] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const questions = [...tracker.questionById.values()].filter((q) => !q.parent_id).sort((a, b) => a.short_title.localeCompare(b.short_title))

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setRunning(true)
    try {
      const res = await editorFetch('/api/editor/read-article', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: f.get('trial_url'), question_id: f.get('trial_question') }),
      })
      setResult(JSON.stringify(await res.json(), null, 2))
    } catch (err) {
      setResult(String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-sm font-bold">Try the article reader on one page</summary>
      <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-3">
        <p className="text-sm text-muted">Fetches the page and has the model read it for everyone on the question’s roster it names. Shows what would be queued; queues nothing.</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_16rem_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="trial_url">
              Article URL
            </label>
            <input id="trial_url" name="trial_url" type="url" required className="field" />
          </div>
          <div>
            <label className="label" htmlFor="trial_question">
              Question
            </label>
            <select id="trial_question" name="trial_question" className="field">
              {questions.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.short_title}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-sm" disabled={running}>
            {running ? 'Reading…' : 'Read it'}
          </button>
        </div>
        {result && <pre className="max-h-96 overflow-auto rounded-[14px] border-2 border-line bg-paper p-3 text-xs whitespace-pre-wrap">{result}</pre>}
      </form>
    </details>
  )
}
