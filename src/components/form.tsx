import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

// The pieces the editor forms share: sections, labelled fields, radio choices and the list of what stops a save.

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
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

export const notSaved = (err: unknown) => `Not saved: ${err instanceof Error ? err.message : String(err)}`

export function Problems({ problems, top }: { problems: string[]; top: RefObject<HTMLDivElement | null> }) {
  return (
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
  )
}

// The write is confirmed by the server, which can be after the editor has gone to another page.
export function useMounted() {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}
