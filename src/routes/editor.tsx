import { Outlet, createFileRoute } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { isEditor, signIn } from '../lib/editor.ts'

// Every page under /editor is for editors only.
export const Route = createFileRoute('/editor')({ component: Editor })

function Editor() {
  return isEditor() ? <Outlet /> : <SignIn />
}

function SignIn() {
  const [failed, setFailed] = useState(false)
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const token = new FormData(e.currentTarget).get('token') as string
    setFailed(!(await signIn(token)))
  }
  return (
    <form onSubmit={onSubmit} className="card mx-auto mt-8 max-w-sm space-y-4 p-6">
      <h1 className="text-[28px] font-black">Editors</h1>
      <div>
        <label className="label" htmlFor="token">
          Editor token
        </label>
        <input id="token" name="token" type="password" required autoComplete="current-password" className="field" />
      </div>
      {failed && <p className="text-sm text-oppose">That token was not accepted.</p>}
      <button className="btn btn-primary">Sign in</button>
    </form>
  )
}
