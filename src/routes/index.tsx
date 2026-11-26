import { Link, createFileRoute } from '@tanstack/react-router'
import { useTracker } from '../lib/tracker.tsx'
import { hemicycleLayout } from '../lib/hemicycle.ts'
import { SPECTRUM, STANDING_BG, standingLabel, type Standing } from '../lib/position.ts'
import { SeatToken, Star, Syncing, Token } from '../components/bits.tsx'
import { QuestionCard } from '../components/QuestionCard.tsx'

export const Route = createFileRoute('/')({ component: Home })

const EXAMPLE: Record<Standing, number> = { support: 15, lean_support: 4, mixed: 3, unknown: 6, lean_oppose: 4, oppose: 8 }
const label = (standing: Standing) => standingLabel(standing, { kind: 'position', act_label: null })
const EXAMPLE_SEATS = SPECTRUM.flatMap((s) => Array.from({ length: EXAMPLE[s] }, () => s))
const EXAMPLE_KEY_FIGURES = new Set([2, 17, 36])
const EXAMPLE_MAJORITY = Math.floor(EXAMPLE_SEATS.length / 2) + 1
const EXAMPLE_LAYOUT = hemicycleLayout(EXAMPLE_SEATS.length)
const EXAMPLE_YES = EXAMPLE.support + EXAMPLE.lean_support
const EXAMPLE_TIMELINE = [
  [2, 1],
  [4, 2],
  [5, 4],
  [7, 5],
  [9, 6],
  [11, 8],
  [13, 9],
  [15, 10],
  [17, 11],
  [19, 12],
]

function Home() {
  return (
    <div>
      <section className="pt-0 sm:pt-6 sm:text-center">
        <h1 className="mx-auto max-w-[960px] text-[40px] leading-[1.04] font-black tracking-[-0.025em] sm:text-[clamp(40px,6vw,68px)]">
          Keeping track of <span className="rounded-xl bg-mixed px-2 whitespace-nowrap sm:px-3">key decisions</span>, and who makes them.
        </h1>
        <p className="mx-auto mt-5 max-w-[700px] text-[17px] leading-[1.55] text-pretty text-muted sm:mt-6 sm:text-xl">
          People who decide things take public positions. They speak, sign and vote. We collect reports of these acts from the news and from readers, check
          each one, and keep the record.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:mt-7 sm:flex-row sm:justify-center">
          <Link to="/questions" className="btn btn-lg btn-primary">
            Browse the questions
          </Link>
          <a href="#own" className="btn btn-lg">
            Run your own
          </a>
        </div>
      </section>

      <ExampleChart />
      <HowItWorks />
      <OpenQuestions />
      <RunYourOwn />
    </div>
  )
}

function ExampleChart() {
  const layout = EXAMPLE_LAYOUT
  const r = layout.dotRadius * 90
  const edge = 100 + r * 2
  const most = Math.max(...Object.values(EXAMPLE))

  return (
    <section className="card card-lg mt-9 px-4 py-[18px] sm:mt-10 sm:px-8 sm:py-7 sm:shadow-hard-lg">
      <p className="tag flex flex-wrap justify-between gap-2 sm:text-[13px]">
        <span>Harbor City Assembly · {EXAMPLE_SEATS.length} seats</span>
        <span className="text-faint">Example</span>
      </p>
      <h2 className="mt-2 mb-2 text-xl leading-tight font-extrabold sm:text-[28px]">Should the harbour ferry be free to ride?</h2>

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,552px)_1fr] lg:items-center lg:gap-x-10 lg:gap-y-5">
        <svg
          viewBox={`${-edge} ${-edge} ${edge * 2} ${edge + r * 1.5}`}
          role="img"
          aria-label={`Example seat chart. ${SPECTRUM.map((s) => `${label(s)}: ${EXAMPLE[s]}`).join(', ')}.`}
          className="mx-auto block w-full max-w-[552px]"
        >
          {layout.dots.map((dot, i) => {
            const standing = EXAMPLE_SEATS[i]
            const [cx, cy] = [dot.x * 100, dot.y * 100]
            const isKey = EXAMPLE_KEY_FIGURES.has(i)
            return (
              <g key={i} stroke="var(--color-ink)">
                <SeatToken cx={cx} cy={cy} r={r} standing={standing} stroke={isKey ? 0.17 : 0.12} />
                {isKey && (
                  <>
                    <circle cx={cx + r * 0.85} cy={cy - r * 0.85} r={r * 0.56} fill="var(--color-mixed)" strokeWidth={r * 0.11} />
                    <text x={cx + r * 0.85} y={cy - r * 0.85} fontSize={r * 0.62} textAnchor="middle" dominantBaseline="central" stroke="none" fill="var(--color-ink)">
                      ★
                    </text>
                  </>
                )}
              </g>
            )
          })}
        </svg>

        <dl className="order-3 flex flex-col gap-2 border-t-2 border-ink pt-3.5 text-sm font-semibold sm:text-base lg:order-2 lg:border-t-0 lg:pt-0">
          {SPECTRUM.map((s) => (
            <div key={s} className="grid grid-cols-[18px_7.25rem_1fr_1.5rem] items-center gap-2.5">
              <Token standing={s} className="size-[18px]" />
              <dt>{label(s)}</dt>
              <span
                className={`h-2.5 rounded-full ${s === 'unknown' ? 'border-2 border-dashed border-line' : STANDING_BG[s]}`}
                style={{ width: `${(EXAMPLE[s] / most) * 100}%` }}
              />
              <dd className="text-right tabular-nums">{EXAMPLE[s]}</dd>
            </div>
          ))}
          <div className="mt-0.5 flex items-center gap-2.5 lg:border-t-2 lg:border-ink lg:pt-2.5">
            <Star />
            Key figure
          </div>
        </dl>

        <div className="order-2 grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 sm:grid-cols-[3rem_minmax(0,1fr)_5.75rem] sm:gap-x-4 sm:gap-y-2.5 lg:order-3 lg:col-span-2 lg:border-t-2 lg:border-ink lg:pt-[18px]">
          <span />
          <p className="tag text-right text-[10px] sm:text-[13px]">{EXAMPLE_MAJORITY} for a majority ▾</p>
          <span />
          <Track solid="support" light="lean_support" />
          <Track solid="oppose" light="lean_oppose" />
        </div>
      </div>
    </section>
  )
}

function Track({ solid, light }: { solid: Standing; light: Standing }) {
  return (
    <>
      <span className="font-display text-sm font-black sm:text-[17px]">{label(solid)}</span>
      <div className="grid gap-0.5 sm:gap-1" style={{ gridTemplateColumns: `repeat(${EXAMPLE_MAJORITY}, 1fr)` }} aria-hidden="true">
        {Array.from({ length: EXAMPLE_MAJORITY }, (_, i) => (
          <span
            key={i}
            className={`h-[18px] rounded-[3px] border-[1.5px] border-ink sm:h-6 sm:rounded-[5px] sm:border-2 ${i < EXAMPLE[solid] ? STANDING_BG[solid] : i < EXAMPLE[solid] + EXAMPLE[light] ? STANDING_BG[light] : 'bg-surface'}`}
          />
        ))}
      </div>
      <span className="text-base leading-none font-black tabular-nums sm:text-[22px]">
        {EXAMPLE[solid] + EXAMPLE[light]}
        <span className="text-[11px] font-semibold text-faint sm:text-[15px]"> / {EXAMPLE_SEATS.length}</span>
      </span>
    </>
  )
}

function Step({ n, numberClass, title, children }: { n: number; numberClass: string; title: string; children: string }) {
  return (
    <div className="flex items-start gap-3 sm:gap-3.5">
      <span className={`grid size-9 flex-none place-items-center rounded-full border-2 border-ink font-black shadow-hard-sm sm:size-10 sm:text-lg ${numberClass}`}>{n}</span>
      <div>
        <h3 className="h-card">{title}</h3>
        <p className="mt-1 text-[15px] leading-[1.55] text-muted sm:mt-1.5 sm:text-base">{children}</p>
      </div>
    </div>
  )
}

function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-6 pt-14 sm:pt-[88px]">
      <h2 className="h-section">How it works</h2>
      <p className="mt-2 max-w-[640px] leading-[1.55] text-muted sm:mt-2.5 sm:text-lg">What the news reader and signed-in readers find counts at once, marked as not checked. An editor reads the source and has the last word on what it shows.</p>

      <div className="mt-6 grid gap-x-10 gap-y-8 sm:mt-8 lg:grid-cols-3">
        <div className="flex flex-col gap-3.5 sm:gap-[18px]">
          <Step n={1} numberClass="bg-mixed" title="Find news reports">
            Once a day, a web search looks for reports of decision-makers taking a stance, and a model reads each report for what it records.
          </Step>
          <div className="flex-1 rounded-2xl border-2 border-dashed border-ink bg-surface p-4 sm:p-5">
            <p className="tag text-faint">Found by news search · 15 Nov</p>
            <p className="mt-2 mb-1.5 font-display text-[17px] font-extrabold sm:text-[19px]">Priya Nair</p>
            <p className="text-[15px] leading-normal text-muted">“…we have the votes to try this for two years and I intend to…”</p>
            <p className="mt-2 text-[13px] underline">Tideline Radio ↗</p>
          </div>
        </div>

        <div className="flex flex-col gap-3.5 sm:gap-[18px]">
          <Step n={2} numberClass="bg-lean-support" title="Catalog intent">
            We read each report at its source, find out what the person really said or did, and mark it as support or opposition.
          </Step>
          <div className="card flex-1 p-4 sm:p-5">
            <p className="tag text-faint">Checked at the source</p>
            <p className="mt-2 mb-3 text-[15px] leading-normal">“We have the votes to try this for two years and I intend to use them.”</p>
            <p className="flex flex-wrap gap-1.5 text-[13px] font-bold">
              {(['support', 'lean_support', 'mixed', 'oppose'] as const).map((s) => (
                <span key={s} className={`rounded-full border-2 border-ink px-2.5 py-1 ${s === 'support' ? 'bg-support text-white shadow-hard-sm' : ''}`}>
                  {label(s)}
                </span>
              ))}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3.5 sm:gap-[18px]">
          <Step n={3} numberClass="bg-support text-white" title="Track decision-making">
            Each question shows its support live, with a timeline of how it developed.
          </Step>
          <div className="card flex-1 bg-mint p-4 sm:p-5">
            <p className="flex items-center gap-3">
              <span className="relative flex flex-none">
                <Token standing="support" className="size-7 border-[3px] shadow-hard-sm" />
                <Star className="absolute -top-2.5 -right-2.5 size-[18px] text-[9px]" />
              </span>
              <span className="font-display font-extrabold sm:text-[17px]">
                Priya Nair: {label('support')}. Now {EXAMPLE_YES} of {EXAMPLE_SEATS.length}.
              </span>
            </p>
            <div className="relative mt-[18px] flex h-24 gap-[5px] border-t-2 border-dashed border-ink" aria-hidden="true">
              <span className="tag absolute -top-2.5 right-0 bg-mint px-1 text-[11px] font-bold">{EXAMPLE_MAJORITY}</span>
              {EXAMPLE_TIMELINE.map(([up, down], i) => (
                <div key={i} className="flex flex-1 flex-col">
                  <div className="flex h-12 items-end">
                    <span className="w-full rounded-t-[3px] bg-support" style={{ height: up * 2.2 }} />
                  </div>
                  <div className="h-0.5 bg-ink" />
                  <span className="w-full rounded-b-[3px] bg-oppose" style={{ height: down * 2.2 }} />
                </div>
              ))}
            </div>
            <p className="tag mt-1.5 flex justify-between text-[11px]">
              <span>Aug</span>
              <span>Nov</span>
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

function OpenQuestions() {
  const { tracker, isReady } = useTracker()
  const demo = new Set(tracker.bodies.filter((b) => b.is_demo).map((b) => b.id))
  const questions = tracker.questions
    .filter((q) => !q.parent_id)
    .sort((a, b) => Number(b.is_hot) - Number(a.is_hot) || Number(demo.has(a.body_id)) - Number(demo.has(b.body_id)) || a.sort - b.sort)

  return (
    <section className="pt-14 sm:pt-[88px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
        <h2 className="h-section">Open questions</h2>
        {isReady && (
          <Link to="/questions" className="link text-[15px] font-semibold">
            Browse all {questions.length}
          </Link>
        )}
      </div>
      {isReady ? (
        <ul className="mt-5 grid gap-[18px] sm:mt-6 sm:gap-6 md:grid-cols-2">
          {questions.slice(0, 2).map((question) => (
            <li key={question.id}>
              <QuestionCard question={question} />
            </li>
          ))}
        </ul>
      ) : (
        <Syncing />
      )}
    </section>
  )
}

function RunYourOwn() {
  return (
    <section id="own" className="card card-lg mt-14 grid scroll-mt-6 overflow-hidden bg-mint sm:mt-[88px] md:grid-cols-2">
      <div className="px-5 py-[22px] sm:px-9 sm:py-8">
        <p className="tag sm:text-[13px]">// For classrooms and research</p>
        <h2 className="mt-2 mb-2.5 text-[28px] leading-[1.1] font-black sm:mt-2.5 sm:mb-3 sm:text-[34px]">Deploy your own</h2>
        <p className="mb-[18px] leading-[1.55] sm:mb-5 sm:text-[17px]">
          Run your own copy. Choose the questions and the people that matter to your class, and track what they say and do.
        </p>
        <a href="https://github.com/mhsnook/sporelight#readme" target="_blank" rel="noreferrer" className="btn w-full shadow-hard-md sm:w-auto">
          Read the guide
        </a>
      </div>
      <pre className="flex flex-col justify-center overflow-x-auto border-t-2 border-ink bg-terminal px-5 py-[18px] font-mono text-[13px] leading-[1.9] text-[oklch(0.88_0.12_150)] sm:px-7 sm:py-8 sm:text-[15px] md:border-t-0 md:border-l-2">
        {['git clone github.com/mhsnook/sporelight', 'pnpm install', 'pnpm db:reset', 'pnpm dev'].map((command) => (
          <span key={command}>
            <span className="text-[oklch(0.65_0.08_150)] select-none">$ </span>
            {command}
          </span>
        ))}
      </pre>
    </section>
  )
}
