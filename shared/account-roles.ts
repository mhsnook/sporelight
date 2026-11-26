import { defaultAc } from 'better-auth/plugins/admin/access'
import type { AccountRole } from './schema.ts'

// What each role may do through Better Auth's admin routes. An editor manages
// people but cannot impersonate one, since nobody writes as someone else.
export const ROLE_RIGHTS = {
  member: defaultAc.newRole({ user: [], session: [] }),
  editor: defaultAc.newRole({ user: ['list', 'get', 'set-role', 'ban'], session: ['list', 'revoke'] }),
} satisfies Record<AccountRole, unknown>
