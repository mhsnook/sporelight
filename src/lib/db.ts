import { useSyncExternalStore } from 'react'
import { createPartyDb, partyTransport } from 'party-db/client'
import { allCollections } from '../../shared/schema.ts'

// The room knows who is signed in from Better Auth's session cookie, which the
// browser sends on the socket and on each write.
const transport = partyTransport({ host: window.location.host, party: 'tracker', room: 'main' })

const party = createPartyDb(transport, [...allCollections])

export const db = party.db
export const persist = party.persist
export const onAuthError = party.onAuthError
export const onReset = party.onReset
// After signing in or out, the room has to be asked again what this browser may read.
export const resetSync = () => party.reset()

let generation = 0
onReset(() => void generation++)
// Changes on each reset. A query keeps reading the collection it was made with,
// so a page that reads a table only signed-in people are sent is remounted
// under this as a key. Public tables are kept across a reset.
export const useSyncGeneration = () => useSyncExternalStore(onReset, () => generation)
