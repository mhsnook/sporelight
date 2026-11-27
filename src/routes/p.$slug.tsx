import { Link, createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import type { Decider, Question } from '../../shared/schema.ts'
import { today, useTracker, type PutTo, type Tenure } from '../lib/tracker.tsx'
import { formatDate, spanOf } from '../lib/position.ts'
import { useIsEditor } from '../lib/auth.ts'
import { CertaintyTag, FootingTag, NotFound, SeatLine, StandingPill, Syncing, Token } from '../components/bits.tsx'
import { AskStatus } from '../components/Asks.tsx'
import { TermToggle } from '../components/QuestionHeader.tsx'
import { ActDateAndKind, ActWords, SourceList } from '../components/RecordItem.tsx'
import { ReadingLine } from '../components/Story.tsx'
import type { SiteSearch } from './__root.tsx'

const ACTS_SHOWN = 8

export const Route = createFileRoute('/p/$slug')({
  component: Person,
  // The root keeps `body` on every link. This page spans bodies, so it is dropped on the way here.
  search: { middlewares: [stripSearchParams<SiteSearch>(['body'])] },
})

function Person() {
  const { slug } = Route.useParams()
  const { tracker, isReady } = useTracker()
  const editor = useIsEditor()
  if (!isReady) return <Syncing />
  const decider = tracker.deciderBySlug.get(slug)
  if (!decider) return <NotFound what="person" />

  const { bodies, atLarge } = tracker.seatsAndOfficesOf(decider.id)
  const { current, former } = tracker.questionsOf(decider.id)

  return (
    <div className="space-y-10">
      <header className="space-y-4">
        <h1 className="h-page">{decider.name}</h1>
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          {bodies.map(({ body, seats, offices }) => (
            <div key={body.id} className="space-y-1">
              <p className="tag">
                {body.name}
                {body.is_demo && ' · demo data, not real'}
              </p>
              {seats.map(({ role, seat }) => (
                <p key={role.id} className="text-sm">
                  <SeatLine role={role} seat={seat} day={tracker.asOf} />
                </p>
              ))}
              {offices.map((t) => (
                <OfficeLine key={t.holder.id} tenure={t} />
              ))}
              <TermToggle body={body} />
            </div>
          ))}
        </div>
        {atLarge.map((t) => (
          <OfficeLine key={t.holder.id} tenure={t} />
        ))}
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {decider.url && (
            <a href={decider.url} target="_blank" rel="noreferrer" className="link">
              Official site ↗
            </a>
          )}
          {editor && (
            <Link to="/people/$slug" params={{ slug: decider.slug }} className="btn btn-sm btn-editor">
              Edit {decider.name}
            </Link>
          )}
        </p>
      </header>

      <div className="grid gap-10 lg:grid-cols-2">
        <div className="space-y-10">
          <section aria-labelledby="questions">
            <h2 id="questions" className="mb-3 text-xl font-semibold">
              Questions
            </h2>
            {current.length === 0 && (
              <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">
                No open question is put to {decider.name}
                {tracker.asOf !== today() && ` on ${formatDate(tracker.asOf)}`}.
              </p>
            )}
            <div className="space-y-6">
              {current.map(({ body, questions }) => (
                <div key={body.id}>
                  {bodies.length > 1 && <h3 className="tag mb-2">{body.name}</h3>}
                  <ul className="space-y-3">
                    {questions.map((p) => (
                      <li key={p.question.id} className="card p-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                          <div className="min-w-0 flex-1 space-y-1">
                            <RecordLink putTo={p} decider={decider} className="h-card block hover:underline">
                              {p.question.short_title}
                            </RecordLink>
                            <p className="text-sm text-muted">{p.question.title}</p>
                            <PutToNote putTo={p} />
                          </div>
                          <span className="flex shrink-0 flex-wrap items-center gap-2">
                            <StandingPill standing={p.contender.standing} question={p.question} />
                            <FootingTag footing={p.contender.footing} />
                          </span>
                        </div>
                        {p.under.length > 0 && (
                          <ul className="mt-3 divide-y divide-line border-t border-line">
                            {p.under.map((sub) => (
                              <QuestionRow key={sub.question.id} putTo={sub} decider={decider} title={sub.question.title} />
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          {former.length > 0 && (
            <section aria-labelledby="past-questions">
              <h2 id="past-questions" className="text-xl font-semibold">
                Past questions
              </h2>
              <p className="mb-3 text-sm text-muted">Questions that have closed, and those put to a seat or office that is no longer theirs, with where they stood.</p>
              <ul className="divide-y divide-line border-y border-line">
                {former.map((p) => (
                  <QuestionRow key={p.question.id} putTo={p} decider={decider} title={p.parent ? p.question.title : p.question.short_title} parent={p.parent} />
                ))}
              </ul>
            </section>
          )}
        </div>

        <LatestActs key={decider.id} decider={decider} />
      </div>
    </div>
  )
}

function LatestActs({ decider }: { decider: Decider }) {
  const { tracker } = useTracker()
  const [everyAct, setEveryAct] = useState(false)
  const latest = tracker.latestActsOf(decider.id)
  const shownActs = everyAct ? latest : latest.slice(0, ACTS_SHOWN)
  return (
    <section aria-labelledby="latest">
      <h2 id="latest" className="text-xl font-semibold">
        Latest on the record
      </h2>
      <p className="mb-3 text-sm text-muted">Newest first. Each question links to the full record there.</p>
      {latest.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">Nothing on file for {decider.name} yet.</p>
      ) : (
        <ol className="space-y-3">
          {shownActs.map(({ act, entries }) => (
            <li key={act.id} className="rounded-xl border-2 border-ink bg-surface p-4">
              <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <ActDateAndKind act={act} />
                {act.withdrawn_on && <span className="rounded bg-paper px-1.5 py-0.5">Withdrawn {formatDate(act.withdrawn_on)}</span>}
              </p>
              <ActWords kind={act.kind} words={act.body} />
              <ul className="mt-2 space-y-0.5 text-sm">
                {entries.map((e) => (
                  <ReadingLine
                    key={e.reading.id}
                    decider={decider}
                    position={e.reading.position}
                    question={e.question}
                    via={e.via}
                    weight={e.reading.weight}
                    checked={e.checked}
                    lead={<Token standing={e.reading.position} className="size-3" />}
                  />
                ))}
              </ul>
              <SourceList reports={entries[0].reports} />
            </li>
          ))}
        </ol>
      )}
      {latest.length > ACTS_SHOWN && (
        <button type="button" className="mt-3 text-sm link" aria-expanded={everyAct} onClick={() => setEveryAct(!everyAct)}>
          {everyAct ? 'Show fewer' : `Show all ${latest.length}`}
        </button>
      )}
    </section>
  )
}

// Their page on one question, through the body it is listed under here.
function RecordLink({ putTo, decider, className, children }: { putTo: PutTo; decider: Decider; className: string; children: ReactNode }) {
  return (
    <Link
      to="/q/$slug/$decider"
      params={{ slug: putTo.question.slug, decider: decider.slug }}
      search={{ body: putTo.body.id !== putTo.question.body_id ? putTo.body.slug : undefined }}
      className={className}
    >
      {children}
    </Link>
  )
}

// A sub-question or a past question, one line each.
function QuestionRow({ putTo, decider, title, parent }: { putTo: PutTo; decider: Decider; title: string; parent?: Question }) {
  return (
    <li className="flex flex-col gap-2 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {parent && <span className="text-muted">{parent.short_title} ·</span>}
        <RecordLink putTo={putTo} decider={decider} className="font-medium hover:underline">
          {title}
        </RecordLink>
        <PutToNote putTo={putTo} />
        <AskStatus ask={putTo.question} />
      </span>
      <span className="shrink-0">
        <StandingPill standing={putTo.contender.standing} question={putTo.question} />
      </span>
    </li>
  )
}

function PutToNote({ putTo }: { putTo: PutTo }) {
  const { tracker } = useTracker()
  const when = spanOf(putTo.claim, tracker.asOf)
  if (!putTo.roleLabel && !when && putTo.claim.certainty === 'certain') return null
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
      {putTo.roleLabel && <span>{putTo.roleLabel}</span>}
      {when && <span>{when}</span>}
      <CertaintyTag certainty={putTo.claim.certainty} />
    </span>
  )
}

function OfficeLine({ tenure: t }: { tenure: Tenure }) {
  const { tracker } = useTracker()
  const when = spanOf(t.holder, tracker.asOf)
  const url = t.holder.source_id ? tracker.sourceById.get(t.holder.source_id)?.url : undefined
  const label = (
    <>
      {t.office.label}
      {t.holder.certainty !== 'certain' && ` (${t.holder.certainty})`}
      {when && ` ${when}`}
    </>
  )
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="block text-sm font-medium underline underline-offset-2">
      {label} ↗
    </a>
  ) : (
    <p className="text-sm font-medium">{label}</p>
  )
}
