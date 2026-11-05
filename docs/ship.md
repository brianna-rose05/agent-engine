# Ship to production: how it works

The preview is where you try the app. Production is the version people use. They are kept apart: production
has its own Vercel project and its own database, and shipping never touches the preview.

## Shipping a new version ("Ship to production")
The app queues the project with `mode: "ship"`, `ship: {from: "done", rollbackTo: null}` (allowed only when the
project is done, has a repo and nothing is running). The worker (worker.py `run_ship_mode`, engine/ship.py):

1. Clones the repo and brings the template files up to date (one commit on main, pushed), so the version
   includes the current template.
2. Runs five checks, one after the other, in one Daytona sandbox on exactly that main commit. No agents run
   and no model money is spent. They are the pieces of the integration check (`NextSupabaseStack.integration_check_cmd`):
   | name | label | command |
   |---|---|---|
   | types | Types check | `npx tsc --noEmit -p .` |
   | lint | Lint | `npx eslint --max-warnings=0 src/app` |
   | tests | All tests pass | `NO_COLOR=1 npx vitest run` |
   | build | Production build | `NEXT_TELEMETRY_DISABLED=1 npx next build` |
   | pages | Every page loads | `node scripts/check-app.mjs <pages from plan.json>` |
   The first failure stops the ship; nothing is tagged or deployed.
3. Creates (or finds) production's own database, `app_<repo name>_prod` (the preview's is `app_<repo name>`).
   This needs `POSTGRES_ADMIN_URL` (docs/databases.md). Without it, or if creating it fails, the ship fails:
   production never runs on the in-memory local mode, whose data resets.
4. Tags main as the next version: annotated tag `v<n>` with message `Version <n>`, where n is one more than
   the highest `v<n>` tag in the repo. The tag is pushed without force. A tag that can't be pushed is removed
   from the clone again; a pushed tag is never moved or deleted (if the deploy then fails, that number is used
   up and the next ship takes the next one).
5. Deploys the tag's files to the production Vercel project, named after the repo without `studio-`
   (`studio-garden-ab12cd` -> `garden-ab12cd`), with `DATABASE_URL` and its own `APP_SESSION_SECRET` (made
   once, then kept) as sensitive variables (engine/deploy.py `deploy_production`).

## Rolling production back
`ship: {from: "done", rollbackTo: n}` redeploys the existing tag `v<n>` the same way (same production
database and Vercel project). There are no checks (that version passed them when it shipped), no template
update and no new tag. A tag that doesn't exist fails the rollback.

## Events
In order: `ship_started {version, rollback}` (version is null for a new ship), then per check
`ship_check {name, label, status: "running"}` and `ship_check {..., status: "passed" | "failed", detail?}`
(detail: the last 1,500 characters of output, on failure only), then `ship_live {url, version, tag, sha,
rollback, database}` or `ship_failed {reason, check?}` (plain English, at most 300 characters). Last, always,
`project_finished {status: "done", repo}`: shipping never changes whether the app is built. The worker exits
with code 1 when the ship failed. A template update in step 1 also sends the usual `template_updated` first.

No event or log line ever holds a connection string, password or token: everything is scrubbed first.

## If something goes wrong
- A check failed: open the failed check in the Ship screen, fix it (a change or quick change), ship again.
- "POSTGRES_ADMIN_URL is not set": add the secret (docs/databases.md), then ship again.
- A run was interrupted: check the Daytona dashboard for a leftover sandbox (it also deletes itself when idle).
