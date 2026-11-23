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

// The person signed in in this browser. Their row arrives through the sync
// room a moment after they first sign in, so `person` can lag `signedIn`.
export function useSignedIn() {
  const session = authClient.useSession()
  const byId = usePeople()
  const id = session.data?.user.id
  return { signedIn: id !== undefined, person: id ? byId.get(id) : undefined, isPending: session.isPending }
}

export async function setDisplayName(name: string): Promise<string | null> {
  const res = await fetch('/api/me/name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: name }) })
  return res.ok ? null : (((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Something went wrong.')
}
