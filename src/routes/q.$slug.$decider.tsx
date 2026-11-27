import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { Certainty } from '../../shared/schema.ts'
import { FOOTING_HINT } from '../../shared/standing.ts'
import { useTracker, useViewedBody, type Tenure } from '../lib/tracker.tsx'
import { FootingTag, NotFound, StandingPill, Syncing } from '../components/bits.tsx'
import { QuestionHeader } from '../components/QuestionHeader.tsx'
import { ActWords, RecordItem } from '../components/RecordItem.tsx'
import { OwnReview } from '../components/OwnReview.tsx'
import { SubmitEvidence } from '../components/SubmitEvidence.tsx'
import { Discussion } from '../components/Discussion.tsx'
import { Modal } from '../components/Modal.tsx'
import { AskStatus, CloseQuestion, ClosedNote } from '../components/Asks.tsx'
import { MergeAct, WithdrawAct } from '../components/MergeAct.tsx'
import { KIND_LABEL, actDate, claimLabel, formatDate, spanOf, standingLabel } from '../lib/position.ts'
import { useIsEditor, useSession } from '../lib/auth.ts'
import { openSignIn } from '../components/SignIn.tsx'

export const Route = createFileRoute('/q/$slug/$decider')({ component: DeciderOnQuestion })

function DeciderOnQuestion() {
  const { slug, decider: deciderSlug } = Route.useParams()
  const { tracker, isReady } = useTracker()
  const editor = useIsEditor()
  const signedIn = useSession().id !== undefined
  const [adding, setAdding] = useState(false)
  const question = tracker.questionBySlug.get(slug)
  const decider = tracker.deciderBySlug.get(deciderSlug)
  const { body } = useViewedBody(question, decider?.id)
  if (!isReady) return <Syncing />

  const role = decider && question && tracker.roleIn(question, decider.id, body?.id)
  const seat = role && tracker.seatById.get(role.seat_id)
  const me = question && role && tracker.contender(question, role)
  // Someone who held, or will hold, the office an ask is put to keeps their page for it.
  const tenures = question && decider ? tracker.tenuresOn(question, decider.id) : []
  if (!question || !decider || !body || !seat || !me || !(tracker.appliesTo(question, decider.id) || tenures.length > 0)) return <NotFound what="record" />

  const measures = tracker.measuresIn(question, body.id).filter((m) => !m.chamber || m.chamber === seat.chamber)
  const isAsk = tracker.isAsk(question)
  const root = tracker.rootOf(question)
  const asks = tracker.asksFor(root, decider.id, body.id)
  const held = tracker.tenuresHeldBy(decider.id, body.id)
  const unsure = (c: Certainty) => (c === 'certain' ? '' : c === 'likely' ? ' (likely)' : ' (possible)')
  const sourceOf = (t: Tenure) => (t.holder.source_id ? tracker.sourceById.get(t.holder.source_id) : undefined)
  const span = (t: { starts_on: string | null; ends_on: string | null }) => {
    const when = spanOf(t, tracker.asOf)
    return when ? ` ${when}` : ''
  }
  const roleLabels = [
    ...new Set([
      ...held.filter((t) => !sourceOf(t)).map((t) => t.office.label + unsure(t.holder.certainty)),
      ...asks.map((k) => k.roleLabel).filter((l) => l !== null),
      ...tenures.filter((t) => span(t.holder)).map((t) => t.office.label + span(t.holder)),
    ]),
  ]
  const claim = claimLabel(me.role, tracker.asOf)
  const holds = claim === 'holds the seat' ? '' : claim
  // Everyone else with a claim on this seat, now or later.
  const rivals = [...(tracker.rolesBySeat.get(seat.id) ?? []), ...(tracker.upcomingBySeat.get(seat.id) ?? [])]
    .filter((r) => r.decider_id !== decider.id)
    .map((r) => tracker.contender(question, r))
    .filter((c) => c !== undefined)
  const outOfScope = question.chamber && question.chamber !== seat.chamber
  const saidNothing = tracker.saidNothingOn(question, decider.id)

  return (
    <div className="space-y-8">
      <QuestionHeader question={question} deciderSlug={decider.slug} />

      <section className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold">
              <Link to="/p/$slug" params={{ slug: decider.slug }} className="hover:underline">
                {decider.name}
              </Link>
            </h2>
            <p className="text-sm text-muted">
              {seat.label}
              {seat.chamber && `, ${seat.chamber}`}
              {me.role.affiliation && ` · ${me.role.affiliation}`}
              {seat.next_election_on && ` · next election ${formatDate(seat.next_election_on)}`}
              {holds && ` · ${holds}`}
            </p>
            {roleLabels.length > 0 && <p className="text-sm font-medium">{roleLabels.join(' · ')}</p>}
            {held.flatMap((t) => {
              const url = sourceOf(t)?.url
              return url ? (
                <a key={t.holder.id} href={url} target="_blank" rel="noreferrer" className="block text-sm font-medium underline underline-offset-2">
                  {t.office.label}
                  {unsure(t.holder.certainty)} ↗
                </a>
              ) : (
                []
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <StandingPill standing={me.standing} question={question} />
            <FootingTag footing={me.footing} />
          </div>
        </div>
        {outOfScope ? (
          <p className="mt-4 text-sm text-muted">This measure is before the {question.chamber}, so it is not {decider.name}'s to sign.</p>
        ) : (
          <>
            {me.set && (
              <div className="mt-4 border-l-2 border-accent pl-3">
                <p className="text-lg">{me.set.reason}</p>
                <p className="mt-1 text-sm text-muted">
                  Set by editors on {formatDate(me.set.set_at)}. The record alone works out to {standingLabel(me.calculated, question)}.
                </p>
              </div>
            )}
            <p className="mt-2 text-sm text-muted">{FOOTING_HINT[me.footing]}</p>
          </>
        )}

        {(isAsk || question.status !== 'open') && (
          <div className="mt-4 space-y-3">
            <ClosedNote question={question} />
            {isAsk && <CloseQuestion question={question} />}
          </div>
        )}

        {!isAsk && asks.length + measures.length > 0 && (
          <ul className="mt-5 divide-y divide-line border-t border-line">
            {asks.map(({ ask, contender }) => (
              <li key={ask.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <Link to="/q/$slug/$decider" params={{ slug: ask.slug, decider: decider.slug }} className="font-medium hover:underline">
                    {ask.title}
                  </Link>
                  <AskStatus ask={ask} />
                </span>
                <StandingPill standing={contender.standing} question={ask} />
              </li>
            ))}
            {measures.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <Link to="/q/$slug/$decider" params={{ slug: m.slug, decider: decider.slug }} className="hover:underline">
                    {m.title}
                  </Link>
                  <AskStatus ask={m} />
                </span>
                <StandingPill standing={tracker.standingFor(m, decider.id)} question={m} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">The record</h2>
            {signedIn ? (
              <button type="button" className="btn" onClick={() => setAdding(true)}>
                Add to the record
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => openSignIn('Sign in to add to the record', () => setAdding(true))}>
                Sign in to add to the record
              </button>
            )}
          </div>
          {me.record.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line p-6 text-center text-muted">
              Nothing on file. If {decider.name} has spoken about this, add it to the record.
            </p>
          ) : (
            <ol className="space-y-3">
              {me.record.map((entry) => (
                <RecordItem key={entry.reading.id} entry={entry} question={question}>
                  <OwnReview act={entry.act} question={question} />
                  {editor && <WithdrawAct act={entry.act} />}
                  {editor && <MergeAct act={entry.act} />}
                </RecordItem>
              ))}
            </ol>
          )}
          {saidNothing.length > 0 && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-muted">Reviewed as saying nothing on this question ({saidNothing.length})</summary>
              <ul className="mt-2 space-y-2">
                {saidNothing.map(({ act, question: on }) => (
                  <li key={act.id} className="rounded-lg border border-line p-3">
                    <p className="mb-1 text-xs text-muted">
                      {actDate(act.occurred_on)} · {KIND_LABEL[act.kind]}
                    </p>
                    <ActWords kind={act.kind} words={act.body} />
                    <OwnReview act={act} question={on} />
                  </li>
                ))}
              </ul>
            </details>
          )}
          <Modal
            open={adding}
            onClose={() => setAdding(false)}
            title="Add to the record"
            description="It counts on this page at once, as your reading. An editor then checks it against its source."
            keepMounted
          >
            <SubmitEvidence question={question} decider={decider} onDone={() => setAdding(false)} />
          </Modal>

          <div className="mt-10">
            <Discussion question={question} decider={decider} />
          </div>
        </section>

        <aside className="space-y-6">
          {rivals.length > 0 && (
            <section>
              <h2 className="mb-2 text-base font-semibold">Others holding or seeking {seat.label}</h2>
              <ul className="space-y-2">
                {rivals.map((r) => (
                  <li key={r.role.id}>
                    <Link
                      to="/q/$slug/$decider"
                      params={{ slug: question.slug, decider: r.decider.slug }}
                      className="block rounded-xl border-2 border-ink bg-surface p-3 transition-transform hover:-translate-y-0.5"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">{r.decider.name}</span>
                        <StandingPill standing={r.standing} question={question} />
                      </span>
                      <span className="block text-xs text-muted first-letter:uppercase">
                        {claimLabel(r.role, tracker.asOf)}
                        {r.role.affiliation && ` · ${r.role.affiliation}`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Link to="/p/$slug" params={{ slug: decider.slug }} className="block text-sm link">
            Every question put to {decider.name}
          </Link>
          {decider.url && (
            <a href={decider.url} target="_blank" rel="noreferrer" className="block text-sm link">
              Official site ↗
            </a>
          )}
          {editor && (
            <div className="space-y-1 text-sm">
              <Link to="/people/$slug" params={{ slug: decider.slug }} className="block link">
                Edit {decider.name}
              </Link>
              <Link to="/roles/$roleId" params={{ roleId: me.role.id }} className="block link">
                Edit their role on {seat.label}
              </Link>
              <Link to="/roles/new" search={{ seat: seat.id, running: true, question: question.slug }} className="block link">
                Add someone running for {seat.label}
              </Link>
            </div>
          )}
          <Link to="/q/$slug" params={{ slug: question.slug }} className="block text-sm text-muted hover:text-ink">
            ← Everyone on this question
          </Link>
        </aside>
      </div>
    </div>
  )
}
