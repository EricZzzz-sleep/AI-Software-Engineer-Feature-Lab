# AI-Software-Engineer-Feature-Lab

Use an existing training repository or prepare an empty
app before timing the exercises
• Confirm install, dev, test, typecheck, lint, and build
commands in the README.
• Use a persistent SQL store, migrations, seed/reset
command, and an existing test runner.
• Provide trusted test sessions for four actors; do not
accept a role from a request body.
• Keep fixture scenarios and fake-provider controls
available only in development/tes

## Campaign editing space

A TypeScript/Node app with persistent SQLite, explicit brief/draft saving, versioned
review, and immutable publication snapshots. The UI follows the supplied wireframe:
equal panes at 960 px and above, stacked brief then draft below 960 px.

### Start locally

Use Node **24+** and npm on macOS/Linux or WSL. Run from the repository root:

```sh
npm ci
NODE_ENV=development npm run db:seed
npm run dev
```

Open <http://127.0.0.1:3000> and choose a test actor. Seed replaces existing fixture
data and revokes sessions. To preserve an existing database, run `npm run db:migrate`
instead; migrating alone does not create the new demo campaigns or actors.

| Task | Command |
| --- | --- |
| Install locked dependencies | `npm ci` |
| Apply migrations | `npm run db:migrate` |
| Seed/reset fixtures | `NODE_ENV=development npm run db:seed` / `NODE_ENV=development npm run db:reset` |
| Development | `npm run dev` |
| Generation worker (second terminal) | `npm run worker` |
| API/database tests | `npm test` |
| Install browser for tests (once) | `npx playwright install chromium` |
| Browser tests | `npm run test:browser` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Build | `npm run build` |
| Run production build | `npm start` |

`DATABASE_PATH` defaults to `data/lab.sqlite`; `PORT` defaults to 3000. The server
binds to loopback. Retain `public/` and `migrations/` beside `dist/` for production.
Startup applies new migrations transactionally. Migration 002 preserves legacy
actors/projects; the retired project/provider endpoints no longer expose them.
The legacy actor role column is retained for compatibility and is not consulted
for campaign authorization. Workspace memberships are authoritative.

### Editing, review, and publication

Save explicitly persists the brief and draft together, creates a new version when
content changes, and invalidates review for that new version. No-op saves keep the
existing version and review. Unsaved edits disable review/publish. Ren reviews a
saved version in a dialog before publishing that exact version. Publications are
read-only snapshots available under Published versions; later edits never change
them. Repeating a successful publication returns the same snapshot, even after
newer edits exist.

Generate now submits a durable job from the **saved brief**. Save goal/facts/tone
changes first. Draft edits may remain unsaved; successful output is saved by the
worker, and the browser never replaces a dirty form. A clean form loads the saved
result automatically. A dirty form keeps its original version and offers explicit
Reload saved content; saving stale edits still returns 409.

F2 uses deterministic local fake providers only. No OpenAI API key or model call
is required; the previous synchronous live-provider implementation is replaced.
Production generation is disabled, while authorized persisted status/results remain
readable. Start the worker in a second terminal, from the same repository directory:

```sh
npm run worker
```

Web server and worker must use the same `DATABASE_PATH` (default `data/lab.sqlite`).
Both commands load optional `.env` settings. Jobs remain queued while the worker is
stopped and resume when it starts. The worker rejects non-development/test execution.

Saving failures and stale-version conflicts preserve local text. A conflict returns
409 and requires an explicit reload to see newer server content; reloading or
switching actor/campaign asks before discarding unsaved changes. Dirty text is never replaced in the background or automatically merged. Session expiry preserves the form;
Sign in again renews the same actor without replacing local text. Browser navigation
warns while dirty; local unsaved text is not persisted across a confirmed page exit.

### Actors and permission policy

| Actor | Workspace | Permissions |
| --- | --- | --- |
| Maya / editor | A | Read, save brief, edit/save draft, generate |
| Ren / publisher | A | Editor actions plus review/publish |
| Evan / viewer | A | Read only, including publication snapshots |
| Priya / editor | B | Edit B; no access to A's objects |

Unauthenticated/expired sessions receive **401**. Missing objects and objects in
another workspace receive the same **404 Not found** response. An actor who can
read an object but cannot perform the requested action receives **403**. UI controls
reflect this matrix; API checks remain authoritative. Unknown request fields,
including supplied roles or workspace assignments, are rejected.

### API

All `/api/` routes require `Authorization: Bearer TOKEN`. Session tokens are random,
stored as SHA-256 hashes, and expire after one hour.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/me` | Identity and memberships |
| `GET /api/campaigns` | Accessible campaigns only |
| `GET /api/campaigns/:id` | Current saved content, version, review flag, publication list |
| `PUT /api/campaigns/:id` | Atomic save with `expectedVersion`, `goal`, `facts`, `tone`, `draft` |
| `POST /api/campaigns/:id/generate` | `{ "key": "unique-request-key", "briefRevision": 1, "draftRevision": 1 }`; 202 for a new job, 200 for identical replay |
| `GET /api/campaigns/:id/generations` | Active job and latest terminal job |
| `GET /api/campaigns/:id/generations/:jobId` | Authorized persisted status/result |
| `POST /api/campaigns/:id/review` | Review `{ "expectedVersion": 1 }` |
| `POST /api/campaigns/:id/publish` | Publish `{ "expectedVersion": 1 }`; requires review |
| `GET /api/campaigns/:id/publications/:publicationId` | Immutable publication with JSON snapshot |
| `GET /health` | Liveness |

Each content field is plain text, at most 20,000 characters. Rendering uses text
nodes, not HTML. Saved versions and review/publication writes use SQL transactions
and compare the expected version under the write lock.

### Development/test controls

Only exact `NODE_ENV=development` or `test` enables these endpoints and the actor
switcher. Controls reject foreign browser origins and non-loopback Host headers.
Session/fixture setup endpoints are unauthenticated local lab tools; keep the development server local. Generation scenario/release controls additionally require a valid session with save permission.

- `GET /__test/actors`: four fixture identities.
- `POST /__test/session`: `{ "actorId": "maya" }` (also `ren`, `evan`, `priya`).
- `POST /__test/fixtures`: `{ "scenario": "default" }` for two campaigns, or
  `{ "scenario": "empty" }` for memberships without campaigns; revokes sessions.

Production, unset, and unknown environments return 404 for all test controls.
Production authentication provisioning remains out of scope; a provisioned session
is required. Use a separate production database so development tokens are not reused.
The old `/api/projects`, `/api/provider/check`, and `/__test/provider` routes are retired.

### Validation

Node tests cover actor permissions, workspace isolation, forged fields, expiry,
atomic saves, conflicts, review invalidation, idempotent publication, snapshots,
forward migration, persistence, and fixture restrictions. Playwright runs an
isolated in-memory server and covers recovery, actor switching, review/publish,
focus return, keyboard order, live status, and layouts at 1440, 960, 959, 390, and
720 CSS px. A separate isolated Chromium test sets actual browser zoom to 200%,
checks reflow, and completes review at that zoom level. Desktop/mobile/zoom
screenshots are emitted under ignored `test-results/` for visual inspection.

### Reviewing saved versions

Publishers such as Ren have **Edit campaign** and **Review versions** tabs. The
review tab lists all saved revisions, newest first, with review indicators. Choose
a revision to inspect its read-only brief/draft, author, and save time, then select
**Review selected version** and confirm. Approval applies only to that revision;
reviewing an older version never approves or replaces the current revision.
Switching tabs preserves unsaved editor input. Publishing continues to require
review of the current saved revision.

Publisher-only, workspace-scoped endpoints:

- `GET /api/campaigns/:id/versions`: version summaries, newest first.
- `GET /api/campaigns/:id/versions/:version`: immutable saved content and review state.
- `POST /api/campaigns/:id/versions/:version/review` with `{}`: idempotently approve
  that exact saved revision, even if a newer revision has since been saved.

The existing current-version review endpoint retains its stale-version check.


### F2 durable generation: invariants and recovery

Migration 003 backfills independent brief/draft revision counters without changing
campaign version numbers, historical approvals, or publications. An initially
absent (empty) draft has revision 0; after the first draft, revisions increase even
when the draft is cleared. A brief-only save retains draft provenance and labels
an older draft **Out of date**. Generated output creates a new draft/campaign
revision even if its text happens to match an earlier draft.

Job admission inserts the immutable brief snapshot, job, outbox work, and active
campaign generation ID in one SQLite transaction. A partial unique index enforces
one active job per campaign. Keys are scoped to workspace/campaign; identical key
and canonical revisions return the original job, including a terminal job, before
checking current revisions. Reusing a key with changed revisions is a 409. Another
key while a job is active returns 409 with its authorized `activeJobId`.

The browser stores unresolved keys/payloads in localStorage scoped to actor,
workspace, and campaign. Transport retry reuses the original payload; a new request
after terminal failure uses a new key. Status is read from the database on return
and polled every second while visible. Status states are queued, running, retrying,
succeeded, failed, and obsolete. IDs and status are not dependent on a browser tab.

The worker uses short transactions to claim outbox work with leases and fencing
tokens; provider calls run outside transactions. Every attempt and deadline is
persisted. Defaults are 30 seconds per attempt, one second backoff, two attempts
maximum, and a 65-second job budget beginning at first claim (queue wait excluded).
Leases expire two seconds after their attempt deadline. Timeout/transient errors
retry once; malformed and other errors fail immediately. Interrupted work consumes
an attempt and can resume only within the same budget. Late or unfenced responses
cannot apply. Output must contain a nonempty string `draft`, at most 20,000 characters.

Result application atomically checks brief revision, base draft revision, active
generation ID, and lease ownership before saving. A mismatch marks the job obsolete
without changing the saved draft; UI offers regeneration. Success writes the draft,
job result, and completed outbox state together. There is no separate commit-to-ack
gap: simulated replay after commit is a no-op. Provider work can repeat after a
crash, but result application is at most once. Errors/results stay durable, and
workspace checks protect every status/result read. Viewers can read but cannot
create jobs or use fake controls.

### Fake scenarios and mentor F2 gate

Choose **Test generation scenario** before Generate. Settings affect only new jobs;
an existing job retains its captured scenario. Controls are development/test-only,
local same-origin, authenticated, and workspace scoped:

- `POST /__test/generation-scenario`: `{ "campaignId": "launch", "scenario": "success" }`.
- `POST /__test/generation-release`: `{ "campaignId": "launch", "jobId": "..." }`.

| Scenario | Behavior |
| --- | --- |
| success | Valid deterministic output from the captured goal and facts |
| delayed_success | Wait for **Release delayed job**, subject to normal deadlines |
| timeout | Both attempts reach their deadlines |
| malformed | Wrong field type; fail before saving |
| transient_then_ok | First call fails transiently, second succeeds |

The mentor repeats this gate before advancing:

1. Start the web server and worker against the same database. As Maya, save a brief,
   generate with delayed_success, note the job ID, navigate away, and return. The
   same job/status must appear. Release within its deadline and verify a saved draft
   survives refresh.
2. Generate with delayed_success again. Save a newer brief before releasing it.
   Confirm **Generation out of date**, preserved draft, and Regenerate. Repeat with
   a newer saved draft. A newer draft must never be replaced by an old result.
3. Leave unsaved edits in the form while releasing a valid job. Confirm the worker
   saves its result but the form preserves every edit until explicit reload.
4. Run malformed and timeout; confirm unchanged saved content, durable terminal
   errors, and a new-key retry. Run transient_then_ok and confirm success at attempt 2.
5. Stop the worker before enqueueing; start it and confirm queued work resumes.
   Force-stop it during delayed_success and restart: lease recovery consumes the
   interrupted attempt; release during the remaining budget. If it expires, use
   Retry generation for a fresh job. Never reset fixtures to simulate a restart.
6. Verify Evan cannot generate, and Priya cannot read Workspace A job status/results
   or release its jobs. Fixture reset clears jobs, attempts, outbox, and scenarios;
   an old in-flight worker cannot write into reset fixtures.
7. Run the automated gate: `npm test`, `npm run test:browser`, `npm run typecheck`,
   `npm run lint`, `npm run build`. Tests cover raced same/different keys, atomic
   rollback, persisted migration/revisions, late results, duplicate delivery,
   actual killed/restarted worker processes, bounded attempts, lost admission
   responses, preserved edits, and cross-workspace denial. Record results before
   mentor advancement.

Browser tests use an isolated in-memory database with a worker loop and shorter
injected deadlines; worker/restart tests use temporary on-disk databases. No tests
invoke live model services.

### Mentor acceptance drills: reliable saves

Save is available to editors and publishers even when the form is unchanged.
Unchanged saves keep the same revision. Save failures and conflicts preserve all
four form fields and the original version in the open tab. Refresh restores the
last committed revision, not unsaved local edits.

The **Mentor drills** panel is available only in development/test. These controls
are local lab tools, protected by the same loopback Host and same-origin checks as
other fixture routes. They are absent from the production page and return 404 in
production, unset, and unknown environments.

- `POST /__test/save-failure` with `{ "campaignId": "launch" }` requires a valid
  bearer session with save permission. It arms one pre-commit failure for that
  session and campaign. Invalid, unauthorized, and conflicting saves do not consume
  it. The next valid save reaches the transaction's pre-commit hook, consumes the
  injection, rolls back its writes, and returns 500. A valid no-op save also
  consumes the injection. Repeated arming does not queue multiple failures.
- `POST /__test/fixtures` also accepts `{ "scenario": "conflict-v7" }`. This
  replaces demo data, creates deterministic launch revisions v1–v7, sets v7 as
  current, clears reviews/publications, generation jobs/outbox work, and armed failures, and revokes sessions.
  The default/empty scenarios retain their existing behavior. Restarting the
  server also clears armed failures.

The mentor repeats this checklist before advancing the exercise:

1. **Save and refresh:** Sign in as Maya, edit goal/audience, facts, tone, and draft,
   and Save. Refresh and verify every field and the saved revision. Save again
   unchanged; the revision must not advance.
2. **Permissions:** Evan can read but cannot save or arm a failure. Maya and Ren
   can save; Priya can only access Workspace B. API authorization is authoritative.
3. **Rollback:** As Maya, edit all fields, select **Fail my next save before commit**,
   wait for the armed message, then Save. Expect “Nothing was saved” and unchanged
   local input. An independent tab still sees the prior revision. Retry Save;
   it now succeeds and survives refresh.
4. **Reset:** Select **Reset fixtures to v7** and confirm the destructive reset.
   Sign in again in both tabs and load the launch campaign; both must show v7.
   An already-open tab preserves local text on sign-in: use Reload saved content
   and confirm discarding old edits to load the reset fixture.
5. **Conflict:** Use Maya in one tab and Ren in the other. Enter different text in
   each and save both. Exactly one tab saves v8. The other reports a conflict and
   keeps its input at v7. Cancel Reload once to verify preservation, then explicitly
   confirm Reload to see the winning v8. Repeat the reset and drill with Ren in
   both tabs (two sessions). No retry may silently replace the winner.
6. Record the results in the PR or exercise notes. Advancement is a manual mentor
   decision, not an automatic application gate.

**Separate lost-response case:** The browser test forwards a real save, waits for
its successful response (and therefore commit), then drops that response before
it reaches the page. The page reports “Save outcome unknown; the request may have
succeeded” and preserves input. An independent GET proves the revision committed;
a stale retry returns 409, and explicit Reload retrieves the committed revision.
This is not a rollback failure. Save reconciliation remains manual; F2 generation
admission separately uses idempotency keys for transport retries.

Run `npm test` and `npm run test:browser` for rollback, persistence across database
reopening, v7 concurrent API saves, both two-tab combinations, fixture reset,
permission enforcement, and lost-response coverage. Also run `npm run typecheck`,
`npm run lint`, and `npm run build` before mentor review.
