import { expect, test, type Page } from '@playwright/test'
import { EDITORS_ID, NEWS_READER_ID } from '../../shared/schema.ts'
import { TODAY, partyWrite } from './fixtures.ts'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(TODAY)
})

type Frame = { channel?: string; ops?: { value: Record<string, unknown> }[]; subscribe?: string }

// Every party-db frame the page sends and is sent.
function recordFrames(page: Page) {
  const sent: Frame[] = []
  const received: Frame[] = []
  const parse = (payload: string | Buffer, into: Frame[]) => {
    try {
      into.push(JSON.parse(String(payload)))
    } catch {
      // partysocket pings are not JSON
    }
  }
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => parse(f.payload, sent))
    ws.on('framereceived', (f) => parse(f.payload, received))
  })
  return {
    rowsOn: (channel: string) => received.filter((f) => f.channel === channel).flatMap((f) => f.ops?.map((op) => op.value) ?? []),
    subscribedTo: (channel: string) => sent.some((f) => f.subscribe === channel),
  }
}

test('the feed lists the record newest first, and its filters live in the URL', async ({ page }) => {
  await page.goto('/q/free-ferry')
  await page.getByRole('link', { name: 'Latest on this question' }).click()
  await expect(page).toHaveURL(/\/news\?question=free-ferry$/)
  await expect(page.getByRole('heading', { name: 'Latest', exact: true })).toBeVisible()
  await expect(page.getByLabel('Question', { exact: true })).toHaveValue('free-ferry')

  const published = page.getByRole('region', { name: 'Stories' })
  const entries = published.getByRole('article')
  await expect(entries.first()).toBeVisible()
  // Every entry links to the person's page on the question it is read on.
  const links = await published.locator('a[href^="/q/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))
  expect(links.length).toBeGreaterThan(0)
  for (const href of links) expect(href).toMatch(/^\/q\/[^/]+\/[^/?]+/)

  await page.getByLabel('Body', { exact: true }).selectOption('harbor-port-authority')
  await expect(page).toHaveURL(/body=harbor-port-authority/)
  await expect(page).toHaveURL(/question=free-ferry/)

  await page.getByLabel('Question', { exact: true }).selectOption('')
  await expect(page).not.toHaveURL(/question=/)
  await page.getByLabel('Body', { exact: true }).selectOption('')
  await expect(page).not.toHaveURL(/body=/)

  // The national record pages: 20 stories, then a link to older ones.
  await expect(published.getByRole('article')).toHaveCount(20)
  await published.getByRole('link', { name: 'Older stories' }).click()
  await expect(page).toHaveURL(/before=/)
  await expect(published.getByRole('link', { name: 'Back to the newest' })).toBeVisible()
})

test('an article with several people in it is one story, with the people as replies folded after three', async ({ page, request }) => {
  const stamp = Date.now()
  const at = TODAY.toISOString()
  const title = `Harbor Ledger: where the council stands (${stamp})`
  const people = ['demo-ikenna-vasquez', 'demo-renzo-achterberg', 'demo-suvi-castellanos', 'demo-priyanka-lindqvist']
  const ids = people.map((_, i) => ({ act: `act-${stamp}-${i}`, report: `rep-${stamp}-${i}`, reading: `rd-${stamp}-${i}` }))
  const positions = ['support', 'oppose', 'mixed', 'lean_support']
  const write = await partyWrite(request, [
    { channel: 'sources', ops: [{ type: 'insert', value: { id: `src-${stamp}`, url: `https://example.com/ledger-${stamp}`, title, publisher: null, published_on: null, published_on_from: null, kind: 'article', archive_url: null, stored_copy: null, created_at: at } }] },
    {
      channel: 'acts',
      ops: people.map((decider_id, i) => ({ type: 'insert', value: { id: ids[i].act, decider_id, kind: 'says', occurred_on: '2026-11-18', body: `Words from person ${i} (${stamp})`, primary_source_id: null, withdrawn_on: null, created_at: at } })),
    },
    { channel: 'reports', ops: people.map((_, i) => ({ type: 'insert', value: { id: ids[i].report, source_id: `src-${stamp}`, act_id: ids[i].act, excerpt: null, created_at: at } })) },
    {
      channel: 'reviews',
      ops: people.map((_, i) => ({
        type: 'insert',
        value: { id: ids[i].reading, reviewer_id: EDITORS_ID, act_id: ids[i].act, question_id: 'free-ferry', position: positions[i], weight: 'clear', based_on: null, created_at: at, updated_at: at },
      })),
    },
  ])
  expect(write.ok()).toBe(true)

  await page.goto('/news?question=free-ferry')
  const story = page.getByRole('article', { name: title })
  await expect(story).toBeVisible()
  await expect(story).toContainText('4 people')
  await expect(story.getByRole('listitem').filter({ hasText: /Words from person/ })).toHaveCount(3)
  await story.getByRole('button', { name: 'Show 1 more' }).click()
  await expect(story.getByRole('listitem').filter({ hasText: /Words from person/ })).toHaveCount(4)
  // Each person links to their page on the question.
  await expect(story.getByRole('link', { name: 'Fare-free ferry' })).toHaveCount(4)
  await expect(story.getByRole('link', { name: 'Fare-free ferry' }).first()).toHaveAttribute('href', /^\/q\/free-ferry\/[a-z-]+/)

  const xml = await (await request.get('/feed.xml?question=free-ferry')).text()
  expect(xml).toContain(`${title} (4 people)`)
})

test('a feed link to a question that does not exist says so instead of showing everything', async ({ page }) => {
  await page.goto('/news?question=no-such-question')
  await expect(page.getByText('No question here.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Stories' })).toHaveCount(0)
  await page.getByRole('link', { name: 'See everything that is new' }).click()
  await expect(page).toHaveURL(/\/news$/)
  await expect(page.getByRole('region', { name: 'Stories' })).toBeVisible()
})

test('the Atom feed is linked from the page and carries the published record', async ({ page, request }) => {
  await page.goto('/news?question=free-ferry')
  await expect(page.locator('head link[rel="alternate"][type="application/atom+xml"]')).toHaveAttribute('href', '/feed.xml?question=free-ferry')
  await expect(page.getByRole('link', { name: 'Atom feed of this selection' })).toHaveAttribute('href', '/feed.xml?question=free-ferry')

  const res = await request.get('/feed.xml?question=free-ferry')
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toBe('application/atom+xml; charset=utf-8')
  const xml = await res.text()
  expect(xml).toContain('The ferry is a bridge we forgot to build.')
  expect(xml.match(/<entry>/g)?.length).toBeGreaterThan(0)
})

let cleanup: (() => Promise<unknown>) | undefined
test.afterEach(async () => {
  const res = (await cleanup?.()) as { ok(): boolean } | undefined
  if (res) expect(res.ok()).toBe(true)
  cleanup = undefined
})

test('what is waiting shows in the feed as a short unchecked line that opens to ask for a review, and showing only the record loads no proposals', async ({ page, request }) => {
  const stamp = Date.now()
  const now = TODAY.toISOString()
  const claimed = `I back a free ferry and will vote for it, every time. (${stamp})`
  const rejected = `A claim an editor turned down. (${stamp})`
  const lead = `An excerpt that names Sato and claims nothing. (${stamp})`
  const names = ['claim', 'rej', 'lead']

  // What comes in for each claim: its act, its report in the source and the sender's review, and an item linking it to the proposal.
  const claims = [
    { name: 'claim', quote: claimed, reading: 'support', editors: undefined },
    { name: 'rej', quote: rejected, reading: 'oppose', editors: null },
  ]
  const act = (c: (typeof claims)[number]) => ({ type: 'insert', value: { id: `act-${c.name}-${stamp}`, decider_id: 'demo-bartholomew-sato', kind: 'says', occurred_on: null, body: c.quote, primary_source_id: null, withdrawn_on: null, created_at: now } })
  const reviewRow = (id: string, reviewer: string, actId: string, position: string | null) => ({
    type: 'insert',
    value: { id, reviewer_id: reviewer, act_id: actId, question_id: 'free-ferry', position, weight: position && 'clear', based_on: null, created_at: now, updated_at: now },
  })
  const item = (id: string, proposal: string, actId: string | null, excerpt: string | null = null) => ({
    type: 'insert',
    value: { id, proposal_id: proposal, sort: 0, decider_id: 'demo-bartholomew-sato', question_id: 'free-ferry', act_id: actId, excerpt },
  })
  const source = (id: string) => ({ type: 'insert', value: { id, url: `https://example.com/${id}`, title: id, publisher: null, published_on: null, published_on_from: null, kind: null, archive_url: null, stored_copy: null, created_at: now } })
  const proposal = (id: string, sourceId: string, origin: string) => ({ type: 'insert', value: { id, source_id: sourceId, origin, submitted_by: NEWS_READER_ID, status: 'pending', created_at: now, reviewed_at: null } })
  const write = await partyWrite(request, [
    { channel: 'sources', ops: names.map((n) => source(`${n}-${stamp}`)) },
    { channel: 'acts', ops: claims.map(act) },
    { channel: 'reports', ops: claims.map((c) => ({ type: 'insert', value: { id: `rep-${c.name}-${stamp}`, source_id: `${c.name}-${stamp}`, act_id: `act-${c.name}-${stamp}`, excerpt: null, passage: null, created_at: now } })) },
    {
      channel: 'reviews',
      ops: [
        ...claims.map((c) => reviewRow(`rv-${c.name}-${stamp}`, NEWS_READER_ID, `act-${c.name}-${stamp}`, c.reading)),
        reviewRow(`rv-editors-rej-${stamp}`, EDITORS_ID, `act-rej-${stamp}`, null),
      ],
    },
    { channel: 'proposals', ops: [proposal(`p-claim-${stamp}`, `claim-${stamp}`, 'reader'), proposal(`p-rej-${stamp}`, `rej-${stamp}`, 'reader'), proposal(`p-lead-${stamp}`, `lead-${stamp}`, 'news_search')] },
    {
      channel: 'proposal_items',
      ops: [item(`i-claim-${stamp}`, `p-claim-${stamp}`, `act-claim-${stamp}`), item(`i-rej-${stamp}`, `p-rej-${stamp}`, `act-rej-${stamp}`), item(`i-lead-${stamp}`, `p-lead-${stamp}`, null, lead)],
    },
    { channel: 'proposal_notes', ops: [{ type: 'insert', value: { id: `note-${stamp}`, proposal_id: `p-claim-${stamp}`, proposal_item_id: null, kind: 'submitter', body: 'Only editors read this note.', created_at: now } }] },
  ])
  expect(write.ok()).toBe(true)
  // The editor flows expect the queue to hold only what they put there.
  const remove = (channel: string, ids: string[], key = 'id') => ({ channel, ops: ids.map((id) => ({ type: 'delete', value: { [key]: id } })) })
  cleanup = () =>
    partyWrite(request, [
      remove('proposal_notes', [`note-${stamp}`]),
      remove('proposal_items', names.map((n) => `i-${n}-${stamp}`)),
      remove('reviews', [...claims.map((c) => `rv-${c.name}-${stamp}`), `rv-editors-rej-${stamp}`]),
      remove('reports', claims.map((c) => `rep-${c.name}-${stamp}`)),
      remove('acts', claims.map((c) => `act-${c.name}-${stamp}`)),
      remove('proposals', names.map((n) => `p-${n}-${stamp}`)),
      remove('sources', names.map((n) => `${n}-${stamp}`)),
    ])

  const frames = recordFrames(page)
  await page.goto('/news?recordOnly=true')
  const stories = page.getByRole('region', { name: 'Stories' })
  await expect(stories.getByRole('article').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show only what is on the record', pressed: true })).toBeVisible()
  // Give any query mounted after first paint time to subscribe before checking none did.
  await page.waitForTimeout(500)
  expect(frames.subscribedTo('proposals')).toBe(false)
  expect(frames.subscribedTo('proposal_items')).toBe(false)
  expect(frames.rowsOn('proposals')).toEqual([])
  expect(frames.rowsOn('proposal_items')).toEqual([])
  await expect(stories.locator('[data-waiting]')).toHaveCount(0)
  // In the URL, so a reload keeps it.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Show only what is on the record', pressed: true })).toBeVisible()
  await expect(stories.getByRole('article').first()).toBeVisible()
  await expect(stories.locator('[data-waiting]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Show only what is on the record' }).click()
  await expect(page).not.toHaveURL(/recordOnly/)
  const entry = stories.locator('[data-waiting]').filter({ hasText: `claim-${stamp}` })
  await expect(entry).toBeVisible()
  await expect(entry).toContainText('Not checked yet')
  await expect(entry).toContainText('example.com · from a reader')
  await expect(entry).toContainText(`claim-${stamp}`)
  await expect(entry).toContainText(/B\. Sato\s*yes\s*on Fare-free ferry · prev\. (yes|no record yet)/)
  // Terse until opened.
  await expect(entry.getByText(claimed)).toHaveCount(0)
  await entry.getByRole('button', { name: /Review/, expanded: false }).click()
  await expect(entry.getByText(claimed)).toBeVisible()
  await expect(entry).toContainText(/Claimed:\s*Yes\s*on\s*Fare-free ferry/)
  await expect(entry.getByText('Can you review this?')).toBeVisible()
  await expect(entry.getByRole('link', { name: 'Read the source ↗' })).toHaveAttribute('href', `https://example.com/claim-${stamp}`)
  await expect(entry.getByRole('link', { name: 'Discuss Bartholomew Sato' })).toHaveAttribute('href', '/q/free-ferry/bartholomew-sato#discussion')
  await expect(page.getByText(rejected)).toHaveCount(0)
  await expect(page.getByText(lead)).toHaveCount(0)
  await expect(page.getByText('Only editors read this note.')).toHaveCount(0)
  expect(frames.subscribedTo('proposal_items')).toBe(true)
  expect(frames.rowsOn('proposal_items').map((i) => i.act_id)).toContain(`act-claim-${stamp}`)
  expect(frames.rowsOn('proposal_notes')).toEqual([])

  const feed = await (await request.get('/feed.xml')).text()
  expect(feed).not.toContain(claimed)
})
