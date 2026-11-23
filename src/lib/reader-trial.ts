import type { ActKind, Direction, UnreadReason, Weight } from '../../shared/schema.ts'
import { UNREAD_TEXT } from './position.ts'

// What `POST /api/editor/read-article` answers, as far as the page reads it.
// The worker's `dryRunArticle` is the source of this shape.
type TrialAct = { person_id: string; question_id: string; kind: ActKind; quote: string; occurred_on: string | null; position: Direction; weight: Weight; reason: string; passage: string }
type TrialDropped = { act: { person_id: string; question_id: string; quote: string }; why: string }
type TrialArticle = { chars: number; truncated: boolean; opening: string }
export type TrialResponse =
  | { error: string }
  | { outcome: 'not_read'; reason: string; unread: UnreadReason; article?: TrialArticle; people?: string[] }
  | { outcome: 'no_people'; article: TrialArticle }
  | { outcome: 'no_acts'; dropped: TrialDropped[]; article: TrialArticle; people: string[] }
  | { outcome: 'acts'; acts: TrialAct[]; dropped: TrialDropped[]; draft: { mentions?: { decider_id: string; words: string }[] }; article: TrialArticle; people: string[] }

export type TrialView =
  | { kind: 'message'; headline: string; detail: string; article?: TrialArticle; readFor?: string[] }
  | {
      kind: 'read'
      article: TrialArticle
      readFor: string[]
      acts: { person: string; question: string; kind: ActKind; position: Direction; weight: Weight; quote: string; passage: string; occurredOn: string | null; reason: string }[]
      dropped: { person: string; question: string; quote: string; why: string }[]
      named: { person: string; words: string }[]
    }

type Names = { person: (id: string) => string; question: (id: string) => string }

// Turns the reader's answer into what the trial form shows: names instead of
// ids, and a sentence wherever the answer is a code.
export function trialView(response: TrialResponse, names: Names, questionTitle: string): TrialView {
  if ('error' in response) return { kind: 'message', headline: 'The reader could not try this page.', detail: response.error }
  if (response.outcome === 'not_read') {
    return { kind: 'message', headline: `Not read. ${UNREAD_TEXT[response.unread]}.`, detail: response.reason, article: response.article, readFor: response.people }
  }
  if (response.outcome === 'no_people') {
    return {
      kind: 'message',
      headline: `The page names nobody the reader can read for on ${questionTitle}.`,
      detail: 'The reader only reads for people on this question’s roster whose name is in the page text. Check that the question is the right one, and how the page names the people you expected.',
      article: response.article,
    }
  }
  const dropped = response.dropped.map((d) => ({ person: names.person(d.act.person_id), question: names.question(d.act.question_id), quote: d.act.quote, why: d.why }))
  if (response.outcome === 'no_acts') return { kind: 'read', article: response.article, readFor: response.people, acts: [], dropped, named: [] }
  return {
    kind: 'read',
    article: response.article,
    readFor: response.people,
    acts: response.acts.map((a) => ({
      person: names.person(a.person_id),
      question: names.question(a.question_id),
      kind: a.kind,
      position: a.position,
      weight: a.weight,
      quote: a.quote,
      passage: a.passage,
      occurredOn: a.occurred_on,
      reason: a.reason,
    })),
    dropped,
    named: (response.draft.mentions ?? []).map((m) => ({ person: names.person(m.decider_id), words: m.words })),
  }
}
