import { Link, Outlet, createRootRoute, retainSearchParams, useLocation } from '@tanstack/react-router'
import { useState } from 'react'
import { TrackerProvider, today } from '../lib/tracker.tsx'
import { formatDate } from '../lib/position.ts'
import { useIsEditor } from '../lib/auth.ts'
import { Logo } from '../components/bits.tsx'
import { NameDialog } from '../components/NameDialog.tsx'
import { SignIn, SignInDialog } from '../components/SignIn.tsx'

// `as` is the day every body is viewed on, and `body` the one a question put
// to several is viewed through. Both are kept across links, so a reader stays
// in the view they chose until they switch back.
export type SiteSearch = { as?: string; body?: string }

export const Route = createRootRoute({
  component: Root,
  validateSearch: (s: Record<string, unknown>): SiteSearch => ({
    as: typeof s.as === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.as) ? s.as : undefined,
    body: typeof s.body === 'string' && s.body ? s.body : undefined,
  }),
  search: { middlewares: [retainSearchParams(['as', 'body'])] },
})

function NavLinks({ className, onNavigate }: { className: string; onNavigate?: () => void }) {
  const editor = useIsEditor()
  return (
    <>
      <Link to="/questions" className={className} onClick={onNavigate}>
        Questions
      </Link>
      <Link to="/news" activeOptions={{ exact: true }} className={className} onClick={onNavigate}>
        News
      </Link>
      <Link to="/" hash="how" className={className} activeProps={{}} onClick={onNavigate}>
        How it works
      </Link>
      <Link to="/" hash="own" className={className} activeProps={{}} onClick={onNavigate}>
        Run your own
      </Link>
      {editor && (
        <>
          <Link to="/news/review" className={className} onClick={onNavigate}>
            Review
          </Link>
          <Link to="/admin" className={`${className} nav-editor bg-editor md:border-2 md:border-ink`} onClick={onNavigate}>
            Admin
          </Link>
        </>
      )}
    </>
  )
}

function Header() {
  const [menuOpen, setMenuOpen] = useState(false)
  // Setting up a new site is the whole page, with nothing to navigate to yet.
  const settingUp = useLocation({ select: (l) => l.pathname === '/setup' })
  return (
    <header className="-mx-5 border-b-2 border-ink px-5 sm:-mx-8 sm:px-8">
      <div className="flex items-center justify-between gap-4 py-4 sm:py-6">
        <Link to="/" className="flex items-center gap-2.5 sm:gap-3" onClick={() => setMenuOpen(false)}>
          <Logo />
          <span className="font-display text-xl font-black sm:text-2xl">Sporelight</span>
        </Link>
        {!settingUp && (
          <>
        <nav className="hidden items-center gap-1 text-[15px] font-semibold md:flex">
          <NavLinks className="rounded-full px-3.5 py-2 hover:text-accent [&.active]:bg-ink [&.active]:text-paper" />
          <SignIn className="rounded-full px-3.5 py-2 hover:text-accent" />
        </nav>
        <button type="button" className="btn px-3 text-sm font-bold shadow-none md:hidden" aria-expanded={menuOpen} aria-controls="menu" onClick={() => setMenuOpen(!menuOpen)}>
          {menuOpen ? 'Close' : 'Menu'}
        </button>
          </>
        )}
      </div>
      {menuOpen && (
        <nav id="menu" className="flex flex-col pb-3 text-lg font-bold md:hidden">
          <NavLinks className="flex min-h-11 items-center border-t-2 border-dashed border-line [&.active]:text-accent" onNavigate={() => setMenuOpen(false)} />
          <div className="flex min-h-11 items-center border-t-2 border-dashed border-line">
            <SignIn className="font-bold" />
          </div>
        </nav>
      )}
    </header>
  )
}

// `as` rides along on every link, including to pages with no control for it,
// so the day being viewed is always said here with a way back.
function ViewedDay({ day }: { day: string }) {
  return (
    <p role="status" className="-mx-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b-2 border-ink bg-mixed px-5 py-2 text-sm font-semibold sm:-mx-8 sm:px-8">
      <span>
        Viewing {formatDate(day)}. Seats, key roles and closing dates are {day > today() ? 'as expected' : 'as they stood'} on that day.
      </span>
      <Link to="." search={(prev) => ({ ...prev, as: undefined })} replace className="link font-bold">
        Back to today
      </Link>
    </p>
  )
}

function Root() {
  const { as } = Route.useSearch()
  return (
    <TrackerProvider asOf={as}>
      <div className="mx-auto flex min-h-dvh max-w-[1200px] flex-col px-5 sm:px-8">
        <Header />
        <SignInDialog />
        <NameDialog />
        {as && as !== today() && <ViewedDay day={as} />}
        <main className="flex-1 py-8">
          <Outlet />
        </main>
        <footer className="-mx-5 mt-10 flex flex-wrap justify-between gap-2 border-t-2 border-ink px-5 py-5 text-[15px] sm:-mx-8 sm:px-8">
          <span>Every position links to its source.</span>
          <span className="tag">Open source · MIT licence</span>
        </footer>
      </div>
    </TrackerProvider>
  )
}
