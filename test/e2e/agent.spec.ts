import { expect, test, type Page } from '@playwright/test'

type Tool = { name: string; execute: (input: unknown, client: unknown) => Promise<unknown> }
type Component = { ref: string; component: string; label?: string; text?: string[]; errors?: string[] }
type ActResult = { ok: boolean; error?: { message: string }; appeared: Component[] }

// Stands in for a browser with WebMCP. The app registers its tools on
// document.modelContext, and the tests call them the way a browser's agent would.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const tools: Tool[] = []
    const pageGlobals = globalThis as unknown as { webmcpTools: Tool[]; document: object }
    pageGlobals.webmcpTools = tools
    Object.defineProperty(pageGlobals.document, 'modelContext', {
      value: { registerTool: async (tool: Tool) => void tools.push(tool) },
    })
  })
})

const callTool = <T,>(page: Page, name: string, input: unknown) =>
  page.evaluate(
    async ([name, input]) => {
      const tool = (globalThis as unknown as { webmcpTools: Tool[] }).webmcpTools.find((t) => t.name === name)
      if (!tool) throw new Error(`no tool named ${name}`)
      return tool.execute(input, { requestUserInteraction: (callback: () => Promise<unknown>) => callback() })
    },
    [name, input] as const,
  ) as Promise<T>

const act = (page: Page, steps: { ref: string; action: string; args?: unknown[] }[]) => callTool<ActResult>(page, 'act', { steps: steps.map((s) => ({ args: [], ...s })) })
const snapshot = (page: Page) => callTool<Component[]>(page, 'snapshot', {})

test('an agent in the reader’s browser fills in "Add to the record", and the report waits for an editor', async ({ page }) => {
  const stamp = Date.now()
  const quote = `Free fares are the fair thing, and I will say so at council. (${stamp})`
  const sourceTitle = `Harbor Ledger: agent report ${stamp}`

  await page.goto('/q/free-ferry/bartholomew-sato')
  await expect(page.getByRole('heading', { name: 'Bartholomew Sato' })).toBeVisible()
  expect((await act(page, [{ ref: 'Add to the record', action: 'press' }])).ok).toBe(true)

  const listed = await snapshot(page)
  expect(listed.map((c) => c.label)).toEqual(expect.arrayContaining(['What did Bartholomew Sato say or do?', 'Link to the source', 'What it shows', 'Send for review']))
  // The honeypot is not on offer, and naming it is refused.
  expect(listed.map((c) => c.label)).not.toContain('Website')
  expect((await act(page, [{ ref: 'Website', action: 'setValue', args: ['https://spam.example'] }])).ok).toBe(false)

  const sent = await act(page, [
    { ref: 'What did Bartholomew Sato say or do?', action: 'setValue', args: [quote] },
    { ref: 'Link to the source', action: 'setValue', args: [`https://example.com/harbor-ledger/agent-${stamp}`] },
    { ref: 'Source name', action: 'setValue', args: [sourceTitle] },
    { ref: 'Date it happened', action: 'setValue', args: ['2026-11-12'] },
    { ref: 'What it shows', action: 'setValue', args: ['Probable'] },
    { ref: 'Send for review', action: 'press' },
  ])
  expect(sent.ok).toBe(true)
  await expect(page.getByText('Thank you. Your report is waiting for an editor.')).toBeVisible()
  // The agent reads the outcome from the page, not only the person.
  const notice = (await snapshot(page)).find((c) => c.component === 'notice')
  expect(notice?.text).toEqual(['Sent · not checked yet', 'Thank you. Your report is waiting for an editor.'])

  // It went through the Worker into the queue, and nothing reached the record.
  const address = (await page.getByText(/\/latest\?proposal=/).textContent())!
  await act(page, [{ ref: 'Done', action: 'press' }])
  await expect(page.getByText(quote)).toHaveCount(0)
  await page.goto(address.slice(address.indexOf('/latest')))
  const waiting = page.getByRole('article', { name: `Not checked yet: ${sourceTitle}` })
  await expect(waiting.getByText(quote)).toBeVisible()
})

test('an agent is told which field the Worker refused', async ({ page }) => {
  await page.goto('/q/free-ferry/bartholomew-sato')
  await expect(page.getByRole('heading', { name: 'Bartholomew Sato' })).toBeVisible()
  await act(page, [{ ref: 'Add to the record', action: 'press' }])

  // The browser accepts any scheme in a url field; the Worker accepts only web addresses.
  const refused = await act(page, [
    { ref: 'What did Bartholomew Sato say or do?', action: 'setValue', args: ['Free fares are the fair thing, and I will say so.'] },
    { ref: 'Link to the source', action: 'setValue', args: ['ftp://example.com/harbor-ledger'] },
    { ref: 'Send for review', action: 'press' },
  ])
  expect(refused.ok).toBe(true)
  await expect(page.getByText('Thank you. Your report is waiting for an editor.')).toHaveCount(0)
  await expect.poll(async () => (await snapshot(page)).find((c) => c.component === 'field' && c.label === 'Link to the source')?.text?.join(' ')).toMatch(/\S/)
})
