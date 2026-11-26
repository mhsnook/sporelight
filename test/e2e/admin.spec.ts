import { expect, test } from '@playwright/test'
import { editorPage, signInWithCode } from './fixtures.ts'

test('once the site has an editor, /setup says so and offers nothing', async ({ page }) => {
  await page.goto('/setup')
  await expect(page.getByText('This site already has an editor.')).toBeVisible()
  await expect(page.getByLabel('Email address')).toHaveCount(0)
})

test('an editor makes a signed-in member an editor from /admin, and the member then sees the editor links', async ({ page, browser }) => {
  const stamp = Date.now()
  const name = `Promoted ${stamp}`
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click()
  await signInWithCode(page, `promoted-${stamp}@example.org`)
  await page.goto('/profile')
  await page.getByLabel('Display name').fill(name)
  await page.getByRole('button', { name: 'Save' }).click()
  const profile = page.getByRole('main')
  await expect(profile.getByText(name, { exact: true })).toBeVisible()
  await expect(profile.getByText('Member', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Editors only' })).toBeVisible()

  const editor = await editorPage(browser)
  await editor.goto('/admin')
  await expect(editor.getByText('Only editors can open this page.')).toBeVisible()
  await editor.getByLabel(`Role of ${name}`).selectOption('editor')
  await expect(editor.getByLabel(`Role of ${name}`)).toHaveValue('editor')

  // The room closes the member's socket so it reconnects as an editor; the Worker tests cover that. Under the
  // Vite dev server the browser is not told of the close, so this page is reloaded.
  await page.reload()
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toBeVisible()
  await page.goto('/profile')
  await expect(profile.getByText('Editors also manage questions and people, and run the news search.')).toBeVisible()

  await editor.getByLabel(`Role of ${name}`).selectOption('member')
  await expect(editor.getByLabel(`Role of ${name}`)).toHaveValue('member')
  await page.reload()
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0)
  await editor.context().close()
})

test('an editor archives a question from /admin, which leaves /questions while its page still works, and unarchives it', async ({ page, browser }) => {
  const editor = await editorPage(browser)
  await editor.goto('/admin')
  const row = editor.getByRole('listitem').filter({ has: editor.getByRole('link', { name: 'Should the cruise ship berth fee stay?' }) })
  await row.getByRole('button', { name: 'Archive' }).click()
  await expect(editor.getByRole('heading', { name: /Archived/ })).toBeVisible()

  await page.goto('/questions')
  await expect(page.getByRole('heading', { name: 'Should the harbor ferry be free to ride?' }).first()).toBeVisible()
  await expect(page.getByText('Should the cruise ship berth fee stay?')).toHaveCount(0)
  await page.goto('/q/berth-fee')
  await expect(page.getByRole('heading', { name: 'Should the cruise ship berth fee stay?' })).toBeVisible()

  await row.getByRole('button', { name: 'Unarchive' }).click()
  await expect(editor.getByRole('heading', { name: /Archived/ })).toHaveCount(0)
  await editor.context().close()
})
