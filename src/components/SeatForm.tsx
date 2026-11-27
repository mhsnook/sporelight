import type { FormEvent } from 'react'
import type { Body, Seat } from '../../shared/schema.ts'
import { chambersIn } from '../lib/role-form.ts'
import { SEATS_AT_ONCE, SEAT_LIMITS, newSeats, readSeatForm, readSeatsForm, seatEdits, seatInputOf, seatInserts, seatProblems, seatsProblems } from '../lib/seat-form.ts'
import { useTracker } from '../lib/tracker.tsx'
import { Field, Problems, SaveBar, Section, useSave } from './form.tsx'

// A chamber is a name on each seat: one the body already has, or a new one typed in.
function ChamberField({ body, start }: { body: Body; start: string | null }) {
  const { tracker } = useTracker()
  const chambers = chambersIn(tracker.seats, body.id)
  return (
    <Field
      label="Chamber"
      id="s-chamber"
      optional
      hint={
        chambers.length
          ? `Choose ${chambers.join(' or ')}, or type a new one. Each chamber gets a seat chart of its own, and seats in none share one.`
          : 'Left empty, the body is drawn as one chart. Name a chamber to give it a chart of its own.'
      }
    >
      <input id="s-chamber" name="chamber" list="s-chambers" maxLength={SEAT_LIMITS.chamber} defaultValue={start ?? ''} autoComplete="off" className="field" />
      <datalist id="s-chambers">
        {chambers.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </Field>
  )
}

function VoteAndElection({ start }: { start: { is_voting: boolean; next_election_on: string | null } }) {
  return (
    <>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="is_voting" defaultChecked={start.is_voting} className="mt-0.5 size-4 accent-ink" />
        <span>
          <span className="font-bold">Votes.</span> Seat charts and the majority line count only seats that vote. A delegate with no vote is listed but not drawn.
        </span>
      </label>
      <Field label="Next election on" id="s-next-election-on" optional hint="Someone added as running for the seat starts from this day. Left empty, they start when the body's next term does.">
        <input id="s-next-election-on" name="next_election_on" type="date" defaultValue={start.next_election_on ?? ''} className="field max-w-56" />
      </Field>
    </>
  )
}

// Fields keep stable `name`s: `readSeatsForm` reads them from the FormData on submit.
export function SeatsForm({ body, onSaved }: { body: Body; onSaved: (made: Seat[]) => void }) {
  const save = useSave()

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = readSeatsForm(new FormData(e.currentTarget))
    if (!save.check(seatsProblems(input))) return
    const made = newSeats(input, body.id)
    save.save(seatInserts(made), () => onSaved(made))
  }

  return (
    <form onSubmit={onSubmit} onChange={save.edited} noValidate className="space-y-6" aria-label="The new seats">
      <Problems save={save} />
      <Section title="The seats">
        <Field label="Seats" id="s-lines" hint={`One seat per line. To give a seat a region, put it after a comma or a tab, as in “Ward 4, North”. Lines pasted from a spreadsheet work. Up to ${SEATS_AT_ONCE} at a time.`}>
          <textarea id="s-lines" name="lines" rows={10} placeholder={'Ward 1\nWard 2\nWard 3'} className="field font-mono" />
        </Field>
      </Section>
      <Section title="What they share" hint="Seats in another chamber, or with another election day, are added separately.">
        <ChamberField body={body} start={null} />
        <VoteAndElection start={{ is_voting: true, next_election_on: null }} />
      </Section>
      <SaveBar save={save} label="Add the seats" isEdit={false} />
    </form>
  )
}

// Fields keep stable `name`s: `readSeatForm` reads them from the FormData on submit.
export function SeatForm({ seat, body }: { seat: Seat; body: Body }) {
  const save = useSave()
  const start = seatInputOf(seat)

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = readSeatForm(new FormData(e.currentTarget))
    if (!save.check(seatProblems(input))) return
    save.save(seatEdits(seat, input))
  }

  return (
    <form onSubmit={onSubmit} onChange={save.edited} noValidate className="space-y-6" aria-label="Edit the seat">
      <Problems save={save} />
      <Section title="The seat">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label" id="s-label" hint="As it is shown on the seat and in lists.">
            <input id="s-label" name="label" required maxLength={SEAT_LIMITS.label} defaultValue={start.label} autoComplete="off" className="field" />
          </Field>
          <Field label="Region" id="s-region" optional hint="A state, district or ward that editors narrow by when choosing a seat.">
            <input id="s-region" name="region" maxLength={SEAT_LIMITS.region} defaultValue={start.region ?? ''} autoComplete="off" className="field" />
          </Field>
        </div>
        <ChamberField body={body} start={start.chamber} />
        <VoteAndElection start={start} />
      </Section>
      <SaveBar save={save} label="Save changes" isEdit />
    </form>
  )
}
