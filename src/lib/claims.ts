import { EDITORS_ID, type ActKind, type Direction, type Proposal, type ProposalItem, type Weight } from '../../shared/schema.ts'
import type { Tracker } from './build-tracker.ts'

// What one proposal item puts forward, as it stands on file: the act's kind,
// date and words, its passage in the proposal's source, and the sender's
// review of it on the item's question. A lead has no act: its words are the
// search excerpt, which is nobody's, and it gives no reading.
export type Claim = {
  item: ProposalItem
  isLead: boolean
  kind: ActKind
  occurred_on: string | null
  quote: string
  passage: string | null
  reading: Direction | null
  weight: Weight | null
  // What the editors' review of the act on the item's question says, if there is one.
  verdict: 'waiting' | 'published' | 'turned_down'
}

export function claimOf(tracker: Pick<Tracker, 'actById' | 'reportIn' | 'reviewBy' | 'shownAs'>, proposal: Pick<Proposal, 'source_id' | 'submitted_by' | 'status'>, item: ProposalItem): Claim {
  const act = item.act_id ? tracker.actById.get(item.act_id) : undefined
  if (!act) {
    return { item, isLead: true, kind: 'says', occurred_on: null, quote: item.excerpt ?? '', passage: null, reading: null, weight: null, verdict: proposal.status === 'reviewed' ? 'turned_down' : 'waiting' }
  }
  const report = tracker.reportIn(proposal.source_id, act.id)
  const sent = proposal.submitted_by ? tracker.reviewBy(proposal.submitted_by, act.id, item.question_id) : undefined
  // Published as a report of an act already on the record, the editors' review is on that act.
  const editors = tracker.reviewBy(EDITORS_ID, tracker.shownAs(act.id), item.question_id) ?? tracker.reviewBy(EDITORS_ID, act.id, item.question_id)
  return {
    item,
    isLead: false,
    kind: act.kind,
    occurred_on: act.occurred_on,
    quote: report?.excerpt ?? act.body,
    passage: report?.passage ?? null,
    reading: sent?.position ?? null,
    weight: sent?.weight ?? null,
    verdict: !editors ? 'waiting' : editors.position ? 'published' : 'turned_down',
  }
}
