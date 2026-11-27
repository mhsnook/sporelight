import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useSearch } from '@tanstack/react-router'
import type { Body, Question } from '../../shared/schema.ts'
import { useLiveQuery } from '@tanstack/react-db'
import { db } from './db.ts'
import { buildTracker, type Tracker } from './build-tracker.ts'

export { isHeld, type ActAcross, type Contender, type Listing, type PutTo, type RelatedQuestion, type HeldSeat, type KeyPerson, type RecordEntry, type SeatRow, type Tenure, type Tracker } from './build-tracker.ts'

export const today = () => new Date().toISOString().slice(0, 10)

const TrackerContext = createContext<{ tracker: Tracker; isReady: boolean } | null>(null)

// Every public collection is synced whole and joined here in memory, so every
// page reads from the same local copy and updates the moment a row changes.
// `asOf` is a day to view every body on; left out, it is today.
export function TrackerProvider({ asOf, children }: { asOf?: string; children: ReactNode }) {
  const bodies = useLiveQuery((q) => q.from({ row: db.bodies }))
  const deciders = useLiveQuery((q) => q.from({ row: db.deciders }))
  const seats = useLiveQuery((q) => q.from({ row: db.seats }))
  const roles = useLiveQuery((q) => q.from({ row: db.roles }))
  const questions = useLiveQuery((q) => q.from({ row: db.questions }))
  const questionBodies = useLiveQuery((q) => q.from({ row: db.question_bodies }))
  const questionDeciders = useLiveQuery((q) => q.from({ row: db.question_deciders }))
  const offices = useLiveQuery((q) => q.from({ row: db.offices }))
  const officeHolders = useLiveQuery((q) => q.from({ row: db.office_holders }))
  const questionOffices = useLiveQuery((q) => q.from({ row: db.question_offices }))
  const questionRelations = useLiveQuery((q) => q.from({ row: db.question_relations }))
  const setPositions = useLiveQuery((q) => q.from({ row: db.set_positions }))
  const sources = useLiveQuery((q) => q.from({ row: db.sources }))
  const acts = useLiveQuery((q) => q.from({ row: db.acts }))
  const reports = useLiveQuery((q) => q.from({ row: db.reports }))
  const reviews = useLiveQuery((q) => q.from({ row: db.reviews }))
  const sameActs = useLiveQuery((q) => q.from({ row: db.same_acts }))
  const people = useLiveQuery((q) => q.from({ row: db.people }).select(({ row }) => ({ id: row.id, role: row.role, kind: row.kind })))
  // Keyed on everyone's tier, so a new display name or a deactivation does not rebuild the tracker.
  const tierKey = people.data.map((p) => `${p.id}:${p.role}:${p.kind}`).sort().join(' ')
  const reviewers = useMemo(() => people.data, [tierKey])

  const day = asOf ?? today()
  const tracker = useMemo(
    () =>
      buildTracker({
        bodies: bodies.data,
        deciders: deciders.data,
        seats: seats.data,
        roles: roles.data,
        questions: questions.data,
        questionBodies: questionBodies.data,
        questionDeciders: questionDeciders.data,
        offices: offices.data,
        officeHolders: officeHolders.data,
        questionOffices: questionOffices.data,
        questionRelations: questionRelations.data,
        setPositions: setPositions.data,
        sources: sources.data,
        acts: acts.data,
        reports: reports.data,
        reviews: reviews.data,
        sameActs: sameActs.data,
        people: reviewers,
      }, day),
    [bodies.data, deciders.data, seats.data, roles.data, questions.data, questionBodies.data, questionDeciders.data, offices.data, officeHolders.data, questionOffices.data, questionRelations.data, setPositions.data, sources.data, acts.data, reports.data, reviews.data, sameActs.data, reviewers, day],
  )
  const isReady = [bodies, deciders, seats, roles, questions, questionBodies, questionDeciders, offices, officeHolders, questionOffices, questionRelations, setPositions, sources, acts, reports, reviews, sameActs, people].every((q) => q.isReady)

  return <TrackerContext value={{ tracker, isReady }}>{children}</TrackerContext>
}

export function useTracker() {
  const ctx = useContext(TrackerContext)
  if (!ctx) throw new Error('useTracker must be used inside TrackerProvider')
  return ctx
}

// The body a question is being looked at through: the one named in the URL if
// the question is put to it, else the one it is listed under. On a person's
// page only the bodies they have a seat in count.
export function useViewedBody(question: Question | undefined, deciderId?: string): { body: Body | undefined; choices: Body[] } {
  const { tracker } = useTracker()
  const search = useSearch({ strict: false }) as { body?: string }
  if (!question) return { body: undefined, choices: [] }
  const all = tracker.bodiesOf(question)
  const seated = deciderId ? all.filter((b) => tracker.seatById.get(tracker.roleIn(question, deciderId, b.id)?.seat_id ?? '')?.body_id === b.id) : all
  const choices = seated.length > 0 ? seated : all
  return { body: choices.find((b) => b.slug === search.body) ?? choices[0], choices }
}
