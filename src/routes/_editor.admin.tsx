import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { EDITORS_ID, type AccountRole, type Person, type Question } from '../../shared/schema.ts'
import { authClient, usePeople, useSession } from '../lib/auth.ts'
import { db } from '../lib/db.ts'
import { useTracker } from '../lib/tracker.tsx'
import { formatDate } from '../lib/position.ts'

export const Route = createFileRoute('/_editor/admin')({ component: Admin })

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function Admin() {
  return (
    <div className="space-y-12">
      <h1 className="h-page">Admin</h1>
      <People />
      <Questions />
    </div>
  )
}

const row = 'grid items-center gap-x-4 gap-y-2 border-t-2 border-dashed border-line p-4 first:border-t-0 md:grid-cols-[minmax(0,1fr)_10rem_8rem_8rem_8.5rem]'
const head = 'hidden gap-x-4 border-b-2 border-ink px-4 py-2 font-mono text-xs font-semibold uppercase md:grid md:grid-cols-[minmax(0,1fr)_10rem_8rem_8rem_8.5rem]'

function seenText(at: string | undefined) {
  if (!at) return 'Not recorded'
  const day = new Date(at).toISOString().slice(0, 10)
  return day === new Date().toISOString().slice(0, 10) ? 'Today' : formatDate(day)
}

function People() {
  const { byId } = usePeople()
  const me = useSession().id
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({})
  useEffect(() => {
    void fetch('/api/editor/last-seen')
      .then((res) => (res.ok ? (res.json() as Promise<{ last_seen: Record<string, string> }>) : { last_seen: {} }))
      .then((answer) => setLastSeen(answer.last_seen))
  }, [])

  // The identity the retired editor token wrote as is kept for its reviews, and nobody can act as it.
  const people = useMemo(
    () =>
      [...byId.values()]
        .filter((p) => p.id !== EDITORS_ID)
        .sort((a, b) => Number(a.deactivated_at !== null) - Number(b.deactivated_at !== null) || Number(b.id === me) - Number(a.id === me) || a.created_at.localeCompare(b.created_at)),
    [byId, me],
  )
  const activeEditors = people.filter((p) => p.role === 'editor' && p.deactivated_at === null)

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-extrabold">
          People <span className="text-faint">{people.length}</span>
        </h2>
        <p className="text-sm text-muted">Listed by display name. Email addresses are not shown.</p>
      </div>
      <div className="card overflow-hidden">
        <div className={head}>
          <span>Name</span>
          <span>Role</span>
          <span>Joined</span>
          <span>Last seen</span>
          <span />
        </div>
        <ul>
          {people.map((p) => (
            <PersonRow key={p.id} person={p} isMe={p.id === me} lastEditor={activeEditors.length === 1 && activeEditors[0].id === p.id} lastSeen={lastSeen[p.id]} />
          ))}
        </ul>
      </div>
    </section>
  )
}

function PersonRow({ person, isMe, lastEditor, lastSeen }: { person: Person; isMe: boolean; lastEditor: boolean; lastSeen: string | undefined }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = person.display_name ?? 'No name yet'
  const deactivated = person.deactivated_at !== null

  async function act(call: () => Promise<{ error: { message?: string } | null }>) {
    setBusy(true)
    setError(null)
    const { error } = await call().catch((err: unknown) => ({ error: { message: errorText(err) } }))
    setBusy(false)
    if (error) setError(error.message ?? 'Not saved.')
  }
  const setRole = (role: AccountRole) => act(() => authClient.admin.setRole({ userId: person.id, role }))
  const deactivate = () => window.confirm(`Deactivate ${name}? They are signed out and cannot sign in until reactivated.`) && act(() => authClient.admin.banUser({ userId: person.id }))
  const reactivate = () => act(() => authClient.admin.unbanUser({ userId: person.id }))

  return (
    <li className={`${row} ${deactivated ? 'bg-paper text-muted' : ''}`}>
      <div className="min-w-0">
        <p className={`font-bold ${person.display_name ? 'text-ink' : 'font-normal text-faint italic'}`}>
          {name} {isMe && <span className="font-normal text-muted">(you)</span>}
          {person.kind === 'agent' && <span className="tag ml-2 text-muted">Agent</span>}
        </p>
        {deactivated && <p className="text-sm">Deactivated {formatDate(person.deactivated_at!.slice(0, 10))}</p>}
        <p className="text-sm text-muted md:hidden">
          Joined {formatDate(person.created_at.slice(0, 10))} · seen {seenText(lastSeen).toLowerCase()}
        </p>
      </div>
      <div>
        {deactivated || person.kind === 'agent' ? (
          <span>{person.role === 'editor' ? 'Editor' : 'Member'}</span>
        ) : (
          <select
            aria-label={`Role of ${name}`}
            className="field min-h-11 py-1.5"
            value={person.role}
            disabled={busy || lastEditor}
            onChange={(e) => void setRole(e.target.value as AccountRole)}
          >
            <option value="member">Member</option>
            <option value="editor">Editor</option>
          </select>
        )}
      </div>
      <span className="hidden md:block">{formatDate(person.created_at.slice(0, 10))}</span>
      <span className="hidden md:block">{seenText(lastSeen)}</span>
      <div className="md:text-right">
        {deactivated ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void reactivate()}>
            Reactivate
          </button>
        ) : (
          <button type="button" className="btn btn-sm" disabled={busy || lastEditor || isMe} onClick={() => void deactivate()}>
            Deactivate
          </button>
        )}
      </div>
      {lastEditor && (
        <p className="border-l-4 border-ink bg-paper px-3 py-1.5 text-sm font-semibold md:col-span-5">
          {name} is the only editor, so this role cannot be changed and this account cannot be deactivated. Make someone else an editor first.
        </p>
      )}
      {error && (
        <p role="status" className="text-sm text-oppose md:col-span-5">
          {error}
        </p>
      )}
    </li>
  )
}

const qRow = 'grid items-center gap-x-4 gap-y-2 border-t-2 border-dashed border-line p-4 first:border-t-0 md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_6rem_7rem_10rem]'

function Questions() {
  const { tracker } = useTracker()
  const all = useMemo(
    () =>
      [...tracker.questionById.values()].sort(
        (a, b) => (tracker.bodyById.get(a.body_id)?.name ?? '').localeCompare(tracker.bodyById.get(b.body_id)?.name ?? '') || a.sort - b.sort || a.title.localeCompare(b.title),
      ),
    [tracker],
  )
  const listed = all.filter((q) => q.archived_at === null)
  const archived = all.filter((q) => q.archived_at !== null)

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl font-extrabold">
          Questions <span className="text-faint">{listed.length}</span>
        </h2>
        <Link to="/questions/new" className="btn btn-sm">
          New question
        </Link>
      </div>
      <QuestionList questions={listed} />
      {archived.length > 0 && (
        <>
          <h3 className="mt-8 text-lg font-extrabold">
            Archived <span className="text-faint">{archived.length}</span>
          </h3>
          <p className="mb-3 text-sm text-muted">Not listed on /questions and left out of the news search. Each page still works at its address.</p>
          <QuestionList questions={archived} />
        </>
      )}
    </section>
  )
}

function QuestionList({ questions }: { questions: Question[] }) {
  const { tracker } = useTracker()
  return (
    <div className="card overflow-hidden">
      <div className="hidden gap-x-4 border-b-2 border-ink px-4 py-2 font-mono text-xs font-semibold uppercase md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_6rem_7rem_10rem]">
        <span>Title</span>
        <span>Body</span>
        <span>Status</span>
        <span>News search</span>
        <span />
      </div>
      <ul>
        {questions.map((q) => (
          <QuestionRow key={q.id} question={q} body={tracker.bodyById.get(q.body_id)?.name ?? ''} />
        ))}
      </ul>
    </div>
  )
}

const STATUS = { open: 'Open', resolved: 'Resolved', lapsed: 'Lapsed' } as const

function QuestionRow({ question, body }: { question: Question; body: string }) {
  const [error, setError] = useState<string | null>(null)
  const archived = question.archived_at !== null
  function setArchived(on: boolean) {
    setError(null)
    db.questions.update(question.id, (q) => void (q.archived_at = on ? new Date().toISOString() : null)).isPersisted.promise.catch((err: unknown) => setError(`Not saved: ${errorText(err)}`))
  }
  return (
    <li className={qRow}>
      <Link to="/q/$slug" params={{ slug: question.slug }} className="link min-w-0 font-semibold">
        {question.title}
      </Link>
      <span className="flex flex-wrap gap-x-2 text-sm text-muted md:contents md:text-base md:text-ink">
        <span>{body}</span>
        <span>
          <span className="md:hidden">· </span>
          {STATUS[question.status]}
        </span>
        <span className="md:text-muted">
          <span className="md:hidden">· </span>
          {question.is_hot ? (
            'In the news'
          ) : (
            <>
              <span className="md:hidden">Not in the news search</span>
              <span className="hidden md:inline">No</span>
            </>
          )}
        </span>
      </span>
      <span className="flex items-center gap-3 md:justify-end">
        <Link to="/q/$slug/edit" params={{ slug: question.slug }} className="link text-sm font-semibold">
          Edit
        </Link>
        <button type="button" className="btn btn-sm" onClick={() => setArchived(!archived)}>
          {archived ? 'Unarchive' : 'Archive'}
        </button>
      </span>
      {error && (
        <p role="status" className="text-sm text-oppose md:col-span-5">
          {error}
        </p>
      )}
    </li>
  )
}
