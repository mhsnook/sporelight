import { expect, test, type Browser, type Page } from '@playwright/test'
import { query } from './db.ts'
import { editorToken, signInWithCode } from './fixtures.ts'

const person = '/q/free-ferry/bartholomew-sato'

async function asEditor(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  await context.addInitScript((token) => localStorage.setItem('sporelight.editor-token', token), editorToken())
  return context.newPage()
}

test('a signed-out reader is asked to sign in instead of commenting, signs in with an emailed code, and comments under a name of their own', async ({ page, browser }) => {
  const stamp = Date.now()
  const email = `reader-${stamp}@example.org`
  const name = `Reader ${stamp}`
  const body = `Is there a recording of this? (${stamp})`

  await page.goto(person)
  const header = page.getByRole('banner')
  await expect(page.getByText('Sign in to comment.')).toBeVisible()
  await expect(page.getByLabel('Comment')).toHaveCount(0)
  await page.locator('#discussion').getByRole('button', { name: 'Sign in' }).click()
  await signInWithCode(page, email)
  await expect(header.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await expect(header.getByText('Signed in')).toBeVisible()

  // The first comment asks for the name the person will be shown under, in the same form.
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Comment').fill(body)
  await page.getByRole('button', { name: 'Post comment' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: body })).toContainText(name)
  await expect(header.getByText(name)).toBeVisible()
  await expect(page.getByLabel('Your name')).toHaveCount(0)
  await expect(page.getByText(email)).toHaveCount(0)
  const [posted] = query<{ email: string }>(`SELECT u.email FROM comments c JOIN auth_users u ON u.id = c.person_id WHERE c.body = '${body}'`)
  expect(posted.email).toBe(email)

  // Another reader, signed out, sees the comment under the same name.
  const reader = await (await browser.newContext()).newPage()
  await reader.goto(person)
  await expect(reader.getByRole('listitem').filter({ hasText: body })).toContainText(name)

  // A rename shows on the comment already posted.
  await page.getByRole('button', { name: 'change' }).click()
  const renaming = page.getByRole('dialog').filter({ hasText: 'Change your name' })
  await renaming.getByLabel('Name').fill(`${name} Renamed`)
  await renaming.getByRole('button', { name: 'Save' }).click()
  await expect(reader.getByRole('listitem').filter({ hasText: body })).toContainText(`${name} Renamed`)

  // An editor can remove it.
  const editor = await asEditor(browser)
  await editor.goto(person)
  await editor.getByRole('listitem').filter({ hasText: body }).getByRole('button', { name: 'Remove' }).click()
  await expect(reader.getByText(body)).toHaveCount(0)

  await header.getByRole('button', { name: 'Sign out' }).click()
  await expect(header.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByText('Sign in to comment.')).toBeVisible()
})
