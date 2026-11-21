import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { inEffect, type Question } from '../../shared/schema.ts'
import { LIMITS, bodyOf, inputOf, nounOf, newQuestionRows, questionEdits, questionInserts, questionProblems, readQuestionForm, type Placement, type QuestionInput, type QuestionLinks } from '../lib/question-form.ts'
import { commit } from '../lib/review.ts'
import { today, useTracker } from '../lib/tracker.tsx'

export type QuestionFormProps =
  | { place: Placement; editing?: undefined; onSaved: (saved: Question) => void }
  | { place?: undefined; editing: { question: Question; links: QuestionLinks }; onSaved?: undefined }

const IMPLIES = [
  ['', 'Nothing'],
  ['support', 'Support'],
  ['lean_support', 'Probable support'],
  ['mixed', 'Mixed'],
  ['oppose', 'Against'],
] as const

// Fields keep stable `name`s: `readQuestionForm` reads them from the FormData on submit.
export function QuestionForm(props: QuestionFormProps) {
  const { tracker } = useTracker()
  const { place, editing } = props
  const question = editing?.question ?? null
  const parent = place && (place.kind === 'measure' || place.kind === 'ask') ? place.parent : question?.parent_id ? tracker.questionById.get(question.parent_id) : undefined
  const isAsk = place ? place.kind === 'ask' : tracker.isAsk(question!)
  const noun = nounOf({ parent_id: parent?.id ?? null }, isAsk)
  const start: QuestionInput = place
    ? {
        ...inputOf(null),
        kind: place.kind === 'measure' ? 'formal_act' : 'position',
        implies_on_parent: place.kind === 'measure' ? 'support' : null,
        chamber: place.kind === 'step' ? place.to.chamber : null,
        also_body_ids: place.kind === 'question' ? [] : tracker.questionBodies.filter((l) => l.question_id === (place.kind === 'step' ? place.to.id : place.parent.id)).map((l) => l.body_id),
        deciders: place.kind === 'ask' ? [{ decider_id: '', role_label: null }] : [],
      }
    : inputOf(question, editing!.links)

  const [bodyId, setBodyId] = useState(place ? bodyOf(place) : question!.body_id)
  const [kind, setKind] = useState(start.kind)
  const [people, setPeople] = useState(() => start.deciders.map((d) => ({ key: crypto.randomUUID(), ...d })))
  const [problems, setProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const top = useRef<HTMLDivElement>(null)
  // The write is confirmed by the server, which can be after the editor has gone to another page.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const body = tracker.bodyById.get(bodyId)
  const chambers = [...new Set(tracker.seats.filter((s) => s.body_id === bodyId && s.chamber).map((s) => s.chamber!))].sort()
  const otherBodies = tracker.bodiesInOrder.filter((b) => b.id !== bodyId)
  const root = parent ?? question ?? undefined
  const seated = root ? tracker.rosterOf(root) : []
  // Someone already named on the ask stays a choice even without a seat here, or saving would drop them.
  const roster = [...seated, ...start.deciders.flatMap((d) => (seated.some((x) => x.id === d.decider_id) ? [] : (tracker.deciderById.get(d.decider_id) ?? [])))]
  const readingsHere = question ? tracker.readings.filter((r) => r.question_id === question.id).length : 0
  const offices = tracker.offices
    .filter((o) => o.body_id === null || (root ? tracker.bodiesOf(root).some((b) => b.id === o.body_id) : o.body_id === bodyId))
    .sort((a, b) => Number(a.body_id === null) - Number(b.body_id === null) || a.sort - b.sort)
  const holdersOf = (officeId: string) =>
    tracker.officeHolders.filter((h) => h.office_id === officeId && inEffect(h, today())).flatMap((h) => tracker.deciderById.get(h.decider_id)?.name ?? [])

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const input = readQuestionForm(f)
    const found = questionProblems(input, isAsk)
    setProblems(found)
    setSaved(false)
    if (found.length) {
      top.current?.scrollIntoView({ block: 'start' })
      return
    }
    let writes
    let result: Question
    if (place) {
      const at: Placement = place.kind === 'question' ? { kind: 'question', body_id: bodyId } : place.kind === 'step' ? { ...place, relation: f.get('relation_kind') === 'related' ? 'related' : 'smaller_step' } : place
      const rows = newQuestionRows(input, at, tracker)
      writes = questionInserts(rows)
      result = rows.question
    } else {
      writes = questionEdits(editing.question, input, editing.links)
      result = editing.question
    }
    setSaving(true)
    commit(writes).then(
      () => {
        setSaving(false)
        setSaved(true)
        if (mounted.current) props.onSaved?.(result)
      },
      (err: unknown) => {
        setSaving(false)
        setProblems([`Not saved: ${err instanceof Error ? err.message : String(err)}`])
        top.current?.scrollIntoView({ block: 'start' })
      },
    )
  }

  return (
    <form onSubmit={onSubmit} onChange={() => setSaved(false)} noValidate className="space-y-6" aria-label={question ? 'Edit the question' : 'The new question'}>
      <div ref={top} className="scroll-mt-4">
        {problems.length > 0 && (
          <div role="alert" className="rounded-xl border-2 border-oppose bg-surface p-4 text-sm">
            <p className="font-bold">{problems.length === 1 && problems[0].startsWith('Not saved') ? 'This was not saved.' : 'Some fields need changing before this can be saved.'}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <Section title="The question">
        {place?.kind === 'question' ? (
          <Field label="Body" id="q-body">
            <select id="q-body" name="body_id" className="field" value={bodyId} onChange={(e) => setBodyId(e.target.value)}>
              {tracker.bodiesInOrder.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.is_demo ? ' (demo)' : ''}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="text-sm">
            <span className="font-bold">Body:</span> {body?.name}
            {parent && (
              <>
                {' · '}
                <span className="font-bold">{isAsk ? 'An ask under:' : 'A measure under:'}</span> {parent.title}
              </>
            )}
            {place?.kind === 'step' && (
              <>
                {' · '}
                <span className="font-bold">Linked to:</span> {place.to.title}
              </>
            )}
          </p>
        )}
        {place?.kind === 'step' && (
          <fieldset>
            <legend className="label">How it is linked</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
              <Choice name="relation_kind" value="smaller_step" defaultChecked>
                A smaller step toward {place.to.short_title}
              </Choice>
              <Choice name="relation_kind" value="related">
                A related issue
              </Choice>
            </div>
          </fieldset>
        )}
        <Field label="The question, as asked" id="q-title">
          <input id="q-title" name="title" required maxLength={LIMITS.title} defaultValue={start.title} placeholder={parent ? undefined : "Do they support lowering the Medicare age to 55?"} className="field" />
        </Field>
        <Field label="Short name" id="q-short" hint={question ? 'Shown on tabs and lists. The page address stays as it is.' : 'Shown on tabs and lists. The page address is made from it.'}>
          <input id="q-short" name="short_title" required maxLength={LIMITS.short_title} defaultValue={start.short_title} placeholder={parent ? undefined : "Medicare at 55"} className="field" />
        </Field>
        <Field label="Description" id="q-description" optional>
          <textarea id="q-description" name="description" rows={3} maxLength={LIMITS.description} defaultValue={start.description ?? ''} className="field" />
        </Field>
        <fieldset>
          <legend className="label">What it asks</legend>
          <div className="space-y-1.5 text-sm">
            <Choice name="kind" value="position" defaultChecked={start.kind === 'position'} onChange={() => setKind('position')}>
              Where someone stands
            </Choice>
            <Choice name="kind" value="formal_act" defaultChecked={start.kind === 'formal_act'} onChange={() => setKind('formal_act')}>
              Whether someone did a specific thing, such as cosponsoring a bill
            </Choice>
          </div>
          {question && kind !== question.kind && readingsHere > 0 && (
            <p role="note" className="mt-2 text-sm font-semibold text-oppose">
              {readingsHere === 1 ? 'One reading is' : `${readingsHere} readings are`} on the record here. Changing what it asks changes how they are counted, and positions set by hand are not shown on a question about doing something.
            </p>
          )}
        </fieldset>
        {kind === 'formal_act' && (
          <Field label="What having done it is called" id="q-act-label" optional hint="Shown in place of “Signed on”, such as “Ratified” or “Cosponsored”.">
            <input id="q-act-label" name="act_label" maxLength={LIMITS.act_label} defaultValue={start.act_label ?? ''} className="field" />
          </Field>
        )}
      </Section>

      {isAsk && (
        <Section title="Put to" hint="An ask is put to people by name, or to whoever holds an office on the day viewed. It needs at least one.">
          {offices.length > 0 && (
            <fieldset>
              <legend className="label">Offices</legend>
              <div className="space-y-1.5 text-sm">
                {offices.map((o) => {
                  const holders = holdersOf(o.id)
                  return (
                    <label key={o.id} className="flex min-h-8 items-start gap-2">
                      <input type="checkbox" name="office_id" value={o.id} defaultChecked={start.office_ids.includes(o.id)} className="mt-0.5 size-4 shrink-0 accent-ink" />
                      <span>
                        {o.label}
                        {holders.length > 0 && <span className="text-faint"> · {holders.join(', ')}</span>}
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )}
          <fieldset>
            <legend className="label">People</legend>
            <ul className="space-y-3">
              {people.map((p, i) => (
                <li key={p.key} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <div>
                    <label className="mb-1 block text-xs font-bold" htmlFor={`q-person-${p.key}`}>
                      Person {i + 1}
                    </label>
                    <select id={`q-person-${p.key}`} name="decider_id" defaultValue={p.decider_id} className="field">
                      <option value="">Choose someone</option>
                      {roster.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-bold" htmlFor={`q-role-${p.key}`}>
                      Their role here <span className="font-normal">(optional)</span>
                    </label>
                    <input id={`q-role-${p.key}`} name="role_label" maxLength={LIMITS.role_label} defaultValue={p.role_label ?? ''} placeholder="Committee chair" className="field" />
                  </div>
                  <button type="button" className="btn btn-sm justify-self-start sm:self-end" onClick={() => setPeople(people.filter((x) => x.key !== p.key))} aria-label={`Remove person ${i + 1}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-sm mt-3" onClick={() => setPeople([...people, { key: crypto.randomUUID(), decider_id: '', role_label: null }])}>
              Add a person
            </button>
          </fieldset>
        </Section>
      )}

      <Section title="Details">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Seats needed to carry it" id="q-threshold" optional hint="Leave empty for a simple majority.">
            <input id="q-threshold" name="threshold" type="number" min={1} step={1} inputMode="numeric" defaultValue={start.threshold ?? ''} className="field" />
          </Field>
          <Field label="Decision expected on" id="q-decides-on" optional>
            <input id="q-decides-on" name="decides_on" type="date" defaultValue={start.decides_on ?? ''} className="field" />
          </Field>
        </div>
        {chambers.length > 0 && (
          <Field label="Chamber" id="q-chamber">
            <select id="q-chamber" name="chamber" defaultValue={start.chamber ?? ''} className="field">
              <option value="">The whole body</option>
              {chambers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Reference link" id="q-reference" optional hint="The bill, motion or proposal itself.">
          <input id="q-reference" name="reference_url" type="url" defaultValue={start.reference_url ?? ''} placeholder="https://" className="field" />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="is_hot" defaultChecked={start.is_hot} className="mt-0.5 size-4 accent-ink" />
          <span>
            <span className="font-bold">In the news.</span> The daily news search looks for articles about it.
          </span>
        </label>
        {parent && (
          <Field label={`What supporting it says on “${parent.short_title}”`} id="q-implies" hint="A supporting reading here is also written on the main question with this reading.">
            <select id="q-implies" name="implies_on_parent" defaultValue={start.implies_on_parent ?? ''} className="field">
              {IMPLIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {place?.kind === 'measure' && (
          <Field label="Closes on" id="q-closes-on" optional hint="A day it is known to close, as a bill dies when its term ends.">
            <input id="q-closes-on" name="closes_on" type="date" className="field" />
          </Field>
        )}
      </Section>

      {otherBodies.length > 0 && (
        <Section title="Also put to">
          <fieldset>
            <legend className="sr-only">Other bodies it is put to</legend>
            <div className="space-y-1.5 text-sm">
              {otherBodies.map((b) => (
                <label key={b.id} className="flex min-h-8 items-center gap-2">
                  <input type="checkbox" name="also_body_id" value={b.id} defaultChecked={start.also_body_ids.includes(b.id)} className="size-4 accent-ink" />
                  {b.name}
                  {b.is_demo && <span className="text-faint">(demo)</span>}
                </label>
              ))}
            </div>
          </fieldset>
        </Section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={saving}>
          {question ? 'Save changes' : `Add the ${noun}`}
        </button>
        {saved && question && (
          <p role="status" className="text-sm font-semibold">
            Saved.
          </p>
        )}
      </div>
    </form>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card space-y-4 p-4 sm:p-6">
      <div>
        <h2 className="text-lg font-extrabold">{title}</h2>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, id, optional, hint, children }: { label: string; id: string; optional?: boolean; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label} {optional && <span className="font-normal">(optional)</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[13px] text-faint">{hint}</p>}
    </div>
  )
}

function Choice({ name, value, defaultChecked, onChange, children }: { name: string; value: string; defaultChecked?: boolean; onChange?: () => void; children: ReactNode }) {
  return (
    <label className="flex min-h-8 cursor-pointer items-start gap-2">
      <input type="radio" name={name} value={value} defaultChecked={defaultChecked} onChange={onChange} className="mt-0.5 size-4 shrink-0 accent-ink" />
      <span>{children}</span>
    </label>
  )
}
