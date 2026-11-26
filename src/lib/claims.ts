import type { ActKind, Direction, Proposal, ProposalItem, Weight } from '../../shared/schema.ts'
import type { Tracker } from './build-tracker.ts'

// The act a proposal brought in for an entry. Every item of one entry names the same one; a lead names none.
export const cameInOf = (items: Pick<ProposalItem, 'act_id'>[]): string | null => items.find((i) => i.act_id)?.act_id ?? null

// What one proposal item puts forward, as it stands on file: the act's kind,
// date and words, its passage in the proposal's source, and the sender's
// review of it on the item's question. A lead has no act, no words (its search
// excerpt is nobody's, and stays on the item) and no reading.
export type Claim = {
  item: ProposalItem
  kind: ActKind
  occurred_on: string | null
  quote: string
  passage: string | null
  reading: Direction | null
  weight: Weight | null
  // What the editors have said of the act on the item's question (see `editorsVerdict`).
  verdict: 'waiting' | 'published' | 'turned_down'
}

export function claimOf(tracker: Pick<Tracker, 'actById' | 'reportIn' | 'reviewBy' | 'editorsVerdict'>, proposal: Pick<Proposal, 'source_id' | 'submitted_by' | 'status'>, item: ProposalItem): Claim {
  const act = item.act_id ? tracker.actById.get(item.act_id) : undefined
  if (!act) {
    return { item, kind: 'says', occurred_on: null, quote: '', passage: null, reading: null, weight: null, verdict: proposal.status === 'reviewed' ? 'turned_down' : 'waiting' }
  }
  const report = tracker.reportIn(proposal.source_id, act.id)
  const sent = proposal.submitted_by ? tracker.reviewBy(proposal.submitted_by, act.id, item.question_id) : undefined
  return {
    item,
    kind: act.kind,
    occurred_on: act.occurred_on,
    quote: report?.excerpt ?? act.body,
    passage: report?.passage ?? null,
    reading: sent?.position ?? null,
    weight: sent?.weight ?? null,
    verdict: tracker.editorsVerdict(act.id, item.question_id),
  }
}
