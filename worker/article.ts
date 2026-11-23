// Fetching an article and turning it into plain text for the model to read and
// for the quote check to search.

import type { UnreadReason } from '../shared/schema.ts'
import { publishedOnPage } from './publish-date.ts'

// Bytes read from the response before giving up on it as too large.
export const MAX_BYTES = 3_000_000
// Characters of text kept, about 15,000 tokens. News articles fit well inside it;
// what is cut is usually page furniture after the story.
export const MAX_TEXT_CHARS = 60_000
const FETCH_TIMEOUT_MS = 10_000
// The converter starts an HTML page's text with its metadata, one `key: value`
// line each (title, description, image), then a blank line, and has no option to
// leave it out as it has for a PDF. The description is the site's own blurb,
// with its HTML entities left in, so it is not article text to quote or cut a
// passage from.
const METADATA_HEADER = /^(?:[a-z][\w:-]*:(?: [^\n]*)?\n)+\n/

const TYPES: Record<string, string> = {
  'text/html': 'article.html',
  'application/xhtml+xml': 'article.html',
  'application/pdf': 'article.pdf',
  'text/plain': 'article.txt',
}

// `publishedOn` is the day the page itself says it was published, when it says.
export type Article =
  | { ok: true; text: string; truncated: boolean; publishedOn: string | null }
  | { ok: false; reason: string; unread: UnreadReason; publishedOn?: string | null }

type Page = { ok: true; body: Uint8Array; type: string; name: string; finalUrl: string } | { ok: false; reason: string; unread: UnreadReason }

// Many news sites turn away anything that is not a browser, so a refusal here is
// an ordinary outcome and comes back as a reason, never as a thrown error.
async function fetchPage(url: string): Promise<Page> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { accept: 'text/html, application/xhtml+xml, application/pdf;q=0.9, text/plain;q=0.8', 'user-agent': 'Sporelight/1 (news reader)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, unread: 'unreachable', reason: `The article could not be fetched (${String(e).slice(0, 120)}).` }
  }
  if (!res.ok) {
    await res.body?.cancel()
    return { ok: false, unread: res.status === 401 || res.status === 403 || res.status === 429 ? 'refused' : 'unreachable', reason: `The site answered ${res.status}.` }
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const name = TYPES[type]
  if (!name) {
    await res.body?.cancel()
    return { ok: false, unread: 'not_an_article', reason: `The page is ${type || 'of no stated type'}, not an article.` }
  }
  const body = await readCapped(res)
  if (!body) return { ok: false, unread: 'not_an_article', reason: 'The page is too large to read.' }
  return { ok: true, body, type, name, finalUrl: res.url || url }
}

// A PDF is not dated: the converter's documented metadata for a PDF has no creation or publish date.
const pageDate = (page: Extract<Page, { ok: true }>, today: string) => (page.name === 'article.html' ? publishedOnPage(page.body, today) : Promise.resolve(null))

export async function fetchArticle(env: Pick<Env, 'AI'>, url: string, today: string): Promise<Article> {
  const page = await fetchPage(url)
  if (!page.ok) return page
  const { body, type, name } = page
  const publishedOn = await pageDate(page, today)

  let text: string
  if (name === 'article.txt') {
    text = new TextDecoder().decode(body)
  } else {
    const converted = await env.AI.toMarkdown(
      { name, blob: new Blob([body], { type }) },
      { conversionOptions: { output: { format: 'text' }, html: { hostname: new URL(page.finalUrl).hostname }, pdf: { metadata: false } } },
    ).catch((e: unknown) => ({ format: 'error' as const, error: String(e) }))
    if (converted.format === 'error') return { ok: false, unread: 'no_text', reason: `The page could not be turned into text (${converted.error.slice(0, 120)}).`, publishedOn }
    text = converted.data.trimStart().replace(METADATA_HEADER, '')
  }

  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length < 200) return { ok: false, unread: 'no_text', reason: 'The page has almost no text, which usually means a paywall or a page built by script.', publishedOn }
  return { ok: true, text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS, publishedOn }
}

// Only the publish date, for a page sent in by a reader: no conversion, no model.
export async function fetchPublishedOn(url: string, today: string): Promise<string | null> {
  const page = await fetchPage(url)
  return page.ok ? pageDate(page, today) : null
}

async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) {
    await res.body?.cancel()
    return null
  }
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
