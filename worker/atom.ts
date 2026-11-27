import { isWebAddress } from '../shared/schema.ts'
import type { Story, StoryItem } from '../src/lib/feed.ts'
import { KIND_LABEL, publishedLine, sourceLabel, standingLabel } from '../src/lib/position.ts'

// XML 1.0 allows no control characters but tab, newline and carriage return,
// and no unpaired surrogates, even escaped, so they are dropped rather than escaped.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function xmlEscape(text: string): string {
  return text
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export type AtomMeta = {
  origin: string
  title: string
  // Both are paths with any query, on `origin`.
  self: string
  page: string
}

// Their record on the question the act is first read on.
const recordPage = (origin: string, item: StoryItem) =>
  `${origin}/q/${encodeURIComponent(item.readings[0].question.slug)}/${encodeURIComponent(item.decider.slug)}`

const personPage = (origin: string, item: StoryItem) => `${origin}/p/${encodeURIComponent(item.decider.slug)}`

const sourceTitle = (story: Story) => sourceLabel(story.source)

// Dates in the feed stay as YYYY-MM-DD, as an act's do. No "8 years ago": a feed entry is kept and read later.
const publishedText = (story: Story) => publishedLine(story.source, (day) => day)

function storyText(story: Story, origin: string): string {
  const people = story.items.map((item) => {
    const { act } = item
    return [
      `${item.decider.name}, ${KIND_LABEL[act.kind].toLowerCase()} on ${act.occurred_on}${act.withdrawn_on ? `, withdrawn ${act.withdrawn_on}` : ''}${item.isNew ? '' : ', already on the record'}:`,
      act.kind === 'says' ? `“${item.words}”` : item.words,
      ...item.readings.map(
        ({ reading, question, via }) =>
          `${question.short_title}: ${standingLabel(reading.position, question)}${via ? ` (through ${via.short_title})` : ''}${reading.weight === 'passing' ? ' (a signal)' : reading.weight === 'presumed' ? ' (presumed, no quote of their own)' : ''}`,
      ),
      recordPage(origin, item),
    ].join('\n')
  })
  return [...people, `Source: ${sourceTitle(story)}${story.source.url && story.source.title ? ` ${story.source.url}` : ''} (${publishedText(story)})${isWebAddress(story.source.archive_url) ? ` (archived: ${story.source.archive_url})` : ''}`, ...(story.isDemo ? ['Demo data, not real.'] : [])].join('\n\n')
}

export function atomFeed(stories: Story[], meta: AtomMeta): string {
  const x = xmlEscape
  const updated = stories.reduce((latest, s) => (s.at > latest ? s.at : latest), '1970-01-01T00:00:00.000Z')
  const body = stories.map((story) => {
    const people = story.items.length
    return [
      '  <entry>',
      `    <id>urn:sporelight:story:${x(encodeURIComponent(story.source.id))}:${x(story.at)}</id>`,
      `    <title>${x(`${sourceTitle(story)} (${story.source.published_on ? `${publishedText(story)}; ` : ''}${people} ${people === 1 ? 'person' : 'people'})`)}</title>`,
      `    <link rel="alternate" type="text/html" href="${x(story.source.url ?? recordPage(meta.origin, story.items[0]))}"/>`,
      ...story.items.map((item) => `    <link rel="related" type="text/html" title="${x(item.decider.name)}" href="${x(personPage(meta.origin, item))}"/>`),
      `    <published>${x(story.at)}</published>`,
      `    <updated>${x(story.at)}</updated>`,
      `    <content type="text">${x(storyText(story, meta.origin))}</content>`,
      '  </entry>',
    ].join('\n')
  })
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${x(meta.title)}</title>`,
    `  <id>${x(meta.origin + meta.self)}</id>`,
    `  <link rel="self" type="application/atom+xml" href="${x(meta.origin + meta.self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${x(meta.origin + meta.page)}"/>`,
    `  <updated>${x(updated)}</updated>`,
    '  <author><name>Sporelight</name></author>',
    ...body,
    '</feed>',
    '',
  ].join('\n')
}
