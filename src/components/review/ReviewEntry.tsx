import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ACT_KINDS, isUnreadLead, DIRECTIONS, POSITIONS, WEIGHTS, type Direction, type Position, type Proposal, type Question, type Source } from '../../../shared/schema.ts'
import { useTracker } from '../../lib/tracker.tsx'
import { commit } from '../../lib/review.ts'
import { questionInserts, relatedQuestionRows } from '../../lib/question-form.ts'
import { dateOffer, decisionStandings, missingFrom, outlook, relatedChoices, reportingAct, withWeight, type EntryDraft, type Outlook, type RelatedChoice } from '../../lib/review-form.ts'
import { DIRECTION_LABEL, KIND_CHOICE, KIND_LABEL, KIND_NOUN, STANDING_BG, WEIGHT_HINT, WEIGHT_LABEL, formatDate, hostOf, sourceLabel, standingLabel, type Standing } from '../../lib/position.ts'
import { Token } from '../bits.tsx'
import { Marked, RecordItem, splitPassage } from '../RecordItem.tsx'
import { Reveal } from './Reveal.tsx'

const PICKED: Record<Direction, string> = {
  support: 'bg-support/20',
  lean_support: 'bg-lean-support/40',
  mixed: 'bg-mixed/30',
  oppose: 'bg-oppose/15',
}

// What the editor is told about words that did not come with a passage.
const WORDS_LABEL: Record<Proposal['origin'], string> = {
  reader: 'Reader’s words, not checked against the source',
  news_search: 'Your words from the source',
  partner: 'Partner’s words, not checked against the source',
  model: 'Found in the article text by a model',
}

const RELATED_BADGE: Record<RelatedChoice['kind'], string> = {
  smaller_step: 'Smaller step',
  fuller_proposal: 'Fuller proposal',
  main_question: 'Main question',
  measure: 'Measure',
  ask: 'Ask',
  related: 'Related issue',
}

const LINK_BASE = 'cursor-pointer font-semibold text-muted underline underline-offset-[3px] hover:text-ink'
const LINK = `${LINK_BASE} text-sm`
const LINK_SMALL = `${LINK_BASE} text-[13px]`
const TAG = 'tag text-faint'

function DirectionButtons({
  value,
  onPick,
  small = false,
  withNone = false,
  label,
}: {
  value: Direction | null
  onPick: (d: Direction | null) => void
  small?: boolean
  withNone?: boolean
  label: string
}) {
  const options: (Direction | null)[] = withNone ? [null, ...DIRECTIONS] : [...DIRECTIONS]
  return (
    <div role="radiogroup" aria-label={label} className={small ? 'grid grid-cols-[repeat(auto-fit,minmax(64px,1fr))] gap-[5px]' : 'grid grid-cols-4 gap-1.5'}>
      {options.map((d) => {
        const on = d === value
        return (
          <button
            key={d ?? 'none'}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(d)}
            className={`flex cursor-pointer flex-col items-center justify-center border-2 border-ink font-bold transition-[transform,background-color,box-shadow] duration-150 ${
              small ? 'min-h-11 gap-[3px] rounded-[10px] px-0.5 py-1 text-xs' : 'min-h-[58px] gap-[5px] rounded-xl px-0.5 py-1.5 text-[13px]'
            } ${on ? `${d ? PICKED[d] : 'bg-paper'} ${small ? '-translate-y-0.5 shadow-hard-sm' : '-translate-y-[3px] shadow-hard-md'}` : 'bg-surface'}`}
          >
            {d && <Token standing={d} className={small ? 'size-[11px]' : 'size-4'} />}
            {d ? DIRECTION_LABEL[d] : 'None'}
          </button>
        )
      })}
    </div>
  )
}

// What changes for the person on a question if the entry is published as it stands.
function thenNote(entry: EntryDraft, view: Outlook, question: Question, whenFirst: string): string {
  if (!view.then) return entry.decider_id ? 'both answers first' : 'the person first'
  if (view.now.set) return 'set by editors, so it stays'
  if (view.now.standing === 'unknown') return whenFirst
  return view.then.standing === view.now.standing ? 'unchanged' : `was ${standingLabel(view.now.standing, question)}`
}

function ResultLine({ lead, standing, question, note }: { lead: string; standing: Standing | null; question: Question; note: string }) {
  return (
    <p className="flex items-center gap-2 text-[15px]">
      <span className={`size-3.5 shrink-0 rounded-full border-2 border-ink transition-colors duration-300 ${standing && standing !== 'unknown' ? STANDING_BG[standing] : 'border-dashed bg-surface'}`} />
      <span>
        {lead} <b>{standing ? standingLabel(standing, question) : 'not decided yet'}</b> on {question.short_title} <span className="text-faint">· {note}</span>
      </span>
    </p>
  )
}

export function ReviewEntry({
  entry,
  onChange,
  onDismiss,
  proposal,
  source,
  notes,
  roster,
  continued,
  readOnly,
}: {
  entry: EntryDraft
  onChange: (patch: Partial<EntryDraft>) => void
  onDismiss: (dismissed: boolean) => void
  proposal: Proposal
  source: Source
  // What whoever put the entry forward wrote for editors, such as the model's reason.
  notes: string[]
  // Who an added entry can be about.
  roster: { id: string; name: string }[]
  // The entry above is another act by the same person.
  continued: boolean
  readOnly: boolean
}) {
  const { tracker } = useTracker()
  const [open, setOpen] = useState<{ related?: boolean; note?: boolean; setPosition?: boolean; passage?: boolean; facts?: boolean; person?: boolean; words?: boolean; record?: boolean; addQuestion?: boolean }>({})
  const toggle = (what: keyof typeof open) => setOpen((o) => ({ ...o, [what]: !o[what] }))
  const passageText = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const [dialogHeight, setDialogHeight] = useState(0)
  useLayoutEffect(() => {
    if (open.passage && dialog.current) setDialogHeight(dialog.current.offsetHeight + 20)
  }, [open.passage, entry.passage, entry.quote])
  const [markError, setMarkError] = useState<string | null>(null)

  useEffect(() => {
    if (!open.passage) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen((o) => ({ ...o, passage: false }))
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open.passage])

  const choices = useMemo(() => relatedChoices(tracker, entry), [tracker, entry.question_id, entry.decider_id])
  const actsOnFile = useMemo(() => [...(tracker.actsByDecider.get(entry.decider_id ?? '') ?? [])].sort((a, b) => b.occurred_on.localeCompare(a.occurred_on)), [tracker, entry.decider_id])

  const question = tracker.questionById.get(entry.question_id)
  if (!question) return <p className="py-4 text-muted">This entry points at a question that no longer exists.</p>
  const decider = entry.decider_id ? tracker.deciderById.get(entry.decider_id) : undefined
  const name = decider?.name ?? 'Another person'
  const isAdded = entry.items.length === 0
  const role = decider && tracker.roleIn(question, decider.id)
  const seat = role && tracker.seatById.get(role.seat_id)
  const sub = entry.copiedFrom ? `Added by you · answers copied from ${entry.copiedFrom}` : [seat?.label, role?.affiliation].filter(Boolean).join(' · ')

  const view = outlook(tracker, entry, question, entry.reading)
  const then = view.then?.standing ?? null
  const across = view.across
  const noun = KIND_NOUN[entry.kind]
  const record = decider ? tracker.recordFor(question, decider.id) : []
  const onFile = tracker.actById.has(entry.act_id)
  const offer = dateOffer(proposal, source)
  const root = tracker.rootOf(question)
  const offered = new Set(choices.map((c) => c.question.id))
  // A reading the proposal came with, on a question that is not offered any more.
  const strays = Object.keys(entry.related).flatMap((id) => {
    const q = tracker.questionById.get(id)
    return q && !offered.has(id) ? [{ question: q, kind: 'related' as const }] : []
  })
  const solid = choices.filter((c) => c.kind !== 'related')
  const dashed = [...choices.filter((c) => c.kind === 'related'), ...strays]
  const chosen = [...choices, ...strays].filter((c) => entry.related[c.question.id])
  const decisionDates = [question, ...choices.map((c) => c.question)].filter((q) => q.decides_on).map((q) => `${q.short_title} decision ${formatDate(q.decides_on!)}`)

  const split = splitPassage(entry.passage, entry.quote)
  const paragraphs = entry.passage !== null ? (entry.wider ?? []) : []
  const hasWider = paragraphs.length > 0
  const typesWords = entry.passage === null
  const needsWords = typesWords && (!entry.quote.trim() || open.words || isAdded || isUnreadLead(proposal))

  // Marks the words the editor selected in the dialog. They have to sit inside
  // one paragraph, which becomes the passage.
  function markSelection() {
    const selected = (window.getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim()
    if (!passageText.current?.contains(window.getSelection()?.anchorNode ?? null) || selected.length < 3) return setMarkError('Select the words in the text above first.')
    const home = [entry.passage, ...paragraphs].find((p) => p?.includes(selected))
    if (!home) return setMarkError('Select words inside one paragraph.')
    setMarkError(null)
    onChange({ passage: home, quote: selected })
  }

  const setRelated = (questionId: string, reading: Direction | null) => onChange({ related: { ...entry.related, [questionId]: reading } })

  const relatedRow = (choice: RelatedChoice, looks: 'solid' | 'dashed') => {
    const value = entry.related[choice.question.id] ?? null
    const picking = looks === 'solid' || value !== null || choice.question.id in entry.related
    const buttons = <DirectionButtons small withNone value={value} onPick={(d) => setRelated(choice.question.id, d)} label={`${choice.question.short_title}: which way it points`} />
    return looks === 'solid' ? (
      <div key={choice.question.id} className="flex flex-col gap-3 rounded-xl border-2 border-ink bg-surface p-[15px] shadow-hard-sm">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0">
            <b className="block text-[15px]">{choice.question.short_title}</b>
            <span className="mt-0.5 block text-[13px] text-muted">{choice.question.description ?? choice.question.title}</span>
          </span>
          <span className="tag shrink-0 rounded-full bg-ink px-2 py-0.5 text-[11px] text-paper">{RELATED_BADGE[choice.kind]}</span>
        </div>
        {buttons}
      </div>
    ) : (
      <div key={choice.question.id} className="flex flex-col rounded-xl border-2 border-dashed border-line px-[15px] py-[13px]">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold">{choice.question.short_title}</span>
            <span className="mt-0.5 block text-[13px] text-muted">{choice.question.description ?? choice.question.title}</span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1.5">
            <span className="tag rounded-full border-2 border-dashed border-faint px-2 py-px text-[11px] text-muted">{RELATED_BADGE[choice.kind]}</span>
            <button
              type="button"
              className="min-h-9 cursor-pointer rounded-full border-2 border-dashed border-ink bg-surface px-3 text-[13px] font-semibold"
              onClick={() => {
                const { [choice.question.id]: _, ...rest } = entry.related
                onChange({ related: picking ? rest : { ...entry.related, [choice.question.id]: null } })
              }}
            >
              {picking ? 'Hide' : 'Read it here too'}
            </button>
          </span>
        </div>
        <Reveal open={picking}>
          <div className="pt-[13px] pb-1">{buttons}</div>
        </Reveal>
      </div>
    )
  }

  const standings = decisionStandings(entry, view)
  const says = (standing: Standing) => standingLabel(standing, question)
  const decisionChoices: { action: EntryDraft['decision']['action']; title: string; body: string }[] = [
    { action: 'keep', title: `Keep our position: ${says(standings.keep)}`, body: `The ${noun} goes on the record. The page still shows ${says(standings.keep)}, with our reason beside it.` },
    { action: 'lift', title: `Lift our position: ${says(standings.lift)}`, body: `The page shows the calculated result with this ${noun}.` },
    { action: 'set', title: `Set a new position: ${says(standings.set)}`, body: `Starts from what this ${noun} shows. Pick another below if needed, and say why.` },
  ]

  return (
    <section
      aria-label={name}
      // Room for the passage dialog, which covers this entry and may be taller than it.
      style={{ minHeight: open.passage ? dialogHeight : undefined }}
      className="relative -mx-3 rounded border-t-2 border-dashed border-line transition-[min-height] duration-300"
    >
      <Reveal open={entry.dismissed}>
        <div className="flex items-center gap-3 px-3 py-[18px]">
          <Token standing="unknown" className="size-6" />
          <p className="min-w-0 flex-1 text-[15px]">
            <b>{name}</b> <span className="text-muted">· dismissed, not published</span>
          </p>
          {!readOnly && (
            <button type="button" onClick={() => onDismiss(false)} className="link min-h-11 cursor-pointer px-1.5 text-[15px] font-bold">
              Undo
            </button>
          )}
        </div>
      </Reveal>

      <Reveal open={!entry.dismissed}>
        <div className="flex flex-col gap-[18px] px-3 py-6">
          <div className={`flex gap-3 ${continued ? 'items-center' : 'items-start'}`}>
            <Token standing={then ?? 'unknown'} className={`transition-colors duration-300 ${continued ? 'size-6' : 'size-10'} ${then && then !== 'unknown' && !continued ? 'shadow-hard-sm' : ''}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <h3 className={continued ? 'text-base leading-[1.2] font-extrabold' : 'text-[22px] leading-[1.1] font-black'}>
                  {continued ? `Also from ${name}: another ${noun}` : decider ? decider.name : 'Choose a person'}
                </h3>
                {isAdded && decider && (
                  <button type="button" aria-label="Change the person" onClick={() => toggle('person')} className="size-9 shrink-0 cursor-pointer rounded-lg border-2 border-transparent text-lg leading-none hover:border-ink">
                    ✎
                  </button>
                )}
              </div>
              {sub && !continued && <p className="mt-1 text-sm text-muted">{sub}</p>}
            </div>
            {!readOnly && (
              <button type="button" onClick={() => onDismiss(true)} className="inline-flex min-h-10 shrink-0 cursor-pointer items-center rounded-full border-2 border-ink bg-surface px-3.5 py-1 text-sm font-semibold">
                Dismiss
              </button>
            )}
          </div>

          {isAdded && (
            <Reveal open={!decider || !!open.person} className={!decider || open.person ? '' : '-mt-[18px]'}>
              <select
                aria-label="Person"
                value={entry.decider_id ?? ''}
                onChange={(e) => {
                  onChange({ decider_id: e.target.value || null })
                  setOpen((o) => ({ ...o, person: false }))
                }}
                className="field mb-1"
              >
                <option value="">Choose a person</option>
                {roster.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Reveal>
          )}

          {(entry.passage !== null || (entry.quote && !needsWords)) && (
            <div>
              <div
                {...(hasWider ? { role: 'button', tabIndex: 0, onClick: () => toggle('passage'), onKeyDown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle('passage')) } : {})}
                className={`block rounded-xl border-2 border-line bg-surface px-3.5 py-3 leading-[1.55] text-muted transition-colors duration-200 ${hasWider ? 'cursor-pointer hover:border-ink' : ''}`}
              >
                <span className={`${TAG} mb-1.5 block`}>{entry.passage === null ? WORDS_LABEL[proposal.origin] : `${KIND_LABEL[entry.kind]}${entry.occurred_on ? ` · ${formatDate(entry.occurred_on)}` : ''}`}</span>
                {split ? <Marked {...split} /> : entry.quote ? <Marked before="" mark={entry.quote} after="" /> : entry.passage}
                {hasWider && <span className="link mt-2 block text-[13px] font-bold text-ink">Read the wider passage</span>}
              </div>
              {entry.passage !== null && !entry.quote && <p className="mt-2 text-[13px] text-faint">No words marked yet. Open the passage, select what they said or did, and mark it.</p>}
              {isAdded && !readOnly && (
                <button type="button" onClick={() => onChange({ passage: null, quote: '' })} className={`${LINK_SMALL} mt-1.5`}>
                  Their words are not in this passage: type them instead
                </button>
              )}
              {entry.copiedFrom && split && <p className="mt-2 text-[13px] text-faint">Same passage as {entry.copiedFrom}. Open it to mark other words.</p>}
            </div>
          )}

          {typesWords && (
            <Reveal open={needsWords} className={needsWords ? '' : '-mt-[18px]'}>
              <div className="flex flex-col gap-1.5 pb-1">
                <label className="text-sm font-bold" htmlFor={`${entry.key}:words`}>
                  The words, from the source
                </label>
                <input
                  id={`${entry.key}:words`}
                  value={entry.quote}
                  onChange={(e) => onChange({ quote: e.target.value })}
                  placeholder="Copy what they said or did from the article"
                  className="field"
                />
                {isUnreadLead(proposal) && <p className="text-[13px] text-faint">Nothing to pick from: the article was not read.</p>}
              </div>
            </Reveal>
          )}

          <div className="-mt-2.5">
            <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-muted">
              <span>
                {KIND_LABEL[entry.kind]} · {entry.occurred_on ? formatDate(entry.occurred_on) : <b className="text-oppose">no date yet</b>}
                {onFile && ' · an act already on the record'}
              </span>
              {!readOnly && !entry.occurred_on && (
                <button type="button" onClick={() => onChange({ occurred_on: offer.date })} className={LINK_SMALL}>
                  Use {formatDate(offer.date)}, {offer.from === 'source' ? 'the source’s date' : 'the day this was put forward'}
                </button>
              )}
              {!readOnly && (
                <button type="button" aria-expanded={!!open.facts} onClick={() => toggle('facts')} className={LINK_SMALL}>
                  {open.facts ? 'Done' : 'Change'}
                </button>
              )}
              {typesWords && !needsWords && !readOnly && (
                <button type="button" onClick={() => toggle('words')} className={LINK_SMALL}>
                  Change the words
                </button>
              )}
            </p>
            <Reveal open={!!open.facts}>
              <div className="grid gap-2.5 pt-2.5 pb-1 sm:grid-cols-2">
                {actsOnFile.length > 0 && (
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor={`${entry.key}:act`}>
                      Which {noun} is this?
                    </label>
                    <select
                      id={`${entry.key}:act`}
                      value={entry.act_id}
                      onChange={(e) => onChange(reportingAct(entry, tracker.actById.get(e.target.value) ?? null))}
                      className="field"
                    >
                      {!tracker.actById.has(entry.newActId) && <option value={entry.newActId}>A new {noun}, not on the record yet</option>}
                      {actsOnFile.map((a) => (
                        <option key={a.id} value={a.id}>
                          On the record: {formatDate(a.occurred_on)} · {KIND_LABEL[a.kind]} · {a.body.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="label" htmlFor={`${entry.key}:kind`}>
                    Kind
                  </label>
                  <select id={`${entry.key}:kind`} value={entry.kind} disabled={onFile} onChange={(e) => onChange({ kind: e.target.value as EntryDraft['kind'] })} className="field">
                    {ACT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_CHOICE[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor={`${entry.key}:date`}>
                    Date it happened
                  </label>
                  <input id={`${entry.key}:date`} type="date" value={entry.occurred_on} disabled={onFile} onChange={(e) => onChange({ occurred_on: e.target.value })} className="field" />
                </div>
              </div>
            </Reveal>
          </div>

          <div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,250px),1fr))] gap-5">
              <div>
                <p className="mb-2 text-sm font-bold">Which way it points on {question.short_title}</p>
                <DirectionButtons
                  label={`Which way it points on ${question.short_title}`}
                  value={entry.mainSkipped ? null : entry.reading}
                  onPick={(d) => onChange({ reading: d, mainSkipped: false })}
                />
                {!readOnly && (entry.mainSkipped || chosen.length > 0) && (
                  <p className="mt-2.5 text-[13px] text-muted">
                    {entry.mainSkipped ? `Left out: this says nothing on ${question.short_title} itself. Pick an answer above to bring it back.` : `Only about ${chosen.map((c) => c.question.short_title).join(' and ')}? `}
                    {!entry.mainSkipped && (
                      <button type="button" onClick={() => onChange({ mainSkipped: true })} className={LINK_SMALL}>
                        Leave {question.short_title} out
                      </button>
                    )}
                  </p>
                )}
                {(choices.length > 0 || strays.length > 0 || !readOnly) && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                    <button type="button" aria-expanded={!!open.related} onClick={() => toggle('related')} className="link min-h-8 cursor-pointer text-sm font-bold">
                      {open.related ? 'Hide related proposals' : 'Related proposals'}
                    </button>
                    {!open.related &&
                      chosen.map((c) => (
                        <span key={c.question.id} className="inline-flex items-center gap-1.5 rounded-full border-2 border-ink bg-surface py-0.5 pr-2.5 pl-1 text-xs font-bold">
                          <Token standing={entry.related[c.question.id]!} className="size-3" />
                          {c.question.short_title}: {DIRECTION_LABEL[entry.related[c.question.id]!]}
                        </span>
                      ))}
                  </div>
                )}
              </div>
              <div>
                <p className="mb-2 text-sm font-bold">How much it counts</p>
                <div role="radiogroup" aria-label="How much it counts" className="grid grid-cols-4 gap-1.5">
                  {WEIGHTS.map((w) => {
                    const on = entry.weight === w
                    return (
                      <button
                        key={w}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => onChange(withWeight(entry, w))}
                        className={`min-h-[58px] cursor-pointer rounded-xl border-2 border-ink px-0.5 py-1.5 text-[13px] font-bold transition-[transform,background-color,color] duration-150 ${on ? '-translate-y-[3px] bg-ink text-paper shadow-hard-go' : 'bg-surface'}`}
                      >
                        {WEIGHT_LABEL[w]}
                      </button>
                    )
                  })}
                </div>
                <p className="mt-2 text-[13px] leading-[1.4] text-muted">{entry.weight ? WEIGHT_HINT[entry.weight] : 'Nothing is filled in. Pick how much it counts.'}</p>
              </div>
            </div>

            <Reveal open={!!open.related}>
              <div className="mt-5 mb-1.5 flex flex-col gap-3.5 rounded-[14px] border-2 border-ink bg-paper p-[18px]">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="font-extrabold">Related proposals</p>
                  {decisionDates.length > 0 && <span className="tag text-muted">{decisionDates.join(' · ')}</span>}
                </div>
                {solid.map((c) => relatedRow(c, 'solid'))}
                {dashed.map((c) => relatedRow(c, 'dashed'))}
                {solid.length + dashed.length === 0 && <p className="text-sm text-muted">Nothing is linked to {root.short_title} yet.</p>}
                {!readOnly && (
                  <div>
                    <button type="button" aria-expanded={!!open.addQuestion} onClick={() => toggle('addQuestion')} className={LINK}>
                      {open.addQuestion ? 'Cancel' : 'Add a related question'}
                    </button>
                    <Reveal open={!!open.addQuestion}>
                      <AddQuestion to={root} onAdded={(id) => (setRelated(id, entry.reading), setOpen((o) => ({ ...o, addQuestion: false })))} />
                    </Reveal>
                  </div>
                )}
              </div>
            </Reveal>
          </div>

          {!across && (
            <div className="flex flex-col gap-1.5">
              {entry.mainSkipped ? (
                <p className="flex items-center gap-2 text-[15px] text-muted">
                  <Token standing="unknown" className="size-3.5" />
                  Not read on {question.short_title}
                </p>
              ) : (
                <ResultLine lead="Then listed as" standing={then} question={question} note={thenNote(entry, view, question, 'their first entry')} />
              )}
              {chosen.map((c) => {
                const other = outlook(tracker, entry, c.question, entry.related[c.question.id]!)
                const to = other.then?.standing ?? null
                return (
                  <ResultLine
                    key={c.question.id}
                    lead="and"
                    standing={to}
                    question={c.question}
                    note={thenNote(entry, other, c.question, 'first reading there')}
                  />
                )
              })}
            </div>
          )}

          {notes.map((n, i) => (
            <p key={i} className="-mt-2 text-sm text-muted">
              {n}
            </p>
          ))}

          {across && (
            <div className="flex flex-col gap-3">
              <div className="-mx-5 border-y-2 border-ink bg-mint px-5 py-4">
                <b>That is the {noun}.</b> <span className="text-muted">Now decide what {name}’s page shows.</span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3 py-1.5">
                <div className="flex flex-col gap-2 rounded-[14px] border-2 border-ink bg-surface px-4 py-3.5">
                  <span className={TAG}>Our position now</span>
                  <span className="flex items-center gap-2.5">
                    <Token standing={across.position} className="size-7 shadow-hard-sm" />
                    <b className="text-[22px] font-black">{standingLabel(across.position, question)}</b>
                  </span>
                  <span className="text-sm text-muted">Set by editors on {formatDate(across.set_at)}</span>
                  <p className="border-l-2 border-accent pl-3 text-[15px] leading-[1.45]">{across.reason}</p>
                </div>
                <div className="flex flex-col gap-2 rounded-[14px] border-2 border-dashed border-ink bg-paper px-4 py-3.5">
                  <span className={TAG}>Calculated from the record</span>
                  <span className="flex items-center gap-2.5">
                    <Token standing={view.then?.calculated ?? 'unknown'} className="size-7" />
                    <b className="text-[22px] font-black">{standingLabel(view.then?.calculated ?? 'unknown', question)}</b>
                  </span>
                  <span className="text-sm text-muted">
                    What the page shows if we lift our position: {record.length} item{record.length === 1 ? '' : 's'} on the record and this {noun}.
                  </span>
                </div>
              </div>
              <h3 className="text-[22px] font-black">What should {name}’s page show?</h3>
              <div role="radiogroup" aria-label="Our position" className="flex flex-col gap-2.5">
                {decisionChoices.map((o) => {
                  const on = entry.decision.action === o.action
                  return (
                    <button
                      key={o.action}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => onChange({ decision: { ...entry.decision, action: o.action } })}
                      className={`flex w-full cursor-pointer items-start gap-3 rounded-[14px] border-2 border-ink px-4 py-3.5 text-left transition-[transform,background-color,box-shadow] duration-150 ${on ? '-translate-y-[3px] bg-mint shadow-hard-md' : 'bg-surface'}`}
                    >
                      <span className={`mt-0.5 size-5 shrink-0 rounded-full border-2 border-ink bg-surface transition-shadow duration-200 ${on ? 'shadow-[inset_0_0_0_3px_#fff,inset_0_0_0_10px_var(--color-ink)]' : ''}`} />
                      <Token standing={standings[o.action]} className="mt-px size-[22px] transition-colors duration-200" />
                      <span>
                        <b className="block text-[17px]">{o.title}</b>
                        <span className="mt-0.5 block text-[15px] leading-[1.4] text-muted">{o.body}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
              <Reveal open={entry.decision.action === 'set'}>
                <label className="label" htmlFor={`${entry.key}:new-position`}>
                  New position
                </label>
                <select
                  id={`${entry.key}:new-position`}
                  value={standings.set}
                  onChange={(e) => onChange({ decision: { ...entry.decision, position: e.target.value as Position } })}
                  className="field mb-1"
                >
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {standingLabel(p, question)}
                    </option>
                  ))}
                </select>
              </Reveal>
              <div>
                <label className="label" htmlFor={`${entry.key}:decision-reason`}>
                  {entry.decision.action === 'lift' ? 'Note on lifting it (only editors see this)' : entry.decision.action === 'keep' ? `Why we keep it (shown on ${name}’s page)` : `Why (shown on ${name}’s page)`}
                </label>
                <input
                  id={`${entry.key}:decision-reason`}
                  value={entry.decision.reason}
                  onChange={(e) => onChange({ decision: { ...entry.decision, reason: e.target.value } })}
                  placeholder={entry.decision.action === 'lift' ? 'Add a note…' : entry.decision.action === 'keep' ? 'Leave empty to keep the reason as it is' : 'One or two plain sentences'}
                  className="field"
                />
              </div>
            </div>
          )}

          <div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <button type="button" aria-expanded={!!open.note} onClick={() => toggle('note')} className={`${LINK} min-h-9`}>
                {open.note ? 'Hide the note' : entry.note ? 'Show the note' : 'Add a note'}
              </button>
              {!across && question.kind === 'position' && decider && !readOnly && (
                <button
                  type="button"
                  aria-expanded={!!open.setPosition}
                  onClick={() => {
                    if (open.setPosition) onChange({ setPosition: null })
                    toggle('setPosition')
                  }}
                  className={`${LINK} min-h-9`}
                >
                  {entry.setPosition ? `Our position: ${standingLabel(entry.setPosition.position, question)} (remove)` : 'Set our position'}
                </button>
              )}
              {record.length > 0 && (
                <button type="button" aria-expanded={!!open.record} onClick={() => toggle('record')} className={`${LINK} min-h-9`}>
                  Already on the record ({record.length})
                </button>
              )}
            </div>
            <Reveal open={!!open.note}>
              <div className="pt-[13px] pb-1">
                <label className="label" htmlFor={`${entry.key}:note`}>
                  Note on {name} <span className="font-normal text-faint">(only editors see this)</span>
                </label>
                <input id={`${entry.key}:note`} value={entry.note} onChange={(e) => onChange({ note: e.target.value })} placeholder="Add a note…" className="field" />
              </div>
            </Reveal>
            <Reveal open={!!open.setPosition}>
              <div className="mt-[13px] mb-1.5 flex flex-col gap-3 rounded-[14px] border-2 border-ink bg-paper p-[18px]">
                <p className="font-extrabold">Set our position for {name}</p>
                <p className="text-sm text-muted">While it is set, their page shows this position instead of the calculated one. Use it when the record alone gives the wrong answer.</p>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-2.5">
                  <select
                    aria-label="Our position"
                    value={entry.setPosition?.position ?? ''}
                    onChange={(e) => onChange({ setPosition: e.target.value ? { position: e.target.value as Position, reason: entry.setPosition?.reason ?? '' } : null })}
                    className="field"
                  >
                    <option value="">Calculated from the record</option>
                    {POSITIONS.map((p) => (
                      <option key={p} value={p}>
                        {standingLabel(p, question)}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Reason, shown on their page"
                    value={entry.setPosition?.reason ?? ''}
                    disabled={!entry.setPosition}
                    onChange={(e) => entry.setPosition && onChange({ setPosition: { ...entry.setPosition, reason: e.target.value } })}
                    placeholder="Reason, shown on their page"
                    className="field disabled:opacity-50"
                  />
                </div>
                <p className="text-[13px] text-faint">It is set when this card is published.</p>
              </div>
            </Reveal>
            <Reveal open={!!open.record}>
              <ol className="space-y-2.5 pt-[13px] pb-1.5">
                {record.map((e) => (
                  <RecordItem key={e.reading.id} entry={e} question={question} />
                ))}
              </ol>
            </Reveal>
          </div>
        </div>
      </Reveal>

      {hasWider && (
        <div
          onClick={() => toggle('passage')}
          aria-hidden={!open.passage}
          inert={!open.passage}
          className={`absolute inset-0 z-[5] flex items-start justify-center rounded-xl bg-ink/55 p-2.5 transition-[opacity,visibility] duration-200 ${open.passage ? 'visible opacity-100' : 'invisible opacity-0'}`}
        >
          <div
            role="dialog"
            aria-label={`The passage, for ${name}`}
            onClick={(e) => e.stopPropagation()}
            ref={dialog}
            className={`relative w-full max-w-[620px] rounded-[18px] border-2 border-ink bg-paper p-5 shadow-hard-lg transition-transform duration-200 ${open.passage ? '' : 'translate-y-2.5 scale-[0.98]'}`}
          >
            <button type="button" aria-label="Close" onClick={() => toggle('passage')} className="absolute top-2 right-2 size-9 cursor-pointer rounded-md text-2xl leading-none text-muted">
              ×
            </button>
            <h2 className="pr-8 text-[19px] font-bold">The passage, for {name}</h2>
            <p className="mt-1 text-sm text-muted">
              {sourceLabel(source)} · {hostOf(source.url)}
            </p>
            <div ref={passageText} className="mt-3.5 flex flex-col gap-2.5 leading-[1.6] text-muted">
              {paragraphs.map((p, i) =>
                p === entry.passage ? (
                  <div key={i} className="rounded-xl border-2 border-ink bg-surface px-3 py-2.5">
                    <span className={`${TAG} mb-1 block text-[11px] select-none`}>We publish this passage</span>
                    {split ? <Marked {...split} /> : p}
                  </div>
                ) : (
                  <p key={i}>{p}</p>
                ),
              )}
            </div>
            <p className="mt-3.5 text-sm leading-[1.45] text-muted">
              We publish the boxed passage with a link to the whole article. The marked words are what {name} {entry.kind === 'says' ? 'said' : 'did'}.
            </p>
            {!readOnly && (
              <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <button type="button" onClick={markSelection} className="btn btn-sm min-h-9">
                  Mark the selected words
                </button>
                <span className="text-[13px] text-faint">{markError ?? 'To mark other words, select them in the text and press this.'}</span>
              </p>
            )}
            <p className="mt-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer" className="link text-sm font-bold">
                  Read the whole article ↗
                </a>
              ) : (
                <span />
              )}
              <button type="button" onClick={() => toggle('passage')} className="btn btn-sm min-h-9">
                Close
              </button>
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

// A new question linked to the one the card is about: a smaller step toward it,
// or a neighbouring question.
function AddQuestion({ to, onAdded }: { to: Question; onAdded: (questionId: string) => void }) {
  const { tracker } = useTracker()
  const [error, setError] = useState<string | null>(null)
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    e.stopPropagation()
    const form = e.currentTarget
    const f = new FormData(form)
    const rows = relatedQuestionRows(to, tracker.questionBodies, tracker, {
      short_title: f.get('short_title') as string,
      title: f.get('title') as string,
      kind: f.get('kind') === 'related' ? 'related' : 'smaller_step',
    })
    setError(null)
    commit(questionInserts(rows)).then(
      () => form.reset(),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    )
    onAdded(rows.question.id)
  }
  return (
    <form onSubmit={onSubmit} className="mt-3 mb-1.5 flex flex-col gap-2.5 rounded-xl border-2 border-ink bg-surface p-[15px]">
      <div>
        <label className="label" htmlFor={`${to.id}:new-short`}>
          Short name
        </label>
        <input id={`${to.id}:new-short`} name="short_title" required maxLength={60} placeholder="Medicare at 55" className="field" />
      </div>
      <div>
        <label className="label" htmlFor={`${to.id}:new-title`}>
          The question, as asked
        </label>
        <input id={`${to.id}:new-title`} name="title" required maxLength={200} placeholder="Do they support lowering the Medicare age to 55?" className="field" />
      </div>
      <fieldset className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        <label className="flex min-h-9 cursor-pointer items-center gap-2">
          <input type="radio" name="kind" value="smaller_step" defaultChecked className="size-4 accent-ink" />A smaller step toward {to.short_title}
        </label>
        <label className="flex min-h-9 cursor-pointer items-center gap-2">
          <input type="radio" name="kind" value="related" className="size-4 accent-ink" />A related issue
        </label>
      </fieldset>
      <p className="text-[13px] text-faint">It is added now, as a question of its own with its own page, and stays whatever happens to this card.</p>
      {error && <p className="text-sm font-semibold text-oppose">Not added: {error}</p>}
      <button className="btn btn-sm self-start">Add the question</button>
    </form>
  )
}
