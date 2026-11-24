import { betterAuth } from 'better-auth'
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
} as const

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
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; createdAt: Date }) => {
            await (await room(env)).addPerson(user.id, user.createdAt.toISOString())
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

const room = (env: Env) => getServerByName<Env, Tracker>(env.Tracker, 'main')

// Who sent this request, if they are signed in.
export async function signedInPerson(req: Request, env: Env): Promise<Person | null> {
  const session = await auth(env).api.getSession({ headers: req.headers, request: req, asResponse: false })
  if (!session) return null
  const person = () => env.DB.prepare(`SELECT id, display_name, created_at FROM people WHERE id = ?`).bind(session.user.id).first<Person>()
  const found = await person()
  if (found) return found
  // The row is added when someone first signs in. If that failed, a valid session adds it here.
  await (await room(env)).addPerson(session.user.id, new Date(session.user.createdAt).toISOString())
  return person()
}
