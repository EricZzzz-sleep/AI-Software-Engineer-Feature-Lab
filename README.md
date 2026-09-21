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

Generate calls the server, which sends the current goal/audience, source facts, tone, and previous draft to the [OpenAI Responses API](https://developers.openai.com/api/docs/guides/text).
Copy `.env.example` to `.env`, set `OPENAI_API_KEY`, and restart `npm run dev`.
`OPENAI_MODEL` defaults to `gpt-4.1-mini` and can be changed to a Responses-compatible
text model available to your account. Both dev and production start commands load
`.env`; existing environment variables take precedence. The key stays on the server.

Select Generate using the current brief, including unsaved edits. A goal/audience
is required; facts and tone are optional. Generate can be used again after each
request without saving first; the previous draft is included to request different
wording and structure. Save is available even without changes and during generation. The result replaces the local draft and remains unsaved until
Save is selected. The prior saved version remains available through Reload saved
content. Review and publish stay disabled while the generated draft is unsaved.
Generation never automatically saves, reviews, or publishes. Provider errors and
60-second timeouts preserve existing text. Concurrent generation for the same
campaign is rejected within the server process, and conflicting brief changes while generating
reject the stale result. Saving the requested brief or just the draft during
generation is allowed. Requests are not automatically retried. Responses are
requested with `store: false`; the brief is still transmitted to OpenAI for processing.

Saving failures and stale-version conflicts preserve local text. A conflict returns
409 and requires an explicit reload to see newer server content; reloading or
switching actor/campaign asks before discarding unsaved changes. There is no silent
background replacement or automatic merge. Session expiry preserves the form;
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
| `POST /api/campaigns/:id/generate` | Generate with `expectedVersion`, optional `goal`/`facts`/`tone` (all three together), and optional `previousDraft`; returns unsaved `{ draft, expectedVersion }` |
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
