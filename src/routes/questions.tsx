import { Link, createFileRoute } from '@tanstack/react-router'
import { isEditor } from '../lib/editor.ts'
import { useTracker } from '../lib/tracker.tsx'
import { Syncing } from '../components/bits.tsx'
import { QuestionCard } from '../components/QuestionCard.tsx'

export const Route = createFileRoute('/questions')({ component: Questions })

function Questions() {
  const { tracker, isReady } = useTracker()
  if (!isReady) return <Syncing />
  const bodies = tracker.bodiesInOrder

  return (
    <div className="space-y-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h-page">Questions</h1>
        {isEditor() && (
          <Link to="/editor/questions/new" className="btn">
            Add a question
          </Link>
        )}
      </div>
      {bodies.map((body) => {
        const questions = tracker.questionsIn(body.id)
        return (
          <section key={body.id}>
            <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-2xl font-extrabold">{body.name}</h2>
              {body.is_demo && <span className="tag-pill">Demo data, not real</span>}
              <p className="w-full text-muted">{body.description}</p>
            </div>
            <ul className="grid gap-6 md:grid-cols-2">
              {questions.map((question) => (
                <li key={question.id}>
                  <QuestionCard question={question} body={body} />
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
