import { Link } from '@tanstack/react-router'
import { useMemo, type FormEvent } from 'react'
import { inEffect, type Body, type Certainty, type Decider, type Office, type OfficeHolder } from '../../shared/schema.ts'
import { OFFICE_LIMITS, holdingEdits, holdingInputOf, holdingInserts, holdingProblems, holdingSource, newOffice, officeEdits, officeInputOf, officeProblems, readHoldingForm, readOfficeForm } from '../lib/office-form.ts'
import { newPerson } from '../lib/person-form.ts'
import { chambersIn, holderProblems, personChoices, readRoleHolder } from '../lib/role-form.ts'
import { useTracker } from '../lib/tracker.tsx'
import { Choice, Field, Problems, SaveBar, Section, useSave } from './form.tsx'
import { PersonPicker } from './PersonForm.tsx'

// Fields keep stable `name`s: `readOfficeForm` reads them from the FormData on submit.
// `body` is undefined for an office held at large.
export function OfficeForm({ body, editing, onSaved }: { body: Body | undefined; editing?: Office; onSaved?: (saved: Office) => void }) {
  const { tracker } = useTracker()
  const save = useSave()
  const start = officeInputOf(editing ?? null)
  // An office's own chamber stays a choice even when no seat names it, or saving would clear it.
  const chambers = body ? [...new Set([...chambersIn(tracker.seats, body.id), ...(editing?.chamber ? [editing.chamber] : [])])].sort() : []

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = readOfficeForm(new FormData(e.currentTarget))
    if (!save.check(officeProblems(input, chambers))) return
    const made = editing ? undefined : newOffice(input, body?.id ?? null, tracker.offices)
    const writes = made ? [{ on: 'offices' as const, type: 'insert' as const, row: made }] : officeEdits(editing!, input)
    save.save(writes, () => onSaved?.(made ?? editing!))
  }

  return (
    <form onSubmit={onSubmit} onChange={save.edited} noValidate className="space-y-6" aria-label={editing ? 'Edit the office' : 'The new office'}>
      <Problems save={save} />
      <Section title="The office" hint={body ? `An office of ${body.name}. Asks put to it go to whoever holds it on the day viewed.` : 'Held at large: it belongs to its holder in their own right and shows with them in every body they sit in.'}>
        <Field label="Name" id="o-label" hint="As it is shown beside its holder, such as “Chair, Finance Committee”.">
          <input id="o-label" name="label" required maxLength={OFFICE_LIMITS.label} defaultValue={start.label} autoComplete="off" className="field" />
        </Field>
        {chambers.length > 0 && (
          <Field label="Chamber" id="o-chamber">
            <select id="o-chamber" name="chamber" defaultValue={start.chamber ?? ''} className="field">
              <option value="">The whole body</option>
              {chambers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Order" id="o-sort" optional hint={editing ? 'Offices are listed from the lowest number. Left empty, it keeps its place.' : 'Offices are listed from the lowest number. Left empty, it goes after the others.'}>
          <input id="o-sort" name="sort" type="number" step={1} inputMode="numeric" defaultValue={start.sort ?? ''} className="field max-w-40" />
        </Field>
      </Section>
      <SaveBar save={save} label={editing ? 'Save changes' : 'Add the office'} isEdit={!!editing} />
    </form>
  )
}

const CERTAINTY_CHOICE: Record<Certainty, string> = {
  certain: 'Certain: holds the office, or is sure to from the start date',
  likely: 'Likely: expected to hold it, not yet settled',
  possible: 'Possible: one of those who may yet hold it',
}

// Fields keep stable `name`s: `readHoldingForm` and `readRoleHolder` read them from the FormData on submit.
export function HoldingForm({ office, editing, onSaved }: { office: Office; editing?: { holder: OfficeHolder; person: Decider }; onSaved?: (saved: OfficeHolder) => void }) {
  const { tracker } = useTracker()
  const save = useSave()
  const choices = useMemo(() => personChoices(tracker.deciders), [tracker.deciders])
  const start = holdingInputOf(editing?.holder ?? null, tracker.sourceById)
  const cited = editing?.holder.source_id ? tracker.sourceById.get(editing.holder.source_id) : undefined
  const unaddressed = cited && cited.url === null ? cited : undefined

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const input = readHoldingForm(f)
    const who = editing ? ({ kind: 'existing', decider: editing.person } as const) : readRoleHolder(f, choices)
    // The holder's kind is already among the problems found; it is checked again to narrow the type.
    if (!save.check([...holderProblems(who), ...holdingProblems(input, !editing)]) || who.kind === 'unknown') return
    const source = holdingSource(input, editing?.holder ?? null, tracker.sources, new Date().toISOString())
    if (editing) return save.save(holdingEdits(editing.holder, input, source))
    const decider = who.kind === 'new' ? newPerson(who.person, tracker.deciders) : who.decider
    const { holder, writes } = holdingInserts(input, office.id, decider, { person: who.kind === 'new' ? decider : undefined, source })
    save.save(writes, () => onSaved?.(holder))
  }

  return (
    <form onSubmit={onSubmit} onChange={save.edited} noValidate className="space-y-6" aria-label={editing ? 'Edit the holding' : 'The new holding'}>
      <Problems save={save} />
      {!editing && <PersonPicker choices={choices} />}
      <Section title="The holding" hint="One stretch of time someone holds the office. One holder can end on the day the next starts.">
        <fieldset>
          <legend className="label">How sure</legend>
          <div className="space-y-1.5 text-sm">
            {(['certain', 'likely', 'possible'] as const).map((c) => (
              <Choice key={c} name="certainty" value={c} defaultChecked={start.certainty === c}>
                {CERTAINTY_CHOICE[c]}
              </Choice>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts on" id="h-starts-on" optional hint="Leave empty if it started before we kept track.">
            <input id="h-starts-on" name="starts_on" type="date" defaultValue={start.starts_on ?? ''} className="field" />
          </Field>
          <Field label="Ends on" id="h-ends-on" optional hint="Leave empty if no end is known. They no longer hold it from this day.">
            <input id="h-ends-on" name="ends_on" type="date" defaultValue={start.ends_on ?? ''} className="field" />
          </Field>
        </div>
        <Field
          label="Source"
          id="h-source"
          optional
          hint={
            unaddressed
              ? `It cites ${unaddressed.title ?? 'a document'} with no public address, which is kept while this is empty.`
              : 'The page that says they hold it. It is linked beside the office on their page.'
          }
        >
          <input id="h-source" name="source_url" type="url" defaultValue={start.source_url ?? ''} placeholder="https://" className="field" />
        </Field>
      </Section>
      <SaveBar save={save} label={editing ? 'Save changes' : 'Add the holding'} isEdit={!!editing} />
    </form>
  )
}

// Offices with whoever holds each on the day viewed, each linking to its page.
export function OfficeList({ offices }: { offices: Office[] }) {
  const { tracker } = useTracker()
  if (offices.length === 0) return <p className="text-sm">None yet.</p>
  const holdersOf = (office: Office) =>
    tracker.officeHolders
      .filter((h) => h.office_id === office.id && h.certainty !== 'possible' && inEffect(h, tracker.asOf))
      .flatMap((h) => tracker.deciderById.get(h.decider_id)?.name ?? [])
      .join(', ')
  return (
    <ul className="divide-y divide-line border-y border-line">
      {offices.map((o) => (
        <li key={o.id} className="flex items-start justify-between gap-3 py-2 text-sm">
          <span>
            <span className="font-medium">{o.label}</span>
            {o.chamber && <span className="text-muted"> · {o.chamber}</span>}
            <span className="block text-xs text-muted">{holdersOf(o) ? `Held by ${holdersOf(o)}` : 'Vacant'}</span>
          </span>
          <Link to="/offices/$officeId" params={{ officeId: o.id }} className="link shrink-0">
            Edit <span className="sr-only">{o.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
