import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { Office } from '../../shared/schema.ts'
import { db } from '../lib/db.ts'
import { holdingLabel, officeDependents } from '../lib/office-form.ts'
import { formatDate } from '../lib/position.ts'
import { useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { Section, notSaved } from '../components/form.tsx'
import { OfficeForm } from '../components/OfficeForm.tsx'

export const Route = createFileRoute('/_editor/offices/$officeId/')({ component: EditOffice })

function EditOffice() {
  const { officeId } = Route.useParams()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />
  const office = tracker.offices.find((o) => o.id === officeId)
  if (!office) return <NotFound what="office" />
  const body = office.body_id ? tracker.bodyById.get(office.body_id) : undefined

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        {body ? (
          <Link to="/bodies/$slug" params={{ slug: body.slug }} hash="offices" className="link text-sm">
            ← {body.name}
          </Link>
        ) : (
          <Link to="/bodies" hash="at-large" className="link text-sm">
            ← Bodies
          </Link>
        )}
        <h1 className="h-page">{office.label}</h1>
        <p className="text-muted">{body ? `${office.chamber ? `${office.chamber} · ` : ''}${body.name}` : 'Held at large'}</p>
      </div>
      <OfficeForm key={office.id} body={body} editing={office} />
      <Holders office={office} />
      <Asks office={office} />
      <DeleteOffice office={office} />
    </div>
  )
}

function Holders({ office }: { office: Office }) {
  const { tracker } = useTracker()
  const holders = tracker.officeHolders.filter((h) => h.office_id === office.id).sort((a, b) => (a.starts_on ?? '').localeCompare(b.starts_on ?? '') || a.id.localeCompare(b.id))
  return (
    <Section id="holders" title="Who holds it" hint="Each stretch someone holds the office, past, present or to come. An ask put to the office goes to whoever holds it on the day viewed.">
      {holders.length === 0 && <p className="text-sm">Nobody yet.</p>}
      {holders.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {holders.map((h) => {
            const person = tracker.deciderById.get(h.decider_id)
            return (
              <li key={h.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{person?.name ?? 'Someone no longer on file'}</span>
                  <span className="block text-xs text-muted first-letter:uppercase">{holdingLabel(h, tracker.asOf, formatDate)}</span>
                </span>
                <Link to="/holdings/$holdingId" params={{ holdingId: h.id }} className="link shrink-0">
                  Edit <span className="sr-only">the holding of {person?.name}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      <Link to="/offices/$officeId/holders/new" params={{ officeId: office.id }} className="btn btn-sm">
        Give someone this office
      </Link>
    </Section>
  )
}

function Asks({ office }: { office: Office }) {
  const { tracker } = useTracker()
  const asks = tracker.questionOffices.flatMap((l) => (l.office_id === office.id ? (tracker.questionById.get(l.question_id) ?? []) : []))
  return (
    <Section id="asks" title="Asks put to it" hint="An ask is put to an office from the ask's own edit page.">
      {asks.length === 0 ? (
        <p className="text-sm">None yet.</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {asks.map((q) => (
            <li key={q.id} className="py-2 text-sm">
              <Link to="/q/$slug" params={{ slug: q.slug }} className="link">
                {q.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function DeleteOffice({ office }: { office: Office }) {
  const { tracker } = useTracker()
  const navigate = Route.useNavigate()
  const [error, setError] = useState<string | null>(null)
  const dependents = officeDependents(office, tracker)
  const body = office.body_id ? tracker.bodyById.get(office.body_id) : undefined

  function remove() {
    if (!window.confirm(`Remove the office ${office.label}? It is gone from every page.`)) return
    setError(null)
    // Not optimistic: the office stays on this page until the server has deleted it.
    db.offices.delete(office.id, { optimistic: false }).isPersisted.promise.then(
      () => (body ? navigate({ to: '/bodies/$slug', params: { slug: body.slug }, hash: 'offices' }) : navigate({ to: '/bodies', hash: 'at-large' })),
      (err: unknown) => setError(notSaved(err)),
    )
  }

  return (
    <Section id="delete-office" title="Removing">
      {dependents.length > 0 ? (
        <p className="text-sm">This office cannot be removed while it has {dependents.join(', ')}.</p>
      ) : (
        <>
          <p className="text-sm text-muted">Nobody has held this office and no ask is put to it, so it can be removed.</p>
          <button type="button" className="btn" onClick={remove}>
            Remove this office
          </button>
        </>
      )}
      {error && <p className="text-sm text-oppose">{error}</p>}
    </Section>
  )
}
