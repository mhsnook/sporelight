import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { SPECTRUM, STANDINGS, STANDING_COLOR, standingLabel, type Standing } from '../../src/lib/position.ts'
import { query } from './db.ts'
import { TODAY, editorToken, partyWrite } from './fixtures.ts'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(TODAY)
})

const DAY = TODAY.toISOString().slice(0, 10)

type Dot = { x: number; y: number; standing: Standing; lit: boolean }

// Every drawn seat, read off the SVG: where it sits and which standing its colour is.
async function dots(figure: Locator): Promise<Dot[]> {
  const byColour = new Map(STANDINGS.map((s) => [STANDING_COLOR[s], s]))
  const raw = await figure.locator('svg[role="img"] > g').evaluateAll((groups) =>
    groups.map((g) => {
      const face = g.querySelectorAll('circle')[g.querySelectorAll('circle').length - 1]
      return { x: Number(face.getAttribute('cx')), y: Number(face.getAttribute('cy')), fill: face.getAttribute('fill') ?? '', lit: g.getAttribute('opacity') === '1' }
    }),
  )
  return raw.map((d) => ({ x: d.x, y: d.y, lit: d.lit, standing: d.fill === 'none' ? 'unknown' : byColour.get(d.fill)! }))
}

const angle = (d: Dot) => Math.atan2(-d.y, d.x)

// The per-standing counts in a chart's accessible name, e.g. "House. Yes: 120, No: 3. 218 is a majority."
async function chartCounts(figure: Locator, question: { kind: 'position' | 'formal_act'; act_label: string | null }) {
  const label = (await figure.getByRole('img').getAttribute('aria-label')) ?? ''
  const counts = new Map<Standing, number>()
  for (const s of SPECTRUM) {
    const n = label.match(new RegExp(`(?:\\. |, )${standingLabel(s, question)}: (\\d+)`))?.[1]
    if (n) counts.set(s, Number(n))
  }
  return counts
}

// The count on each standing button above the seat list.
async function buttonCounts(page: Page, question: { kind: 'position' | 'formal_act'; act_label: string | null }) {
  const counts = new Map<Standing, number>()
  for (const s of SPECTRUM) {
    const button = page.getByRole('button', { name: new RegExp(`^${standingLabel(s, question)}\\s*\\d+$`) })
    if (await button.count()) counts.set(s, Number((await button.textContent())!.match(/(\d+)$/)![1]))
  }
  return counts
}

const sum = (m: Map<unknown, number>) => [...m.values()].reduce((a, b) => a + b, 0)

test('a question page draws each chamber in standing order, and every seat is accounted for', async ({ page }) => {
  const [question] = query<{ kind: 'position'; act_label: null }>(`SELECT kind, act_label FROM questions WHERE slug = 'medicare-for-all'`)
  const seats = query<{ chamber: string; is_voting: number; n: number }>(`SELECT chamber, is_voting, COUNT(*) AS n FROM seats WHERE body_id = 'us-congress' GROUP BY 1, 2`)
  const inDb = (chamber: string, voting: number) => seats.find((r) => r.chamber === chamber && r.is_voting === voting)?.n ?? 0

  await page.goto('/q/medicare-for-all')
  const figures = page.locator('figure')
  await expect(figures).toHaveCount(2)

  const drawn = { House: 0, Senate: 0 }
  for (const chamber of ['House', 'Senate'] as const) {
    const figure = figures.filter({ has: page.getByRole('heading', { name: chamber }) })
    const seen = await dots(figure)
    drawn[chamber] = seen.length
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.length).toBeLessThanOrEqual(inDb(chamber, 1))

    // Support on the left, opposition on the right, the undecided between.
    const order = [...seen].sort((a, b) => angle(b) - angle(a)).map((d) => SPECTRUM.indexOf(d.standing))
    expect(order).toEqual([...order].sort((a, b) => a - b))

    // The accessible name says what is drawn.
    const told = await chartCounts(figure, question)
    for (const s of SPECTRUM) expect(told.get(s) ?? 0, `${chamber} ${s}`).toBe(seen.filter((d) => d.standing === s).length)
    expect(Number(await figure.getByText(standingLabel('support', question).toLowerCase(), { exact: true }).locator('xpath=preceding-sibling::span').textContent())).toBe(told.get('support') ?? 0)
  }

  // Every seat in the body is drawn, held without a vote and listed below, or listed as open.
  const nonVoting = Number((await page.getByText(/\d+ non-voting not drawn/).textContent())!.match(/(\d+) non-voting/)![1])
  expect(nonVoting).toBe(inDb('House', 0) + inDb('Senate', 0))
  const open = await page.locator('section:has(> h2:text-is("Vacant")) li, section:has(> h2:text-is("Not decided yet")) li').count()
  expect(drawn.House + drawn.Senate + nonVoting + open).toBe(seats.reduce((a, r) => a + r.n, 0))

  // The buttons count every held seat; the charts leave out the non-voting ones.
  const buttons = await buttonCounts(page, question)
  expect(sum(buttons)).toBe(drawn.House + drawn.Senate + nonVoting)
  await expect(page.getByText(new RegExp(`^${sum(buttons)} of ${sum(buttons)}$`))).toBeVisible()
})

test("a member's seat is lit in the colour of where their record leaves them when searched for", async ({ page }) => {
  // A sitting council member whose every reading on the question is against it, with no position set by hand.
  const [member] = query<{ name: string; position: Standing }>(`
    SELECT d.name, 'oppose' AS position FROM deciders d
    JOIN roles r ON r.decider_id = d.id JOIN seats s ON s.id = r.seat_id
    WHERE s.body_id = 'harbor-city-council' AND s.is_voting = 1 AND r.certainty = 'certain'
      AND (r.starts_on IS NULL OR r.starts_on <= '${DAY}') AND (r.ends_on IS NULL OR r.ends_on > '${DAY}')
      AND NOT EXISTS (SELECT 1 FROM set_positions sp WHERE sp.question_id = 'free-ferry' AND sp.decider_id = d.id)
      AND EXISTS (SELECT 1 FROM readings rd JOIN acts a ON a.id = rd.act_id WHERE rd.question_id = 'free-ferry' AND a.decider_id = d.id)
      AND NOT EXISTS (SELECT 1 FROM readings rd JOIN acts a ON a.id = rd.act_id WHERE rd.question_id = 'free-ferry' AND a.decider_id = d.id AND rd.position <> 'oppose')
    ORDER BY d.sort_name LIMIT 1`)
  expect(member, 'the seed has a council member whose record is all against').toBeDefined()

  await page.goto('/q/free-ferry')
  const figure = page.locator('figure')
  await expect(figure.locator('svg[role="img"] > g').first()).toBeVisible()
  expect(new Set((await dots(figure)).map((d) => d.standing)).size, 'the chart shows more than one standing').toBeGreaterThan(1)
  await page.getByRole('searchbox', { name: 'Search' }).fill(member.name)
  await expect.poll(async () => (await dots(figure)).filter((d) => d.lit).map((d) => d.standing)).toEqual([member.position])
})

test('a question with its own threshold puts the line there, not at a majority', async ({ page }) => {
  const [question] = query<{ kind: 'formal_act'; act_label: string | null; threshold: number }>(`SELECT kind, act_label, threshold FROM questions WHERE slug = 'equal-rights-amendment'`)
  await page.goto('/q/equal-rights-amendment')
  const figure = page.locator('figure')
  await expect(figure).toHaveCount(1)
  const seen = await dots(figure)
  expect(question.threshold).not.toBe(Math.floor(seen.length / 2) + 1)
  await expect(figure).toContainText(`${question.threshold} needed`)
  await expect(figure).not.toContainText('is a majority')
  const told = await chartCounts(figure, question)
  expect(sum(told)).toBe(seen.length)
})

test('evidence a reader sends reaches the editor under its question and, once approved, the record', async ({ page, context }) => {
  const quote = `The ferry should be free, and I will vote to make it so. (${Date.now()})`
  const sourceTitle = `Harbor Ledger: Sato on the ferry ${Date.now()}`
  const person = '/q/free-ferry/bartholomew-sato'

  await page.goto(person)
  await expect(page.getByRole('heading', { name: 'Bartholomew Sato' })).toBeVisible()
  await expect(page.getByText(quote)).toHaveCount(0)
  await page.getByRole('button', { name: 'Add to the record' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('What did Bartholomew Sato say or do?').fill(quote)
  await dialog.getByLabel('Link to the source').fill(`https://example.com/harbor-ledger/sato-${Date.now()}`)
  await dialog.getByLabel('Source name').fill(sourceTitle)
  await dialog.getByLabel('Date it happened').fill('2026-11-12')
  await dialog.getByLabel('What it shows').selectOption('support')
  await dialog.getByLabel('Anything the editor should know?').fill('Third paragraph.')
  await dialog.getByRole('button', { name: 'Send for review' }).click()
  await expect(dialog.getByText('Thank you. Your report is waiting for an editor.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible()
  const address = (await dialog.getByText(/\/latest\?proposal=/).textContent())!
  await dialog.getByRole('button', { name: 'Done' }).click()
  // Nothing reaches the record before review.
  await expect(page.getByText(quote)).toHaveCount(0)

  // The address the reader was given opens Latest on that report, already opened.
  const friend = await context.newPage()
  await friend.goto(address.slice(address.indexOf('/latest')))
  const waiting = friend.getByRole('article', { name: `Not checked yet: ${sourceTitle}` })
  await expect(waiting.getByText('Can you review this?')).toBeVisible()
  await expect(waiting.getByText(quote)).toBeVisible()

  const editor = await context.newPage()
  await editor.goto('/editor')
  await editor.getByLabel('Editor token').fill(`${editorToken()}x`)
  await editor.getByRole('button', { name: 'Sign in' }).click()
  await expect(editor.getByText('That token was not accepted.')).toBeVisible()
  await expect(editor.getByRole('heading', { name: 'Review queue' })).toHaveCount(0)
  await editor.getByLabel('Editor token').fill(editorToken())
  await editor.getByRole('button', { name: 'Sign in' }).click()
  await expect(editor.getByRole('heading', { name: 'Review queue' })).toBeVisible()

  const upNext = editor.getByRole('button').filter({ hasText: sourceTitle })
  if (await upNext.count()) await upNext.click()
  await expect(editor.getByRole('heading', { name: sourceTitle })).toBeVisible()
  await expect(editor.getByText('Reader’s note: Third paragraph.')).toBeVisible()
  const entry = editor.getByRole('region', { name: 'Bartholomew Sato' })
  await expect(entry.getByRole('heading', { name: 'Bartholomew Sato' })).toBeVisible()
  await expect(entry.getByText('Reader’s words, not checked against the source')).toBeVisible()
  await expect(entry.getByText(quote)).toBeVisible()
  // The reader's answer and the usual weight for words are filled in.
  await expect(entry.getByRole('radiogroup', { name: /^Which way it points on/ }).getByRole('radio', { name: 'Support' })).toBeChecked()
  await expect(entry.getByRole('radiogroup', { name: 'How much it counts' }).getByRole('radio', { name: 'Clear' })).toBeChecked()
  await expect(entry.getByText('their first entry')).toBeVisible()
  await editor.getByRole('button', { name: /Publish 1 person/ }).click()
  await expect(editor.getByRole('status')).toContainText(`Published 1 person from “${sourceTitle}”.`)
  await expect(editor.getByRole('heading', { name: sourceTitle })).toHaveCount(0)

  // Once it is reviewed, the address says so instead of pointing at nothing.
  await friend.reload()
  await expect(friend.getByRole('status').filter({ hasText: 'An editor has reviewed the report that link was for.' })).toBeVisible()

  // The reader's page updates without a reload.
  await expect(page.getByText(quote)).toBeVisible()
  await expect(page.getByText('Nothing on file.')).toHaveCount(0)
  await expect(page.locator('section.card').getByText(standingLabel('support', { kind: 'position', act_label: null }), { exact: true })).toBeVisible()
})

// The rows a news search run queues for a model-read article, written through
// the editor's party endpoint since no model runs in tests.
async function queueModelRead(request: APIRequestContext, item: { decider_id: string; quote: string; passage: string; reading: string; weight: string; kind: string }, sourceTitle: string) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const now = TODAY.toISOString()
  const ids = { source: `src-${stamp}`, proposal: `prop-${stamp}`, item: `item-${stamp}` }
  const write = await partyWrite(request, [
    { channel: 'sources', ops: [{ type: 'insert', value: { id: ids.source, url: `https://example.com/harbor-ledger/model-${stamp}`, title: sourceTitle, publisher: null, published_on: null, kind: null, archive_url: null, stored_copy: null, created_at: now } }] },
    { channel: 'proposals', ops: [{ type: 'insert', value: { id: ids.proposal, source_id: ids.source, origin: 'model', submitted_by: null, status: 'pending', unread: null, created_at: now, reviewed_at: null } }] },
    { channel: 'proposal_items', ops: [{ type: 'insert', value: { id: ids.item, proposal_id: ids.proposal, sort: 0, question_id: 'free-ferry', act_id: `act-${stamp}`, occurred_on: '2026-11-15', status: 'pending', ...item } }] },
    {
      channel: 'proposal_notes',
      ops: [
        { type: 'insert', value: { id: `note-${stamp}`, proposal_id: ids.proposal, proposal_item_id: null, kind: 'submitter', body: 'Read by a test model.', created_at: now } },
        { type: 'insert', value: { id: `note-item-${stamp}`, proposal_id: ids.proposal, proposal_item_id: ids.item, kind: 'submitter', body: "Model's reason: He says how he will vote.", created_at: now } },
      ],
    },
    { channel: 'proposal_contexts', ops: [{ type: 'insert', value: { id: ids.item, proposal_id: ids.proposal, proposal_item_id: ids.item, before: 'The council takes up the amendment on December 2.', after: 'The fiscal note is due before the vote.' } }] },
  ])
  expect(write.ok()).toBe(true)
  return ids
}

// Opens a waiting proposal: it is the open card already, or in the list beside it, on whichever page.
async function openCard(page: Page, sourceTitle: string) {
  await page.goto('/editor')
  await page.getByLabel('Editor token').fill(editorToken())
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible()
  const heading = page.getByRole('heading', { name: sourceTitle })
  const inList = page.getByRole('complementary').getByRole('button').filter({ hasText: sourceTitle })
  const next = page.getByRole('navigation', { name: 'Pages of what is waiting' }).getByRole('button', { name: 'Next' })
  await expect(page.getByRole('article').first()).toBeVisible()
  while (!(await heading.count()) && !(await inList.count()) && (await next.count()) && (await next.isEnabled())) await next.click()
  if (await inList.count()) await inList.click()
  await expect(heading).toBeVisible()
}

test('an entry read by a model shows its words marked in the passage, opens the wider passage over that entry, and publishes a reading on a smaller step too', async ({ page, request }) => {
  const quote = 'I will vote to make the ferry free, and I will say so at every stop.'
  const sourceTitle = `Sato on the ferry ${Date.now()}`
  await queueModelRead(request, { decider_id: 'demo-bartholomew-sato', quote, passage: `Sato was plain about it. ${quote} He spoke at the dock.`, reading: 'support', weight: 'clear', kind: 'says' }, sourceTitle)

  await openCard(page, sourceTitle)
  await expect(page.getByText('Read by a model on')).toBeVisible()
  await expect(page.getByText('Note: Read by a test model.')).toBeVisible()
  const entry = page.getByRole('region', { name: 'Bartholomew Sato' })
  await expect(entry.locator('mark').first()).toHaveText(quote)
  await expect(entry.getByText('Sato was plain about it.').first()).toBeVisible()
  await expect(entry.getByText("Model's reason: He says how he will vote.")).toBeVisible()

  // The dialog belongs to the entry, and holds the text either side that only editors are sent.
  await entry.getByText('Read the wider passage').click()
  const dialog = entry.getByRole('dialog', { name: 'The passage, for Bartholomew Sato' })
  await expect(dialog.getByText('The council takes up the amendment on December 2.')).toBeVisible()
  await expect(dialog.getByText('We publish this passage')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(dialog).toBeHidden()

  // The model's note is its own, not the editor's note on the entry.
  await entry.getByRole('button', { name: 'Add a note' }).click()
  await expect(entry.getByLabel(/Note on Bartholomew Sato/)).toHaveValue('')

  await entry.getByRole('button', { name: 'Related proposals' }).click()
  await entry.getByRole('radiogroup', { name: 'Free for city card holders: which way it points' }).getByRole('radio', { name: 'Probable' }).click()
  await expect(entry.getByText('first reading there')).toBeVisible()

  await entry.getByRole('button', { name: 'Dismiss' }).click()
  await expect(entry.getByText('dismissed, not published')).toBeVisible()
  await expect(page.getByRole('button', { name: /Nothing left to publish/ })).toBeVisible()
  await entry.getByRole('button', { name: 'Undo' }).click()

  await page.getByRole('button', { name: /Publish 1 person/ }).click()
  await expect(page.getByRole('status')).toContainText('Published 1 person')

  // The passage is published with the words marked, and the act is read on both questions.
  await page.goto('/latest?question=free-ferry-card')
  const story = page.getByRole('article', { name: sourceTitle })
  await expect(story.locator('mark')).toHaveText(quote)
  await expect(story.getByText('Sato was plain about it.')).toBeVisible()
  await expect(story.getByText('Free for city card holders')).toBeVisible()
  await expect(story.getByText('Fare-free ferry')).toBeVisible()
})

test('a reading across from a position editors set makes a decision card, and lifting the position shows what the record works out to', async ({ page, request }) => {
  const sourceTitle = `Council minutes ${Date.now()}`
  await page.goto('/q/free-ferry/nadezhda-okafor')
  await expect(page.getByText(/Set by editors on/)).toBeVisible()

  await queueModelRead(request, { decider_id: 'demo-nadezhda-okafor', quote: 'Okafor voted to set the berth fee to zero', passage: 'Item 7. Okafor voted to set the berth fee to zero. Carried 4 to 3.', reading: 'oppose', weight: 'concrete', kind: 'does' }, sourceTitle)
  await openCard(page, sourceTitle)
  await expect(page.getByRole('heading', { name: 'A new action by Nadezhda Okafor contradicts our recorded position' })).toBeVisible()
  const decision = page.getByRole('radiogroup', { name: 'Our position' })
  await expect(decision.getByRole('radio', { name: /Keep our position: Yes/ })).toBeChecked()
  await expect(page.getByRole('button', { name: /Publish, keep Yes/ })).toBeVisible()
  await decision.getByRole('radio', { name: /Lift our position: No/ }).click()
  await page.getByRole('button', { name: /Publish, show No/ }).click()
  await expect(page.getByRole('status')).toContainText('Published 1 person')

  await page.goto('/q/free-ferry/nadezhda-okafor')
  await expect(page.getByText('Okafor voted to set the berth fee to zero', { exact: true })).toBeVisible()
  await expect(page.getByText(/Set by editors on/)).toHaveCount(0)
  await expect(page.locator('section.card').getByText('No', { exact: true }).first()).toBeVisible()
})

test('an entry can be published as a report of an act already on the record, read on the measure with the question it came on left out', async ({ page, request }) => {
  const sourceTitle = `Oyelaran again ${Date.now()}`
  const words = 'Oyelaran voted against sending the fare study on'
  await queueModelRead(request, { decider_id: 'demo-marguerite-oyelaran', quote: words, passage: `In June ${words}.`, reading: 'oppose', weight: 'concrete', kind: 'does' }, sourceTitle)
  const acts = () => query<{ n: number }>(`SELECT COUNT(*) AS n FROM acts WHERE decider_id = 'demo-marguerite-oyelaran'`)[0].n
  const before = acts()

  await openCard(page, sourceTitle)
  const entry = page.getByRole('region', { name: 'Marguerite Oyelaran' })
  await entry.getByRole('button', { name: 'Change' }).click()
  const onRecord = entry.getByLabel('Which action is this?').locator('option', { hasText: 'Voted no on advancing the fare study' })
  await entry.getByLabel('Which action is this?').selectOption((await onRecord.getAttribute('value'))!)
  await expect(entry.getByText('an act already on the record')).toBeVisible()
  await expect(entry.getByLabel('Date it happened')).toBeDisabled()
  await expect(entry.getByLabel('Date it happened')).toHaveValue('2026-06-09')

  await entry.getByRole('button', { name: 'Related proposals' }).click()
  await entry.getByRole('radiogroup', { name: 'Ordinance 26-114: which way it points' }).getByRole('radio', { name: 'Against' }).click()
  await entry.getByRole('button', { name: 'Leave Fare-free ferry out' }).click()
  await expect(entry.getByText('Not read on Fare-free ferry')).toBeVisible()

  await page.getByRole('button', { name: /Publish 1 person/ }).click()
  await expect(page.getByRole('status')).toContainText('Published 1 person')
  await expect.poll(acts).toBe(before)
  expect(query(`SELECT rd.question_id FROM reports r JOIN sources s ON s.id = r.source_id JOIN readings rd ON rd.act_id = r.act_id WHERE s.title = '${sourceTitle}' ORDER BY rd.question_id`).map((r) => r.question_id)).toEqual(['free-ferry', 'free-ferry-ord-26-114'])
})

test('a card whose publish fails comes back as the editor left it', async ({ page, request }) => {
  const sourceTitle = `Sato once more ${Date.now()}`
  const quote = 'I have not changed my mind about the ferry.'
  await queueModelRead(request, { decider_id: 'demo-bartholomew-sato', quote, passage: `Sato said: ${quote}`, reading: 'support', weight: 'clear', kind: 'says' }, sourceTitle)
  await openCard(page, sourceTitle)
  const entry = page.getByRole('region', { name: 'Bartholomew Sato' })
  await entry.getByRole('radiogroup', { name: /^Which way it points on/ }).getByRole('radio', { name: 'Mixed' }).click()
  await entry.getByRole('button', { name: 'Add a note' }).click()
  await entry.getByLabel(/Note on Bartholomew Sato/).fill('Checked against the recording.')

  // The editor's writes go by POST to the party endpoint.
  await page.route('**/parties/tracker/**', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()))
  await page.getByRole('button', { name: /Publish 1 person/ }).click()
  await expect(page.getByText(/^Not saved:/)).toBeVisible()
  await expect(page.getByRole('heading', { name: sourceTitle })).toBeVisible()
  await expect(entry.getByRole('radiogroup', { name: /^Which way it points on/ }).getByRole('radio', { name: 'Mixed' })).toBeChecked()
  await entry.getByRole('button', { name: /the note/ }).click()
  await expect(entry.getByLabel(/Note on Bartholomew Sato/)).toHaveValue('Checked against the recording.')
  expect(query(`SELECT status FROM proposals p JOIN sources s ON s.id = p.source_id WHERE s.title = '${sourceTitle}'`)).toEqual([{ status: 'pending' }])

  // With the connection back, the same card publishes what the editor had set.
  await page.unroute('**/parties/tracker/**')
  await page.getByRole('button', { name: /Publish 1 person/ }).click()
  await expect(page.getByRole('status')).toContainText('Published 1 person')
  await expect.poll(() => query(`SELECT rd.position FROM reports r JOIN sources s ON s.id = r.source_id JOIN readings rd ON rd.act_id = r.act_id WHERE s.title = '${sourceTitle}'`)).toEqual([{ position: 'mixed' }])
})

test('the list beside the open card pages through every waiting proposal', async ({ page, request }) => {
  const stamp = Date.now()
  const title = (n: number) => `Paged ${stamp} no. ${String(n).padStart(2, '0')}`
  // More than two pages' worth, whatever earlier tests left waiting.
  for (let n = 1; n <= 26; n++) {
    await queueModelRead(request, { decider_id: 'demo-bartholomew-sato', quote: `Words for paging ${stamp} ${n}.`, passage: `Words for paging ${stamp} ${n}.`, reading: 'support', weight: 'passing', kind: 'says' }, title(n))
  }
  await page.goto('/editor')
  await page.getByLabel('Editor token').fill(editorToken())
  await page.getByRole('button', { name: 'Sign in' }).click()
  const pages = page.getByRole('navigation', { name: 'Pages of what is waiting' })
  const waiting = query<{ n: number }>(`SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'`)[0].n
  await expect(pages).toContainText(`1–12 of ${waiting}`)
  await expect(pages.getByRole('button', { name: 'Previous' })).toBeDisabled()

  // Every waiting proposal is on exactly one page of the list, the open card among them.
  await expect(page.getByRole('complementary').locator('button[aria-current="true"]')).toHaveCount(1)
  const seen = new Set<string>()
  const list = page.getByRole('complementary').getByRole('listitem')
  for (;;) {
    for (const text of await list.allTextContents()) seen.add(text)
    if (await pages.getByRole('button', { name: 'Next' }).isDisabled()) break
    await pages.getByRole('button', { name: 'Next' }).click()
  }
  expect(seen.size).toBe(waiting)
  await expect(pages).toContainText(`of ${waiting}`)

  // A card on a later page opens from there.
  const last = list.last()
  const lastTitle = (await last.textContent())!
  await last.getByRole('button').click()
  await expect(page.getByRole('article').getByRole('heading').first()).toContainText(lastTitle.match(/Paged \d+ no\. \d+/)![0])
})

test('work on a card is kept while another card is open, and a question added from a card can be read on at once', async ({ page, request }) => {
  const stamp = Date.now()
  const first = `Kept ${stamp} first`
  const second = `Kept ${stamp} second`
  const quote = 'I am for the free ferry, and for the card version too.'
  await queueModelRead(request, { decider_id: 'demo-bartholomew-sato', quote, passage: `Sato said: ${quote}`, reading: 'support', weight: 'clear', kind: 'says' }, first)
  await queueModelRead(request, { decider_id: 'demo-bartholomew-sato', quote: `${quote} Again.`, passage: `${quote} Again.`, reading: 'support', weight: 'clear', kind: 'says' }, second)

  await openCard(page, first)
  const entry = page.getByRole('region', { name: 'Bartholomew Sato' })
  await entry.getByRole('button', { name: 'Related proposals' }).click()
  await entry.getByRole('button', { name: 'Add a related question' }).click()
  const shortName = `Free on weekends ${stamp}`
  await entry.getByLabel('Short name').fill(shortName)
  await entry.getByLabel('The question, as asked').fill('Should the ferry be free on weekends?')
  await entry.getByRole('button', { name: 'Add the question' }).click()
  // It starts with the entry's own reading, as a smaller step.
  const onNew = entry.getByRole('radiogroup', { name: `${shortName}: which way it points` })
  await expect(onNew.getByRole('radio', { name: 'Support' })).toBeChecked()
  await entry.getByRole('radiogroup', { name: /^Which way it points on/ }).getByRole('radio', { name: 'Probable' }).click()

  // Another card, then back: the list marks this one as started, and it is as it was left.
  const list = page.getByRole('complementary')
  const pagesNav = page.getByRole('navigation', { name: 'Pages of what is waiting' })
  const find = async (title: string) => {
    const row = list.getByRole('button').filter({ hasText: title })
    while (!(await row.count()) && (await pagesNav.getByRole('button', { name: 'Next' }).isEnabled())) await pagesNav.getByRole('button', { name: 'Next' }).click()
    return row
  }
  await (await find(second)).click()
  await expect(page.getByRole('heading', { name: second })).toBeVisible()
  const back = await find(first)
  await expect(back).toContainText('started')
  await back.click()
  await expect(page.getByRole('heading', { name: first })).toBeVisible()
  await expect(entry.getByRole('radiogroup', { name: /^Which way it points on/ }).getByRole('radio', { name: 'Probable' })).toBeChecked()

  await page.getByRole('button', { name: /Publish 1 person/ }).click()
  await expect(page.getByRole('status')).toContainText('Published 1 person')
  await expect.poll(() => query(`SELECT rd.position FROM readings rd JOIN questions q ON q.id = rd.question_id WHERE q.short_title = '${shortName}'`)).toEqual([{ position: 'support' }])
  expect(query(`SELECT r.kind FROM question_relations r JOIN questions q ON q.id = r.related_id WHERE q.short_title = '${shortName}' AND r.question_id = 'free-ferry'`)).toEqual([{ kind: 'smaller_step' }])
})

test('someone the article only describes can be recorded as presumed, and their page says there is no quote of their own', async ({ page, request }) => {
  const sourceTitle = `Sato on Kowalczyk ${Date.now()}`
  const quote = 'I am still for the free ferry.'
  const ids = await queueModelRead(request, { decider_id: 'demo-bartholomew-sato', quote, passage: `Sato said: ${quote}`, reading: 'support', weight: 'clear', kind: 'says' }, sourceTitle)
  const words = `Kowalczyk no longer backs the plan ${ids.item}`
  expect((await partyWrite(request, [{ channel: 'proposal_mentions', ops: [{ type: 'insert', value: { id: `mention-${ids.item}`, proposal_id: ids.proposal, decider_id: 'demo-desmond-kowalczyk', words } }] }])).ok()).toBe(true)

  await openCard(page, sourceTitle)
  await page.getByRole('button', { name: 'Record what it says of them, as presumed' }).click()
  const entry = page.getByRole('region', { name: 'Desmond Kowalczyk' })
  await expect(entry.getByLabel('The words, from the source')).toHaveValue(words)
  await expect(entry.getByRole('radiogroup', { name: 'How much it counts' }).getByRole('radio', { name: 'Presumed' })).toBeChecked()
  await expect(page.locator('#approve')).toHaveText(/Publish needs both answers/)
  await entry.getByRole('radiogroup', { name: /^Which way it points on/ }).getByRole('radio', { name: 'Against' }).click()
  await page.getByRole('button', { name: /Publish 2 people/ }).click()
  await expect(page.getByRole('status')).toContainText('Published 2 people')

  // His own earlier statement still decides where he is listed; the account of him is on the record, marked.
  await page.goto('/q/free-ferry/desmond-kowalczyk')
  await expect(page.getByText(words, { exact: false }).first()).toBeVisible()
  await expect(page.getByText('Presumed, no quote of their own yet')).toBeVisible()
  expect(query(`SELECT rd.weight FROM readings rd JOIN acts a ON a.id = rd.act_id WHERE a.body = '${words}'`)).toEqual([{ weight: 'presumed' }])
})

test('a lead whose article was not read says so, starts empty, and cannot be published until the words, both answers and a date are in', async ({ page, request }) => {
  const stamp = Date.now()
  const now = TODAY.toISOString()
  const sourceTitle = `Bayport hearing ${stamp}`
  const write = await partyWrite(request, [
    { channel: 'sources', ops: [{ type: 'insert', value: { id: `src-${stamp}`, url: `https://example.com/bayport/${stamp}`, title: sourceTitle, publisher: null, published_on: null, kind: null, archive_url: null, stored_copy: null, created_at: now } }] },
    { channel: 'proposals', ops: [{ type: 'insert', value: { id: `prop-${stamp}`, source_id: `src-${stamp}`, origin: 'news_search', submitted_by: null, status: 'pending', unread: 'refused', created_at: now, reviewed_at: null } }] },
    {
      channel: 'proposal_items',
      ops: [{ type: 'insert', value: { id: `item-${stamp}`, proposal_id: `prop-${stamp}`, sort: 0, decider_id: 'demo-ikenna-vasquez', question_id: 'free-ferry', act_id: `act-${stamp}`, kind: 'says', occurred_on: null, quote: 'Vasquez told the hearing his city could not carry the ferry', passage: null, reading: null, weight: null, status: 'pending' } }],
    },
  ])
  expect(write.ok()).toBe(true)

  await openCard(page, sourceTitle)
  await expect(page.getByText('We could not read this article.')).toBeVisible()
  await expect(page.getByText('The site turned our reader away, so nothing on this card is filled in.')).toBeVisible()
  const entry = page.getByRole('region', { name: 'Ikenna Vasquez' })
  await expect(entry.getByLabel('The words, from the source')).toHaveValue('')
  const direction = entry.getByRole('radiogroup', { name: /^Which way it points on/ })
  const weight = entry.getByRole('radiogroup', { name: 'How much it counts' })
  await expect(direction.getByRole('radio', { checked: true })).toHaveCount(0)
  await expect(weight.getByRole('radio', { checked: true })).toHaveCount(0)
  const publish = page.locator('#approve')
  await expect(publish).toBeDisabled()
  await expect(publish).toHaveText(/Publish needs the words/)
  await entry.getByLabel('The words, from the source').fill('We cannot ask Bayport to carry our ferry.')
  await expect(publish).toHaveText(/Publish needs both answers/)
  await direction.getByRole('radio', { name: 'Against' }).click()
  await weight.getByRole('radio', { name: 'Clear' }).click()
  // The lead came with no date, and none is assumed.
  await expect(publish).toHaveText(/Publish needs the date/)
  await entry.getByRole('button', { name: /^Use .*, the day this was put forward$/ }).click()
  await expect(publish).toBeEnabled()
  await expect(publish).toHaveText(/Publish 1 person/)
})

test('choosing the next term shows the viewing-another-day strip, and its link returns to today', async ({ page }) => {
  const [body] = query<{ next_term_on: string; next_term_label: string }>(`SELECT next_term_on, next_term_label FROM bodies WHERE id = 'us-congress'`)
  expect(body.next_term_on > DAY, 'the next term lies ahead of the fixed clock').toBe(true)
  await page.goto('/q/medicare-for-all')
  const strip = page.getByRole('status').filter({ hasText: /^Viewing/ })
  await expect(page.getByRole('button', { name: 'Now', pressed: true })).toBeVisible()
  await expect(strip).toHaveCount(0)

  await page.getByRole('button', { name: body.next_term_label }).click()
  await expect(page).toHaveURL(new RegExp(`[?&]as=${body.next_term_on}`))
  await expect(strip).toBeVisible()
  await expect(strip).toContainText('as expected')
  await expect(page.getByRole('button', { name: body.next_term_label, pressed: true })).toBeVisible()

  // The day viewed rides along on links to other pages.
  await page.getByRole('link', { name: 'Questions', exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`[?&]as=${body.next_term_on}`))
  await expect(strip).toBeVisible()

  await strip.getByRole('link', { name: 'Back to today' }).click()
  await expect(strip).toHaveCount(0)
  await expect(page).not.toHaveURL(/[?&]as=/)
})

async function signInAsEditor(page: Page) {
  await page.goto('/editor')
  await page.getByLabel('Editor token').fill(editorToken())
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible()
}

test('an editor adds a question with a measure and an ask, sees it listed and on its own page, and edits it', async ({ page }) => {
  const stamp = Date.now()
  const title = `Should the pier reopen to cars? (${stamp})`
  const shortName = `Pier cars ${stamp}`
  await signInAsEditor(page)

  await page.goto('/questions')
  await page.getByRole('link', { name: 'Add a question' }).click()
  await expect(page.getByRole('heading', { name: 'A new question' })).toBeVisible()
  const form = page.getByRole('form', { name: 'The new question' })
  await form.getByLabel('Body').selectOption({ label: 'Harbor City Council (demo)' })
  await form.getByRole('button', { name: 'Add the question' }).click()
  await expect(page.getByRole('alert')).toContainText('The question needs to be written out.')
  await form.getByLabel('The question, as asked').fill(title)
  await form.getByLabel('Short name').fill(shortName)
  await form.getByLabel(/^Seats needed/).fill('6')
  await form.getByRole('button', { name: 'Add the question' }).click()
  await expect(page.getByRole('heading', { name: 'Edit this question' })).toBeVisible()

  const slug = `pier-cars-${stamp}`
  await expect(page).toHaveURL(new RegExp(`/editor/questions/${slug}/edit$`))
  const [made] = query<{ id: string; body_id: string; threshold: number; parent_id: string | null }>(`SELECT id, body_id, threshold, parent_id FROM questions WHERE slug = '${slug}'`)
  expect(made).toMatchObject({ body_id: 'harbor-city-council', threshold: 6, parent_id: null })
  expect(made.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)

  await page.getByRole('link', { name: 'Add a measure' }).click()
  await expect(page.getByRole('heading', { name: 'A new measure' })).toBeVisible()
  await page.getByLabel('The question, as asked').fill('Have they signed on to Ordinance 27-001?')
  await page.getByLabel('Short name').fill('Ordinance 27-001')
  await page.getByRole('button', { name: 'Add the measure' }).click()
  await expect(page.getByRole('heading', { name: 'Edit this question' })).toBeVisible()

  await page.getByRole('link', { name: 'Add an ask' }).click()
  await page.getByLabel('The question, as asked').fill('Will they bring the pier to a vote?')
  await page.getByLabel('Short name').fill('Pier vote')
  await page.getByRole('button', { name: 'Add the ask' }).click()
  await expect(page.getByRole('alert')).toContainText('An ask needs at least one person or office')
  await page.getByLabel('Person 1', { exact: true }).selectOption({ label: 'Bartholomew Sato' })
  await page.getByLabel('Their role here').fill('Council president')
  await page.getByRole('button', { name: 'Add the ask' }).click()
  const subs = page.getByRole('region', { name: 'Measures and asks' })
  await expect(subs.getByRole('listitem')).toHaveText([/Measure\s*Ordinance 27-001/, /Ask\s*Pier vote/])
  expect(query(`SELECT q.kind, q.implies_on_parent, q.slug FROM questions q WHERE q.parent_id = '${made.id}' ORDER BY q.sort`)).toEqual([
    { kind: 'formal_act', implies_on_parent: 'support', slug: `${slug}-ordinance-27-001` },
    { kind: 'position', implies_on_parent: null, slug: `${slug}-pier-vote` },
  ])

  // Listed on the questions page, and on its own page with the measure's tab and the person the ask is put to.
  await page.goto('/questions')
  await page.getByRole('link', { name: new RegExp(title.replace(/[?()]/g, '\\$&')) }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Related questions' }).getByRole('link', { name: 'Ordinance 27-001' })).toBeVisible()
  const keyPeople = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Key people' }) })
  await expect(keyPeople.getByRole('link', { name: /Bartholomew Sato/ })).toContainText('Will they bring the pier to a vote?')
  await expect(keyPeople).toContainText('Council president')

  // Edited: the new title shows and the address stays.
  await page.getByRole('link', { name: 'Edit this question' }).click()
  const edited = `Should cars be allowed back on the pier? (${stamp})`
  await page.getByLabel('The question, as asked').fill(edited)
  await page.getByLabel('Short name').fill(`Cars on the pier ${stamp}`)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  await expect.poll(() => query(`SELECT title, slug FROM questions WHERE id = '${made.id}'`)).toEqual([{ title: edited, slug }])
  await page.goto(`/q/${slug}`)
  await expect(page.getByRole('heading', { level: 1, name: edited })).toBeVisible()
})

test('a smaller step made from a question’s edit page is linked to it, and any question can be closed and reopened', async ({ page }) => {
  const stamp = Date.now()
  const shortName = `Free at night ${stamp}`
  await signInAsEditor(page)

  await page.goto('/q/free-ferry')
  await page.getByRole('link', { name: 'Edit this question' }).click()
  await page.getByRole('link', { name: 'Add a smaller step or related question' }).click()
  await expect(page.getByRole('heading', { name: 'A new linked question' })).toBeVisible()
  await expect(page.getByRole('radio', { name: /A smaller step toward/ })).toBeChecked()
  await page.getByLabel('The question, as asked').fill('Should the ferry be free after 9 p.m.?')
  await page.getByLabel('Short name').fill(shortName)
  await page.getByRole('button', { name: 'Add the question' }).click()
  await expect(page.getByRole('heading', { name: 'Edit this question' })).toBeVisible()
  await expect
    .poll(() => query(`SELECT r.kind, q.parent_id FROM question_relations r JOIN questions q ON q.id = r.related_id WHERE r.question_id = 'free-ferry' AND q.short_title = '${shortName}'`))
    .toEqual([{ kind: 'smaller_step', parent_id: null }])

  await page.goto('/editor/questions/free-ferry/edit')
  await expect(page.getByRole('region', { name: 'Smaller steps and related questions' }).getByRole('listitem').filter({ hasText: shortName })).toContainText('Smaller step')
  // The fare-free question has readings, so changing what it asks says what that does. Nothing is saved here.
  await page.getByRole('radio', { name: /Whether someone did a specific thing/ }).check()
  await expect(page.getByRole('note')).toContainText('on the record here. Changing what it asks changes how they are counted')

  await page.goto(`/editor/questions/free-at-night-${stamp}/edit`)
  await page.getByRole('button', { name: 'Close this question' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /Lapsed/ }).check()
  await dialog.getByLabel('Date').fill(DAY)
  await dialog.getByRole('button', { name: 'Close the question' }).click()
  await expect(page.getByRole('button', { name: 'Reopen this question' })).toBeVisible()
  await expect.poll(() => query(`SELECT status, closed_on FROM questions WHERE short_title = '${shortName}'`)).toEqual([{ status: 'lapsed', closed_on: DAY }])
  await page.getByRole('button', { name: 'Reopen this question' }).click()
  await expect(page.getByRole('button', { name: 'Close this question' })).toBeVisible()
  await expect.poll(() => query(`SELECT status, closed_on FROM questions WHERE short_title = '${shortName}'`)).toEqual([{ status: 'open', closed_on: null }])
})

test('a question with a closing date still ahead offers to remove the date, not to reopen it', async ({ page }) => {
  const stamp = Date.now()
  const shortName = `Night fares ${stamp}`
  const later = new Date(TODAY.getTime() + 30 * 86_400_000).toISOString().slice(0, 10)
  await signInAsEditor(page)

  await page.goto('/editor/questions/new?linkTo=free-ferry')
  await page.getByLabel('The question, as asked').fill('Should night fares be cut?')
  await page.getByLabel('Short name').fill(shortName)
  await page.getByRole('button', { name: 'Add the question' }).click()
  await expect(page.getByRole('heading', { name: 'Edit this question' })).toBeVisible()

  await page.getByRole('button', { name: 'Close this question' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /Lapsed/ }).check()
  await dialog.getByLabel('Date').fill(later)
  await dialog.getByRole('button', { name: 'Close the question' }).click()
  await expect(page.getByText(/^Closes /)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reopen this question' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Remove the closing date' }).click()
  await expect(page.getByRole('button', { name: 'Close this question' })).toBeVisible()
  await expect.poll(() => query(`SELECT status, closed_on FROM questions WHERE short_title = '${shortName}'`)).toEqual([{ status: 'open', closed_on: null }])
})
