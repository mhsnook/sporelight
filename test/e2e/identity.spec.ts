import { expect, test, type Browser, type Page } from '@playwright/test'
import { query } from './db.ts'
import { editorPage, signInWithCode } from './fixtures.ts'

const person = '/q/free-ferry/bartholomew-sato'


test('a signed-out reader is asked to sign in instead of commenting, signs in with an emailed code, picks a name when they first post, and comments under it', async ({ page, browser }) => {
  const stamp = Date.now()
  const email = `reader-${stamp}@example.org`
  const name = `Reader ${stamp}`
  const body = `Is there a recording of this? (${stamp})`

  await page.goto(person)
  const header = page.getByRole('banner')
  const discussion = page.locator('#discussion')
  await expect(discussion.getByText('Sign in to join the discussion.')).toBeVisible()
  await expect(page.getByLabel('Comment')).toHaveCount(0)
  await discussion.getByRole('button', { name: 'Sign in to comment' }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Sign in to comment' })).toBeVisible()
  await signInWithCode(page, email, { askedForName: 'leave' })

  // A first sign-in asks for a name. Not now leaves the person unnamed, shown as "Signed in", with the comment box ready.
  const naming = page.getByRole('dialog').filter({ hasText: 'Pick a display name' })
  await naming.getByRole('button', { name: 'Not now' }).click()
  await expect(header.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await expect(header.getByRole('link', { name: 'Signed in' })).toHaveAttribute('href', '/profile')
  await expect(page.getByLabel('Comment')).toBeFocused()

  // Posting without a name asks for one first, then posts.
  await page.getByLabel('Comment').fill(body)
  await page.getByRole('button', { name: 'Post comment' }).click()
  await naming.getByLabel('Display name').fill(name)
  await naming.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: body })).toContainText(name)
  await expect(header.getByText(name)).toBeVisible()
  await expect(discussion.getByText(`Posting as ${name}`)).toBeVisible()
  await expect(page.getByText(email)).toHaveCount(0)
  const [posted] = query<{ email: string }>(`SELECT u.email FROM comments c JOIN auth_users u ON u.id = c.person_id WHERE c.body = '${body}'`)
  expect(posted.email).toBe(email)

  // Another reader, signed out, sees the comment under the same name.
  const reader = await (await browser.newContext()).newPage()
  await reader.goto(person)
  await expect(reader.getByRole('listitem').filter({ hasText: body })).toContainText(name)

  // A rename on the profile shows on the comment already posted.
  await discussion.getByRole('link', { name: 'change on your profile' }).click()
  await page.getByRole('button', { name: 'Change' }).click()
  await page.getByLabel('Display name').fill(`${name} Renamed`)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(reader.getByRole('listitem').filter({ hasText: body })).toContainText(`${name} Renamed`)
  await page.goto(person)

  // An editor can remove it.
  const editor = await editorPage(browser)
  await editor.goto(person)
  await editor.getByRole('listitem').filter({ hasText: body }).getByRole('button', { name: 'Remove' }).click()
  await expect(reader.getByText(body)).toHaveCount(0)

  await header.getByRole('button', { name: 'Sign out' }).click()
  await expect(header.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(discussion.getByText('Sign in to join the discussion.')).toBeVisible()
})
