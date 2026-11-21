import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import type { Question } from '../../shared/schema.ts'
import { NEEDS_ATTENTION } from '../../shared/standing.ts'
import { isHeld, useTracker, useViewedBody, type HeldSeat } from '../lib/tracker.tsx'
import { SPECTRUM, STANDINGS, STANDING_BG, claimTag, formatDate, standingLabel, type Standing } from '../lib/position.ts'
import { CertaintyTag, FootingTag, NotFound, StandingDot, StandingPill, Syncing, tally } from '../components/bits.tsx'
import { Hemicycle } from '../components/Hemicycle.tsx'
import { QuestionHeader } from '../components/QuestionHeader.tsx'
import { AskStatus, CloseQuestion, ClosedNote, KeyPeople } from '../components/Asks.tsx'
import { isEditor } from '../lib/editor.ts'
import { nounOf } from '../lib/question-form.ts'

// How many of a group to list before a reader has to ask for the rest.
const PREVIEW = 12

type BoardSearch = { q?: string; chamber?: string; standing?: Standing; thin?: boolean; contested?: boolean }

export const Route = createFileRoute('/q/$slug/')({
  component: Board,
  validateSearch: (s: Record<string, unknown>): BoardSearch => ({
    q: typeof s.q === 'string' && s.q ? s.q : undefined,
    chamber: typeof s.chamber === 'string' && s.chamber ? s.chamber : undefined,
    standing: STANDINGS.includes(s.standing as Standing) ? (s.standing as Standing) : undefined,
    thin: s.thin === true || undefined,
    contested: s.contested === true || undefined,
  }),
})

function Board() {
  const { slug } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { tracker, isReady } = useTracker()
  const question = tracker.questionBySlug.get(slug)
  const { body } = useViewedBody(question)
  const everySeat = useMemo(() => (question && body ? tracker.board(question, body.id) : []), [tracker, question, body])
  const rows = useMemo(() => everySeat.filter(isHeld), [everySeat])
  // Seats nobody certainly or likely holds on the day viewed, but someone may.
  const undecided = everySeat.filter((r) => !r.incumbent && r.alternates.length > 0)
  // Seats nobody holds or may hold on the day viewed. Someone may be due to.
  const vacant = everySeat.filter((r) => !r.incumbent && r.alternates.length === 0)

  if (!isReady) return <Syncing />
  if (!question || !body) return <NotFound what="question" />
  if (tracker.isAsk(question)) return <Ask question={question} bodyId={body.id} />

  const set = (patch: BoardSearch) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  const chambers = [...new Set(rows.map((r) => r.seat.chamber).filter((c) => c !== null))].sort()
  const chamber = chambers.includes(search.chamber ?? '') ? search.chamber : undefined
  // Everyone with a claim on the seat besides its holder: possible holders on
  // the day viewed and anyone due, likely or running to take it later.
  const others = (r: HeldSeat) => [...r.alternates, ...r.upcoming]
  const hasOthers = rows.some((r) => others(r).length > 0)
  const needle = search.q?.toLowerCase()

  // Everything but the chamber, which decides which charts are drawn rather
  // than which seats in them are lit.
  const matches = (r: HeldSeat) => {
    const inc = r.incumbent
    if (search.standing && inc.standing !== search.standing) return false
    if (search.thin && !NEEDS_ATTENTION.has(inc.footing)) return false
    if (search.contested && !others(r).some((c) => c.standing !== 'unknown')) return false
    if (needle) {
      const haystack = [inc.decider.name, r.seat.label, inc.role.affiliation, ...others(r).map((c) => c.decider.name)].join(' ').toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  }

  const scoped = chamber ? rows.filter((r) => r.seat.chamber === chamber) : rows
  const visible = scoped.filter(matches)
  const counts = tally(scoped.map((r) => r.incumbent.standing))
  const charts = chambers.length > 0 ? chambers.filter((c) => !chamber || c === chamber) : [null]
  const groups = STANDINGS.map((standing) => ({
    standing,
    rows: visible.filter((r) => r.incumbent.standing === standing).sort((a, b) => a.incumbent.decider.sort_name.localeCompare(b.incumbent.decider.sort_name)),
  })).filter((g) => g.rows.length > 0)

  return (
    <div className="space-y-6">
      <QuestionHeader question={question} />
      <ClosedNote question={question} />
      <EditorTools question={question} />

      <KeyPeople people={tracker.keyPeople(question, body.id)} />

      <div className={`grid gap-4 ${charts.length > 1 ? 'lg:grid-cols-2' : ''}`}>
        {charts.map((c) => (
          <Hemicycle
            key={c ?? 'all'}
            title={c ?? body?.name ?? 'Seats'}
            rows={c ? rows.filter((r) => r.seat.chamber === c) : rows}
            question={question}
            isLit={matches}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {SPECTRUM.filter((s) => counts[s] > 0).map((s) => {
          const on = search.standing === s
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              onClick={() => set({ standing: on ? undefined : s })}
              className={`min-w-32 flex-1 rounded-lg border px-4 py-3 text-left transition-colors ${on ? 'border-ink bg-surface' : 'border-line hover:border-ink'}`}
            >
              <span className="flex items-center gap-1.5 text-sm text-muted">
                <StandingDot standing={s} />
                {standingLabel(s, question)}
              </span>
              <span className="mt-1 block font-display text-3xl leading-none font-semibold tabular-nums">{counts[s]}</span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-y border-line py-3">
        <input
          type="search"
          className="field max-w-56"
          placeholder="Search name, seat, party"
          aria-label="Search"
          value={search.q ?? ''}
          onChange={(e) => set({ q: e.target.value || undefined })}
        />
        {chambers.length > 1 && (
          <div className="flex" role="group" aria-label="Chamber">
            {[undefined, ...chambers].map((c) => (
              <button
                key={c ?? 'all'}
                type="button"
                aria-pressed={chamber === c}
                onClick={() => set({ chamber: c })}
                className={`btn -ml-px rounded-none first:ml-0 first:rounded-l-md last:rounded-r-md ${chamber === c ? 'btn-primary relative' : ''}`}
              >
                {c ?? 'Both'}
              </button>
            ))}
          </div>
        )}
        <Toggle on={!!search.thin} onChange={(thin) => set({ thin: thin || undefined })}>
          Thin evidence
        </Toggle>
        {hasOthers && (
          <Toggle on={!!search.contested} onChange={(contested) => set({ contested: contested || undefined })}>
            Challenger or successor on record
          </Toggle>
        )}
        <span className="ml-auto text-sm text-muted tabular-nums">
          {visible.length} of {scoped.length}
        </span>
      </div>

      {groups.length === 0 && <p className="py-8 text-center text-muted">Nobody matches those filters.</p>}
      {undecided.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Not decided yet</h2>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {undecided.map((row) => (
              <li key={row.seat.id} className="rounded-xl border-2 border-dashed border-line bg-surface py-2 pr-3 pl-4">
                <span className="block text-xs text-muted">{row.seat.label}</span>
                {row.alternates.map((a, i) => (
                  <span key={a.decider.id}>
                    {i > 0 && ' or '}
                    <Link to="/q/$slug/$decider" params={{ slug: question.slug, decider: a.decider.slug }} className="link font-medium">
                      {a.decider.name}
                    </Link>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      {vacant.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Vacant</h2>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {vacant.map((row) => (
              <li key={row.seat.id} className="rounded-xl border-2 border-dashed border-line bg-surface py-2 pr-3 pl-4">
                <span className="block text-xs text-muted">{row.seat.label}</span>
                {row.upcoming.length === 0 && <span className="text-sm text-muted">Nobody holds this seat.</span>}
                {row.upcoming.map((c) => (
                  <span key={c.role.id} className="block text-sm">
                    <span className="text-muted">{claimTag(c.role, tracker.asOf)}:</span>{' '}
                    <Link to="/q/$slug/$decider" params={{ slug: question.slug, decider: c.decider.slug }} className="link font-medium">
                      {c.decider.name}
                    </Link>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      {groups.map((group) => {
        const shown = search.standing || needle ? group.rows : group.rows.slice(0, PREVIEW)
        return (
          <section key={group.standing}>
            <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <StandingDot standing={group.standing} />
              {standingLabel(group.standing, question)}
              <span className="font-sans text-sm font-normal text-muted tabular-nums">{group.rows.length}</span>
            </h2>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {shown.map((row) => (
                <SeatCard key={row.seat.id} row={row} question={question} />
              ))}
            </ul>
            {shown.length < group.rows.length && (
              <button type="button" className="mt-3 text-sm link" onClick={() => set({ standing: group.standing })}>
                Show all {group.rows.length}
              </button>
            )}
          </section>
        )
      })}
    </div>
  )
}

// An ask is put to a few named people, so it gets a list in place of a seat chart.
function Ask({ question, bodyId }: { question: Question; bodyId: string }) {
  const { tracker } = useTracker()
  const parent = question.parent_id ? tracker.questionById.get(question.parent_id) : undefined
  const people = tracker.peopleOf(question, bodyId)
  return (
    <div className="space-y-6">
      <QuestionHeader question={question} />
      <ClosedNote question={question} />
      {people.length === 0 && <p className="text-muted">Nobody holds the role this is asked of on {formatDate(tracker.asOf)}.</p>}
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {people.map(({ key, roleLabel, certainty, contender, seat }) => (
          <li key={key}>
            <Link
              to="/q/$slug/$decider"
              params={{ slug: question.slug, decider: contender.decider.slug }}
              className="block rounded-xl border-2 border-ink bg-surface p-3 transition-transform hover:-translate-y-0.5"
            >
              <span className="flex items-start justify-between gap-2">
                <span className="leading-snug font-medium">{contender.decider.name}</span>
                <StandingPill standing={contender.standing} question={question} />
              </span>
              <span className="block text-xs text-muted">
                {roleLabel ?? seat.label}
                {contender.role.affiliation && ` · ${contender.role.affiliation}`}
              </span>
              <span className="mt-2 flex flex-wrap items-center gap-2">
                {contender.footing !== 'unknown' && <FootingTag footing={contender.footing} />}
                <CertaintyTag certainty={certainty} />
                <AskStatus ask={question} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-4">
        <EditorTools question={question} />
        {parent && (
          <Link to="/q/$slug" params={{ slug: parent.slug }} className="link text-sm">
            ← {parent.title}
          </Link>
        )}
      </div>
    </div>
  )
}

function EditorTools({ question }: { question: Question }) {
  const { tracker } = useTracker()
  if (!isEditor()) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link to="/editor/questions/$slug/edit" params={{ slug: question.slug }} className="btn">
        Edit this {nounOf(question, tracker.isAsk(question))}
      </Link>
      <CloseQuestion question={question} />
    </div>
  )
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: (on: boolean) => void; children: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={() => onChange(!on)} className={`btn ${on ? 'btn-primary' : ''}`}>
      {children}
    </button>
  )
}

function SeatCard({ row, question }: { row: HeldSeat; question: Question }) {
  const { tracker } = useTracker()
  const inc = row.incumbent
  return (
    <li className="relative overflow-hidden rounded-xl border-2 border-ink bg-surface">
      <span className={`absolute inset-y-0 left-0 w-1.5 ${STANDING_BG[inc.standing]}`} />
      <Link to="/q/$slug/$decider" params={{ slug: question.slug, decider: inc.decider.slug }} className="block py-2 pr-3 pl-4 hover:bg-paper">
        <span className="flex items-start justify-between gap-2">
          <span className="leading-snug font-medium">{inc.decider.name}</span>
          <span className="flex shrink-0 flex-wrap justify-end gap-1">
            <CertaintyTag certainty={inc.role.certainty} />
            {inc.footing !== 'unknown' && <FootingTag footing={inc.footing} />}
          </span>
        </span>
        <span className="block text-xs text-muted">
          {row.seat.label}
          {inc.role.affiliation && ` · ${inc.role.affiliation}`}
          {!row.seat.is_voting && ' · non-voting'}
        </span>
      </Link>
      {row.alternates.length > 0 && (
        <p className="border-t border-line py-1.5 pr-3 pl-4 text-xs text-muted">
          or{' '}
          {row.alternates.map((a, i) => (
            <span key={a.decider.id}>
              {i > 0 && ', '}
              <Link to="/q/$slug/$decider" params={{ slug: question.slug, decider: a.decider.slug }} className="link text-ink">
                {a.decider.name}
              </Link>
            </span>
          ))}
        </p>
      )}
      {row.upcoming.length > 0 && (
        <ul className="border-t border-line py-1.5 pr-3 pl-4 text-xs">
          {row.upcoming.map((c) => (
            <li key={c.role.id}>
              <Link to="/q/$slug/$decider" params={{ slug: question.slug, decider: c.decider.slug }} className="flex items-center gap-1.5 py-0.5 hover:underline">
                <span className={`size-2 shrink-0 rounded-full ${STANDING_BG[c.standing]}`} />
                <span className="truncate">
                  <span className="text-muted">{claimTag(c.role, tracker.asOf)}:</span> {c.decider.name}
                </span>
                <span className="ml-auto whitespace-nowrap text-muted">{standingLabel(c.standing, question)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
