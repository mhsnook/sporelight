import { useMemo } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { createAuthClient } from 'better-auth/react'
import { adminClient, emailOTPClient } from 'better-auth/client/plugins'
import { ROLE_RIGHTS, roleOf } from '../../shared/account-roles.ts'
import type { AccountRole, Person } from '../../shared/schema.ts'
import { db, onReset, resetSync } from './db.ts'

export const authClient = createAuthClient({ basePath: '/api/auth', plugins: [emailOTPClient(), adminClient({ roles: ROLE_RIGHTS })] })

// The room resets this browser's sync when the person's role changes or they
// are deactivated, and then the session has to be read again too. A reset this
// browser asked for follows a session change it has already read.
onReset((reason) => {
  if (reason === 'identity-changed') authClient.$store.notify('$sessionSignal')
})

// When the person signed in here changes, by signing in, signing out or a
// session ending, the room is asked again what this browser may read.
let syncedAs: string | null | undefined
authClient.$store.atoms.session.subscribe((session: { data: { user: { id: string } } | null; isPending: boolean }) => {
  if (session.isPending) return
  const id = session.data?.user.id ?? null
  if (syncedAs !== undefined && id !== syncedAs) resetSync()
  syncedAs = id
})

export const signOut = () => authClient.signOut()

// Everyone who has signed in, by id.
export function usePeople() {
  const { data, isReady } = useLiveQuery((q) => q.from({ row: db.people }))
  const byId = useMemo(() => new Map<string, Person>(data.map((p) => [p.id, p])), [data])
  return { byId, isReady }
}

// Whether someone is signed in in this browser, without loading anyone's row.
export function useSession() {
  const session = authClient.useSession()
  const role: AccountRole | undefined = session.data ? roleOf(session.data.user) : undefined
  return { id: session.data?.user.id, role, isPending: session.isPending }
}

export const useIsEditor = () => useSession().role === 'editor'

// The person signed in in this browser. Their row arrives through the sync
// room a moment after they first sign in, so `person` can lag `signedIn`.
// Until `peopleReady`, a missing `person` says nothing about whether they have a row.
export function useSignedIn() {
  const { id, role, isPending } = useSession()
  const people = usePeople()
  return { signedIn: id !== undefined, role, person: id ? people.byId.get(id) : undefined, isPending, peopleReady: people.isReady }
}

// A post only a signed-in person may make. A 401 means the session ended
// elsewhere, so Better Auth is told to fetch it again and the forms show the
// sign-in prompt.
export async function postAsReader(path: string, body: unknown): Promise<Response> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (res.status === 401) authClient.$store.notify('$sessionSignal')
  return res
}

export async function setDisplayName(name: string): Promise<string | null> {
  const res = await fetch('/api/me/name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: name }) })
  return res.ok ? null : (((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Something went wrong.')
}
