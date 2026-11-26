import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useLocation } from '@tanstack/react-router'
import { setDisplayName, useSignedIn } from '../lib/auth.ts'
import { Modal } from './Modal.tsx'

// One dialog for the whole page that asks a signed-in person for the name others
// see. It opens by itself after a first sign-in, and a form that needs a name
// opens it with what to do once the name is saved.
type Asked = { then?: () => void; declined?: () => void }
let asked: Asked | null = null
const listeners = new Set<() => void>()
function setAsked(next: Asked | null) {
  asked = next
  for (const listener of listeners) listener()
}
export const askForName = (then?: () => void, declined?: () => void) => setAsked({ then, declined })
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener))

// "Not now" lasts for the browser session, per person.
const NOT_NOW = 'sporelight.name-not-now'
function saidNotNow(personId: string): boolean {
  try {
    return sessionStorage.getItem(NOT_NOW) === personId
  } catch {
    return false
  }
}
function rememberNotNow(personId: string) {
  try {
    sessionStorage.setItem(NOT_NOW, personId)
  } catch {
    // Without storage the dialog asks again on the next page load.
  }
}

export function NameDialog() {
  const current = useSyncExternalStore(subscribe, () => asked)
  const { person } = useSignedIn()
  // /setup asks for the name as one of its own steps.
  const settingUp = useLocation({ select: (l) => l.pathname === '/setup' })
  const unnamed = person !== undefined && person.display_name === null && person.kind === 'person'

  useEffect(() => {
    if (unnamed && !settingUp && !saidNotNow(person.id) && asked === null) askForName()
  }, [unnamed, settingUp, person?.id])

  // Also called when the dialog closes after a save, by which time nothing is asked.
  function notNow() {
    if (asked === null) return
    const { declined } = asked
    if (person) rememberNotNow(person.id)
    setAsked(null)
    declined?.()
  }

  return (
    <Modal
      open={current !== null}
      onClose={notNow}
      title="Pick a display name"
      description="It shows next to your comments, proposals and reviews, in place of your email address. You can change it on your profile."
    >
      {current && (
        <NameForm
          onSaved={() => {
            setAsked(null)
            current.then?.()
          }}
          onNotNow={notNow}
        />
      )}
    </Modal>
  )
}

function NameForm({ onSaved, onNotNow }: { onSaved: () => void; onNotNow: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const chosen = String(new FormData(e.currentTarget).get('display_name')).trim()
    if (!chosen) return setError('Choose the name others see you as.')
    setSaving(true)
    const failed = await setDisplayName(chosen)
    setSaving(false)
    if (failed) return setError(failed)
    onSaved()
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
      <div>
        <label className="label" htmlFor="pick-display-name">
          Display name
        </label>
        <input id="pick-display-name" name="display_name" required maxLength={60} autoComplete="nickname" className="field" />
      </div>
      {error && <p className="text-sm text-oppose">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onNotNow}>
          Not now
        </button>
      </div>
    </form>
  )
}
