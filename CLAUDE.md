# Working on Sporelight

The README describes what the app is and how to run it. This file is how changes are made here.

## Commands

- pnpm only; the version is pinned in `package.json` (`packageManager`). Build-script permissions and the one-day `minimumReleaseAge` live in `pnpm-workspace.yaml`.
- Before pushing: `pnpm typecheck`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build`, `pnpm test:e2e`. `pnpm typecheck` needs a `.dev.vars` (copy `.dev.vars.example`).
- `pnpm test:e2e` resets the local database first.

## Pull requests

- One theme per pull request. PRs are squash-merged, so the PR description becomes the commit message on `main`. Put the reasoning there.
- Start the description with anything the owner has to do before merging: dashboard steps, migrations on both databases (`pnpm db:migrate:remote`, `pnpm db:migrate:preview`), secrets.
- Say what was run and what passed, and name what has never run for real (anything that needs Cloudflare credentials, a real model, or a real news site).
- An agent's GitHub token cannot push changes to `.github/workflows/`. Leave those to the owner and say so.

## Issues, epics and milestones

- Keep the work in progress small enough to hold in mind: one or two milestones being worked on, and two to four epics. One epic can have several issues going at once, so the count of open items grows quickly.
- A milestone being worked on has a due date; a later one can be open with none, and gets one when work on it starts. GitHub lists milestones by due date, so the ones being worked on come first.
- An epic being worked on has the `active` label, which comes off when work on it stops.
- Split and close an issue that has grown past what motivated it. Close the part that is done as completed, in the milestone it served, with a comment listing the pull requests that delivered it. Move what is left into a new issue or epic that copies its substance, not only a link, and say in the closing comment where it went. Do this whenever an issue is mostly done and still open: at the end of a piece of work, a week, or a milestone.
- A milestone's own description says what is later. An issue whose rest is later is split, not taken out of the milestone.

## Code

- A comment earns its place in one of two ways:
  - It stops the next person from making a specific wrong assumption about that line: a footgun, an ordering constraint, something that looks wrong but isn't.
  - It is a one-line signpost saying what a block does and why, such as "Parse the model's answer to match the review form's fields".

  Why a change was made goes in the commit message or PR, not in a comment.
- Prefer a two-word name that makes a comment unnecessary over a generic one-word name that needs one: `articleText` over `text` with a note saying which text.
- When a library or a Cloudflare feature covers a job, use it fully. One snag is not a reason to drop it and write its job by hand. If you do drop one, say so and why.
- Anything written as the project (README, UI copy, PR text, test names, prompts) is plain and factual, with no emphasis for effect.
- Unreviewed proposals are public. Text the public should not see goes in a table whose reads need a signed-in person, never in a column of a synced public table.
- Email addresses live only in Better Auth's `auth_` tables, which no collection serves. The public sees a person through `people`.
- Roles and deactivation are Better Auth's admin plugin. The sync room's `auth` hook reads the session and passes the role on as `claims.roles`; access rules name `{ roles: ['editor'] }` for what only editors may write, and `'authed'` means anyone signed in. `people.role` is a copy for pages to show; never check permissions against it.
- A schema change is a new file in `migrations/`. Previews share one database, so a migration on one branch reaches every Preview.

## The news search and the article reader

- The AI Gateway id is the `AI_GATEWAY` var in `wrangler.jsonc`, set at the top level and in the `previews` block. Both the search and the model go through it, because the gateway is where the spending limits are.
- The model id is `MODEL` in `worker/reader.ts`. Check the Workers AI catalogue for a deprecation date before changing it.
- An act the model returns is kept only if its words are found in the fetched article text. Do not loosen that check: an editor trusts a pre-filled form.

## Tests

- Worker tests run in workerd (`test/worker/`). The real `env.AI` cannot be called. Pass a stubbed env (`{ ...env, AI: { ... } } as unknown as Env`), and stub outside fetches with `vi.spyOn(globalThis, 'fetch')`.
- Tests in one file share a database. Each test sets up the state it depends on instead of relying on rows an earlier test left behind.
- Test behaviour and misuse, not constants. Compare against the value in config (`env.AI_GATEWAY`), not a copy of it.
