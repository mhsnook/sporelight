import type { Certainty, Question } from '../../shared/schema.ts'
import { FOOTING_HINT, FOOTING_LABEL, type Footing } from '../../shared/standing.ts'
import { SPECTRUM, STANDING_BG, STANDING_COLOR, standingLabel, type Standing } from '../lib/position.ts'

export function Logo() {
  return (
    <span className="flex gap-1 rounded-full border-2 border-ink bg-surface px-[5px] py-1 shadow-hard-sm" aria-hidden="true">
      <span className="size-3 rounded-full bg-support" />
      <span className="size-3 rounded-full bg-mixed" />
      <span className="size-3 rounded-full bg-oppose" />
    </span>
  )
}

// "No record yet" is drawn as an empty dashed ring, here and in the seat charts.
export function Token({ standing, className = 'size-5' }: { standing: Standing; className?: string }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full border-2 border-ink ${standing === 'unknown' ? 'border-dashed bg-surface' : STANDING_BG[standing]} ${className}`}
    />
  )
}

// The same token inside an SVG seat chart. `stroke` is a fraction of the radius.
export function SeatToken({ cx, cy, r, standing, stroke = 0.12, dashed = true }: { cx: number; cy: number; r: number; standing: Standing; stroke?: number; dashed?: boolean }) {
  const hollow = standing === 'unknown'
  return (
    <>
      {!hollow && <circle cx={cx} cy={cy + r * 0.24} r={r} fill="var(--color-ink)" stroke="var(--color-ink)" strokeWidth={r * stroke} />}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={hollow ? 'none' : STANDING_COLOR[standing]}
        stroke="var(--color-ink)"
        strokeWidth={r * stroke}
        strokeDasharray={hollow && dashed ? `${r * 0.32} ${r * 0.22}` : undefined}
      />
    </>
  )
}

export function Star({ className = 'size-5 text-[10px]' }: { className?: string }) {
  return <span className={`grid shrink-0 place-items-center rounded-full border-2 border-ink bg-mixed leading-none ${className}`}>★</span>
}

export function StandingPill({ standing, question }: { standing: Standing; question: Pick<Question, 'kind' | 'act_label'> }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-ink bg-surface py-0.5 pr-2.5 pl-1 text-xs font-bold whitespace-nowrap">
      <Token standing={standing} className="size-3.5" />
      {standingLabel(standing, question)}
    </span>
  )
}

export function StandingDot({ standing }: { standing: Standing }) {
  return <Token standing={standing} className="size-3.5" />
}

const FOOTING_STYLE: Record<Footing, string> = {
  unknown: 'border-dashed border-line text-faint',
  on_record: 'border-ink text-ink',
  fresh: 'border-ink bg-lean-support text-ink',
  established: 'border-line text-muted',
  sparse: 'border-dashed border-ink text-ink',
  stale: 'border-dotted border-faint text-faint italic',
}

export function FootingTag({ footing }: { footing: Footing }) {
  return (
    <span title={FOOTING_HINT[footing]} className={`rounded-full border-2 px-2 py-px text-[11px] font-semibold whitespace-nowrap ${FOOTING_STYLE[footing]}`}>
      {FOOTING_LABEL[footing]}
    </span>
  )
}

// A bordered bar filled `done` of `total` of the way. `className` sizes it; `fillClassName` colours the fill.
export function ProgressBar({ label, done, total, className, fillClassName = 'bg-support' }: { label: string; done: number; total: number; className: string; fillClassName?: string }) {
  return (
    <div className={`overflow-hidden rounded-full border-2 border-ink bg-surface ${className}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <div className={`h-full transition-[width] duration-[400ms] ${fillClassName}`} style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
    </div>
  )
}

export function TallyBar({ counts, question }: { counts: Record<Standing, number>; question: Pick<Question, 'kind' | 'act_label'> }) {
  const shown = SPECTRUM.filter((s) => counts[s] > 0)
  const summary = shown.map((s) => `${standingLabel(s, question)} ${counts[s]}`).join(' · ')
  return (
    <div>
      <div className="flex h-4 w-full overflow-hidden rounded-full border-2 border-ink bg-surface" aria-hidden="true">
        {shown.map((s) => (
          <div key={s} className={`border-l-2 border-ink first:border-l-0 ${s === 'unknown' ? 'bg-surface' : STANDING_BG[s]}`} style={{ flex: counts[s] }} />
        ))}
      </div>
      <p className="mt-2.5 text-sm font-semibold tabular-nums">{summary}</p>
    </div>
  )
}

export function tally(standings: Standing[]): Record<Standing, number> {
  const counts = { support: 0, lean_support: 0, mixed: 0, lean_oppose: 0, oppose: 0, unknown: 0 }
  for (const s of standings) counts[s]++
  return counts
}

export function Syncing() {
  return <p className="animate-pulse py-16 text-center text-muted">Syncing the record…</p>
}

export function NotFound({ what }: { what: string }) {
  return <p className="py-16 text-center text-muted">No {what} here.</p>
}

// Marks a seat or office whose holder on the day viewed is not settled.
export function CertaintyTag({ certainty }: { certainty: Certainty }) {
  if (certainty === 'certain') return null
  return (
    <span
      className="rounded border-2 border-dashed border-line px-1.5 py-px text-[11px] font-semibold whitespace-nowrap text-muted"
      title={certainty === 'likely' ? 'Expected, not yet settled.' : 'One of those who may yet hold it.'}
    >
      {certainty === 'likely' ? 'Likely' : 'Possible'}
    </span>
  )
}
