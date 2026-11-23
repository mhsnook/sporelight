import { describe, expect, it } from 'vitest'
import { dayOf, EARLIEST_PUBLISHED, publishedOnPage } from '../../worker/publish-date.ts'

// HTMLRewriter exists only in workerd, so these run with the worker tests.

const TODAY = '2026-11-23'

// The shape of the press release that prompted this: the date is in a meta tag,
// the page's <h1> is the section name, the headline is an <h2>, and the only
// <time> elements are in the related-news list, all with the same wrong value.
const related = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `<div class="related-item"><a href="/news/documentsingle.aspx?DocumentID=${2184 - i}" class="related-headline">Another release ${i}</a>
      <div class="newsdetails"><time datetime="2017-11-13">March ${i + 1}, 2020</time> <span class="cattype">| Posted in Press Releases</span></div></div>`,
  ).join('\n')
const dingell = (head: string) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>
	Dingell Launches Medicare For All Congressional Caucus | Congresswoman Debbie Dingell
</title>
<meta name="og:title" content="Press Releases | Congresswoman Debbie Dingell" />
<meta property="og:title" content="Dingell Launches Medicare For All Congressional Caucus" />
<meta property="og:type" content="article" />
${head}
<meta property="article:tag" content="Health Care" />
<meta property="og:site_name" content="U.S. Representative Debbie Dingell" />
</head><body>
<main id="main">
  <div class="hero-section"><div class="container"><h1><a href="/news" class="sectionlink">news</a></h1></div></div>
  <div class="crumb-section"><div class="container"><a href="/">Home</a> | <a href="/news">news</a> | <span class="current">Press Releases</span></div></div>
  <div class="section-heading dark text-center"><h2><span>Press Releases</span></h2></div>
  <div class="single-headline"><h2 class="newsie-titler">Dingell Launches Medicare For All Congressional Caucus</h2></div>
  <div class="news-specs"><div class="topnewstext"><b>Washington, DC, July 19, 2018</b></div></div>
  <div class="newsbody clearfix"><div class="bodycopy"><p>Today, Members of Congress announced the launch of the Medicare for All Caucus.</p></div></div>
  <div class="news-related-news"><span class="relatedochead">Related News</span><div class="related-itemholder">
${related(5)}
  </div></div>
</main></body></html>`

const article = ({ head = '', body = '' }: { head?: string; body?: string }) =>
  `<!doctype html><html><head><title>Alpha backs the plan | The Ledger</title>${head}</head><body><header><a href="/">The Ledger</a></header>${body}<footer>© The Ledger</footer></body></html>`
const jsonLd = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`

describe('publishedOnPage', () => {
  it('reads article:published_time, as on the Dingell press release', async () => {
    expect(await publishedOnPage(dingell('<meta property="article:published_time" content="2018-07-19" />'), TODAY)).toBe('2018-07-19')
  })

  it('does not take a related story’s date for the article’s when the page has no meta date', async () => {
    expect(await publishedOnPage(dingell(''), TODAY)).toBeNull()
  })

  it('finds the headline by the Open Graph title, not by a name="og:title" tag with the site’s title', async () => {
    // The section heading "Press Releases" matches the site's title; a <time> beside it is not the article's.
    const page = dingell('')
      .replace('<h2><span>Press Releases</span></h2>', `<h2><span>Press Releases</span></h2><p>Archive since <time datetime="2016-01-01">2016</time></p>${'<div></div>'.repeat(50)}`)
      .replace('<div class="topnewstext"><b>Washington, DC, July 19, 2018</b></div>', '<div class="topnewstext"><time datetime="2018-07-19">July 19, 2018</time></div>')
      .replace(/<div class="news-related-news">[\s\S]*?<\/main>/, '</main>')
    expect(await publishedOnPage(page, TODAY)).toBe('2018-07-19')
  })

  it('reads the article’s datePublished from JSON-LD, over the page wrapper’s, and ignores dateModified', async () => {
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', datePublished: '2020-01-01T00:00:00Z', dateModified: '2026-11-22T00:00:00Z' },
        { '@type': ['NewsArticle'], headline: 'Alpha backs the plan', datePublished: '2024-03-05T22:30:00-05:00', dateModified: '2026-11-22T00:00:00Z' },
      ],
    }
    expect(await publishedOnPage(article({ head: jsonLd(graph) }), TODAY)).toBe('2024-03-05')
  })

  it('reads a <time> beside the headline, and the earlier of a published and an updated one', async () => {
    const byline = (times: string) => article({ body: `<article><h1>Alpha backs the plan</h1><p class="byline">By A. Writer ${times}</p><p>Text.</p></article>` })
    expect(await publishedOnPage(byline('<time datetime="2025-06-02T08:00:00Z">June 2</time>'), TODAY)).toBe('2025-06-02')
    expect(await publishedOnPage(byline('Updated <time datetime="2025-06-04">June 4</time>, first published <time datetime="2025-06-02">June 2</time>'), TODAY)).toBe('2025-06-02')
  })

  it('does not read a <time> far from the headline', async () => {
    const comments = '<div><p>Comment</p></div>'.repeat(40)
    expect(await publishedOnPage(article({ body: `<article><h1>Alpha backs the plan</h1><p>Text.</p></article>${comments}<time datetime="2025-06-09">A comment</time>` }), TODAY)).toBeNull()
  })

  it('takes the meta tag when the page gives conflicting dates', async () => {
    const page = article({
      head: `<meta property="article:modified_time" content="2026-11-20" /><meta name="date" content="2023-01-01" /><meta property="article:published_time" content="2019-04-01T09:00:00+01:00" />${jsonLd({ '@type': 'NewsArticle', datePublished: '2020-02-02' })}`,
      body: '<h1>Alpha backs the plan</h1><time datetime="2021-03-03">March 3</time>',
    })
    expect(await publishedOnPage(page, TODAY)).toBe('2019-04-01')
  })

  it('passes over a date ahead of today for the next one, and gives none when every date is', async () => {
    const future = '<meta property="article:published_time" content="2027-01-01" />'
    expect(await publishedOnPage(article({ head: future + jsonLd({ '@type': 'Article', datePublished: '2026-11-20' }) }), TODAY)).toBe('2026-11-20')
    expect(await publishedOnPage(article({ head: future, body: '<h1>Alpha backs the plan</h1><time datetime="2026-12-25">Christmas</time>' }), TODAY)).toBeNull()
  })

  it('passes over a placeholder date from before the web', async () => {
    expect(await publishedOnPage(article({ head: '<meta property="article:published_time" content="1970-01-01T00:00:00Z" /><meta name="DC.date" content="2016-05-01" />' }), TODAY)).toBe('2016-05-01')
  })

  it('gives none for a page with no date, or with broken JSON-LD', async () => {
    expect(await publishedOnPage(article({ body: '<article><h1>Alpha backs the plan</h1><p>Text.</p></article>' }), TODAY)).toBeNull()
    expect(await publishedOnPage(article({ head: '<script type="application/ld+json">{"datePublished": "2024-</script>' }), TODAY)).toBeNull()
  })
})

describe('dayOf', () => {
  it.each([
    ['2018-07-19', '2018-07-19'],
    ['2018-07-19T23:30:00-04:00', '2018-07-19'],
    ['20180719', '2018-07-19'],
    ['2018/07/19 10:00', '2018-07-19'],
    ['July 19, 2018', '2018-07-19'],
    ['Thu, 19 Jul 2018 14:00:00 GMT', '2018-07-19'],
  ])('reads %s as %s', (value, day) => {
    expect(dayOf(value, TODAY)).toBe(day)
  })

  it.each(['2018-02-30', '19 or so', '', '2026-11-24', '1990-12-31', 'July 2018'])('gives none for %j', (value) => {
    expect(dayOf(value, TODAY)).toBeNull()
  })

  it('takes today and the earliest day allowed', () => {
    expect(dayOf(TODAY, TODAY)).toBe(TODAY)
    expect(dayOf(EARLIEST_PUBLISHED, TODAY)).toBe(EARLIEST_PUBLISHED)
  })
})
