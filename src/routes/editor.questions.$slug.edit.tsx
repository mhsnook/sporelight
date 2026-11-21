import { Link, createFileRoute } from '@tanstack/react-router'
import type { Question } from '../../shared/schema.ts'
import { nounOf } from '../lib/question-form.ts'
import { useTracker } from '../lib/tracker.tsx'
import { NotFound, Syncing } from '../components/bits.tsx'
import { CloseQuestion, ClosedNote } from '../components/Asks.tsx'
import { QuestionForm } from '../components/QuestionForm.tsx'

export const Route = createFileRoute('/editor/questions/$slug/edit')({ component: EditQuestion })

const LINK_LABEL = { smaller_step: 'Smaller step', fuller_proposal: 'Fuller proposal', related: 'Related issue' } as const

function EditQuestion() {
  const { slug } = Route.useParams()
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />
  const question = tracker.questionBySlug.get(slug)
  if (!question) return <NotFound what="question" />

  const parent = question.parent_id ? tracker.questionById.get(question.parent_id) : undefined
  const noun = nounOf(question, tracker.isAsk(question))
  const links = {
    bodies: tracker.questionBodies.filter((l) => l.question_id === question.id),
    deciders: tracker.questionDeciders.filter((l) => l.question_id === question.id),
    offices: tracker.questionOffices.filter((l) => l.question_id === question.id),
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        {parent && (
          <Link to="/editor/questions/$slug/edit" params={{ slug: parent.slug }} className="link text-sm">
            ← {parent.title}
          </Link>
        )}
        <h1 className="h-page">Edit this {noun}</h1>
        <p>
          <Link to="/q/$slug" params={{ slug: question.slug }} className="link">
            {question.title}
          </Link>
        </p>
      </div>

      <QuestionForm key={question.id} editing={{ question, links }} />

      <section aria-labelledby="closing" className="card space-y-3 p-4 sm:p-6">
        <h2 id="closing" className="text-lg font-extrabold">
          Closing
        </h2>
        {question.status === 'open' && <p className="text-sm text-muted">Open.</p>}
        <ClosedNote question={question} />
        <CloseQuestion question={question} />
      </section>

      {!parent && <SubQuestions question={question} />}
      {!parent && <Linked question={question} />}
    </div>
  )
}

function SubQuestions({ question }: { question: Question }) {
  const { tracker } = useTracker()
  const subs = tracker.subQuestionsOf(question.id)
  return (
    <section aria-labelledby="sub-questions" className="card space-y-3 p-4 sm:p-6">
      <div>
        <h2 id="sub-questions" className="text-lg font-extrabold">
          Measures and asks
        </h2>
        <p className="text-sm text-muted">A measure is put to everyone in the body or chamber. An ask is put to named people or to whoever holds an office.</p>
      </div>
      {subs.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {subs.map((q) => (
            <li key={q.id} className="flex items-start justify-between gap-3 py-2 text-sm">
              <span>
                <span className="tag mr-2">{tracker.isAsk(q) ? 'Ask' : 'Measure'}</span>
                {q.short_title}
                {!tracker.isOpen(q) && <span className="text-faint"> · closed</span>}
              </span>
              <Link to="/editor/questions/$slug/edit" params={{ slug: q.slug }} className="link shrink-0">
                Edit <span className="sr-only">{q.short_title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Link to="/editor/questions/new" search={{ parent: question.slug, sub: 'measure' }} className="btn btn-sm">
          Add a measure
        </Link>
        <Link to="/editor/questions/new" search={{ parent: question.slug, sub: 'ask' }} className="btn btn-sm">
          Add an ask
        </Link>
      </div>
    </section>
  )
}

function Linked({ question }: { question: Question }) {
  const { tracker } = useTracker()
  const linked = tracker.relatedTo(question)
  return (
    <section aria-labelledby="linked-questions" className="card space-y-3 p-4 sm:p-6">
      <div>
        <h2 id="linked-questions" className="text-lg font-extrabold">
          Smaller steps and related questions
        </h2>
        <p className="text-sm text-muted">Each is a question of its own, with its own page, linked to this one.</p>
      </div>
      {linked.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {linked.map(({ question: q, kind }) => (
            <li key={`${kind} ${q.id}`} className="flex items-start justify-between gap-3 py-2 text-sm">
              <span>
                <span className="tag mr-2">{LINK_LABEL[kind]}</span>
                {q.short_title}
              </span>
              <Link to="/editor/questions/$slug/edit" params={{ slug: q.slug }} className="link shrink-0">
                Edit <span className="sr-only">{q.short_title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/editor/questions/new" search={{ linkTo: question.slug }} className="btn btn-sm">
        Add a smaller step or related question
      </Link>
    </section>
  )
}
