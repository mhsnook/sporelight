// The day a page says it was published, read from its HTML with HTMLRewriter.

// Meta tags that name a publish date, most trusted first. Matched against a
// tag's `property`, `name` or `itemprop`, ignoring case. Modified dates are
// left out on purpose: a page edited today was not published today.
const META_NAMES = [
  'article:published_time',
  'og:published_time',
  'datepublished',
  'citation_publication_date',
  'citation_date',
  'dc.date.issued',
  'dcterms.issued',
  'dc.date',
  'dcterms.date',
  'dc.date.created',
  'dcterms.created',
  'pubdate',
  'publishdate',
  'publish-date',
  'publish_date',
  'publication_date',
  'parsely-pub-date',
  'sailthru.date',
  'article.published',
  'original-publish-date',
  'date',
]

// JSON-LD types whose datePublished is the article's own, rather than the
// site's or a page wrapper's.
const ARTICLE_TYPE = /(?:Article|BlogPosting|Report|PressRelease)$/

// How many elements away from the headline a <time> may sit and still be read
// as its date. More than two <time>s that close are a list of other stories,
// not a byline's published and updated dates.
const TIME_REACH = 40
const BYLINE_TIMES = 2

// Before this, a page's metadata date is a placeholder, not when the page was
// published.
export const EARLIEST_PUBLISHED = '1991-01-01'

const MONTH = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i

// A day as YYYY-MM-DD, or null if the value is not a date that can be right
// for a page read on `today`. A timestamp keeps the publisher's own calendar
// day: "2018-07-19T23:30:00-04:00" is 19 July.
export function dayOf(value: string | null | undefined, today: string): string | null {
  const text = (value ?? '').trim()
  let day: string | null = null
  const iso = /^(\d{4})-?(\d{2})-?(\d{2})(?:$|[T\s])/.exec(text) ?? /^(\d{4})\/(\d{2})\/(\d{2})\b/.exec(text)
  if (iso) day = `${iso[1]}-${iso[2]}-${iso[3]}`
  else if (MONTH.test(text) && /\b\d{4}\b/.test(text)) {
    const parsed = Date.parse(text)
    if (!Number.isNaN(parsed)) day = new Date(parsed).toISOString().slice(0, 10)
  }
  if (!day) return null
  const [y, m, d] = day.split('-').map(Number)
  const check = new Date(Date.UTC(y, m - 1, d))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null
  return day >= EARLIEST_PUBLISHED && day <= today ? day : null
}

// Every datePublished in a JSON-LD value, with whether the object holding it
// is an article.
function linkedDates(node: unknown, out: { value: string; isArticle: boolean }[]) {
  if (Array.isArray(node)) {
    for (const child of node) linkedDates(child, out)
    return
  }
  if (!node || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  if (typeof record.datePublished === 'string') {
    const types = ([] as unknown[]).concat(record['@type'] ?? [])
    out.push({ value: record.datePublished, isArticle: types.some((t) => typeof t === 'string' && ARTICLE_TYPE.test(t)) })
  }
  for (const [key, child] of Object.entries(record)) if (key !== 'datePublished') linkedDates(child, out)
}

// In order of trust: the page's meta tags, then its structured data (JSON-LD
// and microdata), then a <time> next to the headline. A date that cannot be
// right is passed over for the next one.
export async function publishedOnPage(html: BodyInit, today: string): Promise<string | null> {
  const meta = new Map<string, string>()
  const linked: { value: string; isArticle: boolean }[] = []
  const microdata: string[] = []
  const times: { at: number; value: string; pubdate: boolean }[] = []
  const headings: { at: number; level: string; text: string }[] = []
  let elements = 0
  let title = ''
  let script = ''

  const rewriter = new HTMLRewriter()
    .on('*', {
      element() {
        elements++
      },
    })
    .on('meta', {
      element(el) {
        const key = (el.getAttribute('property') ?? el.getAttribute('name') ?? el.getAttribute('itemprop') ?? '').trim().toLowerCase()
        const content = el.getAttribute('content')
        if (key && content && !meta.has(key)) meta.set(key, content)
      },
    })
    .on('[itemprop="datePublished"]:not(meta)', {
      element(el) {
        const value = el.getAttribute('datetime') ?? el.getAttribute('content')
        if (value) microdata.push(value)
      },
    })
    .on('script[type="application/ld+json"]', {
      text(chunk) {
        script += chunk.text
        if (!chunk.lastInTextNode) return
        try {
          linkedDates(JSON.parse(script), linked)
        } catch {
          // A site's broken JSON-LD is not a reason to give up on the page.
        }
        script = ''
      },
    })
    .on('title', {
      text(chunk) {
        title += chunk.text
      },
    })
    .on('h1, h2, h3', {
      element(el) {
        headings.push({ at: elements, level: el.tagName, text: '' })
      },
      text(chunk) {
        headings[headings.length - 1].text += chunk.text
      },
    })
    .on('time[datetime]', {
      element(el) {
        times.push({ at: elements, value: el.getAttribute('datetime')!, pubdate: el.hasAttribute('pubdate') })
      },
    })
  await rewriter.transform(new Response(html)).arrayBuffer()

  const fromMeta = META_NAMES.map((name) => meta.get(name))
  const fromLinked = [...linked.filter((d) => d.isArticle), ...linked.filter((d) => !d.isArticle)].map((d) => d.value)
  for (const value of [...fromMeta, ...fromLinked, ...microdata, ...times.filter((t) => t.pubdate).map((t) => t.value)]) {
    const day = dayOf(value, today)
    if (day) return day
  }
  const headline = headlineOf(headings, meta.get('og:title') ?? title)
  if (!headline) return null
  const near = times.filter((t) => Math.abs(t.at - headline.at) <= TIME_REACH)
  if (near.length > BYLINE_TIMES) return null
  const days = near.map((t) => dayOf(t.value, today)).filter((d) => d !== null)
  return days.sort()[0] ?? null
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

// The heading that is the article's title, which is often not the page's first
// <h1>: that can be the site's or the section's name.
function headlineOf(headings: { at: number; level: string; text: string }[], pageTitle: string) {
  const wanted = squash(pageTitle)
  const isTitle = (text: string) => text === wanted || (text.length >= 12 && wanted.startsWith(text))
  return headings.find((h) => isTitle(squash(h.text))) ?? headings.find((h) => h.level === 'h1')
}
