import { describe, expect, it } from 'vitest'
import { draftFromReading, findInArticle, MAX_ACTS_PER_ARTICLE, MAX_PASSAGE_CHARS, modelOutputSchema, modelPrompt, MODEL, passageAround, quoteIsInArticle, readArticle, type ModelAct, type ReadingContext } from './reader.ts'

const ARTICLE = `Ann Alpha told reporters on Monday: “I will vote for this bill — and I’ll whip votes for it.”
The senator  from the north,
Bob Beta, did not comment.`

describe('quoteIsInArticle', () => {
  it('finds words copied from the article whatever the quote marks, dashes, case and line breaks', () => {
    expect(quoteIsInArticle('I will vote for this bill - and I\'ll whip votes for it.', ARTICLE)).toBe(true)
    expect(quoteIsInArticle('"i will vote for this bill"', ARTICLE)).toBe(true)
    expect(quoteIsInArticle('The senator from the north, Bob Beta, did not comment.', ARTICLE)).toBe(true)
  })

  it('turns away a paraphrase, an ellipsis, or an added word', () => {
    expect(quoteIsInArticle('I will support this bill', ARTICLE)).toBe(false)
    expect(quoteIsInArticle('I will vote for this bill … whip votes for it', ARTICLE)).toBe(false)
    expect(quoteIsInArticle('I will vote for this good bill', ARTICLE)).toBe(false)
  })

  it('turns away a quote too short to tell anything', () => {
    expect(quoteIsInArticle('I will', ARTICLE)).toBe(false)
  })
})

// What the model answers with: the acts it found, and nobody only named unless a test says so.
const answer = (acts: unknown[], named_only: unknown[] = []) => ({ acts, named_only })

const act = (overrides: Partial<Record<keyof ModelAct, unknown>> = {}) => ({
  person_id: 'ann',
  question_id: 'hot',
  kind: 'says',
  quote: 'I will vote for this bill',
  occurred_on: '2026-11-16',
  position: 'support',
  weight: 'clear',
  reason: 'A direct statement of how she will vote.',
  ...overrides,
})

describe('findInArticle', () => {
  it('returns the article’s own words for a quote the model wrapped in curly quotes', () => {
    expect(findInArticle('“I will vote for this bill”', ARTICLE)).toBe('I will vote for this bill')
  })

  it('returns the article’s casing and punctuation, not the model’s', () => {
    expect(findInArticle("i will vote for this bill - and i'll whip votes", ARTICLE)).toBe('I will vote for this bill — and I’ll whip votes')
  })

  it('keeps an apostrophe that ends the quote', () => {
    const text = 'The vote rests with the committee members’ letter, sent on Friday.'
    expect(findInArticle("the committee members'", text)).toBe('the committee members’')
  })

  it('cuts the match out correctly after characters outside the basic plane', () => {
    const text = 'Reacting 😀😀 online, Ann Alpha wrote: I will vote for this bill.'
    expect(findInArticle('I will vote for this bill', text)).toBe('I will vote for this bill')
  })
})

describe('modelOutputSchema', () => {
  it('takes a well-formed answer', () => {
    const parsed = modelOutputSchema.parse(answer([act()], [{ person_id: 'bob', quote: 'did not comment' }]))
    expect(parsed.acts[0]).toMatchObject({ person_id: 'ann', occurred_on: '2026-11-16', weight: 'clear' })
    expect(parsed.named_only).toEqual([{ person_id: 'bob', quote: 'did not comment' }])
  })

  it('turns a date it cannot read into no date rather than refusing the act', () => {
    expect(modelOutputSchema.parse(answer([act({ occurred_on: 'last Monday' })])).acts[0].occurred_on).toBeNull()
    expect(modelOutputSchema.parse(answer([act({ occurred_on: '2026-02-30' })])).acts[0].occurred_on).toBeNull()
  })

  it('refuses a kind, position or weight outside the schema', () => {
    expect(modelOutputSchema.safeParse(answer([act({ kind: 'tweets' })])).success).toBe(false)
    expect(modelOutputSchema.safeParse(answer([act({ position: 'strong_support' })])).success).toBe(false)
    expect(modelOutputSchema.safeParse(answer([act({ weight: 'heavy' })])).success).toBe(false)
    expect(modelOutputSchema.safeParse({ result: [] }).success).toBe(false)
  })

  it('takes each of the four directions an act can point, and refuses a lean against', () => {
    for (const position of ['support', 'lean_support', 'mixed', 'oppose']) expect(modelOutputSchema.safeParse(answer([act({ position })])).success).toBe(true)
    expect(modelOutputSchema.safeParse(answer([act({ position: 'lean_oppose' })])).success).toBe(false)
  })

})

describe('modelPrompt with a smaller step linked to the question', () => {
  it('lists the step as a question of its own, marked as a smaller step, and tells the model to read each on its own', () => {
    const step = { id: 'at-55', title: 'Lower the age to 55?', short_title: 'At 55', description: null, kind: 'position' as const, relation: 'smaller_step' as const }
    const prompt = modelPrompt(
      { question: { id: 'hot', title: 'Hot question?', short_title: 'Hot', description: null, kind: 'position' }, subQuestions: [], relatedQuestions: [step], people: [{ id: 'ann', name: 'Ann Alpha', questions: ['hot', 'at-55'] }] },
      { url: 'https://news.example/a', title: null, published: null, text: 'Text.' },
      '2026-11-19',
    )
    expect(prompt.messages[1].content).toMatch(/"question_id": "at-55"[^}]*"relation_to_main_question": "smaller_step"/)
    expect(prompt.messages[0].content).toContain('Support for the smaller step is not support for the main question')
  })
})

describe('an answer that leaves out the people only named', () => {
  it('is read as naming nobody, with its acts kept', () => {
    const parsed = modelOutputSchema.parse({ acts: [] })
    expect(parsed.named_only).toEqual([])
  })

  it('is still asked for in the shape the model is given', () => {
    const { response_format } = modelPrompt({ question: { id: 'hot', title: 'Hot question?', short_title: 'Hot', description: null, kind: 'position' }, subQuestions: [], relatedQuestions: [], people: [] }, { url: 'https://news.example/a', title: null, published: null, text: 'Text.' }, '2026-11-19')
    expect((response_format.json_schema.schema as { required: string[] }).required).toEqual(['acts', 'named_only'])
  })
})

describe('modelPrompt', () => {
  const context = { question: { id: 'hot', title: 'Hot question?', short_title: 'Hot', description: null, kind: 'position' as const }, subQuestions: [], relatedQuestions: [], people: [{ id: 'ann', name: 'Ann Alpha', questions: ['hot'] }] }
  const prompt = modelPrompt(context, { url: 'https://news.example/a', title: 'A', published: null, text: ARTICLE }, '2026-11-19')

  it('gives the model the people it may name and the whole article', () => {
    expect(prompt.messages[1].content).toContain('"person_id": "ann"')
    expect(prompt.messages[1].content).toContain(ARTICLE)
  })


  // The schema sent to the model and the one its answer is checked against are
  // written separately; an answer the first allows must not fail the second.
  it('asks for the same fields and values that modelOutputSchema checks', () => {
    const whole = prompt.response_format.json_schema.schema as unknown as { required: string[]; properties: { acts: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } } }
    expect([...whole.required].sort()).toEqual(Object.keys(modelOutputSchema.shape).sort())
    const sent = whole.properties.acts.items
    const checked = modelOutputSchema.shape.acts.element.shape
    expect([...sent.required].sort()).toEqual(Object.keys(checked).sort())
    for (const [field, spec] of Object.entries(sent.properties)) {
      const zodField = checked[field as keyof typeof checked] as unknown as { options?: readonly string[] }
      if (spec.enum) expect(spec.enum).toEqual(zodField.options)
    }
    const sample = Object.fromEntries(Object.entries(sent.properties).map(([field, spec]) => [field, spec.enum ? spec.enum[0] : field === 'occurred_on' ? null : 'text']))
    expect(modelOutputSchema.safeParse(answer([sample])).success).toBe(true)
  })
})

const context: ReadingContext = {
  question: { id: 'hot', title: 'Hot question?', short_title: 'Hot', description: null, kind: 'position' },
  subQuestions: Array.from({ length: 12 }, (_, i) => ({ id: `sub-${i}`, title: `Sub ${i}?`, short_title: `Sub ${i}`, description: null, kind: 'position' as const, is_ask: false })),
  relatedQuestions: [],
  people: [{ id: 'ann', name: 'Ann Alpha', questions: ['hot', ...Array.from({ length: 12 }, (_, i) => `sub-${i}`)] }],
}
const answering = (answer: unknown) => ({ AI: { run: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) }, AI_GATEWAY: 'gw' }) as unknown as Env
const read = (answer: unknown, text = ARTICLE, readFor = context) => readArticle(answering(answer), readFor, { url: 'https://news.example/a', title: null, published: null, text }, '2026-11-19')
// The same question with Bob read for as well.
const withBob: ReadingContext = { ...context, people: [...context.people, { id: 'bob', name: 'Bob Beta', questions: ['hot'] }] }

describe('readArticle', () => {
  it('keeps one act per person and question when the model repeats itself', async () => {
    const reading = await read(answer([act(), act(), act({ quote: 'whip votes for it' })]))
    expect(reading.ok && reading.acts).toHaveLength(1)
    expect(reading.ok && reading.dropped.map((d) => d.why)).toEqual(['repeats a person and question already listed', 'repeats a person and question already listed'])
  })

  it('keeps no more than MAX_ACTS_PER_ARTICLE acts from one article', async () => {
    const reading = await read(answer(Array.from({ length: 12 }, (_, i) => act({ question_id: `sub-${i}` }))))
    expect(reading.ok && reading.acts).toHaveLength(MAX_ACTS_PER_ARTICLE)
    expect(reading.ok && reading.dropped).toHaveLength(12 - MAX_ACTS_PER_ARTICLE)
  })

  it('cuts an overlong quote and reason to the lengths the review form takes', async () => {
    const long = 'I will vote for this bill '.repeat(200)
    const reading = await read(answer([act({ quote: long, reason: 'y'.repeat(5000) })]), long)
    expect(reading.ok).toBe(true)
    const [kept] = reading.ok ? reading.acts : []
    expect(kept.quote.length).toBeLessThanOrEqual(2000)
    expect(kept.reason.length).toBeLessThanOrEqual(1000)
  })

  it('passes on the weight the model gave each act', async () => {
    const reading = await read(answer([act({ weight: 'passing' }), act({ question_id: 'sub-0', weight: 'clear' }), act({ question_id: 'sub-1', kind: 'does', weight: 'concrete' })]))
    expect(reading.ok && reading.acts.map((a) => [a.question_id, a.weight])).toEqual([
      ['hot', 'passing'],
      ['sub-0', 'clear'],
      ['sub-1', 'concrete'],
    ])
  })

  it('gives each act it keeps the paragraph its words sit in and the text either side', async () => {
    const reading = await read(answer([act({ person_id: 'bob', kind: 'says', quote: 'The senator from the north' })]), `First paragraph.\n\n${ARTICLE}\n\nLast paragraph.`, withBob)
    expect(reading.ok && reading.acts).toMatchObject([
      {
        quote: 'The senator  from the north',
        passage: 'The senator  from the north,',
        context: { before: 'First paragraph.\nAnn Alpha told reporters on Monday: “I will vote for this bill — and I’ll whip votes for it.”', after: 'Bob Beta, did not comment.\nLast paragraph.' },
      },
    ])
  })

  it('keeps the acts of an answer that leaves out the list of people only named', async () => {
    const reading = await read({ acts: [act()] })
    expect(reading.ok && [reading.acts.length, reading.mentions]).toEqual([1, []])
  })
})

describe('readArticle on people the article only names', () => {
  it('lists someone named with nothing to record, in the article’s own words', async () => {
    const reading = await read(answer([act()], [{ person_id: 'bob', quote: 'bob beta, DID NOT comment' }]), ARTICLE, withBob)
    expect(reading.ok && reading.mentions).toEqual([{ person_id: 'bob', words: 'Bob Beta, did not comment' }])
  })

  it('leaves out someone whose words are not in the article', async () => {
    const reading = await read(answer([], [{ person_id: 'bob', quote: 'declined to say how he would vote' }]), ARTICLE, withBob)
    expect(reading.ok && reading.mentions).toEqual([])
  })

  it('leaves out someone the article was not read for', async () => {
    const reading = await read(answer([], [{ person_id: 'bob', quote: 'did not comment' }]))
    expect(reading.ok && reading.mentions).toEqual([])
  })

  it('leaves out someone an act was kept for', async () => {
    const reading = await read(answer([act()], [{ person_id: 'ann', quote: 'told reporters on Monday' }]), ARTICLE, withBob)
    expect(reading.ok && reading.acts).toHaveLength(1)
    expect(reading.ok && reading.mentions).toEqual([])
  })

  it('lists someone whose only act was dropped', async () => {
    const reading = await read(answer([act({ quote: 'I will back this bill' })], [{ person_id: 'ann', quote: 'told reporters on Monday' }]), ARTICLE, withBob)
    expect(reading.ok && reading.acts).toEqual([])
    expect(reading.ok && reading.mentions).toEqual([{ person_id: 'ann', words: 'told reporters on Monday' }])
  })

  it('lists each person once', async () => {
    const reading = await read(answer([], [{ person_id: 'bob', quote: 'did not comment' }, { person_id: 'bob', quote: 'The senator from the north' }]), ARTICLE, withBob)
    expect(reading.ok && reading.mentions).toEqual([{ person_id: 'bob', words: 'did not comment' }])
  })
})

describe('passageAround', () => {
  const sentences = (count: number, about: string) => Array.from({ length: count }, (_, i) => `Sentence ${i} about ${about} goes here.`).join(' ')
  const QUOTE = 'I will vote for this bill'
  const around = (text: string) => {
    const start = text.indexOf(QUOTE)
    return passageAround(text, start, start + QUOTE.length)
  }

  it('keeps a short paragraph whole', () => {
    const paragraph = `Ann Alpha spoke on Monday. She said: “${QUOTE}.” Then she left.`
    expect(around(`The opening paragraph.\n${paragraph}\nThe closing paragraph.`).passage).toBe(paragraph)
  })

  it('cuts a long paragraph back to whole sentences around the quote', () => {
    const paragraph = `${sentences(12, 'the hearing')} Ann Alpha said: “${QUOTE}.” She added nothing. ${sentences(12, 'the weather')}`
    const { passage } = around(`The opening paragraph.\n${paragraph}\nThe closing paragraph.`)
    expect(paragraph.length).toBeGreaterThan(MAX_PASSAGE_CHARS)
    expect(passage.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS)
    expect(paragraph).toContain(passage)
    expect(passage).toContain(`Ann Alpha said: “${QUOTE}.” She added nothing.`)
    expect(passage).toMatch(/^Sentence \d+ about the hearing goes here\./)
    expect(passage).toMatch(/Sentence \d+ about the weather goes here\.$/)
  })

  it('keeps the whole first sentence of a long paragraph when the quote is in it', () => {
    const paragraph = `Ann Alpha said on Monday that ${QUOTE} when it comes up. ${sentences(20, 'the weather')}`
    expect(around(`The opening paragraph.\n${paragraph}`).passage).toMatch(/^Ann Alpha said on Monday that I will vote for this bill when it comes up\. Sentence 0/)
  })

  it('keeps the whole last sentence of a long paragraph when the quote is in it', () => {
    const paragraph = `${sentences(20, 'the hearing')} Ann Alpha said on Monday that ${QUOTE} when it comes up.`
    expect(around(`${paragraph}\nThe closing paragraph.`).passage).toMatch(/goes here\. Ann Alpha said on Monday that I will vote for this bill when it comes up\.$/)
  })

  it('gives the paragraphs either side as context, in the order they are printed and without blank lines', () => {
    const text = `One.\n\nTwo.\nAnn Alpha said: “${QUOTE}.”\n\nFour.\nFive.`
    expect(around(text)).toEqual({ passage: `Ann Alpha said: “${QUOTE}.”`, before: 'One.\nTwo.', after: 'Four.\nFive.' })
  })

  it('gives the rest of a long paragraph as context', () => {
    const paragraph = `${sentences(12, 'the hearing')} Ann Alpha said: “${QUOTE}.” ${sentences(12, 'the weather')}`
    const { passage, before, after } = around(paragraph)
    expect(`${before} ${passage} ${after}`).toBe(paragraph)
  })

  it('keeps only the nearest paragraphs when those further away do not fit', () => {
    const far = sentences(14, 'the budget')
    const near = sentences(10, 'the hearing')
    const text = `${far}\n${near}\nAnn Alpha said: “${QUOTE}.”\n${near}\n${far}`
    expect(around(text)).toMatchObject({ before: near, after: near })
  })

  it('has no context before the first paragraph or after the last', () => {
    expect(around(`Ann Alpha said: “${QUOTE}.”`)).toEqual({ passage: `Ann Alpha said: “${QUOTE}.”`, before: '', after: '' })
  })
})

describe('readArticle dates', () => {
  it('drops a date after today, which is a date promised rather than the date of the act', async () => {
    const reading = await read(answer([act({ occurred_on: '2026-12-03' })]))
    expect(reading.ok && reading.acts[0].occurred_on).toBeNull()
  })

  it('keeps a date on or before today', async () => {
    const reading = await read(answer([act({ occurred_on: '2026-11-19' })]))
    expect(reading.ok && reading.acts[0].occurred_on).toBe('2026-11-19')
  })
})

describe('draftFromReading', () => {
  const found = { passage: 'The paragraph the words sit in.', context: { before: 'The paragraph before.', after: 'The paragraph after.' } }
  const acts: ModelAct[] = modelOutputSchema.parse(answer([act(), act({ person_id: 'bob', kind: 'does', weight: 'passing' })])).acts.map((a) => ({ ...a, ...found }))

  it('makes one proposal with an item per act, the reason in each item note, and the model in the proposal note', () => {
    const draft = draftFromReading({ url: 'https://news.example/a', title: 'A', published: null }, acts, [{ act: { person_id: 'ann', question_id: 'hot', quote: 'made up' }, why: 'quotes words that are not in the article' }], 'q')
    expect(draft.items).toMatchObject([
      { decider_id: 'ann', kind: 'says', reading: 'support', weight: 'clear', note: expect.stringContaining('A direct statement of how she will vote.') },
      { decider_id: 'bob', kind: 'does', weight: 'passing' },
    ])
    expect(draft.note).toContain(MODEL)
    expect(draft.note).toContain('made up')
  })

  it('gives each item the passage its words sit in and the text either side', () => {
    const draft = draftFromReading({ url: 'https://news.example/a', title: 'A', published: null }, acts, [], null)
    expect(draft.items.map((i) => [i.passage, i.context])).toEqual([
      [found.passage, found.context],
      [found.passage, found.context],
    ])
  })

  it('lists the people the article only names, and nobody when none are given', () => {
    const article = { url: 'https://news.example/a', title: 'A', published: null }
    expect(draftFromReading(article, acts, [], null, [{ person_id: 'cy', words: 'was absent' }]).mentions).toEqual([{ decider_id: 'cy', words: 'was absent' }])
    expect(draftFromReading(article, acts, [], null).mentions).toEqual([])
  })

  it('keeps the note short however many acts were dropped', () => {
    const dropped = Array.from({ length: 300 }, (_, i) => ({ act: { person_id: 'ann', question_id: 'hot', quote: `made up ${i} `.repeat(20) }, why: 'quotes words that are not in the article' }))
    const draft = draftFromReading({ url: 'https://news.example/a', title: 'A', published: null }, [], dropped, 'q')
    expect(draft.note!.length).toBeLessThan(1000)
    expect(draft.note).toContain('300')
  })
})
