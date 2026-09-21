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

Generate is intentionally disabled. Dirty content explains that changes need to
be saved; saved content explains that generation is not configured. **No provider,
generation jobs, job status endpoint, or worker exists in this phase.** Any future
worker/status implementation must apply the same workspace/role policy.

Saving failures and stale-version conflicts preserve local text. A conflict returns
409 and requires an explicit reload to see newer server content; reloading or
switching actor/campaign asks before discarding unsaved changes. There is no silent
background replacement or automatic merge. Session expiry preserves the form;
Sign in again renews the same actor without replacing local text. Browser navigation
warns while dirty; local unsaved text is not persisted across a confirmed page exit.

### Actors and permission policy

| Actor | Workspace | Permissions |
| --- | --- | --- |
| Maya / editor | A | Read, save brief, edit/save draft |
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
They are unauthenticated local lab tools; keep the development server local.

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
  current, clears reviews/publications and armed failures, and revokes sessions.
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
This is not a rollback failure. Automatic retries, idempotency keys, and automatic
reconciliation are intentionally outside this PR.

Run `npm test` and `npm run test:browser` for rollback, persistence across database
reopening, v7 concurrent API saves, both two-tab combinations, fixture reset,
permission enforcement, and lost-response coverage. Also run `npm run typecheck`,
`npm run lint`, and `npm run build` before mentor review.
