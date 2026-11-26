import { expect, type APIRequestContext, type Browser, type Cookie, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { query } from './db.ts'

// "Today" in the app is the browser's date, and the next-term toggle only shows
// while a body's next term lies ahead. Fixing the clock keeps these flows
// meaning the same thing after the 120th Congress starts on 2027-01-03.
export const TODAY = new Date('2026-11-19T15:00:00Z')

// The editor every flow signs in as. global-setup.ts makes them the first editor and keeps their session here.
export const EDITOR_EMAIL = 'flow-editor@example.org'
export const EDITOR_STATE = fileURLToPath(new URL('../../playwright/.auth/editor.json', import.meta.url))
const editorCookies = () => (JSON.parse(readFileSync(EDITOR_STATE, 'utf8')) as { cookies: Cookie[] }).cookies

// A page signed in as the flows' editor, in a context of its own.
export async function editorPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: EDITOR_STATE })
  return context.newPage()
}

// Signs the page's context in as the editor, then opens the review queue.
export async function signInAsEditor(page: Page) {
  await page.context().addCookies(editorCookies())
  await page.goto('/news/review')
  await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible()
}

// Writes batches through the party endpoint, as the editor's browser does.
export const partyWrite = (request: APIRequestContext, data: unknown) =>
  request.post('/parties/tracker/main?proto=party-db', { headers: { cookie: editorCookies().map((c) => `${c.name}=${c.value}`).join('; ') }, data })

// Locally the email binding delivers nothing, so the code is read from where
// Better Auth keeps it: `<code>:<attempts>`, under the address it was sent to.
const codeFor = (email: string) => query<{ value: string }>(`SELECT value FROM auth_verifications WHERE identifier = 'sign-in-otp-${email}'`)[0].value.split(':')[0]

// Signs in through the sign-in dialog, once something on the page has opened it.
export async function signInWithCode(page: Page, email: string) {
  const signIn = page.getByRole('dialog').filter({ hasText: 'We email you a code' })
  await signIn.getByLabel('Email address').fill(email)
  await signIn.getByRole('button', { name: 'Email me a code' }).click()
  await expect(signIn.getByText('We sent a six-digit code to the address you gave.')).toBeVisible()
  await signIn.getByLabel('Code').fill(codeFor(email))
  await signIn.getByRole('button', { name: 'Sign in' }).click()
  await expect(signIn).toBeHidden()
}
