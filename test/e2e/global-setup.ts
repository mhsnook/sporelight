import { request, type FullConfig } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { codeFor, EDITOR_EMAIL, EDITOR_STATE } from './fixtures.ts'

// The database is fresh, so it has no editor. The flows' editor becomes its first
// the way a new deployment's does, and the session is kept for every flow that needs one.
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } })
  const asked = await api.post('/api/auth/email-otp/send-verification-otp', { data: { email: EDITOR_EMAIL, type: 'sign-in' } })
  if (!asked.ok()) throw new Error(`no code sent: ${asked.status()}`)
  const signedIn = await api.post('/api/auth/sign-in/email-otp', { data: { email: EDITOR_EMAIL, otp: codeFor(EDITOR_EMAIL) } })
  if (!signedIn.ok()) throw new Error(`not signed in: ${signedIn.status()}`)
  for (const [path, data] of [['/api/me/name', { display_name: 'Flow Editor' }], ['/api/setup', {}]] as const) {
    const res = await api.post(path, { data })
    if (!res.ok()) throw new Error(`${path} answered ${res.status()}: ${await res.text()}`)
  }
  mkdirSync(dirname(EDITOR_STATE), { recursive: true })
  await api.storageState({ path: EDITOR_STATE })
  await api.dispose()
}
