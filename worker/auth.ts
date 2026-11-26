import { betterAuth } from 'better-auth'
import { apiKey } from '@better-auth/api-key'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { admin } from 'better-auth/plugins/admin'
import { anonymous } from 'better-auth/plugins/anonymous'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { waitUntil } from 'cloudflare:workers'
import { getServerByName } from 'partyserver'
import { ROLE_RIGHTS, roleOf } from '../shared/account-roles.ts'
import { SIGN_IN_CODE_MINUTES, type AccountRole, type Person } from '../shared/schema.ts'
import type { Tracker } from './tracker.ts'

// Better Auth's own tables. They hold each person's email address and their
// sessions, and none of them is synced to the browser.
const MODELS = {
  user: 'auth_users',
  session: 'auth_sessions',
  account: 'auth_accounts',
  verification: 'auth_verifications',
  rateLimit: 'auth_rate_limits',
  apikey: 'auth_api_keys',
} as const

export const LAST_EDITOR = 'This is the only editor who can act. Make someone else an editor first.'

// The prefix every agent's key starts with, so a leaked one is easy to recognise.
export const AGENT_KEY_PREFIX = 'sporelight_'

export function authOptions(env: Env) {
  return {
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: { allowedHosts: env.AUTH_HOSTS.split(',').map((host) => host.trim()) },
    basePath: '/api/auth',
    user: { modelName: MODELS.user },
    session: { modelName: MODELS.session },
    account: { modelName: MODELS.account },
    verification: { modelName: MODELS.verification },
    // In memory, a count lasts only as long as one isolate, so it is kept in D1.
    rateLimit: { enabled: true, storage: 'database', modelName: MODELS.rateLimit },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    plugins: [
      admin({ roles: ROLE_RIGHTS, defaultRole: 'member', adminRoles: ['editor'] }),
      emailOTP({
        expiresIn: SIGN_IN_CODE_MINUTES * 60,
        // Not awaited, so how long the send takes says nothing about whether the address has an account.
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'sign-in') return
          waitUntil(sendCode(env, email, otp))
        },
      }),
      // Better Auth wants an email address on every account, and this plugin is
      // its way to make one without: here, only an agent's, which its key
      // identifies. The Worker refuses the plugin's own routes, so the only way
      // in is the MCP endpoint's sign_up tool. Deleting is off, which also stops
      // the plugin removing the account when the agent signs in another way.
      anonymous({ emailDomainName: 'agents.sporelight.invalid', disableDeleteAnonymousUser: true }),
      // A key in x-api-key stands for its owner's session, so signedInPerson
      // knows an agent the way it knows someone signed in with a cookie.
      apiKey({
        enableSessionForAPIKeys: true,
        defaultPrefix: AGENT_KEY_PREFIX,
        schema: { apikey: { modelName: MODELS.apikey } },
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
      }),
    ],
    // Refused here for a clear message; the keep_one_editor trigger refuses it
    // as well, for two such requests at once.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const body = ctx.body as { userId?: unknown; role?: unknown } | undefined
        if (ctx.path === '/admin/set-role') {
          // Better Auth takes a list of roles too, and would count 'editor,member' as an editor where the room counts a member.
          if (body?.role !== 'member' && body?.role !== 'editor') throw new APIError('BAD_REQUEST', { message: 'A role is member or editor.' })
          if (body.role === 'editor' && typeof body.userId === 'string' && (await isAgent(env, body.userId))) throw new APIError('BAD_REQUEST', { message: 'An agent cannot be an editor.' })
        }
        const demoting = (ctx.path === '/admin/set-role' && body?.role !== 'editor') || ctx.path === '/admin/ban-user' || ctx.path === '/admin/remove-user'
        if (!demoting || typeof body?.userId !== 'string' || !(await isLastEditor(env, body.userId))) return
        // Someone who may not make the change is left to Better Auth to refuse.
        const caller = await getSessionFromCtx<{ role?: string | null }>(ctx)
        if (caller && roleOf(caller.user) === 'editor') throw new APIError('BAD_REQUEST', { message: LAST_EDITOR })
      }),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; createdAt: Date; isAnonymous?: boolean | null }) => {
            await (await room(env)).addPerson(user.id, user.createdAt.toISOString(), kindOf(user))
          },
        },
        update: {
          after: async (user: { id: string; role?: string | null; banned?: boolean | null }) => {
            await (await room(env)).syncAccount(user.id, roleOf(user), user.banned === true)
          },
        },
      },
    },
  } satisfies Parameters<typeof betterAuth>[0]
}

const instances = new WeakMap<Env, ReturnType<typeof makeAuth>>()
const makeAuth = (env: Env) => betterAuth(authOptions(env))

export function auth(env: Env) {
  let instance = instances.get(env)
  if (!instance) instances.set(env, (instance = makeAuth(env)))
  return instance
}

async function sendCode(env: Env, email: string, code: string) {
  if (!env.EMAIL_FROM) return console.error('sign-in code not sent: EMAIL_FROM is not set')
  try {
    await env.EMAIL.send({
      from: { email: env.EMAIL_FROM, name: 'Sporelight' },
      to: email,
      subject: `Your Sporelight sign-in code is ${code}`,
      text: `Your Sporelight sign-in code is ${code}. It works once, for ${SIGN_IN_CODE_MINUTES} minutes.\n\nIf you did not ask to sign in, you can ignore this email.`,
    })
  } catch (e) {
    console.error('sign-in code not sent', e)
  }
}

async function isAgent(env: Env, userId: string): Promise<boolean> {
  return (await env.DB.prepare(`SELECT 1 FROM auth_users WHERE id = ? AND "isAnonymous" = 1`).bind(userId).first()) !== null
}

async function isLastEditor(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM active_editors WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM active_editors WHERE id <> ?1)`)
    .bind(userId)
    .first()
  return row !== null
}

export async function hasActiveEditor(env: Env): Promise<boolean> {
  return (await env.DB.prepare(`SELECT 1 FROM active_editors`).first()) !== null
}

// A deployment with no editor who can act takes its first from the first person
// to ask. The check and the grant are one statement, so two people asking at
// once cannot both become the first editor. Better Auth's own route for setting
// a role needs an editor to call it, which a new deployment has not got.
// When FIRST_EDITOR_EMAIL is set, only that address can be made the first editor.
export async function grantFirstEditor(env: Env, userId: string): Promise<boolean> {
  const granted = await env.DB.prepare(
    `UPDATE auth_users SET role = 'editor' WHERE id = ?1 AND (?2 = '' OR lower(email) = lower(?2)) AND NOT EXISTS (SELECT 1 FROM active_editors)`,
  )
    .bind(userId, (env.FIRST_EDITOR_EMAIL ?? '').trim())
    .run()
  return granted.meta.changes === 1
}

const room = (env: Env) => getServerByName<Env, Tracker>(env.Tracker, 'main')

// isAnonymous is Better Auth's mark for an account made without an email address: an agent's.
const kindOf = (user: { isAnonymous?: boolean | null }): Person['kind'] => (user.isAnonymous ? 'agent' : 'person')

// Better Auth refused the key in x-api-key: unknown, disabled, expired, or over its rate limit.
export class KeyRefused extends Error {
  constructor(
    readonly status: 401 | 429,
    message: string,
  ) {
    super(message)
  }
}

type BetterAuthError = { statusCode?: number; body?: { message?: string; details?: { tryAgainIn?: number } } }

// Better Auth's session for this request, if any. Throws KeyRefused for a key
// Better Auth will not accept, so a bad key is never taken for nobody.
async function sessionOf(req: Request, env: Env) {
  let session
  try {
    session = await auth(env).api.getSession({ headers: req.headers, request: req, asResponse: false })
  } catch (e) {
    const { statusCode, body } = e as BetterAuthError
    if (!req.headers.has('x-api-key')) throw e
    if (statusCode === 429) {
      const seconds = Math.ceil((body?.details?.tryAgainIn ?? 60_000) / 1000)
      throw new KeyRefused(429, `Too many requests with this key. Try again in ${seconds} seconds.`)
    }
    // Better Auth answers an unknown key with 403 on this path and a disabled or expired one with 401.
    if (statusCode === 401 || statusCode === 403) throw new KeyRefused(401, `The key in x-api-key was refused: ${body?.message ?? 'it is not valid'}`)
    throw e
  }
  return session
}

// Who sent this request and their role, read from the session alone.
export async function signedInAccount(req: Request, env: Env): Promise<{ id: string; role: AccountRole } | null> {
  const session = await sessionOf(req, env)
  return session && { id: session.user.id, role: roleOf(session.user) }
}

// Who sent this request, if they are signed in, as the public sees them.
export async function signedInPerson(req: Request, env: Env): Promise<Person | null> {
  const session = await sessionOf(req, env)
  if (!session) return null
  const { user } = session
  // The role is read from the session, which is Better Auth's own, not from the public copy.
  const person = async () => {
    const row = await env.DB.prepare(`SELECT id, kind, display_name, role, deactivated_at, created_at FROM people WHERE id = ?`).bind(user.id).first<Person>()
    return row && { ...row, role: roleOf(user) }
  }
  const found = await person()
  if (found) return found
  // The row is added when someone first signs in. If that failed, a valid session adds it here.
  await (await room(env)).addPerson(user.id, new Date(user.createdAt).toISOString(), kindOf(user))
  return person()
}
