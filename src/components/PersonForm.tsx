import { useRef, useState, type FormEvent } from 'react'
import type { Decider } from '../../shared/schema.ts'
import { PERSON_LIMITS, newPerson, personEdits, personInputOf, personProblems, readPersonForm, type PersonInput } from '../lib/person-form.ts'
import { commit } from '../lib/review.ts'
import { useTracker } from '../lib/tracker.tsx'
import { Field, Problems, Section, notSaved, useMounted } from './form.tsx'

// Fields keep stable `name`s: `readPersonForm` reads them from the FormData on submit.
export function PersonForm({ editing, onSaved }: { editing?: Decider; onSaved?: (saved: Decider) => void }) {
  const { tracker } = useTracker()
  const [problems, setProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const top = useRef<HTMLDivElement>(null)
  const mounted = useMounted()

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = readPersonForm(new FormData(e.currentTarget))
    const found = personProblems(input)
    setProblems(found)
    setSaved(false)
    if (found.length) {
      top.current?.scrollIntoView({ block: 'start' })
      return
    }
    const made = editing ? undefined : newPerson(input, tracker.deciders)
    const writes = made ? [{ on: 'deciders' as const, type: 'insert' as const, row: made }] : personEdits(editing!, input)
    setSaving(true)
    commit(writes).then(
      () => {
        setSaving(false)
        setSaved(true)
        if (mounted.current) onSaved?.(made ?? editing!)
      },
      (err: unknown) => {
        setSaving(false)
        setProblems([notSaved(err)])
        top.current?.scrollIntoView({ block: 'start' })
      },
    )
  }

  return (
    <form onSubmit={onSubmit} onChange={() => setSaved(false)} noValidate className="space-y-6" aria-label={editing ? 'Edit the person' : 'The new person'}>
      <Problems problems={problems} top={top} />
      <Section title="The person">
        <PersonFields start={personInputOf(editing ?? null)} isNew={!editing} />
      </Section>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={saving}>
          {editing ? 'Save changes' : 'Add the person'}
        </button>
        {saved && editing && (
          <p role="status" className="text-sm font-semibold">
            Saved.
          </p>
        )}
      </div>
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
