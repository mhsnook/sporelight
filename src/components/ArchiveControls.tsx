import { useId, useRef, useState } from 'react'
import { isWebAddress, type ArchiveNow, type Source } from '../../shared/schema.ts'
import { db } from '../lib/db.ts'
import { useIsEditor } from '../lib/auth.ts'

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Anyone signed in can ask for a Wayback Machine capture of a source now. An
// editor can also give the address of a copy kept anywhere else.
export function ArchiveControls({ source }: { source: Pick<Source, 'id' | 'url' | 'archive_url'> }) {
  const editor = useIsEditor()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const show = (n: string | null, e: string | null = null) => {
    setNote(n)
    setError(e)
  }

  async function archiveNow() {
    setBusy(true)
    show(null)
    try {
      const res = await fetch('/api/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_id: source.id }) })
      const answer = (await res.json().catch(() => ({ error: `The Worker answered ${res.status}.`, status: res.status }))) as ArchiveNow
      if ('error' in answer) show(null, `Not archived: ${answer.error}`)
      else show(answer.outcome === 'archived' ? 'Archived.' : (answer.detail ?? answer.outcome))
    } catch (err) {
      show(null, `Not archived: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  function save() {
    const value = (input.current?.value ?? '').trim() || null
    if (value !== null && !isWebAddress(value)) return show(null, 'An archive address is a full http:// or https:// link.')
    show(null)
    db.sources.update(source.id, (s) => void (s.archive_url = value)).isPersisted.promise.then(
      () => show(value ? 'Saved.' : 'Removed.'),
      (err: unknown) => show(null, `Not saved: ${errorText(err)}`),
    )
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
      {source.url && !source.archive_url && (
        <button type="button" className="underline underline-offset-2" disabled={busy} onClick={archiveNow}>
          {busy ? 'Archiving…' : 'Archive now'}
        </button>
      )}
      {/* Not a form: this sits inside the editor's review form. */}
      {editor && (
      <details>
        <summary className="cursor-pointer">{source.archive_url ? 'Change archived copy' : 'Give an archived copy'}</summary>
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <label htmlFor={id}>Archived copy</label>
          <input
            ref={input}
            id={id}
            inputMode="url"
            defaultValue={source.archive_url ?? ''}
            key={source.archive_url ?? ''}
            placeholder="https://web.archive.org/web/…"
            className="field w-72 max-w-full py-1 text-xs"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              save()
            }}
          />
          <button type="button" className="underline underline-offset-2" onClick={save}>
            Save
          </button>
        </span>
      </details>
      )}
      {note && <span role="status">{note}</span>}
      {error && <span role="status" className="text-oppose">{error}</span>}
    </div>
  )
}
