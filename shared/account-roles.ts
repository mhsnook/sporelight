import { defaultAc } from 'better-auth/plugins/admin/access'
import type { AccountRole } from './schema.ts'

// What each role may do through Better Auth's admin routes. An editor changes
// roles and deactivates people, and nothing else: listing or getting users would
// hand them email addresses, and impersonating would let them write as someone else.
export const ROLE_RIGHTS = {
  member: defaultAc.newRole({ user: [], session: [] }),
  editor: defaultAc.newRole({ user: ['set-role', 'ban'], session: [] }),
} satisfies Record<AccountRole, unknown>
