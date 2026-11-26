import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { openSignIn } from '../components/SignIn.tsx'
import { useSession } from '../lib/auth.ts'
import { useSyncGeneration } from '../lib/db.ts'

// Every route under this layout is for editors only, whatever its address.
export const Route = createFileRoute('/_editor')({ component: Editor })

function Editor() {
  const { id, role, isPending } = useSession()
  // These pages read tables only signed-in people are sent, which start over after a reset.
  const generation = useSyncGeneration()
  if (isPending) return null
  if (role === 'editor')
    return (
      <>
        <p className="editor-band -mt-8 mb-8">
          <span className="editor-tag">Editors</span> Only editors can open this page.
        </p>
        <Outlet key={generation} />
      </>
    )
  return (
    <div className="card mx-auto mt-8 max-w-md space-y-4 p-6">
      <h1 className="text-[28px] font-black">Editors only</h1>
      {id ? (
        <p>This page is for editors. An editor can make you one from the admin page.</p>
      ) : (
        <>
          <p>This page is for editors. Sign in to open it.</p>
          <button type="button" className="btn btn-primary" onClick={() => openSignIn()}>
            Sign in
          </button>
        </>
      )}
      <p className="text-sm text-faint">
        Setting up a new site? <Link to="/setup" className="link">Make the first editor</Link>.
      </p>
    </div>
  )
}
