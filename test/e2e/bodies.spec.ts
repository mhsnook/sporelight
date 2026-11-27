import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { query } from './db.ts'
import { TODAY, partyWrite, signInAsEditor } from './fixtures.ts'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(TODAY)
})

const RANDOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/

type SeatRow = { id: string; label: string; chamber: string | null; region: string | null; is_voting: number }
const seatsOf = (bodyId: string) => query<SeatRow>(`SELECT id, label, chamber, region, is_voting FROM seats WHERE body_id = '${bodyId}' ORDER BY label`)

// Adds a body from /bodies and returns its row, with the editor left on its page.
async function addBody(page: Page, name: string, fill: (form: Locator) => Promise<void> = async () => {}) {
  await page.goto('/bodies')
  await page.getByRole('link', { name: 'Add a body' }).click()
  const form = page.getByRole('form', { name: 'The new body' })
  await form.getByLabel('Name', { exact: true }).fill(name)
  await fill(form)
  await form.getByRole('button', { name: 'Add the body' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  const [body] = query<{ id: string; slug: string; next_term_on: string | null; next_term_label: string | null }>(`SELECT id, slug, next_term_on, next_term_label FROM bodies WHERE name = '${name}'`)
  await expect(page).toHaveURL(new RegExp(`/bodies/${body.slug}$`))
  return body
}

// From a body's page, adds the seats on `lines` and comes back to it.
async function addSeats(page: Page, lines: string, chamber: string, { voting = true } = {}) {
  await page.getByRole('link', { name: 'Add seats' }).click()
  await expect(page.getByRole('heading', { level: 1, name: /^Seats for / })).toBeVisible()
  await page.getByRole('textbox', { name: 'Seats', exact: true }).fill(lines)
  await page.getByLabel(/^Chamber/).fill(chamber)
  if (!voting) await page.getByRole('checkbox', { name: /^Votes/ }).uncheck()
  await page.getByRole('button', { name: 'Add the seats' }).click()
  await expect(page.getByRole('region', { name: 'Seats' })).toBeVisible()
}

// Puts a new person in each seat through the room, as held today, for the seats a flow does not fill on the page.
async function fillSeats(request: APIRequestContext, seats: SeatRow[], stamp: number) {
  const people = seats.map((s) => ({ id: `member-${stamp}-${s.label}`, slug: `member-${stamp}-${s.label.toLowerCase()}`, name: `Member ${s.label} ${stamp}`, sort_name: `${stamp}, ${s.label}`, external_id: null, url: null }))
  const write = await partyWrite(request, [
    { channel: 'deciders', ops: people.map((value) => ({ type: 'insert', value })) },
    {
      channel: 'roles',
      ops: seats.map((s, i) => ({ type: 'insert', value: { id: `role-${stamp}-${s.label}`, seat_id: s.id, decider_id: people[i].id, contest: null, affiliation: null, starts_on: null, ends_on: null, certainty: 'certain' } })),
    },
  ])
  expect(write.ok()).toBe(true)
}

// Adds a question listed under the body from /questions/new and returns its slug.
async function addQuestion(page: Page, bodyName: string, shortName: string) {
  await page.goto('/questions/new')
  const form = page.getByRole('form', { name: 'The new question' })
  await form.getByLabel('Body').selectOption({ label: bodyName })
  await form.getByLabel('The question, as asked').fill(`Should ${bodyName} build the boardwalk?`)
  await form.getByLabel('Short name').fill(shortName)
  await form.getByRole('button', { name: 'Add the question' }).click()
  await expect(page.getByRole('heading', { name: 'Edit this question' })).toBeVisible()
  return query<{ slug: string }>(`SELECT slug FROM questions WHERE short_title = '${shortName}'`)[0].slug
}

test('an editor adds a body with two chambers and its seats, puts someone in a seat, sets its next term, and sees a chart per chamber on a question put to it', async ({ page, request }) => {
  const stamp = Date.now()
  const name = `Lakeview Council ${stamp}`
  const person = `Rowan Pike ${stamp}`
  await signInAsEditor(page)

  await page.getByRole('link', { name: 'Bodies' }).click()
  await page.getByRole('link', { name: 'Add a body' }).click()
  await page.getByRole('button', { name: 'Add the body' }).click()
  await expect(page.getByRole('alert')).toContainText('The body needs a name.')
  const body = await addBody(page, name, async (form) => {
    await form.getByLabel(/^Jurisdiction/).fill('Lakeview')
    await form.getByLabel(/^Starts on/).fill('2027-11-01')
    await form.getByLabel(/^Called/).fill('Council of 2027')
  })
  expect(body.id).toMatch(RANDOM_ID)
  expect(body).toMatchObject({ slug: `lakeview-council-${stamp}`, next_term_on: '2027-11-01', next_term_label: 'Council of 2027' })

  await addSeats(page, 'A1, North\nA2, South\nA3', 'Assembly')
  await addSeats(page, 'Delegate', 'Assembly', { voting: false })
  // Once the body has chambers, a seat with none is refused, since no chart would draw it.
  await page.getByRole('link', { name: 'Add seats' }).click()
  await page.getByRole('textbox', { name: 'Seats', exact: true }).fill('S1\nS2')
  await page.getByRole('button', { name: 'Add the seats' }).click()
  await expect(page.getByRole('alert')).toContainText('The other seats in this body are each in a chamber')
  await page.getByLabel(/^Chamber/).fill('Senate')
  await page.getByRole('button', { name: 'Add the seats' }).click()
  const seatList = page.getByRole('region', { name: 'Seats' })
  await expect(seatList.getByRole('listitem')).toHaveCount(6)
  const seats = seatsOf(body.id)
  expect(seats.map(({ id: _, ...s }) => s)).toEqual([
    { label: 'A1', chamber: 'Assembly', region: 'North', is_voting: 1 },
    { label: 'A2', chamber: 'Assembly', region: 'South', is_voting: 1 },
    { label: 'A3', chamber: 'Assembly', region: null, is_voting: 1 },
    { label: 'Delegate', chamber: 'Assembly', region: null, is_voting: 0 },
    { label: 'S1', chamber: 'Senate', region: null, is_voting: 1 },
    { label: 'S2', chamber: 'Senate', region: null, is_voting: 1 },
  ])
  for (const s of seats) expect(s.id).toMatch(RANDOM_ID)

  // Someone new put in a seat from the seat's own page.
  await seatList.getByRole('link', { name: 'Edit A1' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'A1' })).toBeVisible()
  await page.getByRole('link', { name: 'Give someone a role on this seat' }).click()
  await page.getByRole('radio', { name: 'Someone new' }).check()
  await page.getByLabel('Name', { exact: true }).fill(person)
  await page.getByRole('button', { name: 'Add the role' }).click()
  await expect(page.getByRole('heading', { level: 1, name: person })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Seats' }).getByRole('link', { name })).toBeVisible()
  await fillSeats(request, seats.filter((s) => s.label !== 'A1'), stamp)

  const slug = await addQuestion(page, name, `Boardwalk ${stamp}`)
  await page.goto(`/q/${slug}`)
  const figures = page.locator('figure')
  await expect(figures).toHaveCount(2)
  const assembly = figures.filter({ has: page.getByRole('heading', { name: 'Assembly' }) })
  await expect(assembly).toContainText('3 voting seats · 1 non-voting not drawn')
  await expect(assembly.getByRole('img')).toHaveAttribute('aria-label', 'Assembly. No record yet: 3. 2 is a majority.')
  await expect(figures.filter({ has: page.getByRole('heading', { name: 'Senate' }) }).getByRole('img')).toHaveAttribute('aria-label', 'Senate. No record yet: 2. 2 is a majority.')
  await expect(page.getByRole('link', { name: new RegExp(person) })).toContainText('A1')

  // The next term set on the body is offered on the question's page.
  await page.getByRole('group', { name: 'When' }).getByRole('button', { name: 'Council of 2027' }).click()
  await expect(page).toHaveURL(/[?&]as=2027-11-01/)
  await page.getByRole('link', { name: 'Back to today' }).click()

  // Renaming a chamber on the body's page renames it on its seats, and the question's page follows.
  await page.getByRole('link', { name: `Edit ${name}` }).click()
  const chambers = page.getByRole('region', { name: 'Chambers' })
  await chambers.getByLabel('Chamber to rename').selectOption('Senate')
  await chambers.getByLabel('New name').fill('Upper House')
  await chambers.getByRole('button', { name: 'Rename the chamber' }).click()
  await expect(chambers.getByRole('listitem')).toHaveText([/Assembly · 4 seats/, /Upper House · 2 seats/])
  expect(query(`SELECT chamber, COUNT(*) AS n FROM seats WHERE body_id = '${body.id}' GROUP BY chamber ORDER BY chamber`)).toEqual([
    { chamber: 'Assembly', n: 4 },
    { chamber: 'Upper House', n: 2 },
  ])
  await page.goto(`/q/${slug}`)
  await expect(figures.filter({ has: page.getByRole('heading', { name: 'Upper House' }) })).toContainText('2 voting seats')

  // Something hangs from it, so it cannot be removed.
  await page.goto(`/bodies/${body.slug}`)
  await expect(page.getByRole('region', { name: 'Removing' })).toContainText('This body cannot be removed while it has 6 seats, 1 question listed under it')
  await expect(page.getByRole('button', { name: 'Remove this body' })).toHaveCount(0)
})

test('a body made on the site with no chambers draws one chart, and a seat nobody has held can be removed', async ({ page, request }) => {
  const stamp = Date.now()
  const name = `Millbrook Board ${stamp}`
  await signInAsEditor(page)

  const body = await addBody(page, name)
  await addSeats(page, 'W1\nW2\nW3\nW4\nSpare', '')
  const seats = seatsOf(body.id)
  expect(seats.map((s) => s.chamber)).toEqual([null, null, null, null, null])
  await fillSeats(request, seats.filter((s) => s.label !== 'Spare'), stamp)

  // A seat entered by mistake, with no claim on it, goes.
  await page.getByRole('region', { name: 'Seats' }).getByRole('link', { name: 'Edit Spare' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Remove this seat' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect.poll(() => seatsOf(body.id).map((s) => s.label)).toEqual(['W1', 'W2', 'W3', 'W4'])

  // A seat with a claim on it stays, and can be edited.
  await page.getByRole('region', { name: 'Seats' }).getByRole('link', { name: 'Edit W4' }).click()
  await expect(page.getByRole('region', { name: 'Removing' })).toContainText('This seat cannot be removed, since it has a claim on file.')
  await page.getByLabel('Label', { exact: true }).fill('Ward 4')
  await page.getByLabel(/^Region/).fill('East')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  await expect.poll(() => query(`SELECT label, region FROM seats WHERE id = '${seats.find((s) => s.label === 'W4')!.id}'`)).toEqual([{ label: 'Ward 4', region: 'East' }])

  const slug = await addQuestion(page, name, `Millbrook boardwalk ${stamp}`)
  await page.goto(`/q/${slug}`)
  const figure = page.locator('figure')
  await expect(figure).toHaveCount(1)
  await expect(figure.getByRole('img')).toHaveAttribute('aria-label', `${name}. No record yet: 4. 3 is a majority.`)
})

test('a body with nothing hanging from it can be removed', async ({ page }) => {
  const name = `Short-lived Board ${Date.now()}`
  await signInAsEditor(page)
  const body = await addBody(page, name)
  await expect(page.getByRole('region', { name: 'Removing' })).toContainText('Nothing hangs from this body')
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Remove this body' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Bodies' })).toBeVisible()
  await expect.poll(() => query(`SELECT id FROM bodies WHERE id = '${body.id}'`)).toEqual([])
})

test('an editor gives a body an office and a holder, puts an ask to it, and the ask follows a change of holder', async ({ page, request }) => {
  const stamp = Date.now()
  const name = `Cedar Falls Council ${stamp}`
  const day = TODAY.toISOString().slice(0, 10)
  await signInAsEditor(page)

  const body = await addBody(page, name)
  await addSeats(page, 'C1\nC2\nC3', 'Council')
  await fillSeats(request, seatsOf(body.id), stamp)
  const first = `Member C1 ${stamp}`
  const next = `Member C2 ${stamp}`
  const slug = await addQuestion(page, name, `Cedar boardwalk ${stamp}`)

  // An office of the body, with someone on file in it.
  await page.goto(`/bodies/${body.slug}`)
  await page.getByRole('region', { name: 'Offices' }).getByRole('link', { name: 'Add an office' }).click()
  await expect(page.getByRole('heading', { level: 1, name: `A new office in ${name}` })).toBeVisible()
  await page.getByRole('button', { name: 'Add the office' }).click()
  await expect(page.getByRole('alert')).toContainText('The office needs a name.')
  await page.getByLabel('Name', { exact: true }).fill('Council president')
  await page.getByLabel('Chamber').selectOption('Council')
  await page.getByRole('button', { name: 'Add the office' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Council president' })).toBeVisible()
  const [office] = query<{ id: string; body_id: string; chamber: string }>(`SELECT id, body_id, chamber FROM offices WHERE label = 'Council president' AND body_id = '${body.id}'`)
  expect(office).toMatchObject({ body_id: body.id, chamber: 'Council' })
  expect(office.id).toMatch(RANDOM_ID)

  await page.getByRole('link', { name: 'Give someone this office' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'A holder for Council president' })).toBeVisible()
  await page.getByLabel('Name', { exact: true }).fill(first)
  await page.getByRole('button', { name: 'Add the holding' }).click()
  const holders = page.getByRole('region', { name: 'Who holds it' })
  await expect(holders.getByRole('listitem')).toHaveText([new RegExp(`${first}\\s*holds it`)])

  // An ask put to the office, from the question's edit page.
  await page.goto(`/q/${slug}/edit`)
  await page.getByRole('link', { name: 'Add an ask' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'A new ask' })).toBeVisible()
  await page.getByLabel('The question, as asked').fill('Will they schedule a vote on the boardwalk?')
  await page.getByLabel('Short name').fill(`Cedar vote ${stamp}`)
  await page.getByRole('checkbox', { name: /Council president/ }).check()
  await page.getByRole('button', { name: 'Add the ask' }).click()
  await expect(page.getByRole('region', { name: 'Measures and asks' }).getByRole('listitem')).toHaveText([new RegExp(`Ask\\s*Cedar vote ${stamp}`)])

  const keyPeople = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Key people' }) })
  await page.goto(`/q/${slug}`)
  await expect(keyPeople.getByRole('link')).toHaveCount(1)
  await expect(keyPeople.getByRole('link')).toContainText(first)
  await expect(keyPeople.getByRole('link')).toContainText('Council president')

  // The holder leaves today and the next starts today, with a source.
  await page.goto(`/offices/${office.id}`)
  await holders.getByRole('link', { name: `Edit the holding of ${first}` }).click()
  await expect(page.getByRole('heading', { level: 1, name: `${first} as Council president` })).toBeVisible()
  await page.getByRole('button', { name: 'End the holding' }).click()
  await expect(page.getByText('Ends on Nov 19, 2026.')).toBeVisible()
  await page.getByRole('link', { name: '← Council president' }).click()
  await page.getByRole('link', { name: 'Give someone this office' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'A holder for Council president' })).toBeVisible()
  await page.getByLabel('Name', { exact: true }).fill(next)
  await page.getByLabel(/^Starts on/).fill(day)
  await page.getByLabel(/^Source/).fill(`https://example.org/cedar-falls/${stamp}`)
  await page.getByRole('button', { name: 'Add the holding' }).click()
  await expect(holders.getByRole('listitem')).toHaveCount(2)
  await expect
    .poll(() => query(`SELECT d.name, h.starts_on, h.ends_on, s.url FROM office_holders h JOIN deciders d ON d.id = h.decider_id LEFT JOIN sources s ON s.id = h.source_id WHERE h.office_id = '${office.id}' ORDER BY d.name`))
    .toEqual([
      { name: first, starts_on: null, ends_on: day, url: null },
      { name: next, starts_on: day, ends_on: null, url: `https://example.org/cedar-falls/${stamp}` },
    ])

  // The ask now goes to the new holder, and their page links the source.
  await page.goto(`/q/${slug}`)
  await expect(keyPeople.getByRole('link')).toHaveCount(1)
  await expect(keyPeople.getByRole('link')).toContainText(next)
  await keyPeople.getByRole('link').click()
  await expect(page.getByRole('link', { name: /Council president/ })).toHaveAttribute('href', `https://example.org/cedar-falls/${stamp}`)

  // The office has holders and an ask, so it stays.
  await page.goto(`/offices/${office.id}`)
  await expect(page.getByRole('region', { name: 'Removing' })).toContainText('This office cannot be removed while it has 2 holders, 1 ask put to it.')
})
