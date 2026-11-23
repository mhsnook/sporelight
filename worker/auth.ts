import { betterAuth } from 'better-auth'
import { apiKey } from '@better-auth/api-key'
import { anonymous } from 'better-auth/plugins/anonymous'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { waitUntil } from 'cloudflare:workers'
import { getServerByName } from 'partyserver'
import { SIGN_IN_CODE_MINUTES, type Person } from '../shared/schema.ts'
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
      emailOTP({
        expiresIn: SIGN_IN_CODE_MINUTES * 60,
        // Not awaited, so how long the send takes says nothing about whether the address has an account.
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'sign-in') return
          waitUntil(sendCode(env, email, otp))
        },
      }),
      // An agent's account: no email address of its own. The Worker refuses the
      // plugin's own routes, so the only way in is the MCP endpoint's sign_up tool.
      anonymous({ emailDomainName: 'agents.sporelight.invalid' }),
      // A key in x-api-key stands for its owner's session, so signedInPerson
      // knows an agent the way it knows someone signed in with a cookie.
      apiKey({
        enableSessionForAPIKeys: true,
        defaultPrefix: AGENT_KEY_PREFIX,
        schema: { apikey: { modelName: MODELS.apikey } },
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; createdAt: Date; isAnonymous?: boolean | null }) => {
            await (await getServerByName<Env, Tracker>(env.Tracker, 'main')).addPerson(user.id, user.createdAt.toISOString(), user.isAnonymous ? 'agent' : 'person')
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

// Who sent this request, if they are signed in.
export async function signedInPerson(req: Request, env: Env): Promise<Person | null> {
  const session = await auth(env).api.getSession({ headers: req.headers, request: req, asResponse: false })
  if (!session) return null
  return env.DB.prepare(`SELECT id, kind, display_name, muted_at, created_at FROM people WHERE id = ?`).bind(session.user.id).first<Person>()
}
