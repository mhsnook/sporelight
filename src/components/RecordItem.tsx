import type { ReactNode } from 'react'
import { isWebAddress, type Act, type Question, type Source, type Weight } from '../../shared/schema.ts'
import { ArchiveControls } from './ArchiveControls.tsx'
import { useSession } from '../lib/auth.ts'
import type { RecordEntry } from '../lib/tracker.tsx'
import { KIND_LABEL, POSITION_LABEL, STANDING_BG, actDate, formatDate, publishedLine, sourceLabel } from '../lib/position.ts'

export function RecordItem({ entry, question, children }: { entry: RecordEntry; question?: Question; children?: ReactNode }) {
  const { act, reading, via, reports, lapse } = entry
  return (
    <li className="rounded-xl border-2 border-ink bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <ActDateAndKind act={act} />
        {via && via.id !== question?.id && <span className="rounded bg-paper px-1.5 py-0.5">{via.short_title}</span>}
        <WeightTag weight={reading.weight} />
        {!entry.checked && <UncheckedTag />}
        {lapse === 'withdrawn' && act.withdrawn_on && <span className="rounded bg-paper px-1.5 py-0.5">Withdrawn {formatDate(act.withdrawn_on)}</span>}
        {lapse === 'closed' && via && <span className="rounded bg-paper px-1.5 py-0.5">{via.short_title} has closed</span>}
        <span className="ml-auto flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${STANDING_BG[reading.position]}`} />
          {POSITION_LABEL[reading.position]}
        </span>
      </div>
      <ActWords kind={act.kind} words={act.body} />
      <SourceList reports={reports} />
      {children}
    </li>
  )
}

export function ActDateAndKind({ act }: { act: Act }) {
  return (
    <>
      {act.occurred_on ? (
        <time dateTime={act.occurred_on} className="font-semibold text-ink">
          {formatDate(act.occurred_on)}
        </time>
      ) : (
        <span className="font-semibold text-ink">{actDate(null)} · not counted until dated</span>
      )}
      <span>·</span>
      <span>{KIND_LABEL[act.kind]}</span>
    </>
  )
}

export function SourceList({ reports }: { reports: RecordEntry['reports'] }) {
  const signedIn = useSession().id !== undefined
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {reports.map(({ report, source }) => (
        <li key={report.id}>
          {source.url ? (
            <a href={source.url} target="_blank" rel="noreferrer" className="link">
              {sourceLabel(source)} ↗
            </a>
          ) : (
            <span className="text-muted">{sourceLabel(source)}</span>
          )}
          {source.published_on && <span className="text-xs text-muted"> · {publishedLine(source)}</span>}
          <ArchivedCopy source={source} />
          {signedIn && <ArchiveControls source={source} />}
        </li>
      ))}
    </ul>
  )
}

export function UncheckedTag() {
  return <span className="rounded border border-dashed border-line px-1.5 py-0.5">Not checked by an editor</span>
}

// Marks a reading that is less than the person saying where they stand: a signal, or someone else's account of them.
export function WeightTag({ weight }: { weight: Weight | null }) {
  if (weight !== 'passing' && weight !== 'presumed') return null
  return (
    <span
      className="rounded border border-dashed border-line px-1.5 py-0.5"
      title={
        weight === 'passing'
          ? 'A remark in passing, or about something next to the question. It tells you something here without putting them on the record.'
          : 'Someone else’s account of where they stand. We have no words or act of their own for this yet.'
      }
    >
      {weight === 'passing' ? 'Signal' : 'Presumed, no quote of their own yet'}
    </span>
  )
}

// The words of an act inside the passage of the source they sit in, or null
// if the passage does not hold them.
export function splitPassage(passage: string | null, words: string): { before: string; mark: string; after: string } | null {
  const at = passage ? passage.indexOf(words) : -1
  return at === -1 ? null : { before: passage!.slice(0, at), mark: words, after: passage!.slice(at + words.length) }
}

export function Marked({ before, mark, after }: { before: string; mark: string; after: string }) {
  return (
    <>
      {before}
      <mark className="border-b-2 border-accent bg-mint px-0.5 font-semibold text-ink">{mark}</mark>
      {after}
    </>
  )
}

// With a passage, the words are shown marked in it. Without one, a statement is a quotation.
export function ActWords({ kind, words, passage = null }: { kind: Act['kind']; words: string; passage?: string | null }) {
  const split = splitPassage(passage, words)
  if (split && (split.before.trim() || split.after.trim())) {
    return (
      <p className="leading-relaxed text-muted">
        <Marked {...split} />
      </p>
    )
  }
  return kind !== 'says' ? (
    <p>{words}</p>
  ) : (
    <blockquote className="border-l-2 border-accent pl-3 font-display text-lg leading-snug">“{words}”</blockquote>
  )
}

export function ArchivedCopy({ source }: { source: Pick<Source, 'archive_url'> }) {
  // Editors write this through the sync socket, which checks nothing about it.
  if (!isWebAddress(source.archive_url)) return null
  return (
    <>
      {' '}
      <a href={source.archive_url} target="_blank" rel="noreferrer" className="text-xs text-muted underline decoration-dotted underline-offset-2 hover:text-ink">
        archived
      </a>
    </>
  )
}
