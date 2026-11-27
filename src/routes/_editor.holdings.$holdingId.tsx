import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { OfficeHolder } from '../../shared/schema.ts'
import { endHolding, holdingLabel } from '../lib/office-form.ts'
import { formatDate } from '../lib/position.ts'
import { commit } from '../lib/review.ts'
import { today, useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { Section, notSaved } from '../components/form.tsx'
import { HoldingForm } from '../components/OfficeForm.tsx'

export const Route = createFileRoute('/_editor/holdings/$holdingId')({ component: EditHolding })

function EditHolding() {
  const { holdingId } = Route.useParams()
  const { tracker, isReady } = useTracker()
  const [ends, setEnds] = useState(0)
  if (!isReady) return <Syncing />
  const holder = tracker.officeHolders.find((h) => h.id === holdingId)
  const office = holder && tracker.offices.find((o) => o.id === holder.office_id)
  const person = holder && tracker.deciderById.get(holder.decider_id)
  if (!holder || !office || !person) return <NotFound what="holding" />

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Link to="/offices/$officeId" params={{ officeId: office.id }} hash="holders" className="link text-sm">
          ← {office.label}
        </Link>
        <h1 className="h-page">
          {person.name} as {office.label}
        </h1>
        <p className="text-muted first-letter:uppercase">{holdingLabel(holder, tracker.asOf, formatDate)}</p>
        <p>
          <Link to="/people/$slug" params={{ slug: person.slug }} className="link">
            {person.name}
          </Link>
        </p>
      </div>
      <HoldingForm key={ends} office={office} editing={{ holder, person }} />
      <EndHolding holder={holder} onEnded={() => setEnds((n) => n + 1)} />
    </div>
  )
}

// `onEnded` resets the form above, whose end date field would otherwise still show it empty.
function EndHolding({ holder, onEnded }: { holder: OfficeHolder; onEnded: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const save = (ends_on: string) => {
    setError(null)
    commit([endHolding(holder, ends_on)]).catch((err: unknown) => setError(notSaved(err)))
    onEnded()
  }
  return (
    <Section id="end-holding" title="Ending" hint="When they leave the office. The holding stays on file with its dates, and an ask put to the office goes to whoever holds it next.">
      {holder.ends_on ? (
        <p className="text-sm">Ends on {formatDate(holder.ends_on)}. Clear the end date above to undo it.</p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            save(new FormData(e.currentTarget).get('ends_on') as string)
          }}
        >
          <div>
            <label className="label" htmlFor="end-on">
              Ends on
            </label>
            <input id="end-on" name="ends_on" type="date" required defaultValue={today()} className="field" />
          </div>
          <button className="btn">End the holding</button>
        </form>
      )}
      {error && <p className="text-sm text-oppose">{error}</p>}
    </Section>
  )
}
