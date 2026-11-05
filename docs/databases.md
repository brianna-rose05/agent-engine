# Databases: a durable Postgres for every project's preview

Without this, a preview runs in local mode: each Vercel serverless instance has its own in-memory PGlite, so
data disappears between visits ("Preview data resets"). With it, every project gets its own database in one
Postgres server you own (Neon), and the preview keeps its data across visits, redeploys, retries and changes.

It is optional. Without the secret below, everything works exactly as before (local mode).

## What you set up (once, about 5 minutes)
1. Create a Neon account (neon.com) and a project. The free plan is fine to start.
2. In the Neon console, open the project, click **Connect**, pick the default branch (`main`), the default
   database (`neondb`) and the default role (`neondb_owner`). Turn **Connection pooling** on and copy the
   connection string. It looks like
   `postgresql://neondb_owner:<password>@ep-xxxx-pooler.<region>.aws.neon.tech/neondb?sslmode=require`.
   The role must be able to `CREATE DATABASE` (Neon's default owner role can).
3. In GitHub: agent-engine repo → Settings → Secrets and variables → Actions → **New repository secret**,
   name `POSTGRES_ADMIN_URL`, value the connection string. Never paste it into chat, an issue or a commit.

That's all. The next build, retry, change or rollback that publishes a preview creates the database.

Why the pooled string: each preview runs as many small serverless instances, and every instance opens its own
connections. Neon's pooler (PgBouncer, transaction mode) takes up to 10,000 client connections; a direct
connection on the smallest compute allows about 100 in total, shared by every project. The template is written
to work through the pooler (no prepared statements, a transaction-scoped migration lock). If creating a
database ever fails through the pooler (`database_failed` in the build channel), use the direct string
(without `-pooler`) instead; previews then use direct connections too (each instance opens at most 5 and closes
them when idle).

## What happens (worker.py `publish_preview`, engine/databases.py, engine/deploy.py)
1. When the integration task has merged and `POSTGRES_ADMIN_URL` is set, the worker connects with it and
   creates the project's database if it doesn't exist yet. Name: `app_` + the project's repo name, lowercased,
   with anything other than letters and digits turned into `_` (e.g. repo `studio-garden-ab12cd` → database
   `app_studio_garden_ab12cd`; very long names are shortened and end in a short hash).
2. The project's URL is the admin URL with the database name swapped (same role, password, host, and
   `sslmode` and other options).
3. The deployer sets it on the project's Vercel project as `DATABASE_URL`, type **sensitive** (encrypted and
   write-only: nobody can read it back in the Vercel dashboard), for production and preview. It also sets
   `APP_SESSION_SECRET` (sensitive) the first time only; later deploys keep it, so redeploys don't sign anyone out.
   When the project row has a setup code, it sets `APP_SETUP_CODE` (sensitive) too: see docs/owner-setup.md.
4. The app's first request on a fresh instance (templates/next-supabase/src/lib/runtime.ts → db-postgres.ts →
   migrate.ts) takes a Postgres advisory lock, applies the auth shim (auth schema, `auth.users`, `auth.uid()`,
   the `authenticated`/`anon` roles, local sign-in tables) and every migration not yet recorded in
   `app_meta.migrations`, in file-name order, all in one transaction. Instances starting together wait for each
   other; if a migration fails nothing is applied and the next request tries again.
5. Sign-in uses the template's local accounts (stored in the database), since no Supabase settings are set.
6. The app shows the preview without the "Preview data resets" note once `database_ready` has been seen.

Events (build channel): `database_ready {name}` (never the URL) or `database_failed {reason}` (scrubbed of any
connection string or password). If provisioning fails the preview still deploys; on a project that never had a
database that means local mode, while a project that already had one keeps its `DATABASE_URL` on Vercel and so
keeps using its database.

## Retries, changes and rollbacks
- **Retries and changes**: same database. Any new migrations the change adds are applied on the first request
  after the deploy. Data is kept.
- **Migrations only move forward.** An applied migration is recorded by file name and never runs again, so
  editing it later does nothing on a database that already has it. Schema changes are new, higher-numbered files.
- **A rollback does NOT roll the database back.** It restores the code, not the data or the schema. The rolled
  back code runs against a database that may still have tables or columns a later change added (usually
  harmless: old code ignores them). If the rolled-away change had already been applied, its migration stays
  recorded; if the rolled-back code later gets a different migration under the same file name, that one is
  skipped. Rolling forward again needs nothing special. If you need the data as it was, use Neon's own
  point-in-time restore (branch from a past time) in the Neon console.
- Two projects never share a database. Deleting a project in the app does not delete its database.

## Deleting a project's database by hand
In the Neon console: project → **SQL Editor**, database `neondb`, then

```sql
drop database app_studio_garden_ab12cd with (force);   -- the name from the project's database_ready event
```

`with (force)` disconnects open preview connections first. Or: Neon console → **Databases** → the database's
menu → Delete. A preview that still points at a deleted database fails on its next request; the next worker
run that publishes the preview creates an empty one again (migrations re-apply, data starts empty).

To stop using durable databases altogether, delete the `POSTGRES_ADMIN_URL` secret. Existing previews keep the
`DATABASE_URL` already set on their Vercel project until you remove it there (Vercel → project → Settings →
Environment Variables).

## Checking it locally
`python3 -m pytest tests/test_databases.py` runs a real provisioning test when `TEST_POSTGRES_ADMIN_URL` points
at a throwaway server (or a local `initdb`/`pg_ctl` is available and you're not root); otherwise it is skipped.
