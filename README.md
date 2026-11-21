# Sporelight

A tracker for open questions in front of the people who decide them. For each person and each question it shows where they stand, the statements and acts that position rests on, and how solid that footing is.

The first data set is the United States Congress and Medicare for All. Nothing in the model is specific to either.

## How it works

- **Bodies, seats, roles.** A body (a legislature, a council, a board) has seats. A role is one claim on a seat: who, between which dates, how sure, and what it still depends on. The person who holds a seat today, a member-elect, the leader in a recount and someone running for the seat are all roles, told apart only by those four things. A challenger is a possible holder from the next term, so they sit beside the incumbent they want to replace.
- **Questions, measures and asks.** A question asks where someone stands ("Do they support Medicare for All?"). A measure is a sub-question about one recordable act, put to everyone in the body or chamber ("Have they cosponsored H.R. 3069?"). An ask is a sub-question put to a key role in the body, or to a person by name ("Will they commit to a markup?", asked of the committee chair). It has its own position scale and record, the people it is put to are shown first on the question's page, and an editor closes it when it is resolved or no longer being asked.
- **Offices and terms.** An office is a key role, such as a committee chair, and it outlives its holders. Seats and offices both have dated holders, and a body can name the day its next term starts. A question's page can then be viewed as the body stands now or as it is expected to stand from that day: seats are filled by whoever holds them then, and an ask of an office is put to whoever sits in it then. Each holder keeps their own position and record on the ask.
- **Likely and possible.** A seat or office can be held certainly, likely or possibly over its dates. That is a fact about the holding, not the person: someone can be certain in the seat they have now and only possible in it after a recount. Whoever is certain or likely is shown as the holder, marked "Likely" where it is not settled. Anyone who may yet hold it is listed beside them, and a seat with only possible holders is listed as not decided.
- **Roles held at large.** An office with no body is a role someone holds in their own right, such as leading an outside organisation. It shows with them in every body they sit in, can link to the source that says they hold it, and can have asks put to it like any other office.
- **Questions put to several bodies.** A question is listed under one body and can be put to others as well. Its page is looked at through one body at a time, with that body's seats and chart. Positions and records belong to the person, so someone who sits in two of the bodies has one answer in both.
- **Sources, acts, reports and readings.** A source is an article, press release, official record, transcript or post, one row per URL. An act is one thing a person did or said. A report is a mention of an act in a source, so a statement covered by five articles is one act with five reports. A reading is what an act signals on one question, and one act can read differently on two questions.
- **Archived copies.** Every source that backs something on the record gets a copy in the Wayback Machine where one can be had, linked as "archived" beside the source wherever it is shown. A scheduled pass finds or asks for the copies (see [Archiving sources](#archiving-sources)), and an editor can ask for one or give the address of a copy kept elsewhere.
- **Says, commits, does.** An act is one of three kinds, by how much it binds the person. Saying is words in any medium. Committing is formal, public and revocable: cosponsoring, signing a letter, taking a pledge. Doing is using the office itself: voting, scheduling, ratifying. A commitment can be withdrawn on a date. Words and uses of office cannot be taken back, only answered by a later act.
- **Which way, and how much.** A reading says two things about an act on one question. Which way it points: support, probable (it likely supports, but the words leave that uncertain or unclear), mixed, or against. Support for only part of a proposal is support on a smaller step, not a kind of reading. How much it counts: presumed (someone else's account of where the person stands, with no words or act of their own), passing (a remark in passing, or an act about something next to the question, shown as a signal), clear (words that say where the person stands in plain terms), or concrete (a vote, a signature, a pledge or another use of office, which puts them on the record). A vote on something else that tells you about the question is a passing reading there. This is how someone who says one thing and does another has both on their page.
- **Where someone stands.** On a position question nobody stores a position per person. It is worked out from their record each time it is shown, by the rules in `shared/standing.ts`: a commitment taken back does not count; the most recent concrete act decides, so a later vote supersedes an earlier one; a clear statement made after it, on another side, moves the result one step toward the middle; with no concrete act the most recent clear statement decides; passing remarks count only when there is nothing else, and then as a lean; what someone else says of them counts only when there is nothing of their own, also as a lean, and is marked as presumed wherever it shows. So adding an older act later changes what the page shows without anyone editing a position.
- **A position set by hand.** Editors can set someone's position on a question, with a reason that is shown on the person's page. While it is set, the page shows it instead of the calculated one, and says what the record alone works out to. A new report that points the other way is queued as a bigger decision: keep the position, set a new one, or lift it.
- **Related questions.** A question can be linked to a smaller step toward it (a narrower version, such as an amendment that limits a bill) or to a neighbouring question, and can carry the day its decision is expected. An act can be read on a question and on its smaller steps at once: a yes on the step and a no on the whole.
- **What counts toward the parent.** A reading on a measure or an ask says nothing about the parent question unless the sub-question says what doing it means there (`implies_on_parent`). Cosponsoring a bill is marked as support, so a supporting reading there is also written on the parent, with the same weight. A passing reading is not carried up. A letter against a policy would be marked as opposition.
- **Measures are read off the record.** On a measure nobody sets where someone stands. They have signed on if a commitment or a use of office is on file and still holds, and have not otherwise. Withdraw the commitment and they have not from that day.
- **Closing.** A question can close, and its closing date can lie ahead: a bill dies when its Congress ends. A closed measure keeps showing who had signed on when it closed. On its parent, those commitments stop counting as on the record and stay as dated history.
- **Footing.** Every position links to dated acts. Footing is derived from them: on the record (a concrete use of office, or a concrete commitment still in force), fresh, established, sparse, stale, or unknown. The rules live in `shared/standing.ts`.
- **Seat charts.** A question's page draws each chamber as a hemicycle, one dot per voting seat, packed so neighbours along a row sit as far apart as the rows do, ordered from support on the left to opposition on the right with the undecided in between. A line marks how many seats carry the question: a simple majority unless the question sets its own threshold, such as 38 of 50 states. It runs between the seats with exactly that many on its left, crossing each row through a gap and curving from one gap to the next, and a bloc that reaches it has the votes. A body with no chambers gets a single chart.
- **Adding questions.** Editors add and edit questions on the site, from "Add a question" on `/questions` (`/editor/questions/new`) and "Edit this question" on a question's page (`/editor/questions/<slug>/edit`). The edit page adds measures and asks under a question, and smaller steps and related questions linked to it, each with the same form, and closes or reopens any of them. A question's address is made from its short name when it is added and does not change when it is edited.
- **Review queue.** A proposal is a suggested set of changes from one source. Each item in it is one act by one person, read on one question. Readers send in proposals from any person's page, and a scheduled news search has a model read each article that names people on the roster and adds one for each that records something. Nothing reaches the record until an editor publishes it at `/editor`. See [Reviewing](#reviewing). An editor can also merge two acts that turn out to be the same one.
- **Latest.** `/latest` lists what has entered the record as stories, newest first. A story is one source and everyone an editor published from it in one review: each person's act is a reply under the source, with when it happened and what it shows on each question it is read on. Where the passage around the words was kept, the words are shown marked in it. A source that reports an act already on file makes a new story, and the act is marked as already on the record. Replies fold after three, and a row of standing tokens in each story's header shows how it splits. The feed can be narrowed to a question and everything under it (`?question=`), or to a body (`?body=`: anyone with a seat in it, past, present or running for one, on questions put to it), which also narrows the people in each story; each question's page links to its own slice. It shows 20 stories a page, with a link to older ones. What is waiting for review sits in the same feed, by when it was put forward, as a short dashed entry per proposal: the outlet and who put it forward, the headline, and up to two claims, each with where that person stands now. Opened, it shows every claim with its words, and asks the reader to check them against the source and say what is wrong in the discussion on that person's page. A claim that points the other way from a position editors set says that it would change that position, and that the page stays as it is until an editor reviews it. Each waiting entry has an address of its own (`/latest?proposal=…`), which the reader who sent it is given to pass on. It opens the feed on the page that holds the entry, and says so if an editor has since reviewed it. Only pending items that claim a reading show. Rejected items and search leads that only name someone are left out. `?recordOnly=true` shows only the published record and loads no proposals.
- **Atom feed.** `/feed.xml` is an Atom feed of the newest 20 published stories, served by the Worker from D1, with the same `question` and `body` filters. Each entry lists the people in the story with a link to each one's page. It never carries anything waiting for review.
- **Discussion.** Each person-and-question page has a comment thread. A reader loads and hears only the threads they have open. Comments post under a username the reader picks the first time they post. Editors can remove comments.
- **Signing in.** A reader can sign in with a code sent to their email address. Signing in is optional, and everything works signed out as before. The first name a signed-in person posts under becomes the name shown for them, and they can change it. Their email address is kept with their sign-in account and is never sent to a browser or shown on a page. What they send in records who sent it, and their comments are tied to them. A person's roles are stored one per row, each with where it holds, so the same person can later hold different roles for different organisations; nothing reads them yet.
- **Muting.** An editor can mute someone who has signed in, from any of their comments. While they are muted, their waiting proposals are left out of `/latest` and their comments out of each thread. Editors still see the comments, marked as muted, and can unmute them there. Muting hides what is shown; the rows are still synced like the rest of the public tables. The review queue still lists their proposals.

## Stack

- Cloudflare Worker + D1, with a React SPA served as static assets
- [party-db](https://github.com/mhsnook/party-db) syncs every public table to the browser over one Durable Object room; pages are live queries over the local copy
- TanStack Router (file-based routes in `src/routes`), TanStack DB, Tailwind
- Cloudflare [Web Search API](https://developers.cloudflare.com/web-search/) with Exa, and Workers AI, through AI Gateway, for the news search and reading the articles it finds
- [Better Auth](https://www.better-auth.com) in the Worker, on D1, with its email one-time code plugin, for reader sign-in, and Cloudflare [Email Service](https://developers.cloudflare.com/email-service/) to send the codes

Editors write through the same collections with optimistic transactions. Readers get read-only access. Unreviewed proposals are public. They are sliced collections, so a browser only loads them when a page queries them: the editor's queue, and `/latest` unless `?recordOnly=true` is set. The notes a submitter or reviewer writes for editors are kept in a separate table that is only sent to editor connections, as are the text either side of a quoted passage and the people an article only names. Readers post proposals and comments through the Worker, which validates them and limits each address to 6 posts a minute. Asking for a sign-in code counts as a post, and Better Auth adds its own limits, kept in D1: three codes a minute for one address, and three tries at each code. The sync room still verifies only the editor token. A signed-in reader is known to the Worker on the requests they post and is a reader like any other in the room.

## Reviewing

`/editor` shows one proposal at a time as a card: the source on top, then an entry for each person who did or said something in it.

- **The words.** An entry read from an article shows the words marked in the passage they sit in. Clicking it opens the wider passage over that entry, where other words can be selected and marked. The marked words become the act; the passage is published with them. A reader's proposal has only the words the reader typed.
- **Two answers.** Which way it points, and how much it counts. Under them the entry says where publishing it would leave the person. Each entry names the question its main answer is about. "Related proposals" lists the other questions the same act can be read on: the question's measures and asks, its smaller steps, and neighbouring questions. When the act says nothing on the card's own question, that question can be left out and the act published on the related ones alone. "Add a related question" there makes a new question, as a smaller step or a related issue, which is added at once and can be read on straight away.
- **Publish and Dismiss.** Dismiss is per person or for the whole card. "Add another person" starts a new entry from the first one's answers and passage. Two acts by one person are two entries, the second under the first. People the article names with nothing of their own to record are listed under the entries, and what the article says of one can be recorded as presumed.
- **Set our position.** A link on each entry sets the person's position by hand, with a reason, when the card is published. When an entry points the other way from a position already set, the card says so at the top and asks what the page should show.
- **A lead that was not read.** When the article could not be fetched or read, the card says why and nothing is filled in. The editor opens the source and types the words.
- **Keys.** `A` publishes, `R` dismisses the card, `J` and `K` move through the queue, `O` opens the source. A finished card leaves, the next one comes up and the page returns to the top. Proposals that would change a set position come first. The list beside the card shows everything waiting, a page at a time, with the open card marked in it.

Nothing an editor changes on a card is stored until it is published, apart from a question they add. Work on a card is kept while another card is open, and marked "started" in the list, for as long as the page stays open.

## Develop

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:reset     # migrate and seed the local D1
pnpm dev
```

Sign in at `/editor` with the `EDITOR_TOKEN` from `.dev.vars`.

Reader sign-in works locally too. The local email binding does not deliver mail, so read the code from the local database: `pnpm exec wrangler d1 execute DB --local --command "SELECT identifier, value FROM auth_verifications"`. The value is the code, then a colon and the number of tries used.

The news search needs the remote AI binding, which plain `pnpm dev` leaves off. Run `pnpm dev:remote` (after `wrangler login`) to use it locally; searches bill the logged-in account.

## Tests

```sh
pnpm typecheck     # every TypeScript project, tests included
pnpm test:unit     # pure functions, in Node
pnpm test:worker   # the Worker, in workerd
pnpm test:e2e      # the app, in Chromium
pnpm test          # unit and Worker tests together
```

`pnpm typecheck` needs a `.dev.vars` (copy `.dev.vars.example`), since that is where `wrangler types` finds `EDITOR_TOKEN`.

The Worker tests run in workerd through [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/), with the bindings in `wrangler.jsonc` and a local D1 that has every migration in `migrations/` applied. They call the Worker's `fetch` and the party endpoint the way a browser does, over HTTP and WebSockets. Each test file gets its own database and Durable Object storage, and the tests in a file share them. The news search and the article reader are tested with the AI binding and `fetch` replaced, so nothing reaches the network or a model.

The browser tests reset and seed the local database with `pnpm db:reset`, which throws away anything written to it locally, then start the dev server on port 5179 and drive it with Playwright. They use the editor token in `.dev.vars`. Install Chromium once with `pnpm exec playwright install chromium`.

CI runs all of these on every pull request and on pushes to `main` (`.github/workflows/ci.yml`). It needs no secrets and deploys nothing.

## Data

`seed/data/us-congress.json` holds the current roster (from [congress-legislators](https://github.com/unitedstates/congress-legislators)) and the sponsor and cosponsor records for H.R. 3069 and S. 1506 (from the Congress.gov API). `pnpm seed:fetch` refreshes it; set `CONGRESS_API_KEY` to avoid the shared rate limit.

`seed/data/us-states-era.json` holds each state's action on the Equal Rights Amendment, transcribed from the National Archives' [list of state ratification actions](https://www.archives.gov/files/foia/pdf/era-list-of-state-ratification-actions-03-24-2020.pdf) of March 24, 2020. A state that ratified and later voted to rescind is recorded as mixed, with both acts on its record.

`seed/data/us-congress-elect.json` holds the seats that change hands when the next Congress starts: who leaves each one and who was elected to it, taken from the winners marked on Wikipedia's pages for the 2026 House and Senate elections, which follow the Associated Press. Results are uncertified. Seats not yet decided are listed apart: whoever is ahead in a recount is seeded as the likely holder with the current holder as possible, and the candidates in a runoff are both possible. Someone elected for the first time gets an id of our own, since a Bioguide id only exists once they are sworn in.

`seed/data/us-congress-asks.json` holds the day the next Congress starts, the key offices with who holds them between which dates, and the asks put to those offices. It is written by hand, and an ask starts with nothing on its record.

`seed/data/halifax-ferry-fares.json` holds Halifax Regional Council's mayor and 16 councillors, from the municipality's list of districts and councillors, and one question: whether to waive Alderney ferry fares while the service is reduced. Its records are the council's vote of May 26, 2026, on waiving weekday fares for June, and three statements quoted word for word from the two sources the file names. Each member's vote comes from the account of the councillor who moved the motion, not from the council's minutes, so no act in it is marked as having a primary source. It is written by hand.

Every person and record in the seed is real. The made-up Harbor City council that the end-to-end tests use is in `test/e2e/fixture.json`. `pnpm seed:build` writes it to `seed/out/e2e-fixture.sql`, which is not part of `seed.sql`, and `pnpm test:e2e` loads it into the local database. A body marked `is_demo` is labelled as demo data wherever it appears.

A database seeded before the demo council left the seed still holds it. `seed/remove-demo.sql` deletes every demo body, its questions, the people who sit only in demo bodies, their record, and what readers sent in about them:

```sh
wrangler d1 execute DB --remote --file seed/remove-demo.sql
```

Seeding writes rows directly and skips the sync log, so seed before readers are connected.

Rows an editor makes on the site get random ids, which the seed never uses, so re-running the seed does not overwrite them. The one exception is a question address: if the seed adds a question whose address a question made on the site already has, the seed replaces that question, or stops with a foreign key error if anything points at it. An editor's changes to rows the seed made are overwritten when that data set is seeded again. What an editor adds to a seeded question, such as another person an ask is put to, is kept.

`pnpm seed:build` also writes one file per data set (`seed/out/us-congress.sql`, `us-congress-asks.sql`, `us-states.sql`, `halifax.sql`). Seeding replaces rows, so to add a data set to a database editors have been working in, run only its file:

```sh
pnpm seed:build && wrangler d1 execute DB --remote --file seed/out/us-states.sql
```

## Deploy

Production deploys from git. Cloudflare Workers Builds watches the `main` branch of this repo, runs the Vite build, and deploys the Worker. Every other branch gets a [Preview](https://developers.cloudflare.com/workers/previews/) from `wrangler preview`.

A build can apply database migrations before it deploys. In the Cloudflare dashboard, under the Worker's Settings > Builds:

- set the deploy command to `pnpm run deploy:ci`;
- set the preview command to `pnpm run preview:ci`;
- give the build's API token the D1 Edit permission. The token Cloudflare generates for builds does not include it.

Until that is done, apply migrations by hand before pushing a schema change: `pnpm db:migrate:remote` for production and `pnpm db:migrate:preview` for Previews. Seeding is never automatic.

One-time setup, from a machine with `wrangler login`:

```sh
wrangler d1 create sporelight          # put the id in wrangler.jsonc
wrangler d1 migrations apply DB --remote
pnpm seed:build && wrangler d1 execute DB --remote --file seed/out/seed.sql
wrangler secret put EDITOR_TOKEN
wrangler secret put BETTER_AUTH_SECRET  # a long random string; see Reader sign-in
wrangler secret put ARCHIVE_ORG_KEY   # optional; see Archiving sources
```

Then connect the repo in the Cloudflare dashboard and push to `main`. Secrets persist across deploys.

### Reader sign-in

Codes are sent with Cloudflare Email Service, which needs the Workers Paid plan and a domain on Cloudflare DNS. A `workers.dev` address cannot send mail.

1. In the dashboard, under Compute > Email Service > Email Sending, onboard the sending domain. Codes are sent from `mail.emju.in`. The DNS records it needs are added for you.
2. `EMAIL_FROM` in `wrangler.jsonc`, at the top level and in the `previews` block, is the address codes come from, `auth@mail.emju.in`. While it is empty, no code is sent and the Worker logs why.
3. `AUTH_HOSTS` lists the hosts sign-in answers on, comma separated, with `*` as a wildcard. Production is served on `sporelight.emju.in` and Previews on `*.sporelight.emju.in`, a custom domain set up in the dashboard with Previews enabled. Sign-in on any other host, including the `workers.dev` addresses, is refused.
4. Store `BETTER_AUTH_SECRET`, which signs the session cookies, for production and Previews. `openssl rand -base64 32` makes one.

Better Auth's tables are the `auth_` tables in `migrations/0014_reader_identity.sql`, written by its migration generator. When an upgrade changes them, add a migration with what it generates for SQLite.

### Previews

A Preview takes only the bindings in the `previews` block of `wrangler.jsonc`. All Previews share one database, `sporelight-preview`, so nothing posted or approved on a preview URL reaches production. Each Preview gets its own sync room.

Set the preview database up once. All Previews share it, so a migration on one branch reaches every Preview:

```sh
pnpm db:migrate:preview
pnpm db:seed:preview
wrangler preview base-config secret put EDITOR_TOKEN
wrangler preview base-config secret put BETTER_AUTH_SECRET
```

Without the secrets a Preview still runs, but nobody can sign in at `/editor`, and readers cannot sign in. Cron Triggers only fire in production, so the news search runs on a Preview only when an editor starts it.

The news search and the article reader route through the AI Gateway named `sporelight` (the `AI_GATEWAY` var), which has to be created in the dashboard. Searches pay from AI Gateway credits, or from an Exa key stored on that gateway.

## News search

Once a day (14:17 UTC) the Worker runs four searches for each question marked as in the news. A result is followed up when its title or excerpt names one to three people on that body's roster.

The daily run is skipped while the queue is unattended: when leads it queued earlier are still waiting and no editor has reviewed one in the last day. The next run after a review goes ahead. "Search the news now" in `/editor` always runs.

### Reading the article

For each result followed up, the Worker:

1. Fetches the page (10 second timeout, 3 MB at most) and turns it into plain text with Workers AI [Markdown Conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/) (`env.AI.toMarkdown`, text output). HTML, PDF and plain text are read; the text is cut at 60,000 characters.
2. Sends the text to `@cf/deepseek-ai/deepseek-v4.1-flash-1017` on Workers AI, with reasoning off and JSON output in a fixed schema. The model is told the question, its open sub-questions, the open questions linked to it in the same body (smaller steps and related issues), and which of them are put to each person named, by the same rules the question pages use. It returns each act it finds: who, on which question, the kind, the words, the date, which way it points, how much it counts, and a reason for the editor. It also lists the people it was asked about whom the article names without recording an act.
3. Keeps an act only if its words appear in the fetched text (ignoring case, whitespace, and the style of quote marks and dashes), its person is one the article was read for, and its question is one put to that person. It keeps one act per person and question, and at most eight from one article. For each it keeps the passage the words sit in (the paragraph, or the sentences around the words in a long one, up to 600 characters) and up to 700 characters of the paragraphs either side.
4. Queues the article as one proposal from origin `model`, with one item per act, already filled in. The passage is stored on the item and is public. The text either side of it, the model's reason, the model's id and the people only named are stored where only editors receive them.

An article the model reads and finds nothing in queues nothing. If the page cannot be fetched (many news sites turn away bots), has almost no text, or the model fails or answers out of shape, the result is queued as before: a lead with the search excerpt and no reading, with the reason as a code on the proposal (`unread`) and in full in a note.

Each article is read once per question. The table `article_reads` records the URL, question, time, outcome and model, and a result already in it, or already proposed from on that question, is skipped without fetching. It is a plain table and is not synced to browsers.

The model id is `MODEL` in `worker/reader.ts`. The search and the model both go through the AI Gateway named in `AI_GATEWAY` (`wrangler.jsonc`), so their cost shows on that gateway.

### Calls per run

A run reads at most 15 articles (`MAX_READS_PER_RUN` in `worker/news.ts`); results beyond that are left for the next run, which finds them again if the search still returns them. A model call that fails (a spending limit on the gateway, a rate limit, an outage) also ends reading for the run: that result falls back to its excerpt lead and the rest wait. With two questions in the news, one run spends at most:

| Call | Count | Counts against |
| --- | --- | --- |
| Web searches | 4 per question, so 8 | Cloudflare services |
| Article fetches | 15, plus redirects | outside requests (50 a run on Workers Free) |
| Markdown conversions | 15 | Cloudflare services |
| Model calls | 15 | Cloudflare services |
| D1 queries | about 10 per result looked at | Cloudflare services |

A model call sends up to about 15,000 tokens of article and gets back a few hundred. At $0.30 per million input tokens and $1.20 per million output tokens that is under half a cent per article, and under 10 cents for a full run, which is once a day. Spending limits set on the gateway cap this; a run that hits one stops reading, as above. The model needs the Workers Paid plan or prepaid AI Gateway credits. It allows 20 requests a minute on standard billing, which a run of 15 reads one at a time stays under.

### Trying the reader on one page

An editor can run the reader on one URL without queueing anything: open "Try the article reader on one page" at the top of `/editor`, paste a URL and pick a question. It fetches the page, reads it for everyone on that question's roster the page names (up to eight), and shows what would be queued, what was left out and why, or why the page could not be read. The same is available as `POST /api/editor/read-article` with `{ "url": "...", "question_id": "..." }` and the editor token. On a Preview this calls the real model and bills the account.

## Archiving sources

Web pages move and disappear, so each published source (one with at least one report) that has a URL gets a copy in the Internet Archive's Wayback Machine, and its address is stored in `sources.archive_url`. It shows as an "archived" link after the source on a person's page, in `/latest`, in the Atom feed (once its five-minute cache runs out), and in the editor's review form.

### The scheduled pass

Every six hours (`47 */6 * * *`, a cron of its own, apart from the news search's) the Worker takes the five oldest published sources with a URL and no archived copy that are due (`MAX_ARCHIVE_SOURCES_PER_RUN` in `worker/archive.ts`). For each one it:

1. asks the [availability API](https://archive.org/help/wayback_api.php) for the capture closest to when we recorded the source, and stores it unless it was taken more than 30 days before then (an older capture may predate what the source says) or is a capture of a redirect (which may show wherever the page was sent);
2. otherwise, if the Worker has an archive.org key, asks [Save Page Now 2](https://docs.google.com/document/d/1Nsv52MvSjbLb2PCpHlat0gkzw0EvtSgpKHu4mk0MnrA) for a new capture and records the job.

The pass then waits 90 seconds and asks Save Page Now once how each of its jobs went. A finished capture is stored. A job still running is left for the next run, which asks Save Page Now about the job first, then looks the page up near the time the capture was asked for. The stored address is written through the Tracker room's `commit`, like a proposal, so every open browser gets it through the sync log. The pass runs whether or not the news search is skipping its runs, since it waits on no editor.

The table `archive_attempts` keeps one row per source the pass has worked on: the outcome, the time, failures in a row, when it is next due, and the Save Page Now job and error. It is a plain table and is not synced to browsers. A failed capture is tried again after 12 hours, then 24, 48, 96 and 192; after six failures in a row the pass stops trying. A page the archive says it cannot capture (not found, access denied, blocked, a login wall, an address that does not resolve) is given up on at once. A source that has no URL is never picked up, and an address already on a source, such as one an editor gave, is never replaced. A copy an editor removes is not looked for again by the pass, since it would find the same one; "Archive now" still works for that source.

If the availability API cannot be reached or answers 429 or a server error, or Save Page Now answers 429, refuses the key or says the account is at its limit, the run stops archiving and nothing is counted against the source it was on. Requests to the archive are spaced three seconds apart, since the availability API answered 429 to a few requests a second apart.

### Requests per run

Each source costs at most three outside requests: a lookup, a capture request and a status check. A run therefore makes at most 15, well under the Workers Free limit of 50, and since it has its own cron it never shares a run with the news search's article fetches. At five sources a run and four runs a day, a backlog of published sources clears at about 20 a day. The cap is kept low for Save Page Now, which allows 7 captures a minute and 30,000 a day per account, and 5 captures of one URL a day; with requests three seconds apart, five sources a run stays under the per-minute limit.

### What the owner has to set up

Without a key the pass only looks for captures that already exist; a source with none is marked `no_key` and looked at again a week later, or on the first run after a key is set. To have the pass ask for captures, create an archive.org account, get an S3 key pair at <https://archive.org/account/s3.php>, and store it as one secret in the form `accesskey:secret`:

```sh
wrangler secret put ARCHIVE_ORG_KEY
```

Previews take the secret with `wrangler preview base-config secret put ARCHIVE_ORG_KEY`, though Cron Triggers never fire there, so on a Preview only an editor's request archives anything. Locally it goes in `.dev.vars`.

### By hand

Under each source on a person's page and in the review form an editor sees "Archive now", which runs the same steps for that source at once, ignoring any back-off, and waits about half a minute for the capture before leaving it to the scheduled pass. The same is `POST /api/editor/archive` with `{ "source_id": "..." }` and the editor token. An editor can also give the address of a copy kept anywhere, such as archive.today, which is saved on the source like any other edit.

### Documents with no public address

A press release that arrived only by email has no URL for the Wayback Machine to fetch, so the pass leaves it alone; such a source shows with its title and no link. `sources.stored_copy` is reserved for the address of a copy we keep ourselves, which is not built yet.
