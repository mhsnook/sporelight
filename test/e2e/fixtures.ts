import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { query } from './db.ts'

// "Today" in the app is the browser's date, and the next-term toggle only shows
// while a body's next term lies ahead. Fixing the clock keeps these flows
// meaning the same thing after the 120th Congress starts on 2027-01-03.
export const TODAY = new Date('2026-11-19T15:00:00Z')

export const editorToken = () => {
  const vars = readFileSync(new URL('../../.dev.vars', import.meta.url), 'utf8')
  const token = vars.match(/^EDITOR_TOKEN=(.*)$/m)?.[1]?.trim()
  if (!token) throw new Error('EDITOR_TOKEN is not set in .dev.vars')
  return token
}

// Writes batches through the editor's party endpoint, as the editor's browser does.
export const partyWrite = (request: APIRequestContext, data: unknown) =>
  request.post('/parties/tracker/main?proto=party-db', { headers: { authorization: `Bearer ${editorToken()}` }, data })

// Locally the email binding delivers nothing, so the code is read from where
// Better Auth keeps it: `<code>:<attempts>`, under the address it was sent to.
const codeFor = (email: string) => query<{ value: string }>(`SELECT value FROM auth_verifications WHERE identifier = 'sign-in-otp-${email}'`)[0].value.split(':')[0]

// Signs in through the sign-in dialog, once something on the page has opened it.
export async function signInWithCode(page: Page, email: string) {
  const signIn = page.getByRole('dialog').filter({ hasText: 'We email you a code' })
  await signIn.getByLabel('Email address').fill(email)
  await signIn.getByRole('button', { name: 'Email me a code' }).click()
  await expect(signIn.getByText(`We sent a code to ${email}`)).toBeVisible()
  await signIn.getByLabel('Code').fill(codeFor(email))
  await signIn.getByRole('button', { name: 'Sign in' }).click()
  await expect(signIn).toBeHidden()
}
