import { expect, test } from '@playwright/test'
import { editorToken } from './fixtures.ts'

const PERSON = '/q/free-ferry/odalys-brennan'
const SOURCE = 'Tideline Radio: Morning interview'

test('an archive address an editor gives a source shows beside it for a reader already on the page', async ({ page, browser }) => {
  await page.goto(PERSON)
  const readerItem = page.getByRole('listitem').filter({ hasText: SOURCE }).last()
  await expect(readerItem).toBeVisible()
  await expect(readerItem.getByRole('link', { name: 'archived' })).toHaveCount(0)
  // Readers get no archiving controls.
  await expect(page.getByText('Give an archived copy')).toHaveCount(0)

  const context = await browser.newContext()
  const editor = await context.newPage()
  await editor.goto('/news/review')
  await editor.getByLabel('Editor token').fill(editorToken())
  await editor.getByRole('button', { name: 'Sign in' }).click()
  await expect(editor.getByRole('heading', { name: 'Review queue' })).toBeVisible()
  await editor.goto(PERSON)
  const editorItem = editor.getByRole('listitem').filter({ hasText: SOURCE }).last()
  const copy = `https://archive.example/copy-${Date.now()}`
  await editorItem.getByText('Give an archived copy').click()
  await editorItem.getByLabel('Archived copy').fill(copy)
  await editorItem.getByRole('button', { name: 'Save' }).click()
  await expect(editorItem.getByRole('status')).toHaveText('Saved.')

  await expect(readerItem.getByRole('link', { name: 'archived' })).toHaveAttribute('href', copy)
  await context.close()
})
