import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { Role, Seat } from '../../shared/schema.ts'
import { db } from '../lib/db.ts'
import { claimLabel, plural } from '../lib/position.ts'
import { seatClaims } from '../lib/seat-form.ts'
import { useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { Section, notSaved } from '../components/form.tsx'
import { SeatForm } from '../components/SeatForm.tsx'

export const Route = createFileRoute('/_editor/seats/$seatId')({ component: EditSeat })

function EditSeat() {
  const { seatId } = Route.useParams()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />
  const seat = tracker.seatById.get(seatId)
  const body = seat && tracker.bodyById.get(seat.body_id)
  if (!seat || !body) return <NotFound what="seat" />
  const claims = seatClaims(seat, tracker.roles).sort((a, b) => (a.starts_on ?? '').localeCompare(b.starts_on ?? '') || a.id.localeCompare(b.id))

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Link to="/bodies/$slug" params={{ slug: body.slug }} hash="seats" className="link text-sm">
          ← {body.name}
        </Link>
        <h1 className="h-page">{seat.label}</h1>
        <p className="text-muted">
          {seat.chamber ? `${seat.chamber} · ` : ''}
          {body.name}
        </p>
      </div>
      <SeatForm key={seat.id} seat={seat} body={body} />
      <Claims seat={seat} claims={claims} />
      <DeleteSeat seat={seat} claims={claims} bodySlug={body.slug} />
    </div>
  )
}

function Claims({ seat, claims }: { seat: Seat; claims: Role[] }) {
  const { tracker } = useTracker()
  return (
    <Section id="claims" title="Who holds it" hint="Each claim on the seat, past, present or to come: its holder, a member-elect, someone running for it.">
      {claims.length === 0 && <p className="text-sm">Nobody yet.</p>}
      {claims.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {claims.map((r) => {
            const decider = tracker.deciderById.get(r.decider_id)
            return (
              <li key={r.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{decider?.name ?? 'Someone no longer on file'}</span>
                  <span className="block text-xs text-muted first-letter:uppercase">
                    {claimLabel(r, tracker.asOf)}
                    {r.affiliation && ` · ${r.affiliation}`}
                  </span>
                </span>
                <Link to="/roles/$roleId" params={{ roleId: r.id }} className="link shrink-0">
                  Edit <span className="sr-only">the role of {decider?.name}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      <Link to="/roles/new" search={{ seat: seat.id }} className="btn btn-sm">
        Give someone a role on this seat
      </Link>
    </Section>
  )
}

// A seat that has had a claim on it, ended or not, stays on file. Only one entered by mistake is removed.
function DeleteSeat({ seat, claims, bodySlug }: { seat: Seat; claims: Role[]; bodySlug: string }) {
  const navigate = Route.useNavigate()
  const [error, setError] = useState<string | null>(null)

  function remove() {
    if (!window.confirm(`Remove the seat ${seat.label}? It is gone from every page.`)) return
    setError(null)
    // Not optimistic: the seat stays on this page until the server has deleted it.
    db.seats.delete(seat.id, { optimistic: false }).isPersisted.promise.then(
      () => navigate({ to: '/bodies/$slug', params: { slug: bodySlug }, hash: 'seats' }),
      (err: unknown) => setError(notSaved(err)),
    )
  }

  return (
    <Section id="delete-seat" title="Removing">
      {claims.length > 0 ? (
        <p className="text-sm">
          This seat cannot be removed, since it has {claims.length === 1 ? 'a claim' : plural(claims.length, 'claim', 'claims')} on file. Change its label or whether it votes instead.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">Nobody has had a claim on this seat, so it can be removed, as for one entered by mistake.</p>
          <button type="button" className="btn" onClick={remove}>
            Remove this seat
          </button>
        </>
      )}
      {error && <p className="text-sm text-oppose">{error}</p>}
    </Section>
  )
}
