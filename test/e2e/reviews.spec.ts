import { expect, test } from '@playwright/test'
import { NEWS_READER_ID } from '../../shared/schema.ts'
import { query } from './db.ts'
import { partyWrite, signInWithCode } from './fixtures.ts'

const person = '/q/free-ferry/bartholomew-sato'

let cleanup: (() => Promise<unknown>) | undefined
test.afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

test('a member confirms the reading the news reader gave an act, changes it to their own, and removes it', async ({ page, request }) => {
  const stamp = Date.now()
  const actId = `act-reviewed-${stamp}`
  const words = `The ferry should cost nothing to ride. (${stamp})`
  const now = new Date().toISOString()
  const write = await partyWrite(request, [
    { channel: 'acts', ops: [{ type: 'insert', value: { id: actId, decider_id: 'demo-bartholomew-sato', kind: 'says', occurred_on: '2026-11-10', body: words, primary_source_id: null, withdrawn_on: null, created_at: now } }] },
  ])
  expect(write.ok()).toBe(true)
  // Only a review's author writes it through the room, so the news reader's is put in directly.
  query(`INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, based_on, created_at, updated_at) VALUES ('rv-reader-${stamp}', '${NEWS_READER_ID}', '${actId}', 'free-ferry', 'support', 'clear', NULL, '${now}', '${now}')`)
  cleanup = () => {
    query(`DELETE FROM reviews WHERE act_id = '${actId}'`)
    return partyWrite(request, [{ channel: 'acts', ops: [{ type: 'delete', value: { id: actId } }] }])
  }

  await page.goto(person)
  const onRecord = page.getByRole('listitem').filter({ hasText: words })
  await expect(onRecord.getByText('Yes', { exact: true })).toBeVisible()
  await expect(onRecord.getByText('Not checked by an editor')).toBeVisible()
  // Signed out, there is nothing to review with.
  await expect(onRecord.getByRole('button', { name: /^Confirm/ })).toHaveCount(0)

  await page.locator('#discussion').getByRole('button', { name: 'Sign in' }).click()
  const email = `reviewer-${stamp}@example.org`
  await signInWithCode(page, email)
  const [{ id: memberId }] = query<{ id: string }>(`SELECT id FROM auth_users WHERE email = '${email}'`)

  await onRecord.getByRole('button', { name: 'Confirm: Support · Clear' }).click()
  await expect(onRecord.getByText('Your review on Fare-free ferry: Support · Clear')).toBeVisible()
  await expect.poll(() => query(`SELECT position, weight, based_on FROM reviews WHERE reviewer_id = '${memberId}' AND act_id = '${actId}'`)).toEqual([{ position: 'support', weight: 'clear', based_on: `rv-reader-${stamp}` }])

  // A person's review counts over an agent's, so the act now reads as theirs.
  await onRecord.getByRole('button', { name: 'Change' }).click()
  await onRecord.getByRole('radio', { name: 'Against' }).check()
  await onRecord.getByLabel('How much it counts').selectOption('passing')
  await onRecord.getByRole('button', { name: 'Save your review' }).click()
  await expect(onRecord.getByText('Your review on Fare-free ferry: Against · Passing')).toBeVisible()
  await expect(onRecord.getByText('No', { exact: true })).toBeVisible()
  await expect(onRecord.getByText('Signal')).toBeVisible()

  page.once('dialog', (d) => d.accept())
  await onRecord.getByRole('button', { name: 'Remove' }).click()
  await expect(onRecord.getByRole('button', { name: 'Confirm: Support · Clear' })).toBeVisible()
  await expect(onRecord.getByText('Signal')).toHaveCount(0)
  await expect.poll(() => query(`SELECT id FROM reviews WHERE reviewer_id = '${memberId}'`)).toEqual([])
})

test('a member says an act says nothing on the question, which moves it off the record into a list where they can change their review', async ({ page, request }) => {
  const stamp = Date.now()
  const actId = `act-nothing-${stamp}`
  const words = `I took the ferry to work today. (${stamp})`
  const now = new Date().toISOString()
  const write = await partyWrite(request, [
    { channel: 'acts', ops: [{ type: 'insert', value: { id: actId, decider_id: 'demo-bartholomew-sato', kind: 'says', occurred_on: '2026-11-11', body: words, primary_source_id: null, withdrawn_on: null, created_at: now } }] },
  ])
  expect(write.ok()).toBe(true)
  query(`INSERT INTO reviews (id, reviewer_id, act_id, question_id, position, weight, based_on, created_at, updated_at) VALUES ('rv-reader-${stamp}', '${NEWS_READER_ID}', '${actId}', 'free-ferry', 'mixed', 'passing', NULL, '${now}', '${now}')`)
  cleanup = () => {
    query(`DELETE FROM reviews WHERE act_id = '${actId}'`)
    return partyWrite(request, [{ channel: 'acts', ops: [{ type: 'delete', value: { id: actId } }] }])
  }

  await page.goto(person)
  await page.locator('#discussion').getByRole('button', { name: 'Sign in' }).click()
  await signInWithCode(page, `nothing-${stamp}@example.org`)
  const onRecord = page.getByRole('listitem').filter({ hasText: words })
  await onRecord.getByRole('button', { name: 'Review it yourself on Fare-free ferry' }).click()
  await onRecord.getByRole('radio', { name: 'Says nothing on this question' }).check()
  await expect(onRecord.getByLabel('How much it counts')).toHaveCount(0)
  await onRecord.getByRole('button', { name: 'Save your review' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: words })).toHaveCount(0)

  await page.getByText('Reviewed as saying nothing on this question (1)').click()
  const saidNothing = page.getByRole('listitem').filter({ hasText: words })
  await expect(saidNothing.getByText('Your review on Fare-free ferry: says nothing on this question')).toBeVisible()
  await saidNothing.getByRole('button', { name: 'Change' }).click()
  await saidNothing.getByRole('radio', { name: 'Mixed' }).check()
  await saidNothing.getByRole('button', { name: 'Save your review' }).click()
  await expect(page.getByText('Reviewed as saying nothing on this question')).toHaveCount(0)
  await expect(page.getByRole('listitem').filter({ hasText: words }).getByText('Mixed', { exact: true })).toBeVisible()
})
