import { useEffect, useRef, useState, type ReactNode } from 'react'
import { commit } from '../lib/review.ts'
import type { Write } from '../lib/review-plan.ts'

// The pieces the editor forms share: sections, labelled fields, radio choices and the list of what stops a save.

export function Section({ title, hint, id, children }: { title: string; hint?: string; id?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="card space-y-4 p-4 sm:p-6">
      <div>
        <h2 id={id} className="text-lg font-extrabold">
          {title}
        </h2>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

export function Field({ label, id, optional, hint, children }: { label: string; id: string; optional?: boolean; hint?: string; children: ReactNode }) {
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

export function Choice({
  name,
  value,
  defaultChecked,
  checked,
  onChange,
  children,
}: {
  name: string
  value: string
  defaultChecked?: boolean
  checked?: boolean
  onChange?: () => void
  children: ReactNode
}) {
  return (
    <label className="flex min-h-8 cursor-pointer items-start gap-2">
      <input type="radio" name={name} value={value} defaultChecked={defaultChecked} checked={checked} onChange={onChange} className="mt-0.5 size-4 shrink-0 accent-ink" />
      <span>{children}</span>
    </label>
  )
}

// The save cycle the editor forms share: check, show what stops the save, commit in one transaction, say it saved.
export function useSave() {
  const [problems, setProblems] = useState<string[]>([])
  const [failed, setFailed] = useState(false)
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
  const toTop = () => top.current?.scrollIntoView({ block: 'start' })

  // Shows the problems found, if any. Saving goes ahead only when this returns true.
  function check(found: string[]): boolean {
    setProblems(found)
    setFailed(false)
    setSaved(false)
    if (found.length) toTop()
    return found.length === 0
  }

  function save(writes: Write[], onSaved?: () => void) {
    setSaving(true)
    commit(writes).then(
      () => {
        setSaving(false)
        setSaved(true)
        if (mounted.current) onSaved?.()
      },
      (err: unknown) => {
        setSaving(false)
        setFailed(true)
        setProblems([notSaved(err)])
        toTop()
      },
    )
  }

  return { problems, failed, saving, saved, top, check, save, edited: () => setSaved(false) }
}

export type Save = ReturnType<typeof useSave>

export const notSaved = (err: unknown) => `Not saved: ${err instanceof Error ? err.message : String(err)}`

export function Problems({ save }: { save: Save }) {
  return (
    <div ref={save.top} className="scroll-mt-4">
      {save.problems.length > 0 && (
        <div role="alert" className="rounded-xl border-2 border-oppose bg-surface p-4 text-sm">
          <p className="font-bold">{save.failed ? 'This was not saved.' : 'Some fields need changing before this can be saved.'}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {save.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// "Saved." shows only on an edit; a new record's form is left for the page it made.
export function SaveBar({ save, label, isEdit }: { save: Save; label: string; isEdit: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button className="btn btn-primary" disabled={save.saving}>
        {label}
      </button>
      {save.saved && isEdit && (
        <p role="status" className="text-sm font-semibold">
          Saved.
        </p>
      )}
    </div>
  )
}
