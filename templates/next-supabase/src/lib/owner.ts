import { createHash, timingSafeEqual } from "node:crypto";
import type { Actor, Db } from "./db";
import { AppError } from "./errors";
import { isLocalMode } from "./runtime";

/**
 * The app's owner. Template file: do not edit.
 *
 * The owner IS the app's admin. Whoever runs the app claims the owner role once, in the app itself, on the
 * /owner-setup page: they sign up like anyone else, then enter the setup code Studio shows them. The code
 * comes from APP_SETUP_CODE (set by the deployer, never in the repo), so a stranger who finds the page first
 * can't take over the app.
 *
 *   if (await isOwner(db, actor)) ...            // show admin links
 *   await requireOwner(db, actor);               // first line of every admin-only server function
 *
 * Apps may add further staff roles in their own tables (granted by the owner, in the app). But "is this person
 * the admin/owner" is always `isOwner` / `requireOwner`: never a role column a person sets by hand or "directly
 * in the database". Nobody using the app can do that.
 *
 * The owner is kept in its own template-owned table, `app_owner.owner` (one row, id 1), created on first use like
 * the local sign-in tables. Migrations never create, change or reference it.
 */

const SETUP = `
  create schema if not exists app_owner;
  create table if not exists app_owner.owner (
    id int primary key check (id = 1), user_id uuid not null, claimed_at timestamptz not null default now());
`;

const ready = new WeakMap<Db, Promise<void>>();

async function setup(db: Db): Promise<void> {
  const run = async () => {
    for (const stmt of SETUP.split(";").map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  };
  try {
    await run();
  } catch {
    // Two servers creating the table at the same moment: one of them loses the race on Postgres's catalog.
    // By now the other has created it, so running again finds everything in place.
    await run();
  }
}

function ensureTable(db: Db): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = setup(db);
    ready.set(db, p);
    p.catch(() => ready.delete(db));     // a failure is retried by the next call, not cached
  }
  return p;
}

/** The setup code the deployer set, or null when there is none. */
function configuredCode(): string | null {
  const code = (process.env.APP_SETUP_CODE ?? "").trim();
  return code ? code : null;
}

const normalize = (code: string) => code.trim().toUpperCase();
const digest = (code: string) => createHash("sha256").update(normalize(code)).digest();

/** Timing-safe, trimmed, case-insensitive comparison of two setup codes. */
function sameCode(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** The owner's user id (an id in auth.users), or null while nobody has claimed the app. */
export async function getOwnerId(db: Db): Promise<string | null> {
  await ensureTable(db);
  const { rows } = await db.query<{ user_id: string }>("select user_id from app_owner.owner where id = 1");
  return rows[0]?.user_id ?? null;
}

/** True when `actor` is the app's owner (its admin). False for nobody signed in (null). */
export async function isOwner(db: Db, actor: Actor | null | undefined): Promise<boolean> {
  if (!actor) return false;
  return (await getOwnerId(db)) === actor.userId;
}

/** Throws AppError("forbidden", "Only the owner can do this.") unless `actor` is the app's owner. */
export async function requireOwner(db: Db, actor: Actor): Promise<void> {
  if (!(await isOwner(db, actor))) throw new AppError("forbidden", "Only the owner can do this.");
}

/**
 * What /owner-setup shows:
 * - "claimed": the app has its owner ("This app already has an owner.").
 * - "open": a signed-in person can claim it with the setup code.
 * - "not_configured": no setup code was set for this deployed app, so nobody can claim it (never open to
 *   strangers). Local mode (no DATABASE_URL: automated checks and tests) is always "open" until claimed.
 */
export async function ownerSetupState(db: Db): Promise<"open" | "claimed" | "not_configured"> {
  if (await getOwnerId(db)) return "claimed";
  return configuredCode() || isLocalMode() ? "open" : "not_configured";
}

/**
 * Makes `actor` the app's owner. Exactly one claim ever wins, even when two arrive at the same moment.
 * - Already claimed: AppError("conflict", "This app already has an owner.").
 * - APP_SETUP_CODE set: `code` must match it (spaces around it and letter case don't matter), otherwise
 *   AppError("forbidden", "That setup code isn't right.").
 * - APP_SETUP_CODE not set: local mode (no DATABASE_URL) accepts any code, so checks and tests can claim;
 *   a deployed app refuses with AppError("forbidden", "Owner setup isn't configured for this app.").
 * In tests (local mode): `await claimOwner(db, { userId }, "any")` makes that user the owner.
 */
export async function claimOwner(db: Db, actor: Actor, code: string): Promise<void> {
  if (await getOwnerId(db)) throw new AppError("conflict", "This app already has an owner.");
  const expected = configuredCode();
  if (expected) {
    if (!sameCode(String(code ?? ""), expected)) throw new AppError("forbidden", "That setup code isn't right.");
  } else if (!isLocalMode()) {
    throw new AppError("forbidden", "Owner setup isn't configured for this app.");
  }
  const won = await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ user_id: string }>(
      `insert into app_owner.owner (id, user_id, claimed_at) values (1, $1, now())
       on conflict (id) do nothing returning user_id`, [actor.userId]);
    return rows.length === 1;
  });
  if (!won) throw new AppError("conflict", "This app already has an owner.");
}
