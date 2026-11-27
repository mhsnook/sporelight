import type { ReviewerRow } from '../lib/build-tracker.ts'
import { DIRECTION_LABEL } from '../lib/position.ts'
import { ORDER_NOTE, answersLabel, confirmsLine, notCountedLine, readingFromLine, reviewedByLine, reviewerOf, type ReviewerPerson } from '../lib/reviewers.ts'
import { useTracker } from '../lib/tracker.tsx'

// Whose reviews the reading of an act on a question comes from: a short line that opens to every review of it.
export function ReviewedBy({ actId, questionId, className = '' }: { actId: string; questionId: string; className?: string }) {
  const { tracker, people } = useTracker()
  const reviewers = tracker.reviewersOf(actId, questionId)
  if (!reviewers) return null
  return (
    <details className={`text-sm ${className}`} data-testid="reviewed-by">
      <summary className="cursor-pointer text-xs text-muted hover:text-ink">{reviewedByLine(reviewers)}</summary>
      <div className="mt-2 space-y-3 rounded-lg border border-line bg-paper/60 p-3">
        <p>{readingFromLine(reviewers)}</p>
        <ul className="space-y-2.5">
          {reviewers.rows.map((row) => (
            <ReviewerItem key={row.review.id} row={row} people={people} />
          ))}
        </ul>
        <p className="text-xs text-muted">{ORDER_NOTE}</p>
      </div>
    </details>
  )
}

function ReviewerItem({ row, people }: { row: ReviewerRow; people: ReadonlyMap<string, ReviewerPerson> }) {
  const { name, is } = reviewerOf(row, people)
  return (
    <li className={row.notCounted ? 'text-muted' : ''}>
      <p className="flex flex-wrap items-baseline gap-x-2">
        {name ? <span className="font-semibold">{name}</span> : <span className="text-faint italic">No name yet</span>}
        <span className="text-xs text-muted">{is ?? 'no account on file, so counted with the agents'}</span>
      </p>
      <p className="first-letter:uppercase">
        {row.via && row.position ? `On ${row.via.short_title}: ${answersLabel(row.review)}, which counts here as ${DIRECTION_LABEL[row.position]}` : answersLabel(row)}
      </p>
      {row.confirms && <p className="text-xs text-muted">{confirmsLine(row.confirms, people)}</p>}
      {row.notCounted && <p className="text-xs">{notCountedLine(row.notCounted)}</p>}
    </li>
  )
}
