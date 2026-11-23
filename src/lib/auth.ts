import { useMemo } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { createAuthClient } from 'better-auth/react'
import { emailOTPClient } from 'better-auth/client/plugins'
import type { Person } from '../../shared/schema.ts'
import { db } from './db.ts'

export const authClient = createAuthClient({ basePath: '/api/auth', plugins: [emailOTPClient()] })

// Everyone who has signed in, by id.
export function usePeople() {
  const { data } = useLiveQuery((q) => q.from({ row: db.people }))
  return useMemo(() => new Map<string, Person>(data.map((p) => [p.id, p])), [data])
}

// Whether someone is signed in in this browser, without loading anyone's row.
export function useSession() {
  const session = authClient.useSession()
  return { id: session.data?.user.id, isPending: session.isPending }
}

// The person signed in in this browser. Their row arrives through the sync
// room a moment after they first sign in, so `person` can lag `signedIn`.
export function useSignedIn() {
  const { id, isPending } = useSession()
  const byId = usePeople()
  return { signedIn: id !== undefined, person: id ? byId.get(id) : undefined, isPending }
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
