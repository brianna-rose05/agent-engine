# Ship to production: how it works

The preview is where you try the app. Production is the version people use. They are kept apart: production
has its own Vercel project and its own database, and shipping never touches the preview.

## Shipping a new version ("Ship to production")
The app queues the project with `mode: "ship"`, `ship: {from: "done", rollbackTo: null}` (allowed only when the
project is done, has a repo and nothing is running). The worker (worker.py `run_ship_mode`, engine/ship.py):

1. Clones the repo and brings the template files up to date (one commit on main, pushed), so the version
   includes the current template.
2. Runs eight checks, one after the other, in one Daytona sandbox on exactly that main commit. No agents run
   and no model money is spent. The first five are the pieces of the integration check
   (`NextSupabaseStack.integration_check_cmd`); the last three come from `NextSupabaseStack.ship_check_cmds` and
   run only when shipping:
   | name | label | command | blocks the ship when |
   |---|---|---|---|
   | types | Types check | `npx tsc --noEmit -p .` | any error |
   | lint | Lint | `npx eslint --max-warnings=0 src/app` | any problem |
   | tests | All tests pass | `NO_COLOR=1 npx vitest run` | any test fails |
   | build | Production build | `NEXT_TELEMETRY_DISABLED=1 npx next build` | the build fails |
   | pages | Every page loads | `node scripts/check-app.mjs <pages from plan.json>` | a page errors or is missing |
   | security | Security | `node scripts/check-security.mjs` | a high/critical advisory, or a secret in the repo |
   | accessibility | Accessibility | `node scripts/check-a11y.mjs <pages>` | a serious/critical axe problem |
   | speed | Speed | `node scripts/check-speed.mjs <pages>` | a page loads > 1 MB of JS or takes > 10 s |
   The first failure stops the ship; nothing is tagged or deployed. The last three can also **pass with warnings**
   (their script exits with code 10): the ship goes on, and the Ship screen shows the check in amber with its notes.
   Those three also show a short summary when they pass (the speed table, what was audited).

### The security, accessibility and speed checks
All three are template files (`templates/next-supabase/scripts/`, in `NextSupabaseStack.reserved`, so no task may
own them and `upgrade_template` in step 1 brings them to older projects). They share `scripts/app-server.mjs` with
the page check: the same pages (every static route under `src/app` plus the ones plan.json requires), and the built
app started with `next start` in local mode (no `DATABASE_URL`: an in-process database, no real data touched).
- **Security** (`check-security.mjs`), three parts:
  1. `npm audit --omit=dev` (production dependencies only). A high or critical advisory fails the check; a moderate
     one is a warning; low ones are counted. Advisories the template itself ships with and that only a major
     upgrade fixes (zod 3, postcss inside Next 15: the `ACCEPTED` list in the script) are listed as known and not
     counted, or every app would fail. **If the audit service can't be reached** the check doesn't block: it passes
     with a warning saying the dependencies weren't audited (a registry outage shouldn't stop a ship, and the
     warning makes the gap visible).
  2. A secret scan of every tracked file (`git ls-files`): private key blocks, GitHub/Anthropic/Vercel/Daytona/
     Stripe/AWS/Slack/Supabase secret tokens, and database URLs with a password (`postgres(ql)://user:pw@host`;
     placeholders like `${PASSWORD}` and `localhost` URLs are skipped), plus any committed `.env` file. Any match
     fails the check; only the file, line and kind are printed, never the value.
  3. Sign-in on changes, kept simple and conservative: each route handler that exports POST/PUT/PATCH/DELETE and
     each `"use server"` file under `src/app` should import `@/lib/session` or `@/lib/owner` (or call `getActor`,
     `requireActor`, `getAuth`, `requireOwner`, `isOwner`). One that doesn't is a **warning only**: public forms
     (sign-up, a contact form) are legitimate, and following calls into `src/server` would need real analysis.
- **Accessibility** (`check-a11y.mjs`): axe-core on every page at desktop (1280 x 800) and phone (390 x 844) width
  in headless Chromium (Playwright, a template devDependency with axe-core). Pages that redirect (sign-in) are
  checked where they land. `serious`/`critical` problems fail the check; `moderate`/`minor` ones are warnings.
  Chromium isn't in the `node:22-bookworm` image: the first run does `npx playwright install --with-deps --only-shell
  chromium` (headless shell only, about 115 MB download plus system libraries; then without `--with-deps` if the
  system libraries can't be installed). If Chromium still can't start (no network to Playwright's download host,
  say), the pages are checked without a browser instead: axe-core in jsdom on the server-rendered HTML. That still
  blocks on serious/critical problems, but can't check colour contrast or the phone width, so it always passes
  with a warning that says so.
- **Speed** (`check-speed.mjs`): per page, the server response time (median of 3 requests after a warm-up, in
  local mode: production adds its database's latency) and the first-load JS (the gzipped size of every
  `/_next/static/*.js` file the page's HTML loads, read from `.next/static`; legacy `nomodule` polyfills aren't
  counted, as `next build` doesn't). Warning above 300 kB or 2 s; fails only above 1 MB or 10 s. The detail is a
  small table: page, response time, JS.

Time they add (measured locally on a 2-page app; the sandbox has 2 CPUs): security about 2 s (the audit is one
registry request), speed about 2 s, accessibility about 5 s per run with Chromium present (2 widths x pages) plus
the one-off Chromium install in the sandbox: about 20 s to download the headless shell here, and typically
1-2 minutes in a fresh sandbox with the system libraries. The jsdom fallback takes about 2 s.

To add a check (a design review, say): add it to `CHECKS` in engine/ship.py (name, label, `report=True` if it
prints a summary and may pass with warnings), return its command from the stack's `ship_check_cmds`, and add the
same name and label to `SHIP_CHECKS` in web/convex/ship.ts.
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
`ship_check {name, label, status: "running"}` and `ship_check {..., status: "passed" | "warning" | "failed", detail?}`
(warning: passed with notes, the ship goes on; detail: the last 1,500 characters of output, scrubbed, on failure and
warning, and on a pass for security, accessibility and speed, whose output ends with a short summary), then `ship_live {url, version, tag, sha,
rollback, database}` or `ship_failed {reason, check?}` (plain English, at most 300 characters). Last, always,
`project_finished {status: "done", repo}`: shipping never changes whether the app is built. The worker exits
with code 1 when the ship failed. A template update in step 1 also sends the usual `template_updated` first.

No event or log line ever holds a connection string, password or token: everything is scrubbed first.

## If something goes wrong
- A check failed: open the failed check in the Ship screen, fix it (a change or quick change), ship again.
- A check passed with warnings: the version shipped. Open the amber check to see the notes and fix them in a later
  change if they matter.
- "POSTGRES_ADMIN_URL is not set": add the secret (docs/databases.md), then ship again.
- A run was interrupted: check the Daytona dashboard for a leftover sandbox (it also deletes itself when idle).
