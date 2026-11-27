import { useState, type FormEvent } from 'react'
import type { Decider } from '../../shared/schema.ts'
import { PERSON_LIMITS, newPerson, personEdits, personInputOf, personProblems, readPersonForm, type PersonInput } from '../lib/person-form.ts'
import { useTracker } from '../lib/tracker.tsx'
import { Choice, Field, Problems, SaveBar, Section, useSave } from './form.tsx'

// Fields keep stable `name`s: `readPersonForm` reads them from the FormData on submit.
export function PersonForm({ editing, onSaved }: { editing?: Decider; onSaved?: (saved: Decider) => void }) {
  const { tracker } = useTracker()
  const save = useSave()

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = readPersonForm(new FormData(e.currentTarget))
    if (!save.check(personProblems(input))) return
    const made = editing ? undefined : newPerson(input, tracker.deciders)
    const writes = made ? [{ on: 'deciders' as const, type: 'insert' as const, row: made }] : personEdits(editing!, input)
    save.save(writes, () => onSaved?.(made ?? editing!))
  }

  return (
    <form onSubmit={onSubmit} onChange={save.edited} noValidate className="space-y-6" aria-label={editing ? 'Edit the person' : 'The new person'}>
      <Problems save={save} />
      <Section title="The person">
        <PersonFields start={personInputOf(editing ?? null)} isNew={!editing} />
      </Section>
      <SaveBar save={save} label={editing ? 'Save changes' : 'Add the person'} isEdit={!!editing} />
    </form>
  )
}

// Also used inside the role form, under the `new_` prefix, to add someone along with their role.
export function PersonFields({ start, isNew, prefix = '' }: { start: PersonInput; isNew: boolean; prefix?: string }) {
  const id = (name: string) => `p-${prefix}${name}`
  return (
    <>
      <Field label="Name" id={id('name')} hint={isNew ? 'As it is shown on the site. Their page address is made from it.' : 'As it is shown on the site. Their page address stays as it is.'}>
        <input id={id('name')} name={`${prefix}name`} required maxLength={PERSON_LIMITS.name} defaultValue={start.name} autoComplete="off" className="field" />
      </Field>
      <Field label="Sort name" id={id('sort_name')} optional hint="What lists sort them by. Left empty, it is the last word of the name first, as in “Delgado, Rosa”.">
        <input id={id('sort_name')} name={`${prefix}sort_name`} maxLength={PERSON_LIMITS.sort_name} defaultValue={start.sort_name ?? ''} autoComplete="off" className="field" />
      </Field>
      <Field label="Link" id={id('url')} optional hint="Their official site or campaign site.">
        <input id={id('url')} name={`${prefix}url`} type="url" defaultValue={start.url ?? ''} placeholder="https://" className="field" />
      </Field>
    </>
  )
}

// Who a new role or office holding is for: someone on file, picked by name, or someone added with it.
// `readRoleHolder` reads its fields from the FormData on submit.
export function PersonPicker({ choices }: { choices: readonly { text: string; decider: Decider }[] }) {
  const [holder, setHolder] = useState<'existing' | 'new'>('existing')
  return (
    <Section title="Who">
      <fieldset>
        <legend className="sr-only">Someone on file, or someone new</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
          <Choice name="holder" value="existing" checked={holder === 'existing'} onChange={() => setHolder('existing')}>
            Someone on file
          </Choice>
          <Choice name="holder" value="new" checked={holder === 'new'} onChange={() => setHolder('new')}>
            Someone new
          </Choice>
        </div>
      </fieldset>
      {holder === 'existing' ? (
        <Field label="Name" id="r-person" hint="Start typing and choose from the list.">
          <input id="r-person" name="person" list="r-people" autoComplete="off" className="field" />
          <datalist id="r-people">
            {choices.map((c) => (
              <option key={c.decider.id} value={c.text} />
            ))}
          </datalist>
        </Field>
      ) : (
        <PersonFields start={personInputOf(null)} isNew prefix="new_" />
      )}
    </Section>
  )
}
