# Owner setup: every app's admin claims it with a one-time code

Every generated web app has an owner, and the owner is its admin. Nobody using Studio can edit a database by hand,
so "the admin role is set directly in the database" is never a design: the owner claims the app in the app itself.
Regression (Tool library build, Nov 5): the design did exactly that and the admin pages were unreachable. Pawfect
only worked because its design had a first-come owner page, which on a public URL lets any stranger claim it first.

## In the app (template file `src/lib/owner.ts`, never edited by agents)
- One row in the template-owned table `app_owner.owner` (created on first use, like the local sign-in tables;
  migrations never touch it).
- `getOwnerId(db)`, `isOwner(db, actor)`, `requireOwner(db, actor)` (AppError forbidden "Only the owner can do
  this."): every admin/owner/manager check. Other staff roles, if any, live in the project's own tables and are
  granted by the owner in the app.
- `ownerSetupState(db)`: `"open"`, `"claimed"` or `"not_configured"`.
- `claimOwner(db, actor, code)`: exactly one claim ever wins (insert on conflict). With `APP_SETUP_CODE` set the
  code must match (trimmed, any letter case, timing-safe compare). Without it, local mode (no `DATABASE_URL`:
  checks and tests) accepts any code, and a deployed app refuses every claim ("Owner setup isn't configured for
  this app."), so an app is never open to strangers.

## The page
The integrator always writes `/owner-setup` (engine/project.py `INTEGRATION_SPEC`; the stack's `required_pages`
adds it to the page list and so to the integration check, which fails on a 404 or 5xx). Signed out: sign-up and
sign-in links first. Open: "Set up the owner account", a setup code field, then a redirect to the admin home.
Claimed: "This app already has an owner." The sign-in page's footer links to it as "Owner setup".
Ship and quick-change checks request it like any other page in src/app/, but don't require it, so a project built
before owner setup still ships; its next change run adds the page.

## The codes
Studio stores `setupCodes: {preview?, production?}` on the project row (three groups of four characters, e.g.
`K7PQ-M2XR-9TVD`) and shows them only to the project's owner. The worker reads them from the row
(`project_setup_code`) and passes the preview code to the preview deploy (`publish_preview`) and the production code
to the ship (`run_ship` → `deploy_production`). The deployer sets it on the Vercel project as `APP_SETUP_CODE`,
type **sensitive**, with `DATABASE_URL`. A missing code deploys without one. The code is a secret: it is never
printed, never in an event, and scrubbed from every error and failure reason.
