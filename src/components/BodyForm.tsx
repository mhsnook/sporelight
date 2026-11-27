import type { FormEvent } from 'react'
import type { Body } from '../../shared/schema.ts'
import { BODY_LIMITS, bodyEdits, bodyInputOf, bodyProblems, newBody, nextBodySort, readBodyForm } from '../lib/body-form.ts'
import { useTracker } from '../lib/tracker.tsx'
import { Field, Problems, SaveBar, Section, useSave } from './form.tsx'

// Fields keep stable `name`s: `readBodyForm` reads them from the FormData on submit.
export function BodyForm({ editing, onSaved }: { editing?: Body; onSaved?: (saved: Body) => void }) {
  const { tracker } = useTracker()
  const save = useSave()
  const start = bodyInputOf(editing ?? null)

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = readBodyForm(new FormData(e.currentTarget))
    if (!save.check(bodyProblems(input))) return
    const made = editing ? undefined : newBody(input, tracker.bodies)
    const writes = made ? [{ on: 'bodies' as const, type: 'insert' as const, row: made }] : bodyEdits(editing!, input)
    save.save(writes, () => onSaved?.(made ?? editing!))
  }

  return (
    <form onSubmit={onSubmit} onChange={save.edited} noValidate className="space-y-6" aria-label={editing ? 'Edit the body' : 'The new body'}>
      <Problems save={save} />
      <Section title="The body">
        <Field label="Name" id="b-name" hint={editing ? 'Its page address stays as it is.' : 'Its page address is made from it.'}>
          <input id="b-name" name="name" required maxLength={BODY_LIMITS.name} defaultValue={start.name} placeholder="Lakeview City Council" autoComplete="off" className="field" />
        </Field>
        <Field label="Jurisdiction" id="b-jurisdiction" optional hint="The place it governs.">
          <input id="b-jurisdiction" name="jurisdiction" maxLength={BODY_LIMITS.jurisdiction} defaultValue={start.jurisdiction ?? ''} autoComplete="off" className="field" />
        </Field>
        <Field label="Description" id="b-description" optional hint="Shown under its name on the questions page.">
          <textarea id="b-description" name="description" rows={3} maxLength={BODY_LIMITS.description} defaultValue={start.description ?? ''} className="field" />
        </Field>
        <Field label="Order in the list" id="b-sort" optional hint={editing ? 'Bodies are listed from the lowest number. Demo bodies come last.' : `Bodies are listed from the lowest number. Left empty, it is ${nextBodySort(tracker.bodies)}, after the others.`}>
          <input id="b-sort" name="sort" type="number" step={1} inputMode="numeric" defaultValue={start.sort ?? ''} className="field max-w-40" />
        </Field>
      </Section>
      <Section title="The next term" hint="The day the body next changes over. A question's page can then show the body as it is expected to stand from that day, and someone running for a seat with no election day of its own starts then.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts on" id="b-next-term-on" optional>
            <input id="b-next-term-on" name="next_term_on" type="date" defaultValue={start.next_term_on ?? ''} className="field" />
          </Field>
          <Field label="Called" id="b-next-term-label" optional hint="Such as “120th Congress”. Left empty, it is “Next term”.">
            <input id="b-next-term-label" name="next_term_label" maxLength={BODY_LIMITS.next_term_label} defaultValue={start.next_term_label ?? ''} autoComplete="off" className="field" />
          </Field>
        </div>
      </Section>
      <SaveBar save={save} label={editing ? 'Save changes' : 'Add the body'} isEdit={!!editing} />
    </form>
  )
}
