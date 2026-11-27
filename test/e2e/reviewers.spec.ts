import { expect, test } from '@playwright/test'
import { NEWS_READER_ID } from '../../shared/schema.ts'
import { query } from './db.ts'
import { partyWrite } from './fixtures.ts'

let cleanup: (() => Promise<unknown>) | undefined
test.afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

test("an act's short line says whose reviews its reading comes from, and opens to every review, at desktop and phone width", async ({ page, request }) => {
  const stamp = Date.now()
  const actId = `act-reviewers-${stamp}`
  const words = `Nobody should pay to cross the harbour. (${stamp})`
  const now = new Date().toISOString()
  const write = await partyWrite(request, [
    { channel: 'acts', ops: [{ type: 'insert', value: { id: actId, decider_id: 'demo-bartholomew-sato', kind: 'says', occurred_on: '2026-11-10', body: words, primary_source_id: null, withdrawn_on: null, created_at: now } }] },
  ])
  expect(write.ok()).toBe(true)
  // Two members, one with no display name yet. Only a review's author writes it through the room, so the reviews are put in directly.
  const ana = `ana-${stamp}`
  const unnamed = `unnamed-${stamp}`
  for (const [id, name] of [[ana, 'Ana Ruiz'], [unnamed, null]] as const) {
    query(`INSERT INTO auth_users (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('${id}', '', '${id}@example.org', 1, '${now}', '${now}')`)
    query(`INSERT INTO people (id, kind, display_name, role, created_at) VALUES ('${id}', 'person', ${name ? `'${name}'` : 'NULL'}, 'member', '${now}')`)
  }
  const readers = `rv-reader-${stamp}`
  const reviews = [
    [readers, NEWS_READER_ID, 'support', 'NULL', '2026-11-11T10:00:00.000Z'],
    [`rv-ana-${stamp}`, ana, 'support', `'${readers}'`, '2026-11-11T11:00:00.000Z'],
    [`rv-unnamed-${stamp}`, unnamed, 'lean_support', 'NULL', '2026-11-11T12:00:00.000Z'],
  ]
  for (const [id, reviewer, position, basedOn, at] of reviews)
    query(`INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, based_on, created_at, updated_at) VALUES ('${id}', '${reviewer}', '${actId}', 'free-ferry', '${position}', 'clear', ${basedOn}, '${at}', '${at}')`)
  cleanup = () => {
    query(`DELETE FROM reviews WHERE act_id = '${actId}'`)
    query(`DELETE FROM people WHERE id IN ('${ana}', '${unnamed}')`)
    query(`DELETE FROM auth_users WHERE id IN ('${ana}', '${unnamed}')`)
    return partyWrite(request, [{ channel: 'acts', ops: [{ type: 'delete', value: { id: actId } }] }])
  }

  await page.goto('/q/free-ferry/bartholomew-sato')
  const onRecord = page.getByRole('listitem').filter({ hasText: words })
  const reviewedBy = onRecord.getByTestId('reviewed-by')
  await expect(reviewedBy.locator('summary')).toHaveText('Reviewed by 2 members · 1 more not counted')
  await expect(reviewedBy.getByText('Ana Ruiz')).toBeHidden()

  await reviewedBy.locator('summary').click()
  await expect(reviewedBy.getByText('No editor has reviewed this yet, so the reading shown comes from the members’ reviews, averaged.')).toBeVisible()
  const rows = reviewedBy.getByRole('listitem')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Ana Ruiz')
  await expect(rows.nth(0)).toContainText('Support · Clear')
  await expect(rows.nth(0)).toContainText('Made by confirming News reader’s review.')
  await expect(rows.nth(1)).toContainText('No name yet')
  await expect(rows.nth(1)).toContainText('Probable · Clear')
  await expect(rows.nth(2)).toContainText('News reader')
  await expect(rows.nth(2)).toContainText('Does not count while members have reviewed it.')
  await expect(reviewedBy).not.toContainText('@example.org')

  await page.setViewportSize({ width: 375, height: 800 })
  await expect(rows.nth(2)).toBeVisible()
  expect(await page.locator('html').evaluate((html) => html.scrollWidth <= html.clientWidth)).toBe(true)
  await onRecord.screenshot({ path: 'test-results/reviewers-phone.png' })
})

test("a story's reading line says which editor reviewed it, and opens to the review", async ({ page, request }) => {
  const stamp = Date.now()
  // Newer than what other flows add, so the story is on the feed's first page.
  const at = new Date().toISOString()
  const title = `Harbor Ledger: one councillor on fares (${stamp})`
  const actId = `act-story-${stamp}`
  const write = await partyWrite(request, [
    { channel: 'sources', ops: [{ type: 'insert', value: { id: `src-${stamp}`, url: `https://example.com/one-${stamp}`, title, publisher: null, published_on: null, published_on_from: null, kind: 'article', archive_url: null, stored_copy: null, created_at: at } }] },
    { channel: 'acts', ops: [{ type: 'insert', value: { id: actId, decider_id: 'demo-ikenna-vasquez', kind: 'says', occurred_on: '2026-11-18', body: `Fares should go. (${stamp})`, primary_source_id: null, withdrawn_on: null, created_at: at } }] },
    { channel: 'reports', ops: [{ type: 'insert', value: { id: `rep-${stamp}`, source_id: `src-${stamp}`, act_id: actId, excerpt: null, created_at: at } }] },
    // Written as the flows' editor, whom the room stamps as the reviewer.
    { channel: 'reviews', ops: [{ type: 'insert', value: { id: `rv-${stamp}`, act_id: actId, question_id: 'free-ferry', position: 'support', weight: 'clear', based_on: null, created_at: at, updated_at: at } }] },
  ])
  expect(write.ok()).toBe(true)

  await page.goto('/news?question=free-ferry&recordOnly=true')
  const story = page.getByRole('article', { name: title })
  const reviewedBy = story.getByTestId('reviewed-by')
  await expect(reviewedBy).toHaveCount(1)
  await expect(reviewedBy.locator('summary')).toHaveText('Reviewed by an editor')
  await reviewedBy.locator('summary').click()
  await expect(reviewedBy.getByText('The reading shown comes from the editors’ review.')).toBeVisible()
  await expect(reviewedBy.getByRole('listitem')).toHaveCount(1)
  await expect(reviewedBy.getByRole('listitem')).toContainText('Flow Editor')
  await expect(reviewedBy.getByRole('listitem')).toContainText('editor')
  await expect(reviewedBy.getByRole('listitem')).toContainText('Support · Clear')
  await page.setViewportSize({ width: 375, height: 800 })
  expect(await page.locator('html').evaluate((html) => html.scrollWidth <= html.clientWidth)).toBe(true)
  await story.screenshot({ path: 'test-results/reviewers-story-phone.png' })
})
