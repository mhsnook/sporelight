import { useMemo, useState, type FormEvent } from 'react'
import { CONTESTS, type Certainty, type Decider, type Role, type Seat } from '../../shared/schema.ts'
import { newPerson } from '../lib/person-form.ts'
import {
  ROLE_LIMITS,
  chambersIn,
  holderNames,
  holderProblems,
  newRole,
  personChoices,
  readRoleForm,
  readRoleHolder,
  regionsIn,
  roleEdits,
  roleInserts,
  roleProblems,
  seatsIn,
  type Contest,
  type RoleInput,
} from '../lib/role-form.ts'
import { useTracker } from '../lib/tracker.tsx'
import { Choice, Field, Problems, SaveBar, Section, useSave } from './form.tsx'
import { PersonPicker } from './PersonForm.tsx'

const CERTAINTY_CHOICE: Record<Certainty, string> = {
  certain: 'Certain: holds the seat, or is sure to from the start date',
  likely: 'Likely: expected to hold it, not yet settled',
  possible: 'Possible: one of those who may yet hold it, such as a candidate',
}

// A body with more seats than this is narrowed to a chamber and a region before its seats are listed.
const SEATS_LISTED_AT_ONCE = 60

const CONTEST_CHOICE: Record<Contest, string> = { primary: 'A primary', general: 'A general election', runoff: 'A runoff', recount: 'A recount' }

export type RoleFormProps = {
  // Set when the seat is already known: the role being edited, or the seat the editor came from.
  seat?: Seat
  // Set when the person is already known.
  person?: Decider
  start: RoleInput
  editing?: Role
  // Shown under the start date, such as where a challenger's default start came from.
  startHint?: string
  onSaved?: (role: Role, person: Decider) => void
}

// Fields keep stable `name`s: `readRoleForm` and `readRoleHolder` read them from the FormData on submit.
export function RoleForm({ seat, person, start, editing, startHint, onSaved }: RoleFormProps) {
  const { tracker } = useTracker()
  const firstBody = seat?.body_id ?? tracker.bodiesInOrder[0]?.id ?? ''
  const [bodyId, setBodyId] = useState(firstBody)
  const [chamber, setChamber] = useState<string | null>(seat?.chamber ?? null)
  const [region, setRegion] = useState<string | null>(seat?.region ?? null)
  const [seatId, setSeatId] = useState(seat?.id ?? '')
  const [certainty, setCertainty] = useState(start.certainty)
  const save = useSave()

  const choices = useMemo(() => personChoices(tracker.deciders), [tracker.deciders])
  const chambers = chambersIn(tracker.seats, bodyId)
  const regions = regionsIn(tracker.seats, bodyId, chamber)
  const mustNarrow = tracker.seats.filter((s) => s.body_id === bodyId).length > SEATS_LISTED_AT_ONCE
  const narrowed = !mustNarrow || ((chamber !== null || chambers.length === 0) && (region !== null || regions.length === 0))
  const seatChoices = narrowed ? seatsIn(tracker.seats, { body_id: bodyId, chamber, region }) : []
  const chosenSeat = seat ?? tracker.seatById.get(seatId)
  const affiliations = [...new Set(tracker.roles.filter((r) => r.affiliation && tracker.seatById.get(r.seat_id)?.body_id === (chosenSeat?.body_id ?? bodyId)).map((r) => r.affiliation!))].sort()

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const input = readRoleForm(f)
    const who = person ? ({ kind: 'existing', decider: person } as const) : readRoleHolder(f, choices)
    const found = [...(chosenSeat ? [] : ['Choose the seat.']), ...holderProblems(who), ...roleProblems(input, !editing)]
    // The last two are already among the problems found; they are repeated to narrow the types.
    if (!save.check(found) || !chosenSeat || who.kind === 'unknown') return
    const decider = who.kind === 'new' ? newPerson(who.person, tracker.deciders) : who.decider
    const added = who.kind === 'new' ? decider : undefined
    const role = editing ?? newRole(input, chosenSeat.id, decider.id)
    const writes = editing ? roleEdits(editing, input) : roleInserts(role, added)
    save.save(writes, () => onSaved?.({ ...role, ...input }, decider))
  }

  const pickBody = (id: string) => {
    setBodyId(id)
    setChamber(null)
    setRegion(null)
    setSeatId('')
  }

  return (
    <form onSubmit={onSubmit} onChange={save.edited} noValidate className="space-y-6" aria-label={editing ? 'Edit the role' : 'The new role'}>
      <Problems save={save} />

      {!person && <PersonPicker choices={choices} />}

      <Section title="The seat">
        {seat ? (
          <p className="text-sm">
            <span className="font-bold">{seat.label}</span>
            {seat.chamber && `, ${seat.chamber}`} · {tracker.bodyById.get(seat.body_id)?.name}
            {holderNames(seat, tracker) && <span className="text-muted"> · held by {holderNames(seat, tracker)}</span>}
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Body" id="r-body">
                <select id="r-body" name="seat_body" className="field" value={bodyId} onChange={(e) => pickBody(e.target.value)}>
                  {tracker.bodiesInOrder.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                      {b.is_demo ? ' (demo)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              {chambers.length > 0 && (
                <Field label="Chamber" id="r-chamber">
                  <select id="r-chamber" name="seat_chamber" className="field" value={chamber ?? ''} onChange={(e) => (setChamber(e.target.value || null), setRegion(null), setSeatId(''))}>
                    <option value="">Choose a chamber</option>
                    {chambers.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {regions.length > 0 && (
                <Field label="Region" id="r-region">
                  <select id="r-region" name="seat_region" className="field" value={region ?? ''} onChange={(e) => (setRegion(e.target.value || null), setSeatId(''))}>
                    <option value="">{mustNarrow ? 'Choose a region' : 'Any region'}</option>
                    {regions.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <Field label="Seat" id="r-seat" hint={narrowed ? undefined : 'Choose a chamber and a region to list their seats.'}>
              <select id="r-seat" name="seat_id" className="field" value={seatId} disabled={!narrowed} onChange={(e) => setSeatId(e.target.value)}>
                <option value="">Choose a seat</option>
                {seatChoices.map((s) => {
                  const held = holderNames(s, tracker)
                  return (
                    <option key={s.id} value={s.id}>
                      {s.label}
                      {held ? ` · ${held}` : ' · vacant'}
                    </option>
                  )
                })}
              </select>
            </Field>
          </>
        )}
      </Section>

      <Section title="The claim" hint="A seat's holder today, a member-elect and someone running for it are all claims, told apart by how sure they are, what they depend on, and their dates.">
        <fieldset>
          <legend className="label">How sure</legend>
          <div className="space-y-1.5 text-sm">
            {(['certain', 'likely', 'possible'] as const).map((c) => (
              <Choice key={c} name="certainty" value={c} defaultChecked={start.certainty === c} onChange={() => setCertainty(c)}>
                {CERTAINTY_CHOICE[c]}
              </Choice>
            ))}
          </div>
        </fieldset>
        <Field label="What it still depends on" id="r-contest" hint={certainty === 'certain' ? 'A certain claim depends on nothing.' : undefined}>
          <select id="r-contest" name="contest" defaultValue={start.contest ?? ''} className="field">
            <option value="">Nothing named</option>
            {CONTESTS.map((c) => (
              <option key={c} value={c}>
                {CONTEST_CHOICE[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Affiliation" id="r-affiliation" optional hint="A party or grouping, as it is shown beside their name.">
          <input id="r-affiliation" name="affiliation" list="r-affiliations" maxLength={ROLE_LIMITS.affiliation} defaultValue={start.affiliation ?? ''} autoComplete="off" className="field" />
          <datalist id="r-affiliations">
            {affiliations.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts on" id="r-starts-on" optional hint={startHint ?? 'Leave empty if it started before we kept track.'}>
            <input id="r-starts-on" name="starts_on" type="date" defaultValue={start.starts_on ?? ''} className="field" />
          </Field>
          <Field label="Ends on" id="r-ends-on" optional hint="Leave empty if no end is known. The claim no longer holds from this day.">
            <input id="r-ends-on" name="ends_on" type="date" defaultValue={start.ends_on ?? ''} className="field" />
          </Field>
        </div>
      </Section>

      <SaveBar save={save} label={editing ? 'Save changes' : 'Add the role'} isEdit={!!editing} />
    </form>
  )
}
