import { describe, expect, it } from 'vitest'
import { trialView, type TrialResponse } from './reader-trial.ts'

const names = { person: (id: string) => ({ ann: 'Ann Alpha', bob: 'Bob Beta' })[id] ?? id, question: (id: string) => ({ hot: 'Hot Topic', 'hot-bill': 'Bill' })[id] ?? id }
const article = { chars: 5000, truncated: false, opening: 'Ann Alpha spoke.' }
const act = { person_id: 'ann', question_id: 'hot', kind: 'says' as const, quote: 'I will vote for it', occurred_on: null, position: 'support' as const, weight: 'clear' as const, reason: 'Says how she will vote.', passage: 'She said: I will vote for it.' }

describe('trialView', () => {
  it('shows people and questions by name, with what was dropped and who was only named', () => {
    const response: TrialResponse = {
      outcome: 'acts',
      acts: [act],
      dropped: [{ act: { person_id: 'bob', question_id: 'hot-bill', quote: 'Not in the page' }, why: 'quotes words that are not in the article' }],
      draft: { mentions: [{ decider_id: 'bob', words: 'Bob Beta was absent' }] },
      article,
      people: ['Ann Alpha', 'Bob Beta'],
    }
    expect(trialView(response, names, 'Hot Topic')).toEqual({
      kind: 'read',
      article,
      readFor: ['Ann Alpha', 'Bob Beta'],
      acts: [{ person: 'Ann Alpha', question: 'Hot Topic', kind: 'says', position: 'support', weight: 'clear', quote: 'I will vote for it', passage: 'She said: I will vote for it.', occurredOn: null, reason: 'Says how she will vote.' }],
      dropped: [{ person: 'Bob Beta', question: 'Bill', quote: 'Not in the page', why: 'quotes words that are not in the article' }],
      named: [{ person: 'Bob Beta', words: 'Bob Beta was absent' }],
    })
  })

  it('keeps an id it has no name for, rather than showing nothing', () => {
    const response: TrialResponse = { outcome: 'acts', acts: [{ ...act, person_id: 'gone' }], dropped: [], draft: {}, article, people: [] }
    const view = trialView(response, names, 'Hot Topic')
    expect(view.kind === 'read' && view.acts[0].person).toBe('gone')
  })

  it('says in a sentence why a page was not read', () => {
    expect(trialView({ outcome: 'not_read', reason: 'The site answered 403.', unread: 'refused' }, names, 'Hot Topic')).toEqual({
      kind: 'message',
      headline: 'Not read. The site turned our reader away.',
      detail: 'The site answered 403.',
      article: undefined,
      readFor: undefined,
    })
  })

  it('names the question when the page names nobody on its roster', () => {
    const view = trialView({ outcome: 'no_people', article }, names, 'Hot Topic')
    expect(view).toMatchObject({ kind: 'message', headline: 'The page names nobody the reader can read for on Hot Topic.', article })
  })

  it('shows an article the model found nothing in as read, with no acts', () => {
    expect(trialView({ outcome: 'no_acts', dropped: [], article, people: ['Ann Alpha'] }, names, 'Hot Topic')).toEqual({ kind: 'read', article, readFor: ['Ann Alpha'], acts: [], dropped: [], named: [] })
  })

  it('passes on an error from the server', () => {
    expect(trialView({ error: 'Unknown question.' }, names, 'Hot Topic')).toMatchObject({ kind: 'message', detail: 'Unknown question.' })
  })
})
