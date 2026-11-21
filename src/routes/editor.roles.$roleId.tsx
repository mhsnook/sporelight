import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { inArray, useLiveQuery } from '@tanstack/react-db'
import type { Role } from '../../shared/schema.ts'
import { db } from '../lib/db.ts'
import { endRole, roleDependents, roleInputOf, threadsFor } from '../lib/role-form.ts'
import { commit } from '../lib/review.ts'
import { claimLabel, formatDate } from '../lib/position.ts'
import { today, useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { notSaved } from '../components/form.tsx'
import { RoleForm } from '../components/RoleForm.tsx'

export const Route = createFileRoute('/editor/roles/$roleId')({ component: EditRole })

function EditRole() {
  const { roleId } = Route.useParams()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />
  const role = tracker.roles.find((r) => r.id === roleId)
  const seat = role && tracker.seatById.get(role.seat_id)
  const decider = role && tracker.deciderById.get(role.decider_id)
  if (!role || !seat || !decider) return <NotFound what="role" />
  const body = tracker.bodyById.get(seat.body_id)
  const question = tracker.questionsIn(seat.body_id)[0]

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <Link to="/editor/people/$slug" params={{ slug: decider.slug }} className="link text-sm">
          ← {decider.name}
        </Link>
        <h1 className="h-page">
          {decider.name} on {seat.label}
        </h1>
        <p className="text-muted first-letter:uppercase">
          {claimLabel(role, tracker.asOf)} · {body?.name}
        </p>
        {question && body && (
          <p>
            <Link to="/q/$slug" params={{ slug: question.slug }} search={{ body: body.slug, q: seat.label }} className="link">
              {seat.label} on {question.short_title}
            </Link>
          </p>
        )}
      </div>

      <RoleForm key={role.ends_on ?? ''} seat={seat} person={decider} start={roleInputOf(role)} editing={role} />
      <EndRole role={role} />
      <DeleteRole role={role} personSlug={decider.slug} />
    </div>
  )
}

function EndRole({ role }: { role: Role }) {
  const [error, setError] = useState<string | null>(null)
  const save = (ends_on: string) => {
    setError(null)
    commit([endRole(role, ends_on)]).catch((err: unknown) => setError(notSaved(err)))
  }
  return (
    <section aria-labelledby="end-role" className="card space-y-3 p-4 sm:p-6">
      <div>
        <h2 id="end-role" className="text-lg font-extrabold">
          Ending
        </h2>
        <p className="text-sm text-muted">When they leave the seat, lose a race or stop running. The claim stays on file with its dates, and their record stays theirs.</p>
      </div>
      {role.ends_on ? (
        <p className="text-sm">Ends on {formatDate(role.ends_on)}. Clear the end date above to undo it.</p>
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
          <button className="btn">End the role</button>
        </form>
      )}
      {error && <p className="text-sm text-oppose">{error}</p>}
    </section>
  )
}

// A role can be deleted only when nothing on file needs it to be found. Otherwise it is ended.
function DeleteRole({ role, personSlug }: { role: Role; personSlug: string }) {
  const { tracker } = useTracker()
  const navigate = Route.useNavigate()
  const [error, setError] = useState<string | null>(null)
  const threads = threadsFor(role, tracker)
  const proposalItems = useLiveQuery((q) => q.from({ row: db.proposal_items }))
  const proposalMentions = useLiveQuery((q) => q.from({ row: db.proposal_mentions }))
  const comments = useLiveQuery({ query: (q) => q.from({ c: db.comments }).where(({ c }) => inArray(c.thread_id, threads)) })
  const loaded = proposalItems.isReady && proposalMentions.isReady && comments.isReady
  const dependents = loaded ? roleDependents(role, tracker, { proposalItems: proposalItems.data, proposalMentions: proposalMentions.data, comments: comments.data }) : []

  function remove() {
    if (!window.confirm('Delete this role? It is gone from every page, with no record that it was there.')) return
    setError(null)
    commit([{ on: 'roles', type: 'delete', id: role.id }]).then(
      () => navigate({ to: '/editor/people/$slug', params: { slug: personSlug } }),
      (err: unknown) => setError(notSaved(err)),
    )
  }

  return (
    <section aria-labelledby="delete-role" className="card space-y-3 p-4 sm:p-6">
      <h2 id="delete-role" className="text-lg font-extrabold">
        Deleting
      </h2>
      {!loaded ? (
        <p className="text-sm text-muted">Checking what depends on this role…</p>
      ) : dependents.length > 0 ? (
        <p className="text-sm">
          This role cannot be deleted, since without it their page in this body would be lost along with {dependents.join(', ')}. End it instead.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">Nothing on file depends on this role, so it can be deleted, as for one entered by mistake.</p>
          <button type="button" className="btn" onClick={remove}>
            Delete this role
          </button>
        </>
      )}
      {error && <p className="text-sm text-oppose">{error}</p>}
    </section>
  )
}
