import { expect, test, type Page } from '@playwright/test'
import { TODAY } from './fixtures.ts'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(TODAY)
})

const questionCard = (page: Page, shortTitle: string) =>
  page.getByRole('region', { name: 'Questions', exact: true }).getByRole('listitem').filter({ has: page.getByRole('link', { name: shortTitle, exact: true }) })

test("a reader opens a Halifax councillor's page from their name on a question, sees where they stand, and goes back to that question", async ({ page }) => {
  await page.goto('/q/halifax-ferry-fares')
  await page.getByRole('link', { name: /Cathy Deagle Gammon/ }).first().click()
  await expect(page).toHaveURL(/\/q\/halifax-ferry-fares\/cathy-deagle-gammon$/)
  await page.getByRole('heading', { name: 'Cathy Deagle Gammon' }).getByRole('link').click()
  await expect(page).toHaveURL(/\/p\/cathy-deagle-gammon$/)

  await expect(page.getByRole('heading', { level: 1, name: 'Cathy Deagle Gammon' })).toBeVisible()
  await expect(page.getByText('District 1')).toBeVisible()
  const fares = questionCard(page, 'Alderney ferry fares')
  await expect(fares).toContainText('No')
  await expect(fares).toContainText('On the record')
  const latest = page.getByRole('region', { name: 'Latest on the record' })
  await expect(latest.getByRole('listitem').first()).toContainText('May 26, 2026')

  await fares.getByRole('link', { name: 'Alderney ferry fares', exact: true }).click()
  await expect(page).toHaveURL(/\/q\/halifax-ferry-fares\/cathy-deagle-gammon$/)
})

test("a member of Congress's page lists Medicare for All with the bill under it, and the next-term view moves the lapsed bill to past questions", async ({ page }) => {
  await page.goto('/p/bernard-sanders')
  const m4a = questionCard(page, 'Medicare for All')
  await expect(m4a).toContainText('Yes')
  await expect(m4a.getByRole('link', { name: /Have they cosponsored S\. 1506/ })).toBeVisible()
  await expect(m4a).toContainText('Signed on')
  await expect(page.getByRole('region', { name: 'Past questions' })).toHaveCount(0)

  await page.getByRole('button', { name: '120th Congress' }).click()
  await expect(page).toHaveURL(/as=2027-01-03/)
  const past = page.getByRole('region', { name: 'Past questions' })
  await expect(past.getByRole('link', { name: /Have they cosponsored S\. 1506/ })).toBeVisible()
  await expect(past).toContainText('Lapsed Jan 3, 2027')
  await expect(questionCard(page, 'Medicare for All').getByRole('link', { name: /S\. 1506/ })).toHaveCount(0)

  await questionCard(page, 'Medicare for All').getByRole('link', { name: 'Medicare for All', exact: true }).click()
  await expect(page).toHaveURL(/\/q\/medicare-for-all\/bernard-sanders\?as=2027-01-03$/)
})

test("a state's page in the ERA data set shows the amendment and what the state did", async ({ page }) => {
  await page.goto('/p/virginia')
  await expect(page.getByText('State legislatures')).toBeVisible()
  await expect(questionCard(page, 'Equal Rights Amendment')).toContainText('Ratified')
  await expect(page.getByRole('region', { name: 'Latest on the record' })).toContainText('Ratified the Equal Rights Amendment')
})

test('a name in the news feed opens that person’s page', async ({ page }) => {
  await page.goto('/news?question=halifax-ferry-fares&recordOnly=true')
  const story = page.getByRole('region', { name: 'Stories' }).getByRole('article').first()
  const name = story.locator('a[href^="/p/"]').first()
  const slug = (await name.getAttribute('href'))!.slice('/p/'.length)
  await name.click()
  await expect(page).toHaveURL(new RegExp(`/p/${slug}$`))
  await expect(questionCard(page, 'Alderney ferry fares')).toBeVisible()
})

test('the page lists every question across bodies once, whatever body the reader was viewing a question through', async ({ page }) => {
  await page.goto('/q/no-cruise-money/odalys-brennan?body=harbor-port-authority')
  await page.getByRole('link', { name: 'Every question put to Odalys Brennan' }).click()
  await expect(page).toHaveURL(/\/p\/odalys-brennan$/)
  await expect(page.getByText('Harbor Port Authority Board · demo data, not real')).toBeVisible()
  const questions = page.getByRole('region', { name: 'Questions', exact: true })
  for (const title of ['Fare-free ferry', 'Cruise money pledge', 'Free for city card holders', 'Cruise ship berth fee']) {
    await expect(questions.getByRole('link', { name: title, exact: true })).toHaveCount(1)
  }
  await expect(questionCard(page, 'Cruise money pledge')).toContainText('Pledged')
})
